"""Read an adopted pull request's check state once.

The single-shot probe inside the lifecycle's re-drive wait: after a branch update
pushes a new head, CI restarts, and the merge queue should see concluded checks,
not a pending batch it can only hold. The engine's durable `wait:` node owns the
time between probes; this reads `gh pr checks` and declares one state:

  pending    some check is still running
  concluded  every check finished green or skipped, or none are reported
  red        a check failed or was cancelled

Red is a report, not a verdict: the merge queue reads the required-check policy
and decides. Deterministic gh reads only.
"""

import json
import os
import subprocess
import sys


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    url = os.environ.get("INPUTS_PR", "").strip()
    if not url:
        raise ValueError("no pull request to read")
    read = subprocess.run(["gh", "pr", "checks", url, "--json", "name,bucket"],
                          capture_output=True, text=True)
    if read.returncode != 0 and "no checks reported" in (read.stderr or "").lower():
        print(json.dumps({"state": "concluded", "detail": "no checks reported"}))
        return 0
    # gh exits 8 while checks are pending; the JSON is still complete.
    if read.returncode not in (0, 1, 8) or not read.stdout.strip():
        raise OSError(f"gh pr checks failed: {read.stderr.strip()}")
    checks = json.loads(read.stdout)
    buckets = {str(check.get("bucket") or "") for check in checks}
    pending = [c["name"] for c in checks if c.get("bucket") == "pending"]
    red = [c["name"] for c in checks if c.get("bucket") in ("fail", "cancel")]
    if pending:
        state, detail = "pending", f"{len(pending)} check(s) running: {', '.join(pending)}"
    elif red:
        state, detail = "red", f"non-green checks: {', '.join(red)}"
    elif buckets - {"pass", "skipping"}:
        state, detail = "red", f"checks with unknown state: {sorted(buckets - {'pass', 'skipping'})}"
    else:
        state, detail = "concluded", f"{len(checks)} check(s) concluded"
    print(json.dumps({"state": state, "detail": detail}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"pr-checks: {error}", file=sys.stderr)
        sys.exit(1)
