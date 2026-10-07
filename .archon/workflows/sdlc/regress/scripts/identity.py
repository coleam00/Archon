"""Regression identity. Judgment remains owned by the included agent producers."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


def identity(artifacts, phase):
    if phase not in ("before", "checked", "after"):
        raise ValueError("unsupported identity phase")
    revision = os.environ["INPUTS_REVISION"]
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
        raise ValueError("revision must be a full lowercase commit object ID")
    head = git("rev-parse", "--verify", "HEAD").decode().strip()
    dirty = bool(git("diff", "--name-only", "HEAD", "--"))
    untracked = [
        name.decode("utf-8")
        for name in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
        if name and not name.startswith(b".archon/")
    ]
    record = {"expected": revision, "head": head, "tracked_clean": not dirty,
              "untracked": untracked}
    write_json(artifacts / f"regression-{phase}.json", record)
    if head != revision or dirty or untracked:
        raise ValueError(f"checkout identity is not intact: {json.dumps(record)}")
    return record


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    print(json.dumps(identity(Path(os.environ["ARTIFACTS_DIR"]), os.environ["INPUTS_PHASE"])))
