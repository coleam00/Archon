"""Validate proposal identities and evidence state, then render local review artifacts."""

import json
import os
import re
import subprocess
import sys
from html import unescape
from urllib.parse import unquote, urlsplit

# The workflow declares this vocabulary; the package test checks conformance.
CLASSIFICATIONS = ("stale", "duplicate", "update-existing", "new")


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def indexed(records, count, label):
    if (not isinstance(records, list) or len(records) != count
            or any(not isinstance(e, dict) or type(e.get("item_index")) is not int for e in records)
            or sorted(e["item_index"] for e in records) != list(range(count))):
        fail(f"render: {label} must contain exactly one entry per input item.")
    return {entry["item_index"]: entry for entry in records}


def public_text(value):
    if not isinstance(value, str) or not value.strip():
        fail("render: public title, summary, and rationale must be nonempty strings.")
    # Structural path checks supplement the model's disclosure judgment. They
    # cannot recognize arbitrary private facts or certify prose for publication.
    decoded = unescape(unquote(value))
    if (re.search(r"(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?:^|[\s\"'\x60(<=\[])/(?:home|Users|tmp|var|private|root|mnt|opt|etc)/)", decoded)
            or "$ARTIFACTS_DIR" in decoded or "${ARTIFACTS_DIR}" in decoded
            or "file://" in decoded.casefold()):
        fail("render: proposed public text contains a local absolute path.")
    return value.strip()


def target_identity(target, forge):
    if not isinstance(target, dict) or type(target.get("number")) is not int or target["number"] < 1:
        fail("render: invalid target item number.")
    if not isinstance(target.get("url"), str):
        fail("render: target URL is missing.")
    url = urlsplit(target["url"])
    paths = [f"/{forge['path']}/{kind}/{target['number']}" for kind in ("issues", "pull")]
    if (url.scheme != "https" or url.netloc != forge["host"] or url.path not in paths
            or url.query or url.fragment or not forge["host"]):
        fail("render: target URL does not match the configured repository and item number.")


def main():
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    artifacts = os.environ["ARTIFACTS_DIR"]
    with open(os.path.join(artifacts, "discoveries", "normalized.json"), encoding="utf-8") as f:
        normalized = json.load(f)
    with open(os.path.join(artifacts, "discoveries", "context.json"), encoding="utf-8") as f:
        context = json.load(f)
    with open(os.path.join(artifacts, "evidence-check.json"), encoding="utf-8") as f:
        evidence = indexed(json.load(f), len(normalized), "evidence check")
    try:
        searches = indexed(json.loads(os.environ["INPUTS_SEARCH_RESULTS"]), len(normalized), "search")
        classifications = indexed(json.loads(os.environ["INPUTS_CLASSIFICATION"]), len(normalized), "classification")
    except (KeyError, ValueError):
        fail("render: missing or malformed agent output.")
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True)
    if head.returncode != 0 or head.stdout.strip() != context["revision"]:
        fail("render: source revision moved after revalidation; restart discovery proposals.")
    forge = context["forge"]
    rows = []
    counts = dict.fromkeys(CLASSIFICATIONS, 0)
    for item in normalized:
        index = item["item_index"]
        checked, search, classified = evidence[index], searches[index], classifications[index]
        cls, target = classified.get("classification"), classified.get("target_item")
        if cls not in CLASSIFICATIONS:
            fail("render: unrecognized classification.")
        # Missing citations do not disprove a claim. Retain the model's verdict
        # separately; only source-bound supported claims can be actionable.
        if (cls == "stale") != (checked["verdict"] == "disproved"):
            fail("render: stale classification requires a disproved model verdict.")
        matches = search.get("matches")
        if type(search.get("forge_checked")) is not bool or not isinstance(matches, list):
            fail("render: invalid search result.")
        if search["forge_checked"] and not forge["available"]:
            fail("render: search claims a forge check while the configured forge is unavailable.")
        if matches and not search["forge_checked"]:
            fail("render: matches require a completed forge search.")
        for match in matches:
            target_identity(match, forge)
        if cls in ("duplicate", "update-existing"):
            target_identity(target, forge)
            if not any(m["number"] == target["number"] and m["url"] == target["url"] for m in matches):
                fail("render: target item was not found by the forge search.")
        elif target is not None:
            fail("render: new and stale proposals must not name a target item.")
        if cls == "new" and matches:
            fail("render: a new proposal cannot ignore related existing work.")
        if classified.get("disclosure_safe") is not True:
            fail("render: model has not cleared the proposed text for public disclosure.")
        title = public_text(classified.get("public_title"))
        summary = public_text(classified.get("public_summary"))
        rationale = public_text(classified.get("rationale"))
        actionable = (cls in ("new", "update-existing") and checked["verdict"] == "supported"
                      and checked["evidence_status"] == "source-bound"
                      and forge["available"] and search["forge_checked"])
        rows.append({
            "item_index": index, "title": title, "summary": summary, "rationale": rationale,
            "classification": cls, "model_verdict": checked["verdict"],
            "evidence_status": checked["evidence_status"], "revision": context["revision"],
            "evidence_refs": checked["evidence_refs"] if checked["evidence_status"] == "source-bound" else [],
            "target_item": target, "marker": item["marker"] if cls != "stale" else None,
            "forge_checked": search["forge_checked"], "actionable": actionable,
            "publication_authorized": False,
        })
        counts[cls] += 1
    document = {
        "revision": context["revision"], "forge": forge,
        "publication_authorized": False, "proposals": rows,
    }
    lines = ["# Discovery proposals", "",
             "Local review artifact. Publication is not authorized by this workflow.", "",
             "Source-bound citations check locations, not claim truth. Model judgments and public text need human review.", ""]
    if not forge["available"]:
        lines.extend(["Publication unavailable: " + forge["reason"] + ".", ""])
    for row in rows:
        lines.extend([f"## {row['title']}", "", row["summary"], "", row["rationale"], "",
                      f"Classification: {row['classification']}; model: {row['model_verdict']}; evidence: {row['evidence_status']}.",
                      f"Actionable proposal: {'yes' if row['actionable'] else 'no'}. Publication authorized: no.", ""])
        lines.extend(f"- Source: \u0060{ref['path']}:{ref['line']}\u0060 at \u0060{row['revision']}\u0060"
                     for ref in row["evidence_refs"])
        if row["target_item"]:
            lines.append("Related: " + row["target_item"]["url"])
        if row["marker"]:
            lines.append("Proposed marker: <!-- archon-discovery:" + row["marker"] + " -->")
        lines.append("")
    with open(os.path.join(artifacts, "discovery-proposals.json"), "w", encoding="utf-8") as f:
        json.dump(document, f, indent=2)
    with open(os.path.join(artifacts, "discovery-proposals.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(json.dumps({"count": len(rows), **{k.replace("-", "_") + "_count": v for k, v in counts.items()}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
