"""Resolve the revision to deploy and pass the trusted project commands through.

A malformed invocation fails the node: an empty deploy or health command, or a
requested revision that is not the remote default branch head, is a bad call
rather than a failed deployment.
"""

import json
import os
import re
import subprocess
import sys


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def default_branch_head() -> tuple[str, str]:
    # `ls-remote --symref origin HEAD` prints "ref: refs/heads/<branch>\tHEAD"
    # then "<sha>\tHEAD". Read the remote, never the local clone's notion of it.
    out = git("ls-remote", "--symref", "origin", "HEAD")
    branch = sha = ""
    for line in out.splitlines():
        fields = line.split()
        # "ref: refs/heads/<branch>\tHEAD" names the branch; "<sha>\tHEAD" is its head.
        if len(fields) == 3 and fields[0] == "ref:" and fields[1].startswith("refs/heads/"):
            branch = fields[1][len("refs/heads/"):]
        elif len(fields) == 2 and fields[1] == "HEAD":
            sha = fields[0]
    if not branch or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("could not resolve the remote default branch head")
    return branch, sha


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    deploy = os.environ.get("INPUTS_DEPLOY", "").strip()
    health = os.environ.get("INPUTS_HEALTH", "").strip()
    identity = os.environ.get("INPUTS_IDENTITY", "").strip()
    requested = os.environ.get("INPUTS_REVISION", "").strip()
    if not deploy or not health:
        raise ValueError("deploy and health commands are required")
    branch, head = default_branch_head()
    if requested and requested != head:
        raise ValueError(f"requested revision {requested[:12]} is not the {branch} head {head[:12]}")
    print(json.dumps({"revision": head, "branch": branch, "deploy": deploy,
                      "health": health, "identity": identity}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"resolve-revision: {error}", file=sys.stderr)
        sys.exit(1)
