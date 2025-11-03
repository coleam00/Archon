"""Git Operations Utilities

Helper functions for git operations and inspection.
"""

import subprocess
from pathlib import Path


async def get_commit_count(branch_name: str, repo_path: str | Path, base_branch: str = "main") -> int:
    """Get the number of commits added on a branch compared to base

    Args:
        branch_name: Name of the git branch
        repo_path: Path to the git repository
        base_branch: Base branch to compare against (default: "main")

    Returns:
        Number of commits added on this branch (not total branch history)
    """
    try:
        result = subprocess.run(
            ["git", "rev-list", "--count", f"origin/{base_branch}..{branch_name}"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return int(result.stdout.strip())
        return 0
    except (subprocess.SubprocessError, ValueError):
        return 0


async def get_files_changed(branch_name: str, repo_path: str | Path, base_branch: str = "main") -> int:
    """Get the number of files changed on a branch compared to base

    Args:
        branch_name: Name of the git branch
        repo_path: Path to the git repository
        base_branch: Base branch to compare against

    Returns:
        Number of files changed
    """
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"{base_branch}...{branch_name}"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            files = [f for f in result.stdout.strip().split("\n") if f]
            return len(files)
        return 0
    except subprocess.SubprocessError:
        return 0


async def get_latest_commit_message(branch_name: str, repo_path: str | Path) -> str | None:
    """Get the latest commit message on a branch

    Args:
        branch_name: Name of the git branch
        repo_path: Path to the git repository

    Returns:
        Latest commit message or None
    """
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--pretty=%B", branch_name],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip() or None
        return None
    except subprocess.SubprocessError:
        return None


async def has_planning_commits(branch_name: str, repo_path: str | Path) -> bool:
    """Check if branch has commits indicating planning work

    Looks for:
    - Commits mentioning 'plan', 'spec', 'design'
    - Files in specs/ or plan/ directories
    - Files named plan.md or similar

    Args:
        branch_name: Name of the git branch
        repo_path: Path to the git repository

    Returns:
        True if planning commits detected
    """
    try:
        # Check commit messages
        result = subprocess.run(
            ["git", "log", "--oneline", branch_name],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            log_text = result.stdout.lower()
            if any(keyword in log_text for keyword in ["plan", "spec", "design"]):
                return True

        # Check for planning-related files
        result = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", branch_name],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            files = result.stdout.lower()
            if any(
                pattern in files
                for pattern in ["specs/", "plan/", "plan.md", "design.md"]
            ):
                return True

        return False
    except subprocess.SubprocessError:
        return False


async def get_current_branch(repo_path: str | Path) -> str | None:
    """Get the current git branch name

    Args:
        repo_path: Path to the git repository

    Returns:
        Current branch name or None
    """
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            return branch if branch else None
        return None
    except subprocess.SubprocessError:
        return None
