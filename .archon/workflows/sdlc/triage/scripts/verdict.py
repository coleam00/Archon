"""Validate the triage verdict before it routes work, and apply its labels.

The prompt judges; this boundary verifies. It refuses a tuple that breaks the
pack's invariants (only a READY contract carries an engineering route,
design-first is a READY item routed to plan, only NEEDS_CONTRACT_WORK proposes
edits, only BLOCKED names blockers), derives the pack's own labels from the
declared fields, and, only when the run was launched with publish=true and the
target is a tracker issue, verifies the item's identity on the tracker, applies
the labels, and reads them back. Area labels are never created: the prompt may
only pick labels the repository already has. gh is the interim transport; the
forge contract's work-item operation is the intended owner.
"""

import json
import os
import subprocess
import sys
from urllib.parse import urlsplit

CONTRACTS = ("READY", "NEEDS_CONTRACT_WORK", "BLOCKED", "NO_ACTION")
ROUTES = ("investigate", "plan", "deliver", "no_action")
COMPLEXITIES = ("small", "risky", "large")

# Exactly one state label per item. Design-first is READY whose next step is
# design, so it replaces the ready label rather than sitting beside it.
STATE_LABEL = {
    "READY": "archon-ready",
    "NEEDS_CONTRACT_WORK": "archon-needs-contract",
    "BLOCKED": "archon-blocked",
    "NO_ACTION": "archon-close",
}
DESIGN_FIRST_LABEL = "archon-design-first"
COMPLEXITY_LABEL = {"small": "archon-small", "risky": "archon-risky", "large": "archon-large"}
PACK_LABELS = {
    "archon-ready": ("0E8A16", "Triage: the contract is ready for a run"),
    "archon-needs-contract": ("D93F0B", "Triage: one of the contract's six elements is missing"),
    "archon-blocked": ("B60205", "Triage: a prerequisite or human decision must land first"),
    "archon-close": ("6A737D", "Triage: already delivered, duplicate, obsolete, or out of direction"),
    "archon-design-first": ("5319E7", "Triage: ready, but settle the engineering shape before implementing"),
    "archon-small": ("C2E0C6", "Triage: bounded change"),
    "archon-risky": ("FBCA04", "Triage: touches auth, data, a destructive path, or a compatibility boundary"),
    "archon-large": ("F9D0C4", "Triage: several packages or schemas, or an unsettled shape"),
}


def fail(message: str) -> int:
    print(f"invalid triage verdict: {message}", file=sys.stderr)
    return 1


def parse_json_input(raw: str, default):
    raw = raw.strip()
    if raw in ("", "null"):
        return default
    if raw[0] in "[{":
        return json.loads(raw)
    return default


def qualified_url(value) -> bool:
    if not isinstance(value, str) or not value or any(c.isspace() for c in value):
        return False
    url = urlsplit(value)
    return url.scheme in ("http", "https") and bool(url.hostname)


def gh(*args: str) -> str:
    result = subprocess.run(["gh", *args], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])} failed: {result.stderr.strip()}")
    return result.stdout


def existing_labels(repository: str) -> set[str]:
    rows = json.loads(gh("label", "list", "--repo", repository, "--limit", "500", "--json", "name"))
    return {row["name"] for row in rows}


def read_issue(repository: str, number: int) -> set[str]:
    """The item's current labels, after proving the number names the issue the prompt declared."""
    issue = json.loads(gh("api", f"repos/{repository}/issues/{number}"))
    url = f"https://github.com/{repository}/issues/{number}"
    if (
        not isinstance(issue, dict)
        or issue.get("number") != number
        or str(issue.get("html_url", "")).lower() != url.lower()
        or "pull_request" in issue
    ):
        raise RuntimeError(f"tracker identity mismatch: {url} is not the issue the verdict names")
    return {row["name"] for row in issue.get("labels", [])}


def apply(repository: str, number: int, wanted: list[str], area: list[str]) -> list[str]:
    current = read_issue(repository, number)
    present = existing_labels(repository)
    for name in wanted:
        if name not in present:
            color, description = PACK_LABELS[name]
            gh("label", "create", name, "--repo", repository, "--color", color, "--description", description)
    area_present = [name for name in area if name in present]
    stale = sorted(name for name in current if name in PACK_LABELS and name not in wanted)
    to_add = sorted(set(wanted + area_present) - current)
    # Narrow add and remove operations, never a whole-set write, so labels an
    # operator adds concurrently survive.
    args = ["issue", "edit", str(number), "--repo", repository]
    for name in to_add:
        args += ["--add-label", name]
    for name in stale:
        args += ["--remove-label", name]
    if to_add or stale:
        gh(*args)
    after = read_issue(repository, number)
    missing = [name for name in wanted + area_present if name not in after]
    lingering = [name for name in stale if name in after]
    if missing or lingering:
        raise RuntimeError(f"label read-back disagrees: missing={missing} lingering={lingering}")
    return sorted(set(wanted + area_present))


