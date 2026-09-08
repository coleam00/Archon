"""Reject an impossible classification, then render the public-safe action set.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_FORGE_HOST / INPUTS_FORGE_PATH: resolve-input's forge identity, or
  empty strings when no forge was reachable.
- INPUTS_SEARCH_RESULTS: search-existing's full declared array (JSON text).
- INPUTS_CLASSIFICATION: classify's full declared array (JSON text).

Both bound arrays come from agent nodes, delivered through node-output wiring
rather than a file either node "would have written" - every fixture stubs
agent nodes, so only a declared output, never a custom file, survives a stub.
evidence-check.json is read as a plain file instead, because check-evidence is
a script node that always executes for real.

No tracker write happens anywhere in this workflow. The marker computed here
is forward-looking only - the value a later, separate, gated publication
workflow would embed as an idempotency marker - and is never written
anywhere but this run's own proposal artifacts.

Public text must never carry a local artifact path, a run id, or this
machine's checkout path: only repo-relative evidence citations, forge URLs
and numbers, and the discoveries' own title/claim/rationale text reach
discovery-proposals.md and discovery-proposals.json.
"""

import hashlib
import json
import os
import re
import subprocess
import sys

VALID_CLASSIFICATIONS = {"stale", "duplicate", "update-existing", "new"}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def read_json_array(path: str, label: str) -> list:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except OSError as err:
        fail(f"render: could not read {label} ({err}).")
    except ValueError as err:
        fail(f"render: {label} is not valid JSON ({err}).")
    if not isinstance(data, list):
        fail(f"render: {label} must be a JSON array.")
    return data


def parse_json_array_env(name: str, label: str) -> list:
    raw = os.environ.get(name, "")
    try:
        data = json.loads(raw) if raw else []
    except ValueError as err:
        fail(f"render: {label} is not valid JSON ({err}).")
    if not isinstance(data, list):
        fail(f"render: {label} must be a JSON array.")
    return data


def by_item_index(records: list) -> dict:
    return {r.get("item_index"): r for r in records if isinstance(r, dict)}


def repo_identity(forge_host: str, forge_path: str) -> str:
    if forge_host and forge_path:
        return f"{forge_host}/{forge_path}"
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown-repository"
    if result.returncode != 0 or not result.stdout.strip():
        return "unknown-repository"
    return os.path.basename(result.stdout.strip().rstrip("/\\")) or "unknown-repository"


def stable_key(title: str) -> str:
    return re.sub(r"\s+", " ", title.strip().lower())


def compute_marker(identity: str, title: str) -> str:
    return hashlib.sha256(f"{identity}:{stable_key(title)}".encode("utf-8")).hexdigest()


def check_tuple(index: int, title: str, classification: str, still_valid: bool, matches: list, target_item: object) -> None:
    if classification not in VALID_CLASSIFICATIONS:
        fail(f"render: item {index} ('{title}') has an unrecognized classification '{classification}'.")
    if classification == "stale" and still_valid:
        fail(
            f"render: item {index} ('{title}') is classified 'stale' but evidence-check.json "
            "marked it still_valid - a stale item must have failed revalidation or evidence "
            "verification."
        )
    if classification != "stale" and not still_valid:
        fail(
            f"render: item {index} ('{title}') is classified '{classification}' but "
            "evidence-check.json marked it not still_valid - unverified evidence must not "
            "become proved work of any classification other than 'stale'."
        )
    if classification == "new" and matches:
        fail(
            f"render: item {index} ('{title}') is classified 'new' but search-existing named "
            "a match for it - classify it 'duplicate' or 'update-existing' instead, or drop "
            "the match if it is not actually related."
        )
    if classification in ("duplicate", "update-existing"):
        if not isinstance(target_item, dict) or not target_item.get("number"):
            fail(
                f"render: item {index} ('{title}') is classified '{classification}' but has no "
                "target_item naming the existing work it refers to."
            )
        match_numbers = {m.get("number") for m in matches if isinstance(m, dict)}
        if target_item.get("number") not in match_numbers:
            fail(
                f"render: item {index} ('{title}') names target_item #{target_item.get('number')} "
                "which does not appear in search-existing's matches for it."
            )


