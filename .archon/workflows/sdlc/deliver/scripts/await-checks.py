"""Wait for the current branch's PR checks to clear.

Archon-owned facts only (gh state, never the project's toolchain). A repository
with no checks configured passes -- the bundle must run on any project -- and
says so. A failed check fails the node; the run stays resumable after fixes.
No timeout by design: the run reports when it is done.
"""

import json
import subprocess
import sys
import time


def checks() -> list[dict]:
    proc = subprocess.run(
        ["gh", "pr", "checks", "--json", "name,bucket"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 and "no checks reported" in (proc.stdout + proc.stderr).lower():
        return []
    # Non-zero with data still parses: gh exits 1 when checks failed.
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"await-checks: could not read check state: {proc.stderr.strip()}", file=sys.stderr)
        sys.exit(1)


def main() -> int:
    rounds = checks()
    if not rounds:
        print("no checks configured on this repository — nothing to await")
        return 0

    while any(c["bucket"] == "pending" for c in rounds):
        time.sleep(30)
        rounds = checks()

    failed = [c["name"] for c in rounds if c["bucket"] == "fail"]
    if failed:
        print(f"checks failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"all {len(rounds)} check(s) green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
