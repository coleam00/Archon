"""Choose what this lifecycle run works on.

An explicit target wins unchanged. With none, this is the factory's backlog
intake: the oldest open issue in the origin repository that no earlier run has
touched — no `archon-*` state label (triage publishes one when the caller sets
publish=true) and no open pull request that names it. Nothing found completes
the run with nothing to do, which is a fact, not a failure. Deterministic gh
reads only; the judgment about the issue belongs to triage.
"""

import json
import os
import re
import subprocess
import sys


def gh(*args: str):
    out = subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else []


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    explicit = os.environ.get("INPUTS_TARGET", "").strip()
    if explicit:
        print(json.dumps({"target": explicit, "found": True, "selected": False, "reason": "explicit target"}))
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
        if any(name.startswith("archon-") for name in labels):
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
