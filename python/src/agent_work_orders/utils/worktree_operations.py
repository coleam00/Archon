"""Worktree management operations for isolated agent work order execution.

Provides utilities for creating and managing git worktrees under trees/<work_order_id>/
to enable parallel execution in isolated environments.
"""

import hashlib
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config import config
from .port_allocation import create_ports_env_file

if TYPE_CHECKING:
    import structlog


def _get_repo_hash(repository_url: str) -> str:
    """Get a short hash for repository URL.

    Args:
        repository_url: Git repository URL

    Returns:
        8-character hash of the repository URL
    """
    return hashlib.sha256(repository_url.encode()).hexdigest()[:8]


def get_base_repo_path(repository_url: str) -> str:
    """Get path to base repository clone.

    Args:
        repository_url: Git repository URL

    Returns:
        Absolute path to base repository directory
    """
    repo_hash = _get_repo_hash(repository_url)
    base_path = config.ensure_temp_dir() / "repos" / repo_hash / "main"
    return str(base_path)


def get_worktree_path(repository_url: str, work_order_id: str) -> str:
    """Get absolute path to worktree.

    Args:
        repository_url: Git repository URL
        work_order_id: The work order ID

    Returns:
        Absolute path to worktree directory
    """
    repo_hash = _get_repo_hash(repository_url)
    worktree_path = config.ensure_temp_dir() / "repos" / repo_hash / "trees" / work_order_id
    return str(worktree_path)


def ensure_base_repository(repository_url: str, logger: "structlog.stdlib.BoundLogger") -> tuple[str | None, str | None]:
    """Ensure base repository clone exists.

    Args:
        repository_url: Git repository URL to clone
        logger: Logger instance

    Returns:
        Tuple of (base_repo_path, error_message)
    """
    base_repo_path = get_base_repo_path(repository_url)

    # If base repo already exists, just fetch latest
    if os.path.exists(base_repo_path):
        logger.info(f"Base repository exists at {base_repo_path}, fetching latest")
        fetch_result = subprocess.run(
            ["git", "fetch", "origin"],
            capture_output=True,
            text=True,
            cwd=base_repo_path
        )
        if fetch_result.returncode != 0:
            logger.warning(f"Failed to fetch from origin: {fetch_result.stderr}")
        return base_repo_path, None

    # Create parent directory
    Path(base_repo_path).parent.mkdir(parents=True, exist_ok=True)

    # Clone the repository
    logger.info(f"Cloning base repository from {repository_url} to {base_repo_path}")
    clone_result = subprocess.run(
        ["git", "clone", repository_url, base_repo_path],
        capture_output=True,
        text=True
    )

    if clone_result.returncode != 0:
        error_msg = f"Failed to clone repository: {clone_result.stderr}"
        logger.error(error_msg)
        return None, error_msg

    logger.info(f"Created base repository at {base_repo_path}")
    return base_repo_path, None


def create_worktree(
    repository_url: str,
    work_order_id: str,
    branch_name: str,
    logger: "structlog.stdlib.BoundLogger"
) -> tuple[str | None, str | None]:
    """Create a git worktree for isolated execution.

    Args:
        repository_url: Git repository URL
        work_order_id: The work order ID for this worktree
        branch_name: The branch name to create the worktree from
        logger: Logger instance

    Returns:
        Tuple of (worktree_path, error_message)
        worktree_path is the absolute path if successful, None if error
    """
    # Ensure base repository exists
    base_repo_path, error = ensure_base_repository(repository_url, logger)
    if error or not base_repo_path:
        return None, error

    # Construct worktree path
    worktree_path = get_worktree_path(repository_url, work_order_id)

    # Check if worktree already exists
    if os.path.exists(worktree_path):
        logger.warning(f"Worktree already exists at {worktree_path}")
        return worktree_path, None

    # Create parent directory for worktrees
    Path(worktree_path).parent.mkdir(parents=True, exist_ok=True)

    # Fetch latest changes from origin
    logger.info("Fetching latest changes from origin")
    fetch_result = subprocess.run(
        ["git", "fetch", "origin"],
        capture_output=True,
        text=True,
        cwd=base_repo_path
    )
    if fetch_result.returncode != 0:
        logger.warning(f"Failed to fetch from origin: {fetch_result.stderr}")

    # Create the worktree using git, branching from origin/main
    # Use -b to create the branch as part of worktree creation
    cmd = ["git", "worktree", "add", "-b", branch_name, worktree_path, "origin/main"]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=base_repo_path)

    if result.returncode != 0:
        # If branch already exists, try without -b
        if "already exists" in result.stderr:
            cmd = ["git", "worktree", "add", worktree_path, branch_name]
            result = subprocess.run(cmd, capture_output=True, text=True, cwd=base_repo_path)

        if result.returncode != 0:
            error_msg = f"Failed to create worktree: {result.stderr}"
            logger.error(error_msg)
            return None, error_msg

    logger.info(f"Created worktree at {worktree_path} for branch {branch_name}")
    return worktree_path, None


