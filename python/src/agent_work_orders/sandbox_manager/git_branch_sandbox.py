"""Git Branch Sandbox Implementation

Provides isolated execution environment using git branches.
Agent creates the branch during execution (git-first philosophy).
"""

import asyncio
import shutil
import time
from pathlib import Path

from ..config import config
from ..models import CommandExecutionResult, SandboxSetupError
from ..utils.git_operations import get_current_branch
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class GitBranchSandbox:
    """Git branch-based sandbox implementation

    Creates a temporary clone of the repository where the agent
    executes workflows. Agent creates branches during execution.
    """

    def __init__(self, repository_url: str, sandbox_identifier: str):
        self.repository_url = repository_url
        self.sandbox_identifier = sandbox_identifier
        self.working_dir = str(
            config.ensure_temp_dir() / sandbox_identifier
        )
        self._logger = logger.bind(
            sandbox_identifier=sandbox_identifier,
            repository_url=repository_url,
        )

    async def setup(self) -> None:
        """Clone repository to temporary directory

        Does NOT create a branch - agent creates branch during execution.
        """
        self._logger.info("sandbox_setup_started")

        try:
            # Clone repository
            process = await asyncio.create_subprocess_exec(
                "git",
                "clone",
                self.repository_url,
                self.working_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                error_msg = stderr.decode() if stderr else "Unknown git error"
                self._logger.error(
                    "sandbox_setup_failed",
                    error=error_msg,
                    returncode=process.returncode,
                )
                raise SandboxSetupError(f"Failed to clone repository: {error_msg}")

            self._logger.info("sandbox_setup_completed", working_dir=self.working_dir)

        except Exception as e:
            self._logger.error("sandbox_setup_failed", error=str(e), exc_info=True)
            raise SandboxSetupError(f"Sandbox setup failed: {e}") from e

    async def execute_command(
        self, command: str, timeout: int = 300
    ) -> CommandExecutionResult:
        """Execute command in the sandbox directory

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

            # Explicit check for None returncode (should never happen after communicate())
            if process.returncode is None:
                self._logger.error(
                    "command_execution_unexpected_state",
                    command=command,
                    error="process.returncode is None after communicate() - this indicates a serious bug",
                )
                raise RuntimeError(
                    f"Process returncode is None after communicate() for command: {command}. "
                    "This should never happen and indicates a serious issue."
                )

            duration = time.time() - start_time
            exit_code = process.returncode
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
        """Get current git branch name in sandbox

        Returns:
            Current branch name or None
        """
        try:
            return await get_current_branch(self.working_dir)
        except Exception as e:
            self._logger.error("git_branch_query_failed", error=str(e))
            return None

    async def cleanup(self) -> None:
        """Remove temporary sandbox directory"""
        self._logger.info("sandbox_cleanup_started")

        try:
            path = Path(self.working_dir)
            if path.exists():
                shutil.rmtree(path)
                self._logger.info("sandbox_cleanup_completed")
            else:
                self._logger.warning("sandbox_cleanup_skipped", reason="Directory does not exist")
        except Exception as e:
            self._logger.error("sandbox_cleanup_failed", error=str(e), exc_info=True)
