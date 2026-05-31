#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Cleanup Merged Branches
Removes local and optionally remote branches that have been merged
"""

import subprocess
import sys
from skill_config import load_config

def run_git(cmd):
    """Run git command"""
    result = subprocess.run(f"git {cmd}", shell=True, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def main():
    cfg = load_config()
    remote = cfg["remote_name"]
    default_branch = cfg["default_branch"]
    dry_run = "--no-dry-run" not in sys.argv
    delete_remote = "--delete-remote" in sys.argv

    print("=== Cleanup Merged Branches ===\n")

    # Get current branch
    code, current_branch, _ = run_git("rev-parse --abbrev-ref HEAD")

    # Get merged branches
    code, branches, _ = run_git(f"branch --merged {default_branch}")
    merged = [b.strip().lstrip("* ") for b in branches.split("\n") if b.strip() and default_branch not in b and "*" not in b]

    if not merged:
        print("No merged branches to clean up")
        sys.exit(0)

    print("Merged branches:")
    for branch in merged:
        print(f"  - {branch}")
    print()

    if dry_run:
        print("🔍 DRY RUN - No changes will be made")
        print("Run with --no-dry-run to delete branches")
        sys.exit(0)

    # Confirm
    confirm = input("Delete these branches? (y/n): ").strip().lower()
    if confirm != "y":
        print("Cancelled")
        sys.exit(0)

    # Delete local branches
    for branch in merged:
        print(f"Deleting local branch: {branch}")
        run_git(f"branch -d {branch}")

    # Delete remote branches
    if delete_remote:
        print("\nDeleting remote branches...")
        for branch in merged:
            code, out, _ = run_git(f"ls-remote --heads {remote} {branch}")
            if out:
                print(f"Deleting remote branch: {remote}/{branch}")
                run_git(f"push {remote} --delete {branch}")

    print("\n✅ Cleanup complete")

if __name__ == "__main__":
    main()
