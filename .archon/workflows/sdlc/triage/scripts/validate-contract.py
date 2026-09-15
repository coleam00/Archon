"""Validate the judgment, then optionally map, publish, and verify labels."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit


STATE_LABEL_METADATA = {
    "READY": ("0e8a16", "Contract is ready for engineering"),
    "NEEDS_CONTRACT_WORK": ("d93f0b", "Contract needs work"),
    "DESIGN_FIRST": ("fbca04", "Engineering shape needs design"),
    "BLOCKED": ("b60205", "Unresolved dependency or decision"),
    "NO_ACTION": ("cfd3d7", "A human should consider closing"),
}
ROUTES = ("investigate", "plan", "deliver", "no_action")
CONTRACTS = tuple(key for key in STATE_LABEL_METADATA if key != "DESIGN_FIRST")
COMPLEXITIES = ("small_bounded", "risky", "large")


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def qualified_url(value) -> bool:
    if not isinstance(value, str) or any(c.isspace() for c in value):
        return False
    url = urlsplit(value)
    return url.scheme in ("http", "https") and bool(url.hostname) and not url.username and not url.password


def parse_state_labels(raw: str) -> dict[str, str]:
    value = json.loads(raw)
    require(isinstance(value, dict), "state_labels must be a JSON object")
    require(all(key in STATE_LABEL_METADATA for key in value),
            "state_labels contains an unsupported state")
    require(all(isinstance(label, str) and label.strip() == label and 0 < len(label) <= 50
                and not any(ord(char) < 32 for char in label) for label in value.values()),
            "state_labels values must be non-empty GitHub label names")
    folded = [label.casefold() for label in value.values()]
    require(len(folded) == len(set(folded)),
            "state_labels must not map multiple states to the same label")
    return value


def selected_state(triage: dict) -> str:
    return "DESIGN_FIRST" if triage.get("design_first") else triage["contract"]


def validate(triage: dict, artifacts: str, state_labels: dict[str, str]) -> None:
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
    owned = {label.casefold() for label in state_labels.values()}
    require(not any(label.casefold() in owned for label in labels),
            "the triage agent must not propose caller-owned state labels")
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


def publish(triage: dict, state_labels: dict[str, str]) -> dict:
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
    existing_folded = {name.casefold() for name in existing}
    for state, name in state_labels.items():
        color, description = STATE_LABEL_METADATA[state]
        if name.casefold() not in existing_folded:
            gh(["api", "--hostname", "github.com", f"repos/{repo}/labels", "--method", "POST", "--input", "-"],
               {"name": name, "color": color, "description": description})
    accepted = [label for label in triage["labels"] if label in existing]
    state_label = state_labels.get(selected_state(triage))
    if state_label is not None:
        accepted.append(state_label)
    owned = {label.casefold() for label in state_labels.values()}
    current_folded = {label.casefold() for label in current}
    additions = {label for label in accepted if label.casefold() not in current_folded}
    if additions:
        # Narrow mutations preserve unrelated labels added since the read.
        gh(["api", "--hostname", "github.com", f"{endpoint}/labels", "--method", "POST", "--input", "-"],
           {"labels": sorted(additions)})
    desired_owned = set() if state_label is None else {state_label.casefold()}
    for label in sorted(label for label in current
                        if label.casefold() in owned and label.casefold() not in desired_owned):
        gh(["api", "--hostname", "github.com", f"{endpoint}/labels/{quote(label, safe='')}", "--method", "DELETE"])
    actual = read_issue(endpoint, triage)
    actual_folded = {label.casefold() for label in actual}
    unrelated = {label.casefold() for label in current if label.casefold() not in owned}
    require(unrelated <= actual_folded
            and {label.casefold() for label in accepted} <= actual_folded
            and {label.casefold() for label in actual if label.casefold() in owned} == desired_owned,
            "label read-back mismatch: proposed or unrelated labels missing, or stale owned labels remain; writes may have completed")
    return {"published": True, "applied_labels": accepted,
            "skipped_labels": [label for label in triage["labels"] if label not in accepted]}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    try:
        triage = json.loads(os.environ["INPUTS_TRIAGE"])
        state_labels = parse_state_labels(os.environ.get("INPUTS_STATE_LABELS", "{}"))
        validate(triage, os.environ["ARTIFACTS_DIR"], state_labels)
        enabled = os.environ.get("INPUTS_PUBLISH", "false")
        require(enabled in ("true", "false"), "publish must be true or false")
        triage["publication"] = (publish(triage, state_labels) if enabled == "true" else
                                 {"published": False, "applied_labels": [], "skipped_labels": []})
        mapped = state_labels.get(selected_state(triage))
        if mapped is not None:
            triage["labels"].append(mapped)
        print(json.dumps(triage, separators=(",", ":")))
        return 0
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
        print(f"validate-contract: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
