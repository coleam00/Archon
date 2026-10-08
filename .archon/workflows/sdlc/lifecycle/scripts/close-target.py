"""Close the issue this lifecycle run worked once its pull requests have merged.

A pull request that says `Relates to #N` leaves issue N open when it merges, and
every issue whose backlog says `Depends on: #N` then waits on it forever. The
lifecycle chose this issue and delivered these pull requests for it, so after
the merge queue reports a merge this step reads both facts back from GitHub:
every pull request must be merged, and the issue must still be open. Only then
does it close the issue, with a comment naming the pull requests.

Targets that are not an issue reference (a free-text work order, a pull request)
are left alone. Deterministic gh reads and one write; no judgment.
"""

import json
import os
import re
import subprocess
import sys


ISSUE_URL = re.compile(r"^https?://[^\s/]+/(?P<repo>[\w.-]+/[\w.-]+)/issues/(?P<number>\d+)/?$")
SHORT = re.compile(r"^(?:(?P<repo>[\w.-]+/[\w.-]+))?#?(?P<number>\d+)$")


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def issue_reference(target: str) -> list[str] | None:
    """gh arguments naming the target issue, or None when the target is not one."""
    match = ISSUE_URL.match(target)
    if match:
        return [match.group("number"), "--repo", match.group("repo")]
    match = SHORT.match(target)
    if match:
        return [match.group("number"), *(["--repo", match.group("repo")] if match.group("repo") else [])]
    return None


def result(closed: bool, reason: str) -> int:
    print(json.dumps({"closed": closed, "reason": reason}))
    return 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    target = os.environ.get("INPUTS_TARGET", "").strip()
    prs = json.loads(os.environ.get("INPUTS_PRS", "[]") or "[]")
    if not isinstance(prs, list) or not all(isinstance(pr, str) and pr for pr in prs):
        raise ValueError("prs must be a JSON array of pull request URLs")
    issue = issue_reference(target)
    if issue is None:
        return result(False, "target is not an issue reference")
    if not prs:
        return result(False, "no pull requests were delivered for this issue")
    unmerged = [pr for pr in prs
                if json.loads(gh("pr", "view", pr, "--json", "state")).get("state") != "MERGED"]
    if unmerged:
        return result(False, "not every pull request is merged: " + ", ".join(unmerged))
    state = json.loads(gh("issue", "view", *issue, "--json", "state")).get("state")
    if state != "OPEN":
        return result(False, "issue is already closed")
    gh("issue", "close", *issue, "--comment",
       "Closed after its delivered pull request(s) merged: " + ", ".join(prs) + ". "
       "Remaining work belongs in a new issue.")
    return result(True, "closed after " + ", ".join(prs) + " merged")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or ""
        print(f"close-target: {error} {detail}".strip(), file=sys.stderr)
        sys.exit(1)
