"""Bind the pull request a delivery handed back, from facts only.

The delivery is either ship's return (`delivered` and a summary whose first token
is the pull request URL that deliver's flip certified) or a repair delivery's
return (`pr_url`). Deliver reaches that flip only after its review-ready and
validation-green gates, so a delivered URL already implies both ran; this step
checks that their reports exist in this run and that GitHub and git agree on
what was delivered:

- the URL is a GitHub pull request, open, not a draft, from this repository;
- its head branch is this checkout's branch and its head commit is git HEAD.

Anything else is delivered=false: a declined triage, no pull request, or identity
or evidence that does not line up. Deterministic gh and git reads; no judgment.
"""

import json
import os
import re
import subprocess
import sys

PR_URL = re.compile(r"https?://[^\s/]+/[\w.-]+/[\w.-]+/pull/\d+")
EVIDENCE = ("review/report.md", "validation.md")


def run(*args: str) -> str:
    return subprocess.run(list(args), check=True, capture_output=True, text=True).stdout.strip()


def result(delivered: bool, reason: str, prs: list[str] | None = None, head: str = "") -> int:
    print(json.dumps({"delivered": delivered, "prs": prs or [], "head": head, "reason": reason}))
    return 0


def delivered_url(delivery: dict) -> str:
    if "pr_url" in delivery:
        return str(delivery.get("pr_url") or "").strip()
    if delivery.get("delivered") is not True:
        return ""
    summary = str(delivery.get("summary") or "").strip()
    first = summary.split()[0] if summary else ""
    return first if PR_URL.fullmatch(first) else ""


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    delivery = json.loads(os.environ.get("INPUTS_DELIVERY", "") or "null")
    if not isinstance(delivery, dict):
        return result(False, "no delivery result")
    url = delivered_url(delivery)
    if not PR_URL.fullmatch(url):
        return result(False, "the delivery handed back no pull request")
    artifacts = os.environ.get("ARTIFACTS_DIR", "")
    missing = [name for name in EVIDENCE
               if not artifacts or not os.path.isfile(os.path.join(artifacts, name))
               or os.path.getsize(os.path.join(artifacts, name)) == 0]
    if missing:
        return result(False, "this run has no " + " or ".join(missing))
    pr = json.loads(run("gh", "pr", "view", url, "--json",
                        "state,isDraft,isCrossRepository,headRefName,headRefOid"))
    head = run("git", "rev-parse", "HEAD")
    branch = run("git", "branch", "--show-current")
    if pr.get("state") != "OPEN" or pr.get("isDraft"):
        return result(False, f"{url} is not an open ready pull request")
    if pr.get("isCrossRepository"):
        return result(False, f"{url} comes from another repository")
    if pr.get("headRefName") != branch or pr.get("headRefOid") != head:
        return result(False, f"{url} head {pr.get('headRefName')}@{pr.get('headRefOid')} "
                             f"is not this checkout's {branch}@{head}")
    return result(True, f"{url} at {head}", [url], head)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or ""
        print(f"bind-delivered-pr: {error} {detail}".strip(), file=sys.stderr)
        sys.exit(1)
