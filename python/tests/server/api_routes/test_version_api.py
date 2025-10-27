"""
Unit tests for version_api.py
"""

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.config.version import ARCHON_VERSION
from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_version_data():
    """Mock version check data."""
    return {
        "current": ARCHON_VERSION,
        "latest": "0.2.0",
        "update_available": True,
        "release_url": "https://github.com/coleam00/Archon/releases/tag/v0.2.0",
        "release_notes": "New features and bug fixes",
        "published_at": datetime(2025, 1, 1, 0, 0, 0),
        "check_error": None,
        "author": "coleam00",
        "assets": [{"name": "archon.zip", "size": 1024000}],
    }


def test_check_for_updates_success(client, mock_version_data):
    """Test successful version check."""
    with patch("src.server.api_routes.version_api.version_service") as mock_service:
        mock_service.check_for_updates = AsyncMock(return_value=mock_version_data)

        response = client.get("/api/version/check")

        assert response.status_code == 200
        data = response.json()
        assert data["current"] == ARCHON_VERSION
        assert data["latest"] == "0.2.0"
        assert data["update_available"] is True
        assert data["release_url"] == mock_version_data["release_url"]


def test_check_for_updates_no_update(client):
    """Test when no update is available."""
    mock_data = {
        "current": ARCHON_VERSION,
        "latest": ARCHON_VERSION,
        "update_available": False,
        "release_url": None,
        "release_notes": None,
        "published_at": None,
        "check_error": None,
    }

    with patch("src.server.api_routes.version_api.version_service") as mock_service:
        mock_service.check_for_updates = AsyncMock(return_value=mock_data)

        response = client.get("/api/version/check")

        assert response.status_code == 200
        data = response.json()
        assert data["current"] == ARCHON_VERSION
        assert data["latest"] == ARCHON_VERSION
        assert data["update_available"] is False




def test_check_for_updates_with_etag_modified(client, mock_version_data):
    """Test ETag handling when data has changed."""
    with patch("src.server.api_routes.version_api.version_service") as mock_service:
        mock_service.check_for_updates = AsyncMock(return_value=mock_version_data)

        # First request
        response1 = client.get("/api/version/check")
        assert response1.status_code == 200
        old_etag = response1.headers.get("etag")

        # Modify data
        modified_data = mock_version_data.copy()
        modified_data["latest"] = "0.3.0"
        mock_service.check_for_updates = AsyncMock(return_value=modified_data)

        # Second request with old ETag
        response2 = client.get("/api/version/check", headers={"If-None-Match": old_etag})
        assert response2.status_code == 200  # Data changed, return new data
        data = response2.json()
        assert data["latest"] == "0.3.0"


def test_check_for_updates_error_handling(client):
    """Test error handling in version check."""
    with patch("src.server.api_routes.version_api.version_service") as mock_service:
        mock_service.check_for_updates = AsyncMock(side_effect=Exception("API error"))

        response = client.get("/api/version/check")

        assert response.status_code == 200  # Should still return 200
        data = response.json()
        assert data["current"] == ARCHON_VERSION
        assert data["latest"] is None
        assert data["update_available"] is False
        assert data["check_error"] == "API error"


def test_get_current_version(client):
    """Test getting current version."""
    response = client.get("/api/version/current")

    assert response.status_code == 200
    data = response.json()
    assert data["version"] == ARCHON_VERSION
    assert "timestamp" in data


def test_clear_version_cache_success(client):
    """Test clearing version cache."""
    with patch("src.server.api_routes.version_api.version_service") as mock_service:
        mock_service.clear_cache.return_value = None

        response = client.post("/api/version/clear-cache")

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["message"] == "Version cache cleared successfully"
        mock_service.clear_cache.assert_called_once()


def test_clear_version_cache_error(client):
    """Test error handling when clearing cache fails."""
    with patch("src.server.api_routes.version_api.version_service") as mock_service:
        mock_service.clear_cache.side_effect = Exception("Cache error")

        response = client.post("/api/version/clear-cache")

        assert response.status_code == 500
        assert "Failed to clear cache" in response.json()["detail"]