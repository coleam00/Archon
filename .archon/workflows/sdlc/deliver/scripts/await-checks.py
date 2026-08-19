"""Wait for the current branch's PR checks to clear.

Archon-owned facts only (gh state, never the project's toolchain). A repository
with no checks configured passes -- the bundle must run on any project -- and
says so.

Success is an EXPLICIT set: `pass` counts, `skipping` is accepted as
non-blocking (and named), everything else -- `fail`, `cancel`, or any bucket
this script does not recognize -- fails the node with the check names. A
cancelled check is not a green check (R4).

The wait is bounded by the node's declared `timeout:` (60 minutes in
deliver.yaml) -- without it the engine kills a script node at its 120 s
default, far under a normal CI run.
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
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"await-checks: could not read check state: {proc.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(parsed, list) or not all(
        isinstance(c, dict) and "name" in c and "bucket" in c for c in parsed
    ):
        print(f"await-checks: unexpected check payload shape: {proc.stdout[:200]}", file=sys.stderr)
        sys.exit(1)
    return parsed


def main() -> int:
    rounds = checks()
    if not rounds:
        print("no checks configured on this repository — nothing to await")
        return 0

    while any(c["bucket"] == "pending" for c in rounds):
        time.sleep(30)
        rounds = checks()

    passed = [c["name"] for c in rounds if c["bucket"] == "pass"]
    skipped = [c["name"] for c in rounds if c["bucket"] == "skipping"]
    not_green = [
        f"{c['name']} ({c['bucket']})" for c in rounds if c["bucket"] not in ("pass", "skipping")
    ]

    if not_green:
        print(f"checks not green: {', '.join(not_green)}", file=sys.stderr)
        return 1

    note = f"; skipped (non-blocking): {', '.join(skipped)}" if skipped else ""
    print(f"all {len(passed)} required check(s) green{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
