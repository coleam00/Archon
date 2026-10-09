"""Refresh the facts for the next planned merge and return a typed request.

Reads the approved $ARTIFACTS_DIR/merge-plan.json and the previous loop result,
then re-reads GitHub for the next planned pull request. It authorizes the write
only while the plan still describes reality:

- the pull request is open, not a draft, from this repository, targeting the
  planned base, at exactly the planned head, and not in conflict;
- the live base branch head (the branch reference, never a pull request's
  base snapshot) equals the plan's base_sha before the first merge, and the
  previous merge's prior_base_sha after it;
- after an earlier merge moved the base, this pull request's head already
  contains the new base, so its validation covered the composition.

It never merges and never re-decides review or the required-check policy: the
assessment and the gate settled those for these pinned heads, and the
merge-action script owns the write boundary and checks this request against
the approved plan again. Deterministic gh reads only; no judgment.
"""

import json
import os
import subprocess
import sys
import time

BLOCKING_STATES = {"DIRTY", "BEHIND", "DRAFT", "UNKNOWN"}
UNKNOWN_READS = int(os.environ.get("REFRESH_UNKNOWN_READS", "6"))
UNKNOWN_WAIT_S = float(os.environ.get("REFRESH_UNKNOWN_WAIT_S", "5"))


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout.strip()


def emit(authorized: bool, summary: str, entry: dict | None = None, plan: dict | None = None) -> int:
    entry, plan = entry or {}, plan or {}
    print(json.dumps({
        "authorized": authorized,
        "repository": plan.get("repository", "") if authorized else "",
        "number": entry.get("number", 0) if authorized else 0,
        "head_sha": entry.get("head_sha", "") if authorized else "",
        "method": plan.get("method", "") if authorized else "",
        "summary": summary,
    }))
    return 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    with open(os.path.join(os.environ["ARTIFACTS_DIR"], "merge-plan.json"), encoding="utf-8") as handle:
        plan = json.load(handle)
    previous = json.loads(os.environ.get("INPUTS_PREVIOUS", "") or "null") or {}
    merged = [url for url in previous.get("urls") or [] if isinstance(url, str)]
    entries = plan.get("pull_requests") or []
    repository, base = plan.get("repository", ""), plan.get("base", "")
    if not entries or not repository or not base or not plan.get("base_sha"):
        return emit(False, "the approved merge plan is missing its repository, base or entries")
    if len(merged) >= len(entries):
        return emit(False, "every planned pull request is already merged")
    entry = entries[len(merged)]
    number = entry.get("number")
    expected_base = previous.get("prior_base_sha") if merged else plan["base_sha"]
    if not expected_base:
        return emit(False, "the previous merge left no base readback to compare against")

    live_base = gh("api", f"repos/{repository}/branches/{base}", "--jq", ".commit.sha")
    if live_base != expected_base:
        return emit(False, f"{base} moved from {expected_base} to {live_base} since "
                           + ("the last merge" if merged else "the assessment"))
    # GitHub computes mergeability lazily: a first read can say UNKNOWN.
    for attempt in range(UNKNOWN_READS):
        pr = json.loads(gh("pr", "view", str(number), "--repo", repository, "--json",
                           "state,isDraft,isCrossRepository,baseRefName,headRefOid,mergeStateStatus"))
        if pr.get("mergeStateStatus") != "UNKNOWN":
            break
        time.sleep(UNKNOWN_WAIT_S)
    if pr.get("state") != "OPEN" or pr.get("isDraft") or pr.get("isCrossRepository"):
        return emit(False, f"#{number} is no longer an open ready pull request from {repository}")
    if pr.get("baseRefName") != base:
        return emit(False, f"#{number} now targets {pr.get('baseRefName')}, not {base}")
    if pr.get("headRefOid") != entry.get("head_sha"):
        return emit(False, f"#{number} head moved from {entry.get('head_sha')} to {pr.get('headRefOid')}")
    if pr.get("mergeStateStatus") in BLOCKING_STATES:
        return emit(False, f"#{number} cannot merge as planned: GitHub reports {pr.get('mergeStateStatus')}")
    if merged:
        behind = gh("api", f"repos/{repository}/compare/{live_base}...{entry.get('head_sha')}",
                    "--jq", ".behind_by")
        if behind != "0":
            return emit(False, f"#{number} was validated without the base the earlier merge produced; "
                               "it needs a fresh run on the updated base")
    return emit(True, f"#{number} at {entry.get('head_sha')} onto {base}@{live_base}", entry, plan)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or ""
        print(f"refresh-merge: {error} {detail}".strip(), file=sys.stderr)
        sys.exit(1)
