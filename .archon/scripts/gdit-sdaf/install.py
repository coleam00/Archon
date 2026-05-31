#!/usr/bin/env python3
"""GDIT-SDAF Framework — Installer

Runs from inside the framework package (scripts/ alongside agents/, steering/, etc.).

Usage:
    python3 ~/.kiro/scripts/install.py            # First-time install
    python3 ~/.kiro/scripts/install.py --upgrade   # Upgrade existing install
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

FRAMEWORK_DIRS = ["agents", "steering", "hooks", "skills", "config", "scripts", "settings"]
KIRO_HOME = Path.home() / ".kiro"


def get_repo_root():
    """Get the package root (parent of scripts/)."""
    return Path(__file__).resolve().parent.parent


def read_version(repo_root):
    """Read VERSION file."""
    return (repo_root / "VERSION").read_text().strip()


def run_prereqs(repo_root):
    """Run prerequisite checker, abort on failure."""
    result = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "check-prereqs.py")],
        capture_output=False,
    )
    if result.returncode != 0:
        print("\nInstall aborted: missing required tools.")
        sys.exit(1)
    print()


def copy_directory(src, dst):
    """Copy src to dst, preserving user files not in source (no deletions)."""
    copied = 0
    for item in src.rglob("*"):
        if item.is_file():
            rel = item.relative_to(src)
            dest_file = dst / rel
            dest_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, dest_file)
            copied += 1
    return copied


def install(repo_root, upgrade=False):
    """Main install logic."""
    version = read_version(repo_root)
    version_file = KIRO_HOME / ".gdit-sdaf-version"

    if upgrade and not version_file.exists():
        print("No existing install found. Running first-time install.")
        upgrade = False

    if not upgrade and version_file.exists():
        existing = version_file.read_text().strip()
        print(f"Existing install detected (v{existing}). Use --upgrade to update.")
        sys.exit(1)

    action = "Upgrading" if upgrade else "Installing"
    print(f"{action} GDIT-SDAF Framework v{version} → {KIRO_HOME}\n")

    # Run prereqs
    run_prereqs(repo_root)

    # Create base directory
    KIRO_HOME.mkdir(parents=True, exist_ok=True)

    # Copy each framework directory
    total_files = 0
    for dirname in FRAMEWORK_DIRS:
        src = repo_root / dirname
        if not src.exists():
            print(f"  SKIP {dirname}/ (not in repo)")
            continue
        dst = KIRO_HOME / dirname
        count = copy_directory(src, dst)
        total_files += count
        print(f"  ✓ {dirname}/ ({count} files)")

    # Write version marker
    version_file.write_text(version + "\n")

    # Refresh skills cache
    update_script = KIRO_HOME / "skills" / "update-agent.py"
    if update_script.exists():
        subprocess.run(
            [sys.executable, str(update_script)], capture_output=True
        )
        print("  ✓ Skills cache refreshed")

    print(f"\n{'Upgrade' if upgrade else 'Install'} complete:")
    print(f"  Version:  {version}")
    print(f"  Location: {KIRO_HOME}")
    print(f"  Files:    {total_files}")


def main():
    parser = argparse.ArgumentParser(description="GDIT-SDAF Framework Installer")
    parser.add_argument("--upgrade", action="store_true", help="Upgrade existing install")
    args = parser.parse_args()

    repo_root = get_repo_root()
    if not (repo_root / "VERSION").exists():
        print("ERROR: VERSION file not found. Run from the gdit-sdaf repo root.")
        sys.exit(1)

    install(repo_root, upgrade=args.upgrade)


if __name__ == "__main__":
    main()
