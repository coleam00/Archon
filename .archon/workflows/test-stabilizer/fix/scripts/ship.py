# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Open or reuse one concern PR and wait for its current head's CI."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

CI_WATCH_SECONDS = 45 * 60
POLL_SECONDS = 2


def run(cmd: list[str], timeout: float | None = None) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def read_checks(pr_url: str, timeout: float) -> list[dict]:
    code, out = run(["gh", "pr", "checks", pr_url, "--json", "name,bucket"], timeout=timeout)
    if code != 0 and "no checks reported" in out.lower():
        return []
    if code != 0:
        raise RuntimeError(f"could not read CI checks: {out}")
    try:
        checks = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"could not read CI checks: {out}") from exc
    if not isinstance(checks, list) or not all(
        isinstance(check, dict) and "name" in check and "bucket" in check for check in checks
    ):
        raise RuntimeError(f"unexpected CI checks payload: {out[:200]}")
    return checks


def read_pr_head(pr_url: str, timeout: float) -> str:
    code, out = run(
        ["gh", "pr", "view", pr_url, "--json", "headRefOid", "--jq", ".headRefOid"],
        timeout=timeout,
    )
    if code != 0 or not out:
        raise RuntimeError(f"could not read PR head: {out}")
    return out.splitlines()[-1].strip()


def check_detail(checks: list[dict]) -> str:
    return ", ".join(f"{check['name']}={check['bucket']}" for check in checks)


def watch_ci(pr_url: str, expected_head: str) -> dict:
    deadline = time.monotonic() + CI_WATCH_SECONDS

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"ci_verdict": "timeout", "ci_detail": "PR head or checks did not register"}
        try:
            head_matches = read_pr_head(pr_url, remaining) == expected_head
            checks = read_checks(pr_url, remaining) if head_matches else []
        except subprocess.TimeoutExpired:
            return {"ci_verdict": "timeout", "ci_detail": "PR head or checks did not register"}
        if checks:
            break
        time.sleep(min(POLL_SECONDS, remaining))

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"ci_verdict": "timeout", "ci_detail": check_detail(checks)}
    try:
        code, out = run(
            ["gh", "pr", "checks", pr_url, "--watch", "--fail-fast"], timeout=remaining
        )
    except subprocess.TimeoutExpired:
        return {"ci_verdict": "timeout", "ci_detail": "checks did not finish before deadline"}

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"ci_verdict": "timeout", "ci_detail": "checks did not finish before deadline"}
    try:
        checks = read_checks(pr_url, remaining)
    except subprocess.TimeoutExpired:
        return {"ci_verdict": "timeout", "ci_detail": "checks did not finish before deadline"}

    if code == 0:
        return {"ci_verdict": "green", "ci_detail": check_detail(checks)}
    if any(check["bucket"] in ("fail", "cancel") for check in checks):
        return {"ci_verdict": "red", "ci_detail": check_detail(checks)}
    raise RuntimeError(f"CI watch failed without a failed or cancelled check: {out}")


def find_open_pr(branch: str) -> str | None:
    code, out = run(
        ["gh", "pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "url"]
    )
    if code != 0:
        raise RuntimeError(f"could not search for an existing PR: {out}")
    try:
        matches = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"could not parse existing PR search: {out}") from exc
    if not matches:
        return None
    return matches[0]["url"]


def create_pr(branch: str, base: str, title: str, body: str) -> str:
    code, out = run([
        "gh", "pr", "create",
        "--head", branch,
        *(["--base", base] if base else []),
        "--title", title,
        "--body", body,
    ])
    if code != 0:
        raise RuntimeError(f"gh pr create failed: {out}")
    return out.splitlines()[-1].strip()


def main() -> int:
    fix = json.loads(os.environ["INPUTS_FIX"])
    order = json.loads(os.environ["INPUTS_ORDER"])
    base = os.environ.get("BASE_BRANCH", "")
    branch = fix["branch"].strip()
    title = order["title"].strip()[:120]
    body = (
        f"Concern: {order['concern_id']}\n\n"
        f"Diagnoses: {', '.join(order['diagnosis_ids'])}\n\n"
        f"---\n\nAutomated fix from the standalone test stabilizer.\n\n"
        f"**Summary:** {fix.get('summary', '')}\n\n"
        f"**Verification:** `{fix.get('test_cmd', '')}` once, then "
        f"`{fix.get('validate_cmd', '')}` once, followed by independent test-scope review."
    )

    try:
        pr_url = find_open_pr(branch) or create_pr(branch, base, title, body)
        code, expected_head = run(["git", "rev-parse", "HEAD"])
        if code != 0 or not expected_head:
            raise RuntimeError(f"could not resolve branch head: {expected_head}")
        result = watch_ci(pr_url, expected_head.splitlines()[-1].strip())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps({
        "concern": order["title"],
        "branch": branch,
        "pr_url": pr_url,
        **result,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
