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

CI_WATCH_SECONDS = 45 * 60


def run(cmd: list[str], timeout: int | None = None) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


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
        print(f"gh pr create failed: {out}")
        return 1
    pr_url = out.splitlines()[-1].strip()

    print(f"watching CI for {pr_url} (bounded {CI_WATCH_SECONDS}s)")
    try:
        code, out = run(["gh", "pr", "checks", pr_url, "--watch", "--fail-fast"],
                        timeout=CI_WATCH_SECONDS)
        ci_verdict = "green" if code == 0 else "red"
    except subprocess.TimeoutExpired:
        ci_verdict = "timeout"

    print(json.dumps({"branch": branch, "pr_url": pr_url, "ci_verdict": ci_verdict}))
    # A red/timeout CI verdict is data for the batch report, not a child crash.
    return 0


if __name__ == "__main__":
    sys.exit(main())
