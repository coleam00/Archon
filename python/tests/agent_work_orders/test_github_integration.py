"""Tests for GitHub Integration"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent_work_orders.github_integration.github_client import GitHubClient
from src.agent_work_orders.models import GitHubOperationError


@pytest.mark.asyncio
async def test_verify_repository_access_success():
    """Test successful repository verification"""
    client = GitHubClient()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 0
    mock_process.communicate = AsyncMock(return_value=(b"Repository info", b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        result = await client.verify_repository_access("https://github.com/owner/repo")

    assert result is True


@pytest.mark.asyncio
async def test_verify_repository_access_failure():
    """Test failed repository verification"""
    client = GitHubClient()

    # Mock subprocess failure
    mock_process = MagicMock()
    mock_process.returncode = 1
    mock_process.communicate = AsyncMock(return_value=(b"", b"Error: Not found"))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        result = await client.verify_repository_access("https://github.com/owner/nonexistent")

    assert result is False


@pytest.mark.asyncio
async def test_get_repository_info_success():
    """Test getting repository information"""
    client = GitHubClient()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 0
    mock_output = b'{"name": "repo", "owner": {"login": "owner"}, "defaultBranchRef": {"name": "main"}}'
    mock_process.communicate = AsyncMock(return_value=(mock_output, b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        repo_info = await client.get_repository_info("https://github.com/owner/repo")

    assert repo_info.name == "repo"
    assert repo_info.owner == "owner"
    assert repo_info.default_branch == "main"
    assert repo_info.url == "https://github.com/owner/repo"


@pytest.mark.asyncio
async def test_get_repository_info_failure():
    """Test failed repository info retrieval"""
    client = GitHubClient()

    # Mock subprocess failure
    mock_process = MagicMock()
    mock_process.returncode = 1
    mock_process.communicate = AsyncMock(return_value=(b"", b"Error: Not found"))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        with pytest.raises(GitHubOperationError):
            await client.get_repository_info("https://github.com/owner/nonexistent")


@pytest.mark.asyncio
async def test_create_pull_request_success():
    """Test successful PR creation"""
    client = GitHubClient()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 0
    mock_process.communicate = AsyncMock(
        return_value=(b"https://github.com/owner/repo/pull/42", b"")
    )

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        pr = await client.create_pull_request(
            repository_url="https://github.com/owner/repo",
            head_branch="feat-wo-test123",
            base_branch="main",
            title="Test PR",
            body="PR body",
        )

    assert pr.pull_request_url == "https://github.com/owner/repo/pull/42"
    assert pr.pull_request_number == 42
    assert pr.title == "Test PR"
    assert pr.head_branch == "feat-wo-test123"
    assert pr.base_branch == "main"


@pytest.mark.asyncio
async def test_create_pull_request_failure():
    """Test failed PR creation"""
    client = GitHubClient()

    # Mock subprocess failure
    mock_process = MagicMock()
    mock_process.returncode = 1
    mock_process.communicate = AsyncMock(return_value=(b"", b"Error: PR creation failed"))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        with pytest.raises(GitHubOperationError):
            await client.create_pull_request(
                repository_url="https://github.com/owner/repo",
                head_branch="feat-wo-test123",
                base_branch="main",
                title="Test PR",
                body="PR body",
            )


def test_parse_repository_url_https():
    """Test parsing HTTPS repository URL"""
    client = GitHubClient()

    owner, repo = client._parse_repository_url("https://github.com/owner/repo")
    assert owner == "owner"
    assert repo == "repo"


def test_parse_repository_url_https_with_git():
    """Test parsing HTTPS repository URL with .git"""
    client = GitHubClient()

    owner, repo = client._parse_repository_url("https://github.com/owner/repo.git")
    assert owner == "owner"
    assert repo == "repo"


def test_parse_repository_url_short_format():
    """Test parsing short format repository URL"""
    client = GitHubClient()

    owner, repo = client._parse_repository_url("owner/repo")
    assert owner == "owner"
    assert repo == "repo"


def test_parse_repository_url_invalid():
    """Test parsing invalid repository URL"""
    client = GitHubClient()

    with pytest.raises(ValueError):
        client._parse_repository_url("invalid-url")

    with pytest.raises(ValueError):
        client._parse_repository_url("owner/repo/extra")


@pytest.mark.asyncio
async def test_get_issue_success():
    """Test successful GitHub issue fetch"""
    client = GitHubClient()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 0
    issue_json = json.dumps({
        "number": 42,
        "title": "Add login feature",
        "body": "Users need to log in with email and password",
        "state": "open",
        "url": "https://github.com/owner/repo/issues/42"
    })
    mock_process.communicate = AsyncMock(return_value=(issue_json.encode(), b""))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        issue_data = await client.get_issue("https://github.com/owner/repo", "42")

    assert issue_data["number"] == 42
    assert issue_data["title"] == "Add login feature"
    assert issue_data["state"] == "open"


@pytest.mark.asyncio
async def test_get_issue_failure():
    """Test failed GitHub issue fetch"""
    client = GitHubClient()

    # Mock subprocess
    mock_process = MagicMock()
    mock_process.returncode = 1
    mock_process.communicate = AsyncMock(return_value=(b"", b"Issue not found"))

    with patch("asyncio.create_subprocess_exec", return_value=mock_process):
        with pytest.raises(GitHubOperationError, match="Failed to fetch issue"):
            await client.get_issue("https://github.com/owner/repo", "999")
