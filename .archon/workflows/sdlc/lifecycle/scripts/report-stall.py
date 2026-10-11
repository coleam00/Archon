"""Make a stalled backlog visible instead of a quiet "nothing to do".

Runs when intake found no work. With no open issues the backlog is done and this
reports so. With open issues the lifecycle cannot advance on its own: every issue
is claimed, waiting on an open dependency, or carries a state label only a human
or another workflow clears. Then this step:

- leaves one `<!-- archon-stall -->` comment on each root blocker intake named,
  updated in place on later ticks, so its owner hears about it once instead of
  every tick;
- fails the run when `stall_fail` is "true" (the default), so a schedule shows a
  failed run rather than a completed one that did nothing.

Deterministic gh reads and comment writes only; it changes no labels or code.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

STALL_MARKER = "<!-- archon-stall -->"


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout.strip()


def upsert(repo: str, number: int, body: str) -> str:
    pages = json.loads(gh("api", f"repos/{repo}/issues/{number}/comments?per_page=100", "--paginate",
                          "--slurp") or "[]")
    comments = [comment for page in pages for comment in page] if pages and isinstance(pages[0], list) else pages
    existing = next((c for c in comments if str(c.get("body") or "").lstrip().startswith(STALL_MARKER)), None)
    if existing:
        gh("api", f"repos/{repo}/issues/comments/{existing['id']}", "--method", "PATCH", "-f", f"body={body}")
        return "updated"
    gh("api", f"repos/{repo}/issues/{number}/comments", "--method", "POST", "-f", f"body={body}")
    return "posted"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    intake = json.loads(os.environ.get("INPUTS_INTAKE", "") or "{}")
    fail = os.environ.get("INPUTS_STALL_FAIL", "true").strip().lower() != "false"
    open_issues = int(intake.get("open_issues") or 0)
    waiting_on = [int(n) for n in intake.get("waiting_on") or []]
    reason = str(intake.get("reason") or "")
    if open_issues == 0 and not waiting_on:
        print(json.dumps({"stalled": False, "notified": [], "summary": "backlog is empty"}))
        return 0
    notified = []
    if waiting_on:
        # gh resolves {owner}/{repo} from the checkout it runs in.
        repo = "{owner}/{repo}"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        run_id = os.environ.get("WORKFLOW_ID", "")
        for number in waiting_on:
            body = (f"{STALL_MARKER}\nThe automatic backlog is stalled behind #{number}: "
                    f"{open_issues} open issue(s), and intake found nothing else it can start "
                    f"({reason}). Finishing, closing or unblocking #{number} lets the queue move. "
                    f"Last checked {now}{(' by run ' + run_id) if run_id else ''}.")
            upsert(repo, number, body)
            notified.append(number)
    summary = (f"stalled: {reason}" if waiting_on else
               f"stalled: {open_issues} open issue(s), every one claimed or labeled for a human ({reason})")
    print(json.dumps({"stalled": True, "notified": notified, "summary": summary}))
    if fail:
        print(summary, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or ""
        print(f"report-stall: {error} {detail}".strip(), file=sys.stderr)
        sys.exit(1)
