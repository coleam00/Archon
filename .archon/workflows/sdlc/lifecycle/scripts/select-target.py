"""Choose what this lifecycle run works on.

An explicit target wins unchanged. With none, choose the oldest open issue with
none of the caller-configured state labels and no open pull request naming it.
Without every state label automatic intake stops safely because it cannot
distinguish all touched work. Deterministic gh reads only; judgment belongs to
triage.
"""

import json
import os
import re
import subprocess
import sys


STATES = {"READY", "DESIGN_FIRST", "NEEDS_CONTRACT_WORK", "BLOCKED", "NO_ACTION"}


def gh(*args: str):
    out = subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else []


def state_labels() -> tuple[set[str], bool]:
    value = json.loads(os.environ.get("INPUTS_STATE_LABELS", "{}"))
    if not isinstance(value, dict) or any(key not in STATES for key in value):
        raise ValueError("state_labels must be a JSON object with supported state keys")
    labels = list(value.values())
    if any(not isinstance(label, str) or not label or label.strip() != label or len(label) > 50
           or any(ord(char) < 32 for char in label)
           for label in labels):
        raise ValueError("state_labels values must be non-empty GitHub label names")
    folded = {label.casefold() for label in labels}
    if len(folded) != len(labels):
        raise ValueError("state_labels must not map multiple states to the same label")
    return folded, set(value) == STATES


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    owned_labels, complete_mapping = state_labels()
    explicit = os.environ.get("INPUTS_TARGET", "").strip()
    if explicit:
        print(json.dumps({"target": explicit, "found": True, "selected": False, "reason": "explicit target"}))
        return 0
    if not complete_mapping:
        print(json.dumps({"target": "", "found": False, "selected": True,
                          "reason": "automatic intake requires state_labels for every state"}))
        return 0
    issues = gh("issue", "list", "--state", "open", "--limit", "100",
                "--json", "number,url,labels,createdAt")
    prs = gh("pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,body")
    referenced = set()
    for pr in prs:
        for match in re.findall(r"#(\d+)", f"{pr.get('title', '')}\n{pr.get('body', '')}"):
            referenced.add(int(match))
    candidates = []
    for issue in issues:
        labels = {label.get("name", "") for label in issue.get("labels", [])}
        if any(name.casefold() in owned_labels for name in labels):
            continue
        if issue["number"] in referenced:
            continue
        candidates.append(issue)
    if not candidates:
        print(json.dumps({"target": "", "found": False, "selected": True,
                          "reason": f"{len(issues)} open issue(s), none untouched"}))
        return 0
    chosen = min(candidates, key=lambda issue: issue["number"])
    print(json.dumps({"target": chosen["url"], "found": True, "selected": True,
                      "reason": f"oldest untouched open issue of {len(candidates)}"}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"select-target: {error}", file=sys.stderr)
        sys.exit(1)