def validate_worktree(
    repository_url: str,
    work_order_id: str,
    state: dict[str, Any]
) -> tuple[bool, str | None]:
    """Validate worktree exists in state, filesystem, and git.

    Performs three-way validation to ensure consistency:
    1. State has worktree_path
    2. Directory exists on filesystem
    3. Git knows about the worktree

    Args:
        repository_url: Git repository URL
        work_order_id: The work order ID to validate
        state: The work order state dictionary

    Returns:
        Tuple of (is_valid, error_message)
    """
    # Check state has worktree_path
    worktree_path = state.get("worktree_path")
    if not worktree_path:
        return False, "No worktree_path in state"

    # Check directory exists
    if not os.path.exists(worktree_path):
        return False, f"Worktree directory not found: {worktree_path}"

    # Check git knows about it (query from base repository)
    base_repo_path = get_base_repo_path(repository_url)
    if not os.path.exists(base_repo_path):
        return False, f"Base repository not found: {base_repo_path}"

    result = subprocess.run(
        ["git", "worktree", "list"],
        capture_output=True,
        text=True,
        cwd=base_repo_path
    )
    if worktree_path not in result.stdout:
        return False, "Worktree not registered with git"

    return True, None


def remove_worktree(
    repository_url: str,
    work_order_id: str,
    logger: "structlog.stdlib.BoundLogger"
) -> tuple[bool, str | None]:
    """Remove a worktree and clean up.

    Args:
        repository_url: Git repository URL
        work_order_id: The work order ID for the worktree to remove
        logger: Logger instance

    Returns:
        Tuple of (success, error_message)
    """
    worktree_path = get_worktree_path(repository_url, work_order_id)
    base_repo_path = get_base_repo_path(repository_url)

    # First remove via git (if base repo exists)
    if os.path.exists(base_repo_path):
        cmd = ["git", "worktree", "remove", worktree_path, "--force"]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=base_repo_path
        )

        if result.returncode != 0:
            # Try to clean up manually if git command failed
            if os.path.exists(worktree_path):
                try:
                    shutil.rmtree(worktree_path)
                    logger.warning(f"Manually removed worktree directory: {worktree_path}")
                except Exception as e:
                    return False, f"Failed to remove worktree: {result.stderr}, manual cleanup failed: {e}"
    else:
        # If base repo doesn't exist, just remove directory
        if os.path.exists(worktree_path):
            try:
                shutil.rmtree(worktree_path)
                logger.info(f"Removed worktree directory (no base repo): {worktree_path}")
            except Exception as e:
                return False, f"Failed to remove worktree directory: {e}"

    logger.info(f"Removed worktree at {worktree_path}")
    return True, None


def setup_worktree_environment(
    worktree_path: str,
    start_port: int,
    end_port: int,
    available_ports: list[int],
    logger: "structlog.stdlib.BoundLogger"
) -> None:
    """Set up worktree environment by creating .ports.env file.

    The actual environment setup (copying .env files, installing dependencies) is handled
    by separate commands which run inside the worktree.

    Args:
        worktree_path: Path to the worktree
        start_port: Start of port range
        end_port: End of port range
        available_ports: List of available ports in range
        logger: Logger instance
    """
    create_ports_env_file(worktree_path, start_port, end_port, available_ports)
    logger.info(
        f"Created .ports.env with port range {start_port}-{end_port} "
        f"({len(available_ports)} available ports)"
    )
