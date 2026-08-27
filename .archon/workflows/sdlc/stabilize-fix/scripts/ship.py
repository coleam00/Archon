# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Ship one stabilize-fix child: open the PR, watch its CI to a verdict.

Reads FIX_OUTPUT (branch, summary, validate_cmd) and INPUTS_WORK_ORDER (title).
Opens a PR of the pushed branch against $BASE_BRANCH with --fill, then watches
its checks with a bounded wait. Returns canonical JSON on stdout:

    {"branch": ..., "pr_url": ..., "ci_verdict": "green"|"red"|"timeout"}

A red or timeout CI is REPORTED, not hidden — the batch collector surfaces it.
"""

import json
import os
import subprocess
import sys
import time

CI_WATCH_SECONDS = 45 * 60
CHECK_REGISTRATION_POLL_SECONDS = 2


def run(cmd: list[str], timeout: float | None = None) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def read_checks(pr_url: str, timeout: float) -> list[dict]:
    code, out = run(
        ["gh", "pr", "checks", pr_url, "--json", "name,bucket"],
        timeout=timeout,
    )
    if code != 0 and "no checks reported" in out.lower():
        return []
    try:
        checks = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"could not read CI checks: {out}") from exc
    if not isinstance(checks, list) or not all(
        isinstance(check, dict) and "name" in check and "bucket" in check
        for check in checks
    ):
        raise RuntimeError(f"unexpected CI checks payload: {out[:200]}")
    return checks


def watch_ci(pr_url: str) -> str:
    deadline = time.monotonic() + CI_WATCH_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "timeout"
        try:
            if read_checks(pr_url, remaining):
                break
        except subprocess.TimeoutExpired:
            return "timeout"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "timeout"
        time.sleep(min(CHECK_REGISTRATION_POLL_SECONDS, remaining))

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "timeout"
    try:
        code, out = run(
            ["gh", "pr", "checks", pr_url, "--watch", "--fail-fast"],
            timeout=remaining,
        )
    except subprocess.TimeoutExpired:
        return "timeout"
    if code == 0:
        return "green"

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "timeout"
    try:
        checks = read_checks(pr_url, remaining)
    except subprocess.TimeoutExpired:
        return "timeout"
    if any(check["bucket"] in ("fail", "cancel") for check in checks):
        return "red"
    raise RuntimeError(f"CI watch failed without a failed or cancelled check: {out}")


def main() -> int:
    fix = json.loads(os.environ["INPUTS_FIX"])
    order = os.environ.get("INPUTS_WORK_ORDER", "")
    base = os.environ.get("BASE_BRANCH", "")
    branch = fix["branch"].strip()

    title_line = order.strip().splitlines()[0][:120] if order.strip() else branch
    body = (
        f"{order.strip()}\n\n"
        f"---\n\nAutomated fix from an archon-stabilize-batch run.\n\n"
        f"**Summary:** {fix.get('summary', '')}\n\n"
        f"**Verification:** targeted test green "
        f"{os.environ.get('INPUTS_TEST_REPETITIONS', '5')}x consecutively + project checks."
    )

    code, out = run(
        [
            "gh", "pr", "create",
            "--head", branch,
            *(["--base", base] if base else []),
            "--title", title_line,
            "--body", body,
        ]
    )
    if code != 0:
        print(f"gh pr create failed: {out}", file=sys.stderr)
        return 1
    pr_url = out.splitlines()[-1].strip()

    print(f"watching CI for {pr_url} (bounded {CI_WATCH_SECONDS}s)")
    try:
        ci_verdict = watch_ci(pr_url)
    except RuntimeError as exc:
        print(f"CI check probe failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps({"branch": branch, "pr_url": pr_url, "ci_verdict": ci_verdict}))
    # A red/timeout CI verdict is data for the batch report, not a child crash.
    return 0


if __name__ == "__main__":
    sys.exit(main())
