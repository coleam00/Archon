"""One return for every legitimate terminal result of the stabilize chain.

A no_action assessment completes with the report that explains it; a delivered
fix is accepted only when the deliver branch actually ran AND GitHub confirms
a ready (non-draft) pull request.

Second copy of upkeep's outcome script (rule of three: extract into a shared
named script on the third class that needs it).

Bound inputs (`with:` bindings, canonical text in env):
- INPUTS_ACTION / INPUTS_SUMMARY: the assessment's verdict.
- INPUTS_DELIVERED: deliver's returned output, or "null" when the deliver
  branch was skipped (no_action).
- INPUTS_GATE_PASSED: the spend gate's output, "null" when skipped. A passed
  gate with null delivered means delivery STARTED and died mid-flight — never
  claim the assessment stopped it (the misattribution seen on run a1da7249).
"""

import os
import subprocess
import sys


def main() -> int:
    action = os.environ["INPUTS_ACTION"]
    summary = os.environ["INPUTS_SUMMARY"]
    delivered = os.environ.get("INPUTS_DELIVERED", "null")
    gate_passed = os.environ.get("INPUTS_GATE_PASSED", "null") != "null"
    artifacts = os.environ["ARTIFACTS_DIR"]

    if action == "no_action":
        print(
            f"No stabilization needed: {summary}\n"
            f"Report: {artifacts}/stabilize-assessment.md"
        )
        return 0

    if delivered == "null":
        if gate_passed:
            print(
                "outcome: delivery started but did not complete — see the run's "
                "earliest failed delivery node.",
                file=sys.stderr,
            )
            return 1
        print(
            "outcome: the assessment chose 'fix' but the spend gate never "
            "passed — see the assessment stage's failed node.",
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
