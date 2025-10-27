"""
Unit tests for version_service.py
"""

import json
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.server.config.version import ARCHON_VERSION
from src.server.services.version_service import VersionService


@pytest.fixture
def version_service():
    """Create a fresh version service instance for each test."""
    service = VersionService()
    # Clear any cache from previous tests
    service._cache = None
    service._cache_time = None
    return service


@pytest.fixture
def mock_release_data():
    """Mock GitHub release data."""
    return {
        "tag_name": "v0.2.0",
        "name": "Archon v0.2.0",
        "html_url": "https://github.com/coleam00/Archon/releases/tag/v0.2.0",
        "body": "## Release Notes\n\nNew features and bug fixes",
        "published_at": "2025-01-01T00:00:00Z",
        "author": {"login": "coleam00"},
        "assets": [
            {
                "name": "archon-v0.2.0.zip",
                "size": 1024000,
                "download_count": 100,
                "browser_download_url": "https://github.com/coleam00/Archon/releases/download/v0.2.0/archon-v0.2.0.zip",
                "content_type": "application/zip",
            }
        ],
    }


@pytest.mark.asyncio
async def test_get_latest_release_success(version_service, mock_release_data):
    """Test successful fetching of latest release from GitHub."""
    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_release_data
        mock_client.get.return_value = mock_response
        mock_client_class.return_value.__aenter__.return_value = mock_client

        result = await version_service.get_latest_release()

        assert result == mock_release_data
        assert version_service._cache == mock_release_data
        assert version_service._cache_time is not None


@pytest.mark.asyncio
async def test_get_latest_release_uses_cache(version_service, mock_release_data):
    """Test that cache is used when available and not expired."""
    # Set up cache
    version_service._cache = mock_release_data
    version_service._cache_time = datetime.now()

    with patch("httpx.AsyncClient") as mock_client_class:
        result = await version_service.get_latest_release()

        # Should not make HTTP request
        mock_client_class.assert_not_called()
        assert result == mock_release_data


@pytest.mark.asyncio
async def test_get_latest_release_cache_expired(version_service, mock_release_data):
    """Test that cache is refreshed when expired."""
    # Set up expired cache
    old_data = {"tag_name": "v0.1.0"}
    version_service._cache = old_data
    version_service._cache_time = datetime.now() - timedelta(hours=2)

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_release_data
        mock_client.get.return_value = mock_response
        mock_client_class.return_value.__aenter__.return_value = mock_client

        result = await version_service.get_latest_release()

        # Should make new HTTP request
        mock_client.get.assert_called_once()
        assert result == mock_release_data
        assert version_service._cache == mock_release_data


@pytest.mark.asyncio
async def test_get_latest_release_404(version_service):
    """Test handling of 404 (no releases)."""
    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_client.get.return_value = mock_response
        mock_client_class.return_value.__aenter__.return_value = mock_client

        result = await version_service.get_latest_release()

        assert result is None


@pytest.mark.asyncio
async def test_get_latest_release_timeout(version_service, mock_release_data):
    """Test handling of timeout with cache fallback."""
    # Set up cache
    version_service._cache = mock_release_data
    version_service._cache_time = datetime.now() - timedelta(hours=2)  # Expired

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client.get.side_effect = httpx.TimeoutException("Timeout")
        mock_client_class.return_value.__aenter__.return_value = mock_client

        result = await version_service.get_latest_release()

        # Should return cached data
        assert result == mock_release_data


@pytest.mark.asyncio
async def test_check_for_updates_new_version_available(version_service, mock_release_data):
    """Test when a new version is available."""
    with patch.object(version_service, "get_latest_release", return_value=mock_release_data):
        result = await version_service.check_for_updates()

        assert result["current"] == ARCHON_VERSION
        assert result["latest"] == "0.2.0"
        assert result["update_available"] is True
        assert result["release_url"] == mock_release_data["html_url"]
        assert result["release_notes"] == mock_release_data["body"]
        assert result["published_at"] == datetime.fromisoformat("2025-01-01T00:00:00+00:00")
        assert result["author"] == "coleam00"
        assert len(result["assets"]) == 1


@pytest.mark.asyncio
async def test_check_for_updates_same_version(version_service):
    """Test when current version is up to date."""
    mock_data = {"tag_name": f"v{ARCHON_VERSION}", "html_url": "test_url", "body": "notes"}

    with patch.object(version_service, "get_latest_release", return_value=mock_data):
        result = await version_service.check_for_updates()

        assert result["current"] == ARCHON_VERSION
        assert result["latest"] == ARCHON_VERSION
        assert result["update_available"] is False


@pytest.mark.asyncio
async def test_check_for_updates_no_release(version_service):
    """Test when no releases are found."""
    with patch.object(version_service, "get_latest_release", return_value=None):
        result = await version_service.check_for_updates()

        assert result["current"] == ARCHON_VERSION
        assert result["latest"] is None
        assert result["update_available"] is False
        assert result["release_url"] is None


@pytest.mark.asyncio
async def test_check_for_updates_parse_version(version_service, mock_release_data):
    """Test version parsing with and without 'v' prefix."""
    # Test with 'v' prefix
    mock_release_data["tag_name"] = "v1.2.3"
    with patch.object(version_service, "get_latest_release", return_value=mock_release_data):
        result = await version_service.check_for_updates()
        assert result["latest"] == "1.2.3"

    # Test without 'v' prefix
    mock_release_data["tag_name"] = "2.0.0"
    with patch.object(version_service, "get_latest_release", return_value=mock_release_data):
        result = await version_service.check_for_updates()
        assert result["latest"] == "2.0.0"


@pytest.mark.asyncio
async def test_check_for_updates_missing_fields(version_service):
    """Test handling of incomplete release data."""
    mock_data = {"tag_name": "v0.2.0"}  # Minimal data

    with patch.object(version_service, "get_latest_release", return_value=mock_data):
        result = await version_service.check_for_updates()

        assert result["latest"] == "0.2.0"
        assert result["release_url"] is None
        assert result["release_notes"] is None
        assert result["published_at"] is None
        assert result["author"] is None
        assert result["assets"] == []  # Empty list, not None


def test_clear_cache(version_service, mock_release_data):
    """Test cache clearing."""
    # Set up cache
    version_service._cache = mock_release_data
    version_service._cache_time = datetime.now()

    # Clear cache
    version_service.clear_cache()

    assert version_service._cache is None
    assert version_service._cache_time is None


def test_is_newer_version():
    """Test version comparison logic using the utility function."""
    from src.server.utils.semantic_version import is_newer_version

    # Test various version comparisons
    assert is_newer_version("1.0.0", "2.0.0") is True
    assert is_newer_version("2.0.0", "1.0.0") is False
    assert is_newer_version("1.0.0", "1.0.0") is False
    assert is_newer_version("1.0.0", "1.1.0") is True
    assert is_newer_version("1.0.0", "1.0.1") is True
    assert is_newer_version("1.2.3", "1.2.3") is False