def main() -> int:
    contract = os.environ.get("INPUTS_CONTRACT", "")
    route = os.environ.get("INPUTS_ROUTE", "")
    complexity = os.environ.get("INPUTS_COMPLEXITY", "")
    design_first = os.environ.get("INPUTS_DESIGN_FIRST", "") == "true"
    publish = os.environ.get("INPUTS_PUBLISH", "") == "true"
    summary = os.environ.get("INPUTS_SUMMARY", "")
    blocked_reason = os.environ.get("INPUTS_BLOCKED_REASON", "")
    area = parse_json_input(os.environ.get("INPUTS_AREA_LABELS", ""), [])
    item = parse_json_input(os.environ.get("INPUTS_ITEM", ""), None)
    edits = parse_json_input(os.environ.get("INPUTS_PROPOSED_EDITS", ""), None)
    blocked_by = parse_json_input(os.environ.get("INPUTS_BLOCKED_BY", ""), [])
    if isinstance(item, dict) and not item.get("repository"):
        item = None

    if contract not in CONTRACTS:
        return fail(f"contract must be one of {CONTRACTS}, got {contract!r}")
    if route not in ROUTES:
        return fail(f"route must be one of {ROUTES}, got {route!r}")
    if complexity not in COMPLEXITIES:
        return fail(f"complexity must be one of {COMPLEXITIES}, got {complexity!r}")
    if (contract == "READY") != (route != "no_action"):
        return fail(
            "only a READY contract carries an engineering route: "
            f"got contract={contract!r} route={route!r}"
        )
    if design_first and route != "plan":
        return fail(f"design_first requires route=plan, got route={route!r}")
    if not isinstance(edits, dict) or any(not isinstance(edits.get(key), str) for key in ("title", "body")):
        return fail("proposed_edits must be an object with string title and body")
    if contract == "NEEDS_CONTRACT_WORK" and not (edits["title"].strip() and edits["body"].strip()):
        return fail("NEEDS_CONTRACT_WORK requires a proposed title and body")
    if contract != "NEEDS_CONTRACT_WORK" and (edits["title"] or edits["body"]):
        return fail("only NEEDS_CONTRACT_WORK proposes edits")
    if not isinstance(blocked_by, list) or any(not qualified_url(url) for url in blocked_by):
        return fail("blocked_by must be a list of fully qualified http(s) URLs")
    if contract == "BLOCKED" and not blocked_reason.strip():
        return fail("BLOCKED requires a blocked_reason")
    if contract != "BLOCKED" and (blocked_reason or blocked_by):
        return fail("only BLOCKED names a blocker")
    if not summary.strip():
        return fail("summary is empty")
    if not isinstance(area, list) or any(not isinstance(name, str) or not name for name in area):
        return fail("area_labels must be a list of label names")
    if any(name in PACK_LABELS for name in area):
        # The state and size labels are derived above; a pack label smuggled in as an
        # area label would be added beside the derived state or removed as stale.
        return fail("area_labels may not name a pack label; those derive from the verdict")
    if item is not None and (
        not isinstance(item, dict)
        or not isinstance(item.get("repository"), str)
        or "/" not in item["repository"]
        or not isinstance(item.get("number"), int)
        or item["number"] <= 0
    ):
        return fail("item must be null or {repository: owner/repo, number: N}")

    labels = [DESIGN_FIRST_LABEL if design_first else STATE_LABEL[contract]]
    # Size only matters on an item that can still be worked; a close verdict carries none.
    if contract != "NO_ACTION":
        labels.append(COMPLEXITY_LABEL[complexity])

    published = False
    if publish and item is not None:
        labels = apply(item["repository"], item["number"], labels, area)
        published = True
    else:
        labels = sorted(set(labels + area))

    print(
        json.dumps(
            {
                "contract": contract,
                "route": route,
                "ready": contract == "READY",
                "design_first": design_first,
                "complexity": complexity,
                "labels": labels,
                "published": published,
                "proposed_edits": {"title": edits["title"], "body": edits["body"]},
                "blocked_reason": blocked_reason,
                "blocked_by": blocked_by,
                "summary": summary,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
