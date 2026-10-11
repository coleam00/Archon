"""Put this run's checkout on an unfinished pull request and decide how to finish it.

Intake returned `kind: pr`: a pull request an earlier run delivered that never
merged. This step records the attempt on the pull request first (a re-drive
comment, which intake counts against `redrive_limit`, so a crash still counts),
then checks out the pull request's own branch in this run's checkout and routes:

- `deliver` when the pull request is a draft (its delivery never finished) or
  conflicts with its base: an agent must resolve or complete it, so the caller
  hands it to a repair delivery on this branch;
- `verify` when it is ready and merges cleanly. A branch behind its base is
  brought up to date here with `git merge` and a plain push (never a rebase or
  force push); a merge that unexpectedly conflicts is aborted and routed to
  `deliver` instead. The caller then re-validates and re-verifies the new head.

It judges nothing about the code. Deterministic gh and git only.
"""

import json
import os
import re
import subprocess
import sys

REDRIVE_MARKER = "<!-- archon-redrive -->"
PR_URL = re.compile(r"https?://[^\s/]+/(?P<repo>[\w.-]+/[\w.-]+)/pull/(?P<number>\d+)")


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(list(args), check=check, capture_output=True, text=True)


def out(*args: str) -> str:
    return run(*args).stdout.strip()


def result(adopted: bool, reason: str, **fields) -> int:
    print(json.dumps({"adopted": adopted, "route": fields.get("route", ""),
                      "pr": fields.get("pr", ""), "number": fields.get("number", 0),
                      "branch": fields.get("branch", ""), "base": fields.get("base", ""),
                      "head": fields.get("head", ""), "attempt": fields.get("attempt", 0),
                      "reason": reason}))
    return 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    url = os.environ.get("INPUTS_PR", "").strip()
    match = PR_URL.fullmatch(url)
    if not match:
        return result(False, f"not a pull request URL: {url!r}")
    repo, number = match.group("repo"), int(match.group("number"))
    limit = int(os.environ.get("INPUTS_REDRIVE_LIMIT", "").strip() or "2")
    pr = json.loads(out("gh", "pr", "view", url, "--json",
                        "state,isDraft,isCrossRepository,headRefName,baseRefName,"
                        "mergeStateStatus,comments"))
    if pr.get("state") != "OPEN" or pr.get("isCrossRepository"):
        return result(False, f"#{number} is not an open pull request from {repo}", pr=url, number=number)
    attempt = 1 + sum(str(c.get("body") or "").lstrip().startswith(REDRIVE_MARKER)
                      for c in pr.get("comments") or [] if isinstance(c, dict))
    if attempt > limit:
        return result(False, f"#{number} already had {attempt - 1} re-drive(s)", pr=url, number=number)
    branch, base = pr.get("headRefName") or "", pr.get("baseRefName") or ""
    run_id = os.environ.get("WORKFLOW_ID", "")
    note = (f"{REDRIVE_MARKER}\nRe-drive {attempt} of {limit}: this pull request was delivered "
            f"but never merged, so a lifecycle run{(' (' + run_id + ')') if run_id else ''} "
            f"is bringing it up to date with `{base}` and finishing it.")
    out("gh", "api", f"repos/{repo}/issues/{number}/comments", "--method", "POST", "-f", f"body={note}")

    out("git", "fetch", "--quiet", "origin", branch, base)
    # An earlier run's worktree may still have this branch checked out; it is idle.
    out("git", "checkout", "--quiet", "--ignore-other-worktrees", "-B", branch, f"origin/{branch}")
    fields = {"pr": url, "number": number, "branch": branch, "base": base, "attempt": attempt}
    if pr.get("isDraft"):
        return result(True, f"#{number} is a draft: its delivery never finished",
                      route="deliver", head=out("git", "rev-parse", "HEAD"), **fields)
    if pr.get("mergeStateStatus") == "DIRTY":
        return result(True, f"#{number} conflicts with {base}",
                      route="deliver", head=out("git", "rev-parse", "HEAD"), **fields)
    behind = run("git", "merge-base", "--is-ancestor", f"origin/{base}", "HEAD", check=False).returncode != 0
    if behind:
        merged = run("git", "merge", "--no-edit", f"origin/{base}", check=False)
        if merged.returncode != 0:
            run("git", "merge", "--abort", check=False)
            return result(True, f"#{number} conflicts with {base} when merged locally",
                          route="deliver", head=out("git", "rev-parse", "HEAD"), **fields)
        out("git", "push", "--quiet", "origin", f"HEAD:refs/heads/{branch}")
    head = out("git", "rev-parse", "HEAD")
    reason = f"#{number} merged {base} in and pushed" if behind else f"#{number} is up to date with {base}"
    return result(True, reason, route="verify", head=head, **fields)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or ""
        print(f"adopt-pr: {error} {detail}".strip(), file=sys.stderr)
        sys.exit(1)
