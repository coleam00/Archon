"""Validate the judgment, then optionally publish and verify labels.

One standalone script owns the tuple and pack labels because bundled scripts
are materialized independently. gh is the interim boundary permitted by #3212;
the forthcoming forge work-item operation should absorb publication.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit


STATE_LABELS = {
    "READY": ("archon-ready", "0e8a16", "Archon: contract is ready for engineering"),
    "NEEDS_CONTRACT_WORK": ("archon-needs-contract", "d93f0b", "Archon: contract needs work"),
    "DESIGN_FIRST": ("archon-design-first", "fbca04", "Archon: engineering shape needs design"),
    "BLOCKED": ("archon-blocked", "b60205", "Archon: unresolved dependency or decision"),
    "NO_ACTION": ("archon-close", "cfd3d7", "Archon: a human should consider closing"),
}
PACK_LABELS = {entry[0] for entry in STATE_LABELS.values()}
ROUTES = ("investigate", "plan", "deliver", "no_action")
CONTRACTS = tuple(key for key in STATE_LABELS if key != "DESIGN_FIRST")
COMPLEXITIES = ("small_bounded", "risky", "large")


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def qualified_url(value) -> bool:
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return False
    url = urlsplit(value)
    return url.scheme in ("http", "https") and bool(url.hostname) and not url.username and not url.password


def validate(triage: dict, artifacts: str) -> None:
    report = Path(artifacts) / "triage.md"
    require(report.is_file() and bool(report.read_text(encoding="utf-8").strip()),
            "no triage.md evidence: a route without evidence is not a triage")
    require(isinstance(triage, dict), "triage must be an object")
    for field in ("route", "contract", "summary", "complexity", "blocked_reason", "issue_repo", "issue_url"):
        require(isinstance(triage.get(field), str), f"{field} must be a string")
    route, contract = triage["route"], triage["contract"]
    design_first = triage.get("design_first")
    require(type(design_first) is bool, "design_first must be a boolean")
    require(route in ROUTES, "route is not one of the declared values")
    require(contract in CONTRACTS, "contract is not one of the declared values")
    require(triage["complexity"] in COMPLEXITIES, "complexity is not one of the declared values")
    require(bool(triage["summary"].strip()), "summary must be non-empty")
    if contract == "READY":
        require(route != "no_action", "READY must route to investigate, plan, or deliver")
    else:
        require(route == "no_action", f"{contract} must route to no_action")
    require(not design_first or (contract == "READY" and route == "plan"),
            "design_first is only valid when contract is READY and route is plan")
    edits = triage.get("proposed_edits")
    require(isinstance(edits, dict) and all(isinstance(edits.get(k), str) for k in ("title", "body")),
            "proposed_edits must contain string title and body")
    if contract == "NEEDS_CONTRACT_WORK":
        require(all(edits[k].strip() for k in ("title", "body")),
                "NEEDS_CONTRACT_WORK must propose a non-empty title and body")
    else:
        require(not edits["title"] and not edits["body"], "contract must not propose edits")
    blockers = triage.get("blocked_by")
    require(isinstance(blockers, list) and all(qualified_url(b) for b in blockers),
            "blocked_by must be an array of qualified HTTP(S) URLs")
    if contract == "BLOCKED":
        require(bool(triage["blocked_reason"].strip()), "BLOCKED must name a blocked_reason")
    else:
        require(not blockers and not triage["blocked_reason"], "only BLOCKED may report blockers or blocked_reason")
    labels = triage.get("labels")
    require(isinstance(labels, list) and all(isinstance(v, str) and v.strip() for v in labels),
            "labels must be an array of non-empty strings")
    require(len(labels) == len(set(labels)), "labels must not contain duplicates")
    expected = STATE_LABELS["DESIGN_FIRST" if design_first else contract][0]
    require([label for label in labels if label in PACK_LABELS] == [expected],
            f"labels must contain exactly the pack label {expected!r}")
    repo, number, url = triage["issue_repo"], triage.get("issue_number"), triage["issue_url"]
    require(type(number) is int and number >= 0, "issue_number must be a non-negative integer")
    if repo or number or url:
        # This parses a declared identifier, never the user's natural-language target.
        require(bool(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)) and number > 0,
                "issue_repo and issue_number must identify one issue")
        require(url.lower() == f"https://github.com/{repo}/issues/{number}".lower(),
                "issue_url must match the resolved issue_repo and issue_number")


def gh(args: list[str], payload=None):
    proc = subprocess.run(["gh", *args], input=None if payload is None else json.dumps(payload),
                          capture_output=True, text=True, encoding="utf-8", timeout=30)
    require(proc.returncode == 0,
            f"gh {args[0]} failed (exit {proc.returncode}); writes may have partially completed: {proc.stderr.strip()}")
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def label_names(entries) -> set[str]:
    require(isinstance(entries, list) and all(isinstance(e, dict) and isinstance(e.get("name"), str) for e in entries),
            "forge labels must be an array of named objects")
    return {entry["name"] for entry in entries}


def read_issue(endpoint: str, triage: dict) -> set[str]:
    issue = gh(["api", "--hostname", "github.com", endpoint])
    require(isinstance(issue, dict) and issue.get("number") == triage["issue_number"]
            and isinstance(issue.get("html_url"), str)
            and issue["html_url"].lower() == triage["issue_url"].lower()
            and "pull_request" not in issue,
            "issue identity mismatch on read-back; refusing publication success")
    return label_names(issue.get("labels"))


def publish(triage: dict) -> dict:
    repo, number = triage["issue_repo"], triage["issue_number"]
    result = {"published": False, "applied_labels": [], "skipped_labels": []}
    # Prose, unsupported trackers and refused multi-item input have no write target.
    if not repo:
        return result
    endpoint = f"repos/{repo}/issues/{number}"
    current = read_issue(endpoint, triage)
    pages = gh(["api", "--hostname", "github.com", f"repos/{repo}/labels?per_page=100", "--paginate", "--slurp"])
    require(isinstance(pages, list), "forge label pages must be an array")
    existing = set().union(*(label_names(page) for page in pages))
    for name, color, description in STATE_LABELS.values():
        if name not in existing:
            gh(["api", "--hostname", "github.com", f"repos/{repo}/labels", "--method", "POST", "--input", "-"],
               {"name": name, "color": color, "description": description})
    accepted = [label for label in triage["labels"] if label in PACK_LABELS or label in existing]
    target = (current - PACK_LABELS) | set(accepted)
    additions = set(accepted) - current
    if additions:
        # Narrow mutations preserve unrelated labels added since the read.
        gh(["api", "--hostname", "github.com", f"{endpoint}/labels", "--method", "POST", "--input", "-"],
           {"labels": sorted(additions)})
    for label in sorted((current & PACK_LABELS) - set(accepted)):
        gh(["api", "--hostname", "github.com", f"{endpoint}/labels/{quote(label, safe='')}", "--method", "DELETE"])
    actual = read_issue(endpoint, triage)
    require(target <= actual and actual & PACK_LABELS == target & PACK_LABELS,
            "label read-back mismatch: proposed or unrelated labels missing, or stale pack labels remain; writes may have completed")
    return {"published": True, "applied_labels": accepted,
            "skipped_labels": [label for label in triage["labels"] if label not in accepted]}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    try:
        triage = json.loads(os.environ["INPUTS_TRIAGE"])
        validate(triage, os.environ["ARTIFACTS_DIR"])
        enabled = os.environ.get("INPUTS_PUBLISH", "false")
        require(enabled in ("true", "false"), "publish must be true or false")
        triage["publication"] = (publish(triage) if enabled == "true" else
                                 {"published": False, "applied_labels": [], "skipped_labels": []})
        print(json.dumps(triage, separators=(",", ":")))
        return 0
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print(f"validate-contract: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
