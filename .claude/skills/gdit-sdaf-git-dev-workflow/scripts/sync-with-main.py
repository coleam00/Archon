#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///

"""
Sync Dev Branch with Main
Recommended start-of-day workflow: pulls remote dev branch updates,
then syncs latest main into your dev branch.
"""

import subprocess
import sys
from skill_config import load_config, detect_provider, load_credentials, ensure_project_yaml_remote
from credential_manager import push_with_credentials, git_with_credentials, mask_tokens

def run_git(cmd):
    """Run git command"""
    result = subprocess.run(f"git {cmd}", shell=True, capture_output=True, text=True)
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def main():
    # Auto-configure project.yaml if git-remote section is missing
    ensure_project_yaml_remote()
    # Parse --remote if provided
    remote_override = None
    strategy_arg = None
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--remote" and i + 1 < len(sys.argv):
            remote_override = sys.argv[i + 1]
        elif not arg.startswith("--"):
            strategy_arg = arg

    cfg = load_config(remote_override=remote_override)
    remote = cfg["remote_name"]
    default_branch = cfg["default_branch"]
    strategy = strategy_arg or cfg["sync_strategy"]
    provider, provider_meta = detect_provider(remote, provider_override=cfg.get("provider_override"))

    print("=== Daily Sync: Dev Branch Update ===\n")
    print(f"Provider: {provider}")
    if provider == "codecommit":
        print(f"Repo: {provider_meta.get('repo_name', 'unknown')}, Profile: {provider_meta.get('profile', 'default')}, Region: {provider_meta.get('region', 'unknown')}")
    print(f"Remote: {remote}, Default branch: {default_branch}, Strategy: {strategy}\n")

    # Load credentials for remote operations and set up output masking
    creds_all = load_credentials()
    _mask = lambda t: mask_tokens(t, creds_all)
    code, remote_url, _ = run_git(f"remote get-url {remote}")
    push_creds = None
    if code == 0 and remote_url.startswith("https://"):
        host = remote_url.replace("https://", "").split("/")[0].split("@")[-1]
        push_creds = creds_all.get(f"https://{host}")

    def run_remote(*args):
        """Run git command that hits the remote, injecting credentials if available."""
        if push_creds and provider != "codecommit":
            return git_with_credentials(list(args), push_creds)
        return run_git(" ".join(args))

    # Get current branch
    code, current_branch, _ = run_git("rev-parse --abbrev-ref HEAD")
    print(f"Current branch: {current_branch}")

    if current_branch == default_branch:
        print(f"On {default_branch} branch, pulling latest...")
        run_remote("pull", remote, default_branch)
        print(f"\n✅ {default_branch} branch updated. Switch to your dev branch to sync.")
        sys.exit(0)

    # Check for uncommitted changes
    code, status, _ = run_git("status --porcelain")
    stashed = False
    if status:
        print("⚠️  Uncommitted changes detected, stashing...")
        run_git('stash push -m "Auto-stash before sync"')
        stashed = True

    # Step 1: Fetch all remote branches
    print(f"Fetching all remote updates from {remote}...")
    run_remote("fetch", remote)

    # Step 2: Pull remote updates to current dev branch
    print(f"Pulling remote updates for {current_branch}...")
    code, _, err = run_git(f"merge --ff-only {remote}/{current_branch}")
    if code != 0:
        _, remote_check, _ = run_git(f"rev-parse --verify {remote}/{current_branch}")
        if remote_check:
            print("⚠️  Dev branch has diverged from remote, rebasing...")
            code, _, err = run_git(f"rebase {remote}/{current_branch}")
            if code != 0:
                print("❌ Failed to sync remote dev branch updates")
                print(_mask(err))
                print("Resolve conflicts, then re-run this script.")
                sys.exit(1)
        else:
            print(f"ℹ️  No remote tracking branch for {current_branch}, skipping dev pull")

    # Step 3: Sync default branch into dev branch
    print(f"Syncing {default_branch} into {current_branch} using {strategy}...")
    if strategy == "rebase":
        code, _, err = run_git(f"rebase {remote}/{default_branch}")
    else:
        code, _, err = run_git(f"merge {remote}/{default_branch}")

    if code != 0:
        print(f"❌ Sync with {default_branch} failed (likely conflicts)")
        print(_mask(err))
        print(f"\nResolve conflicts and run: git {strategy} --continue")
        sys.exit(1)

    # Check for conflicts
    code, conflicts, _ = run_git("diff --name-only --diff-filter=U")
    if conflicts:
        print("❌ Merge conflicts detected:")
        for file in conflicts.split("\n"):
            print(f"  - {file}")
        print(f"\nResolve conflicts and run: git {strategy} --continue")
        sys.exit(1)

    # Pop stash
    if stashed:
        print("Restoring stashed changes...")
        run_git("stash pop")

    # Push using credential helper
    print("Pushing updated branch...")
    run_remote("push", "--force-with-lease", remote, current_branch)

    print(f"\n✅ Branch fully synced (remote dev + {default_branch})")

if __name__ == "__main__":
    main()
