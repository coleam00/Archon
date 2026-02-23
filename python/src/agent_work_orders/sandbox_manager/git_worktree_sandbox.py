"""Git Worktree Sandbox Implementation

Provides isolated execution environment using git worktrees.
Enables parallel execution of multiple work orders without conflicts.
"""

import asyncio
import os
import subprocess
import time

from ..models import CommandExecutionResult, SandboxSetupError
from ..utils.git_operations import get_current_branch
from ..utils.port_allocation import find_available_port_range
from ..utils.structured_logger import get_logger
from ..utils.worktree_operations import (
    create_worktree,
    get_base_repo_path,
    get_worktree_path,
    remove_worktree,
    setup_worktree_environment,
)

logger = get_logger(__name__)


class GitWorktreeSandbox:
    """Git worktree-based sandbox implementation

    Creates a git worktree under trees/<work_order_id>/ where the agent
    executes workflows. Enables parallel execution with isolated environments
    and deterministic port allocation.
    """

    def __init__(self, repository_url: str, sandbox_identifier: str):
        self.repository_url = repository_url
        self.sandbox_identifier = sandbox_identifier
        self.working_dir = get_worktree_path(repository_url, sandbox_identifier)
        self.port_range_start: int | None = None
        self.port_range_end: int | None = None
        self.available_ports: list[int] = []
        self.temp_branch: str | None = None  # Track temporary branch for cleanup
        self._logger = logger.bind(
            sandbox_identifier=sandbox_identifier,
            repository_url=repository_url,
        )

    async def setup(self) -> None:
        """Create worktree and set up isolated environment

        Creates worktree from origin/main and allocates a port range.
        Each work order gets 10 ports for flexibility.
        """
        self._logger.info("worktree_sandbox_setup_started")

        try:
            # Allocate port range deterministically
            self.port_range_start, self.port_range_end, self.available_ports = find_available_port_range(
                self.sandbox_identifier
            )
            self._logger.info(
                "port_range_allocated",
                port_range_start=self.port_range_start,
                port_range_end=self.port_range_end,
                available_ports_count=len(self.available_ports),
            )

            # Create worktree with temporary branch name
            # Agent will create the actual feature branch during execution
            # The temporary branch will be cleaned up in cleanup() method
            self.temp_branch = f"wo-{self.sandbox_identifier}"

            worktree_path, error = create_worktree(
                self.repository_url,
                self.sandbox_identifier,
                self.temp_branch,
                self._logger
            )

            if error or not worktree_path:
                raise SandboxSetupError(f"Failed to create worktree: {error}")

            # Set up environment with port configuration
            setup_worktree_environment(
                worktree_path,
                self.port_range_start,
                self.port_range_end,
                self.available_ports,
                self._logger
            )

            self._logger.info(
                "worktree_sandbox_setup_completed",
                working_dir=self.working_dir,
                port_range=f"{self.port_range_start}-{self.port_range_end}",
                available_ports_count=len(self.available_ports),
            )

        except Exception as e:
            self._logger.error(
                "worktree_sandbox_setup_failed",
                error=str(e),
                exc_info=True
            )
            raise SandboxSetupError(f"Worktree sandbox setup failed: {e}") from e

    async def execute_command(
        self, command: str, timeout: int = 300
    ) -> CommandExecutionResult:
        """Execute command in the worktree directory

        Args:
            command: Shell command to execute
            timeout: Timeout in seconds

        Returns:
            CommandExecutionResult
        """
        self._logger.info("command_execution_started", command=command)
        start_time = time.time()

        try:
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=self.working_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )
            except TimeoutError:
                process.kill()
                await process.wait()
                duration = time.time() - start_time
                self._logger.error(
                    "command_execution_timeout", command=command, timeout=timeout
                )
                return CommandExecutionResult(
                    success=False,
                    stdout=None,
                    stderr=None,
                    exit_code=-1,
                    error_message=f"Command timed out after {timeout}s",
                    duration_seconds=duration,
                )

            duration = time.time() - start_time
            # Use actual returncode when available, or -1 as sentinel for None
            exit_code = process.returncode if process.returncode is not None else -1
            success = exit_code == 0

            result = CommandExecutionResult(
                success=success,
                stdout=stdout.decode() if stdout else None,
                stderr=stderr.decode() if stderr else None,
                exit_code=exit_code,
                error_message=None if success else stderr.decode() if stderr else "Command failed",
                duration_seconds=duration,
            )

            if success:
                self._logger.info(
                    "command_execution_completed", command=command, duration=duration
                )
            else:
                self._logger.error(
                    "command_execution_failed",
                    command=command,
                    exit_code=exit_code,
                    duration=duration,
                )

            return result

        except Exception as e:
            duration = time.time() - start_time
            self._logger.error(
                "command_execution_error", command=command, error=str(e), exc_info=True
            )
            return CommandExecutionResult(
                success=False,
                stdout=None,
                stderr=None,
                exit_code=-1,
                error_message=str(e),
                duration_seconds=duration,
            )

    async def get_git_branch_name(self) -> str | None:
        """Get current git branch name in worktree

        Returns:
            Current branch name or None
        """
        try:
            return await get_current_branch(self.working_dir)
        except Exception as e:
            self._logger.error("git_branch_query_failed", error=str(e))
            return None

    async def cleanup(self) -> None:
        """Remove worktree and temporary branch

        Removes the worktree directory and the temporary branch that was created
        during setup. This ensures cleanup even if the agent failed before creating
        the actual feature branch.
        """
        self._logger.info("worktree_sandbox_cleanup_started")

        try:
            # Remove the worktree first
            worktree_success, error = remove_worktree(
                self.repository_url,
                self.sandbox_identifier,
                self._logger
            )

            if not worktree_success:
                self._logger.error(
                    "worktree_sandbox_cleanup_failed",
                    error=error
                )

            # Delete the temporary branch if it was created
            # Always try to delete branch even if worktree removal failed,
            # as the branch may still exist and need cleanup
            if self.temp_branch:
                await self._delete_temp_branch()

            # Only log success if worktree removal succeeded
            if worktree_success:
                self._logger.info("worktree_sandbox_cleanup_completed")
        except Exception as e:
            self._logger.error(
                "worktree_sandbox_cleanup_failed",
                error=str(e),
                exc_info=True
            )

    async def _delete_temp_branch(self) -> None:
        """Delete the temporary branch from the base repository

        Attempts to delete the temporary branch created during setup.
        Fails gracefully if the branch doesn't exist or was already deleted.
        """
        if not self.temp_branch:
            return

        base_repo_path = get_base_repo_path(self.repository_url)

        try:
            # Check if base repo exists
            if not os.path.exists(base_repo_path):
                self._logger.warning(
                    "temp_branch_cleanup_skipped",
                    reason="Base repository does not exist",
                    temp_branch=self.temp_branch
                )
                return

            # Delete the branch (local only - don't force push to remote)
            # Use -D to force delete even if not merged
            cmd = ["git", "branch", "-D", self.temp_branch]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=base_repo_path,
            )

            if result.returncode == 0:
                self._logger.info(
                    "temp_branch_deleted",
                    temp_branch=self.temp_branch
                )
            else:
                # Branch might not exist (already deleted or wasn't created)
                if "not found" in result.stderr.lower() or "no such branch" in result.stderr.lower():
                    self._logger.debug(
                        "temp_branch_not_found",
                        temp_branch=self.temp_branch,
                        message="Branch may have been already deleted or never created"
                    )
                else:
                    # Other error (e.g., branch is checked out)
                    self._logger.warning(
                        "temp_branch_deletion_failed",
                        temp_branch=self.temp_branch,
                        error=result.stderr,
                        message="Branch may need manual cleanup"
                    )
        except Exception as e:
            self._logger.warning(
                "temp_branch_deletion_error",
                temp_branch=self.temp_branch,
                error=str(e),
                exc_info=True,
                message="Failed to delete temporary branch - may need manual cleanup"
            )
