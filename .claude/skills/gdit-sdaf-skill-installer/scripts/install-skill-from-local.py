#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Install a skill from a local directory path into ~/.kiro/skills/."""

import argparse
import os
import shutil
import sys


def _skills_home():
    return os.environ.get("KIRO_SKILLS_HOME", os.path.expanduser("~/.kiro/skills"))


def main(argv):
    parser = argparse.ArgumentParser(description="Install a skill from a local path.")
    parser.add_argument("path", help="Path to skill directory (must contain SKILL.md)")
    parser.add_argument("--name", help="Override skill name (defaults to directory name)")
    args = parser.parse_args(argv)

    src = os.path.abspath(args.path)
    if not os.path.isdir(src):
        print(f"Error: Not a directory: {src}", file=sys.stderr)
        return 1
    if not os.path.isfile(os.path.join(src, "SKILL.md")):
        print(f"Error: SKILL.md not found in {src}", file=sys.stderr)
        return 1

    skill_name = args.name or os.path.basename(src.rstrip("/"))
    dest = os.path.join(_skills_home(), skill_name)

    if os.path.exists(dest):
        print(f"Error: Destination already exists: {dest}", file=sys.stderr)
        return 1

    shutil.copytree(src, dest)
    print(f"Installed {skill_name} to {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
