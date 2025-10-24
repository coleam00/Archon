"""GitHub Client

Handles GitHub operations via gh CLI.
"""

import asyncio
import json
import re

from ..config import config
from ..models import GitHubOperationError, GitHubPullRequest, GitHubRepository
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class GitHubClient:
    """GitHub operations using gh CLI"""

    def __init__(self, gh_cli_path: str | None = None):
        self.gh_cli_path = gh_cli_path or config.GH_CLI_PATH
        self._logger = logger

    async def verify_repository_access(self, repository_url: str) -> bool:
        """Check if repository is accessible via gh CLI

        Args:
            repository_url: GitHub repository URL

        Returns:
            True if accessible
        """
        self._logger.info("github_repository_verification_started", repository_url=repository_url)

        try:
            owner, repo = self._parse_repository_url(repository_url)
            repo_path = f"{owner}/{repo}"

            process = await asyncio.create_subprocess_exec(
                self.gh_cli_path,
                "repo",
                "view",
                repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)

            if process.returncode == 0:
                self._logger.info("github_repository_verified", repository_url=repository_url)
                return True
            else:
                error = stderr.decode() if stderr else "Unknown error"
                self._logger.warning(
                    "github_repository_not_accessible",
                    repository_url=repository_url,
                    error=error,
                )
                return False

        except Exception as e:
            self._logger.error(
                "github_repository_verification_failed",
                repository_url=repository_url,
                error=str(e),
                exc_info=True,
            )
            return False

    async def get_repository_info(self, repository_url: str) -> GitHubRepository:
        """Get repository metadata

        Args:
            repository_url: GitHub repository URL

        Returns:
            GitHubRepository with metadata

        Raises:
            GitHubOperationError: If unable to get repository info
        """
        self._logger.info("github_repository_info_started", repository_url=repository_url)

        try:
            owner, repo = self._parse_repository_url(repository_url)
            repo_path = f"{owner}/{repo}"

            process = await asyncio.create_subprocess_exec(
                self.gh_cli_path,
                "repo",
                "view",
                repo_path,
                "--json",
                "name,owner,defaultBranchRef",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)

            if process.returncode != 0:
                error = stderr.decode() if stderr else "Unknown error"
                self._logger.error(
                    "github_repository_info_failed",
                    repository_url=repository_url,
                    error=error,
                )
                raise GitHubOperationError(f"Failed to get repository info: {error}")

            data = json.loads(stdout.decode())

            repo_info = GitHubRepository(
                name=data["name"],
                owner=data["owner"]["login"],
                default_branch=data["defaultBranchRef"]["name"],
                url=repository_url,
            )

            self._logger.info("github_repository_info_completed", repository_url=repository_url)
            return repo_info

        except GitHubOperationError:
            raise
        except Exception as e:
            self._logger.error(
                "github_repository_info_error",
                repository_url=repository_url,
                error=str(e),
                exc_info=True,
            )
            raise GitHubOperationError(f"Failed to get repository info: {e}") from e

    async def get_issue(self, repository_url: str, issue_number: str) -> dict:
        """Get GitHub issue details

        Args:
            repository_url: GitHub repository URL
            issue_number: Issue number

        Returns:
            Issue details as JSON dict

        Raises:
            GitHubOperationError: If unable to fetch issue
        """
        self._logger.info("github_issue_fetch_started", repository_url=repository_url, issue_number=issue_number)

        try:
            owner, repo = self._parse_repository_url(repository_url)
            repo_path = f"{owner}/{repo}"

            process = await asyncio.create_subprocess_exec(
                self.gh_cli_path,
                "issue",
                "view",
                issue_number,
                "--repo",
                repo_path,
                "--json",
                "number,title,body,state,url",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)

            if process.returncode != 0:
                error = stderr.decode() if stderr else "Unknown error"
                raise GitHubOperationError(f"Failed to fetch issue: {error}")

            issue_data: dict = json.loads(stdout.decode())
            self._logger.info("github_issue_fetched", issue_number=issue_number)
            return issue_data

        except Exception as e:
            self._logger.error("github_issue_fetch_failed", error=str(e), exc_info=True)
            raise GitHubOperationError(f"Failed to fetch GitHub issue: {e}") from e

    async def create_pull_request(
        self,
        repository_url: str,
        head_branch: str,
        base_branch: str,
        title: str,
        body: str,
    ) -> GitHubPullRequest:
        """Create pull request via gh CLI

        Args:
            repository_url: GitHub repository URL
            head_branch: Source branch
            base_branch: Target branch
            title: PR title
            body: PR body

        Returns:
            GitHubPullRequest with PR details

        Raises:
            GitHubOperationError: If PR creation fails
        """
        self._logger.info(
            "github_pull_request_creation_started",
            repository_url=repository_url,
            head_branch=head_branch,
            base_branch=base_branch,
        )

        try:
            owner, repo = self._parse_repository_url(repository_url)
            repo_path = f"{owner}/{repo}"

            process = await asyncio.create_subprocess_exec(
                self.gh_cli_path,
                "pr",
                "create",
                "--repo",
                repo_path,
                "--title",
                title,
                "--body",
                body,
                "--head",
                head_branch,
                "--base",
                base_branch,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60)

            if process.returncode != 0:
                error = stderr.decode() if stderr else "Unknown error"
                self._logger.error(
                    "github_pull_request_creation_failed",
                    repository_url=repository_url,
                    error=error,
                )
                raise GitHubOperationError(f"Failed to create pull request: {error}")

            # Parse PR URL from output
            pr_url = stdout.decode().strip()

            # Extract PR number from URL
            pr_number_match = re.search(r"/pull/(\d+)", pr_url)
            pr_number = int(pr_number_match.group(1)) if pr_number_match else 0

            pr = GitHubPullRequest(
                pull_request_url=pr_url,
                pull_request_number=pr_number,
                title=title,
                head_branch=head_branch,
                base_branch=base_branch,
            )

            self._logger.info(
                "github_pull_request_created",
                pr_url=pr_url,
                pr_number=pr_number,
            )

            return pr

        except GitHubOperationError:
            raise
        except Exception as e:
            self._logger.error(
                "github_pull_request_creation_error",
                repository_url=repository_url,
                error=str(e),
                exc_info=True,
            )
            raise GitHubOperationError(f"Failed to create pull request: {e}") from e

    def _parse_repository_url(self, repository_url: str) -> tuple[str, str]:
        """Parse GitHub repository URL

        Args:
            repository_url: GitHub repository URL

        Returns:
            Tuple of (owner, repo)

        Raises:
            ValueError: If URL format is invalid
        """
        # Handle formats:
        # - https://github.com/owner/repo
        # - https://github.com/owner/repo.git
        # - owner/repo

        if "/" not in repository_url:
            raise ValueError("Invalid repository URL format")

        if repository_url.startswith("http"):
            # Extract from URL
            match = re.search(r"github\.com[/:]([^/]+)/([^/\.]+)", repository_url)
            if not match:
                raise ValueError("Invalid GitHub URL format")
            return match.group(1), match.group(2)
        else:
            # Direct owner/repo format
            parts = repository_url.split("/")
            if len(parts) != 2:
                raise ValueError("Invalid repository format, expected owner/repo")
            return parts[0], parts[1]
