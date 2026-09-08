"""Validate the triage verdict before it routes work, and apply its labels.

The prompt judges; this boundary verifies. It refuses a tuple that breaks the
pack's invariant (only a READY contract carries an engineering route, and
design-first is a READY item routed to plan), derives the pack's own labels from
the declared fields, and, only when the run was launched with publish=true and
the target is a tracker issue, applies them and reads them back. Area labels are
never created: the prompt may only pick labels the repository already has.
"""

import json
import os
import subprocess
import sys

CONTRACTS = ("READY", "NEEDS_CONTRACT_WORK", "BLOCKED", "NO_ACTION")
ROUTES = ("investigate", "plan", "deliver", "no_action")
COMPLEXITIES = ("small", "risky", "large")

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
    "archon-needs-contract": ("D93F0B", "Triage: problem, why, outcome, or acceptance is missing"),
    "archon-blocked": ("B60205", "Triage: a prerequisite or human decision must land first"),
    "archon-close": ("6A737D", "Triage: already delivered, duplicate, obsolete, or out of direction"),
    "archon-design-first": ("5319E7", "Triage: settle the engineering shape before implementing"),
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


def gh(*args: str) -> str:
    result = subprocess.run(["gh", *args], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])} failed: {result.stderr.strip()}")
    return result.stdout


def existing_labels(repository: str) -> set[str]:
    rows = json.loads(gh("label", "list", "--repo", repository, "--limit", "500", "--json", "name"))
    return {row["name"] for row in rows}


def apply(repository: str, number: int, wanted: list[str], area: list[str]) -> list[str]:
    present = existing_labels(repository)
    for name in wanted:
        if name not in present:
            color, description = PACK_LABELS[name]
            gh("label", "create", name, "--repo", repository, "--color", color, "--description", description)
    area_present = [name for name in area if name in present]
    current = {
        row["name"]
        for row in json.loads(gh("issue", "view", str(number), "--repo", repository, "--json", "labels", "--jq", ".labels"))
    }
    stale = sorted(name for name in current if name in PACK_LABELS and name not in wanted)
    to_add = sorted(set(wanted + area_present) - current)
    args = ["issue", "edit", str(number), "--repo", repository]
    for name in to_add:
        args += ["--add-label", name]
    for name in stale:
        args += ["--remove-label", name]
    if to_add or stale:
        gh(*args)
    after = {
        row["name"]
        for row in json.loads(gh("issue", "view", str(number), "--repo", repository, "--json", "labels", "--jq", ".labels"))
    }
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
    edits_proposed = os.environ.get("INPUTS_EDITS_PROPOSED", "") == "true"
    publish = os.environ.get("INPUTS_PUBLISH", "") == "true"
    summary = os.environ.get("INPUTS_SUMMARY", "")
    area = parse_json_input(os.environ.get("INPUTS_AREA_LABELS", ""), [])
    item = parse_json_input(os.environ.get("INPUTS_ITEM", ""), None)
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
    if contract == "NEEDS_CONTRACT_WORK" and not edits_proposed:
        return fail("NEEDS_CONTRACT_WORK requires a proposed contract in the assessment")
    if not summary.strip():
        return fail("summary is empty")
    if not isinstance(area, list) or any(not isinstance(name, str) or not name for name in area):
        return fail("area_labels must be a list of label names")
    if item is not None and (
        not isinstance(item, dict)
        or not isinstance(item.get("repository"), str)
        or "/" not in item["repository"]
        or not isinstance(item.get("number"), int)
        or item["number"] <= 0
    ):
        return fail("item must be null or {repository: owner/repo, number: N}")

    labels = [STATE_LABEL[contract], COMPLEXITY_LABEL[complexity]]
    if design_first:
        labels.append(DESIGN_FIRST_LABEL)

    published = False
    applied: list[str] = []
    if publish and item is not None:
        try:
            applied = apply(item["repository"], item["number"], labels, area)
        except RuntimeError as err:
            print(f"label publication failed: {err}", file=sys.stderr)
            return 1
        published = True

    print(
        json.dumps(
            {
                "contract": contract,
                "route": route,
                "ready": contract == "READY",
                "design_first": design_first,
                "complexity": complexity,
                "labels": applied if published else sorted(set(labels + area)),
                "published": published,
                "edits_proposed": edits_proposed,
                "summary": summary,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