def render_markdown(rows: list, forge_available: bool) -> str:
    lines = [
        "# Discovery Proposals",
        "",
        "This is a read-only proposal. No tracker item was created, updated, or "
        "closed by this run.",
        "",
    ]
    if not forge_available:
        lines += [
            "No forge was reachable from this checkout, so every proposal below is "
            "local only: publication is unavailable until a later, separate, gated "
            "workflow runs against a configured forge.",
            "",
        ]
    for label, heading in (
        ("new", "New"),
        ("update-existing", "Update existing"),
        ("duplicate", "Duplicate"),
        ("stale", "Stale"),
    ):
        group = [r for r in rows if r["classification"] == label]
        if not group:
            continue
        lines.append(f"## {heading} ({len(group)})")
        lines.append("")
        for row in group:
            lines.append(f"### {row['title']}")
            lines.append("")
            lines.append(row["rationale"])
            if row["evidence_refs"]:
                lines.append("")
                lines.append("Evidence:")
                for ref in row["evidence_refs"]:
                    lines.append(f"- `{ref['path']}:{ref['line']}`")
            if row["target_item"]:
                lines.append("")
                lines.append(f"Related: {row['target_item']['url']}")
            if row["marker"]:
                lines.append("")
                lines.append(f"Marker: `{row['marker']}`")
            lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    artifacts = os.environ["ARTIFACTS_DIR"]
    forge_host = os.environ.get("INPUTS_FORGE_HOST", "")
    forge_path = os.environ.get("INPUTS_FORGE_PATH", "")

    normalized = by_item_index(
        read_json_array(os.path.join(artifacts, "discoveries", "normalized.json"), "discoveries/normalized.json")
    )
    evidence_check = by_item_index(
        read_json_array(os.path.join(artifacts, "evidence-check.json"), "evidence-check.json")
    )
    search_results = by_item_index(
        parse_json_array_env("INPUTS_SEARCH_RESULTS", "search-existing's output")
    )
    classification = by_item_index(
        parse_json_array_env("INPUTS_CLASSIFICATION", "classify's output")
    )

    expected = set(normalized.keys())
    for label, mapping in (
        ("evidence-check.json", evidence_check),
        ("search-existing's output", search_results),
        ("classify's output", classification),
    ):
        if set(mapping.keys()) != expected:
            fail(
                f"render: {label} does not cover the same item_index set as "
                f"discoveries/normalized.json (expected {sorted(expected)}, got {sorted(mapping.keys())})."
            )

    identity = repo_identity(forge_host, forge_path)
    counts = {"stale": 0, "duplicate": 0, "update-existing": 0, "new": 0}
    rows = []
    for index in sorted(expected):
        title = normalized[index]["title"]
        classified = classification[index]
        cls = str(classified.get("classification") or "")
        still_valid = bool(evidence_check[index].get("still_valid"))
        matches = [m for m in (search_results[index].get("matches") or []) if isinstance(m, dict)]
        target_item = classified.get("target_item")

        check_tuple(index, title, cls, still_valid, matches, target_item)
        counts[cls] = counts.get(cls, 0) + 1

        rows.append(
            {
                "item_index": index,
                "title": title,
                "classification": cls,
                "evidence_refs": evidence_check[index].get("evidence_refs") or [],
                "target_item": target_item,
                "marker": None if cls == "stale" else compute_marker(identity, title),
                "rationale": str(classified.get("rationale") or ""),
            }
        )

    with open(
        os.path.join(artifacts, "discovery-proposals.json"), "w", encoding="utf-8", newline="\n"
    ) as f:
        json.dump(rows, f, indent=2)
    with open(
        os.path.join(artifacts, "discovery-proposals.md"), "w", encoding="utf-8", newline="\n"
    ) as f:
        f.write(render_markdown(rows, forge_available=bool(forge_host and forge_path)))

    print(
        json.dumps(
            {
                "count": len(rows),
                "stale_count": counts["stale"],
                "duplicate_count": counts["duplicate"],
                "update_existing_count": counts["update-existing"],
                "new_count": counts["new"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
