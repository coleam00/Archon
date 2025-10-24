"""Sandbox Factory

Creates appropriate sandbox instances based on sandbox type.
"""

from ..models import SandboxType
from .git_branch_sandbox import GitBranchSandbox
from .git_worktree_sandbox import GitWorktreeSandbox
from .sandbox_protocol import AgentSandbox


class SandboxFactory:
    """Factory for creating sandbox instances"""

    def create_sandbox(
        self,
        sandbox_type: SandboxType,
        repository_url: str,
        sandbox_identifier: str,
    ) -> AgentSandbox:
        """Create a sandbox instance

        Args:
            sandbox_type: Type of sandbox to create
            repository_url: Git repository URL
            sandbox_identifier: Unique identifier for this sandbox

        Returns:
            AgentSandbox instance

        Raises:
            NotImplementedError: If sandbox type is not yet implemented
        """
        if sandbox_type == SandboxType.GIT_BRANCH:
            return GitBranchSandbox(repository_url, sandbox_identifier)
        elif sandbox_type == SandboxType.GIT_WORKTREE:
            return GitWorktreeSandbox(repository_url, sandbox_identifier)
        elif sandbox_type == SandboxType.E2B:
            raise NotImplementedError("E2B sandbox not implemented (Phase 2+)")
        elif sandbox_type == SandboxType.DAGGER:
            raise NotImplementedError("Dagger sandbox not implemented (Phase 2+)")
        else:
            raise ValueError(f"Unknown sandbox type: {sandbox_type}")
