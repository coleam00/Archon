"""
Unit tests for bug_report_api.py
"""

import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.config.version import GITHUB_REPO_NAME, GITHUB_REPO_OWNER
from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_bug_report():
    """Mock bug report data."""
    return {
        "title": "Test Bug",
        "description": "Test description",
        "stepsToReproduce": "Step 1\nStep 2",
        "expectedBehavior": "Expected result",
        "actualBehavior": "Actual result",
        "severity": "medium",
        "component": "ui",
        "context": {
            "error": {
                "name": "TypeError",
                "message": "Test error",
                "stack": "Test stack trace",
            },
            "app": {
                "version": "0.1.0",
                "url": "http://localhost:3737",
                "timestamp": "2025-10-17T12:00:00Z",
            },
            "system": {
                "platform": "linux",
                "memory": "8GB",
            },
            "services": {
                "server": True,
                "mcp": True,
                "agents": False,
            },
            "logs": ["Log line 1", "Log line 2"],
        },
    }


def test_health_check_with_defaults(client):
    """Test health check returns correct default repository."""
    with patch.dict(os.environ, {}, clear=False):
        # Ensure no GITHUB_TOKEN or GITHUB_REPO env vars
        os.environ.pop("GITHUB_TOKEN", None)
        os.environ.pop("GITHUB_REPO", None)

        response = client.get("/api/bug-report/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "degraded"  # No token
        assert data["github_token_configured"] is False
        assert data["github_repo_configured"] is False
        # Verify it uses the version.py constants
        assert data["repo"] == f"{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}"
        assert data["repo"] == "coleam00/Archon"


def test_health_check_with_github_token(client):
    """Test health check when GitHub token is configured."""
    with patch.dict(os.environ, {"GITHUB_TOKEN": "test-token"}, clear=False):
        os.environ.pop("GITHUB_REPO", None)

        response = client.get("/api/bug-report/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["github_token_configured"] is True
        assert data["github_repo_configured"] is False
        assert data["repo"] == f"{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}"


def test_health_check_with_custom_repo(client):
    """Test health check with custom GITHUB_REPO environment variable."""
    with patch.dict(os.environ, {"GITHUB_REPO": "custom/repo"}, clear=False):
        response = client.get("/api/bug-report/health")

        assert response.status_code == 200
        data = response.json()
        assert data["github_repo_configured"] is True
        assert data["repo"] == "custom/repo"


def test_manual_submission_url_uses_correct_repo(client, mock_bug_report):
    """Test that manual submission URL points to correct repository."""
    with patch.dict(os.environ, {}, clear=False):
        # No GITHUB_TOKEN, should create manual submission URL
        os.environ.pop("GITHUB_TOKEN", None)
        os.environ.pop("GITHUB_REPO", None)

        response = client.post("/api/bug-report/github", json=mock_bug_report)

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["issue_url"] is not None
        # Verify URL contains correct repository
        expected_repo = f"{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}"
        assert expected_repo in data["issue_url"]
        assert "coleam00/Archon" in data["issue_url"]
        # Ensure old repository is NOT in URL
        assert "dynamous-community" not in data["issue_url"]
        assert "Archon-V2-Alpha" not in data["issue_url"]
        # Verify URL contains required parameters including template
        assert "title=" in data["issue_url"]
        assert "body=" in data["issue_url"]
        assert "template=auto_bug_report.md" in data["issue_url"]


def test_api_submission_with_token(client, mock_bug_report):
    """Test bug report submission with GitHub token."""
    mock_response_data = {
        "success": True,
        "issue_number": 123,
        "issue_url": f"https://github.com/{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}/issues/123",
    }

    with patch.dict(os.environ, {"GITHUB_TOKEN": "test-token"}, clear=False):
        with patch("src.server.api_routes.bug_report_api.github_service") as mock_service:
            mock_service.token = "test-token"
            mock_service.repo = f"{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}"
            mock_service.create_issue = AsyncMock(return_value=mock_response_data)

            response = client.post("/api/bug-report/github", json=mock_bug_report)

            assert response.status_code == 200
            data = response.json()
            assert data["success"] is True
            assert data["issue_number"] == 123
            # Verify issue URL contains correct repository
            assert f"{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}" in data["issue_url"]
            # Ensure old repository is NOT in URL
            assert "dynamous-community" not in data["issue_url"]


def test_github_service_initialization():
    """Test GitHubService uses correct default repository."""
    from src.server.api_routes.bug_report_api import GitHubService

    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GITHUB_REPO", None)

        service = GitHubService()

        # Verify service uses version.py constants as default
        expected_repo = f"{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}"
        assert service.repo == expected_repo
        assert service.repo == "coleam00/Archon"
        # Ensure old repository is NOT used
        assert service.repo != "dynamous-community/Archon-V2-Alpha"


def test_github_service_with_custom_repo():
    """Test GitHubService respects GITHUB_REPO environment variable."""
    from src.server.api_routes.bug_report_api import GitHubService

    with patch.dict(os.environ, {"GITHUB_REPO": "custom/repo"}, clear=False):
        service = GitHubService()
        assert service.repo == "custom/repo"
