"""Deterministic guard: does this run have work to show?

An AI node that declines its task still exits 0, so without this check the
stages after implement would spend money or go public on nothing. It reads
Archon-owned facts only -- git state and the run's own recorded artifacts --
never the project's layout or toolchain.

Three ways to pass, in order:
1. The working tree changed since the run started (outside `.archon/`).
2. Commits were made since the recorded start SHA.
3. Verified existing work: no new change this run, but the loop declared
   green AND the branch already carries commits ahead of the base branch --
   a rerun that verified a fix a prior run committed is progress, not a
   decline.

A decline (green false, nothing changed) and a green claim with neither new
work nor a branch lead both fail.

Only UNCOMMITTED `.archon/` changes are excluded: Archon copies the operator's
workflow edits into every run worktree, so pre-existing uncommitted `.archon/`
files predate implement and are not its output. A commit made during the run
counts as work even when it only touches `.archon/` -- run-made commits are the
run's output (implement legitimately edits workflows).
"""

import os
import subprocess
import sys
from pathlib import Path

EXCLUDE = ":(exclude).archon"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


def try_git(*args: str) -> str | None:
    proc = subprocess.run(["git", *args], capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else None


def main() -> int:
    artifacts = Path(os.environ["ARTIFACTS_DIR"])
    start = (artifacts / ".start-sha").read_text().strip()
    # The loop's green verdict, bound by the workflow (`with: green:`) and
    # delivered as canonical boolean text ("true"/"false").
    green = os.environ.get("INPUTS_GREEN", "").strip()

    tracked = git("diff", "--name-only", "HEAD", "--", EXCLUDE)
    untracked = git("ls-files", "--others", "--exclude-standard", "--", EXCLUDE)
    head = git("rev-parse", "HEAD")

    if tracked or untracked:
        stat = git("diff", "--stat", "HEAD", "--", EXCLUDE)
        print(stat.splitlines()[-1] if stat else "working-tree changes present")
        return 0

    if head != start:
        count = git("rev-list", "--count", f"{start}..HEAD")
        print(f"{count} commit(s) made this run")
        return 0

    base = os.environ.get("BASE_BRANCH", "")
    if green == "true" and base:
        for ref in (f"origin/{base}", base):
            ahead = try_git("rev-list", "--count", f"{ref}..HEAD")
            if ahead is not None:
                if int(ahead) > 0:
                    print(
                        f"no new changes this run; verified existing work -- "
                        f"{ahead} commit(s) ahead of {ref}"
                    )
                    return 0
                break

    print(
        "implement produced neither a commit nor a working-tree change outside .archon/, "
        f"and the branch carries no verified work ahead of the base (green={green or 'unknown'}).\n"
        "If it declined, its summary says why -- a run with nothing to show fails "
        "rather than reporting success.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
