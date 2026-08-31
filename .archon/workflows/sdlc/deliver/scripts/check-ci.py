"""Classify the current branch PR's check state, once.

Archon-owned facts only (gh state, never the project's toolchain). This is the
single-shot probe inside the `await-checks` loop_group: the engine's durable
`wait:` node owns the time between probes, so this script never sleeps
through CI — it reads the state, declares it, and exits.

States, on stdout as JSON so `when:`/`until_bash` can branch without prose:
  {"state": "pending", "detail": ...}    checks exist and some are still running
  {"state": "concluded", "detail": ...}  green, no CI configured, or CI gated on
                                         a maintainer's approval (fork or first
                                         contribution) — a gate only a
                                         maintainer can open, named, never
                                         blocked on and never called green
  {"state": "red", "detail": ...}        concluded with non-green checks, named.
                                         `pass` counts, `skipping` is accepted as
                                         non-blocking, everything else — `fail`,
                                         `cancel`, or any bucket this script does
                                         not recognize — is red. A cancelled
                                         check is not a green check (R4).
Red is a report, never a verdict: this probe declares the state and the
deliver tail's convergence pass decides what it means — introduced red is
correction work, any other red terminates at the flip preflight with the
recovery named. Nothing here retries: a concluded check does not re-run itself.

The one in-process wait left: when CI is configured but nothing has started
yet, registration gets a single 60 s grace before the maintainer-gated skip is
declared — the same grace the polling predecessor gave it.
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
        print(f"check-ci: could not read check state: {proc.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(parsed, list) or not all(
        isinstance(c, dict) and "name" in c and "bucket" in c for c in parsed
    ):
        print(f"check-ci: unexpected check payload shape: {proc.stdout[:200]}", file=sys.stderr)
        sys.exit(1)
    return parsed


def repo_has_active_workflows() -> bool | None:
    """None means the answer could not be determined (treated as configured)."""
    proc = subprocess.run(
        ["gh", "api", "repos/{owner}/{repo}/actions/workflows",
         "--jq", '[.workflows[] | select(.state == "active")] | length'],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        return int(proc.stdout.strip()) > 0
    except ValueError:
        return None


def conclude(detail: str) -> int:
    print(json.dumps({"state": "concluded", "detail": detail}))
    return 0


def main() -> int:
    rounds = checks()
    if not rounds:
        active = repo_has_active_workflows()
        if active is False:
            return conclude("no checks configured on this repository — nothing to await")
        # CI exists (or could not be ruled out) but nothing started. Give
        # registration one grace interval, then skip with the reason: starting
        # gated CI is a maintainer's power, not this run's.
        time.sleep(60)
        rounds = checks()
        if not rounds:
            return conclude(
                "CI is configured but no checks started on this PR — most likely awaiting "
                "a maintainer's approval to run (fork or first contribution), or path filters. "
                "Skipping the CI gate; running and verifying checks stays with the maintainer."
            )

    pending = [c["name"] for c in rounds if c["bucket"] == "pending"]
    if pending:
        print(json.dumps({"state": "pending", "detail": f"{len(pending)} check(s) running"}))
        return 0

    passed = [c["name"] for c in rounds if c["bucket"] == "pass"]
    skipped = [c["name"] for c in rounds if c["bucket"] == "skipping"]
    not_green = [
        f"{c['name']} ({c['bucket']})" for c in rounds if c["bucket"] not in ("pass", "skipping")
    ]

    if not_green:
        print(json.dumps({"state": "red", "detail": ", ".join(not_green)}))
        return 0

    note = f"; skipped (non-blocking): {', '.join(skipped)}" if skipped else ""
    return conclude(f"all {len(passed)} required check(s) green{note}")


if __name__ == "__main__":
    sys.exit(main())
