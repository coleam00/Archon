"""One return for every legitimate terminal result of the routed fix chain.

Negative advisory verdicts complete with the report that explains them; delivery
is accepted only when the deliver branch actually ran AND GitHub confirms a
ready (non-draft) pull request.

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_ROUTE / INPUTS_SUMMARY: triage's verdict.
- INPUTS_DELIVERED: deliver's returned output, or "null" when the deliver
  branch was skipped (no_action, or an advisory stop upstream of the gates).
"""

import os
import subprocess
import sys


def main() -> int:
    route = os.environ["INPUTS_ROUTE"]
    summary = os.environ["INPUTS_SUMMARY"]
    delivered = os.environ.get("INPUTS_DELIVERED", "null")
    artifacts = os.environ["ARTIFACTS_DIR"]

    if route == "no_action":
        print(f"No delivery needed: {summary}\nReport: {artifacts}/triage.md")
        return 0

    if delivered == "null":
        if route == "investigate":
            print(
                "No delivery started: the investigation did not establish a safe "
                f"fix boundary.\nReport: {artifacts}/investigation.md"
            )
            return 0
        if route == "plan":
            print(
                "No delivery started: planning left a material decision "
                f"unresolved.\nReport: {artifacts}/plan.md"
            )
            return 0
        print(
            f"outcome: route '{route}' skipped delivery without an advisory report to point to.",
            file=sys.stderr,
        )
        return 1

    # Deliver ran: accept only what GitHub confirms (a ready, non-draft PR).
    remote = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    origin_repo = "/".join(
        remote.removesuffix(".git").replace(":", "/").rstrip("/").split("/")[-2:]
    )
    # With --repo, gh disables branch inference and requires an explicit
    # selector (seen red on run 925f6c43); pass the current branch.
    branch = subprocess.run(
        ["git", "branch", "--show-current"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if not branch:
        print("outcome: detached HEAD — cannot resolve the PR branch.", file=sys.stderr)
        return 1
    proc = subprocess.run(
        [
            "gh",
            "pr",
            "view",
            branch,
            "--repo",
            origin_repo,
            "--json",
            "isDraft,url",
            "--jq",
            "select(.isDraft == false) | .url",
        ],
        capture_output=True,
        text=True,
    )
    url = proc.stdout.strip() if proc.returncode == 0 else ""
    if not url:
        print("outcome: delivery did not finish with a ready pull request.", file=sys.stderr)
        return 1
    print(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
