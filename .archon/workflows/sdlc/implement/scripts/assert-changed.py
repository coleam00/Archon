"""Deterministic guard: did this run actually change anything?

An AI node that declines its task still exits 0, so without this check the
stages after implement would spend money or go public on nothing. It reads
Archon-owned facts only -- git state measured against the start SHA recorded
by the record-start node -- never the project's layout or toolchain.

`.archon/` is excluded deliberately: Archon copies the operator's workflow
edits into every run worktree, so those files predate implement and are not
its output.
"""

import os
import subprocess
import sys
from pathlib import Path

EXCLUDE = ":(exclude).archon"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
    artifacts = Path(os.environ["ARTIFACTS_DIR"])
    start = (artifacts / ".start-sha").read_text().strip()

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

    print(
        "implement produced neither a commit nor a working-tree change outside .archon/.\n"
        "If it declined, its summary says why -- a run with nothing to show fails "
        "rather than reporting success.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
