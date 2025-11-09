"""Sandbox Protocol

Defines the interface that all sandbox implementations must follow.
"""

from typing import Protocol

from ..models import CommandExecutionResult


class AgentSandbox(Protocol):
    """Protocol for agent sandbox implementations

    All sandbox types must implement this interface to provide
    isolated execution environments for agents.
    """

    sandbox_identifier: str
    repository_url: str
    working_dir: str

    async def setup(self) -> None:
        """Set up the sandbox environment

        This should prepare the sandbox for agent execution.
        For git-based sandboxes, this typically clones the repository.
        Does NOT create a branch - agent creates branch during execution.
        """
        ...

    async def execute_command(self, command: str, timeout: int = 300) -> CommandExecutionResult:
        """Execute a command in the sandbox

        Args:
            command: Shell command to execute
            timeout: Timeout in seconds

        Returns:
            CommandExecutionResult with execution details
        """
        ...

    async def get_git_branch_name(self) -> str | None:
        """Get the current git branch name

        Returns:
            Current branch name or None if no branch is checked out
        """
        ...

    async def cleanup(self) -> None:
        """Clean up the sandbox environment

        This should remove temporary files and directories.
        """
        ...
