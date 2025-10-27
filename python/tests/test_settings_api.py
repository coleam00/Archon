"""
Simple tests for settings API credential handling.
Focus on critical paths for optional settings with defaults.
"""

from unittest.mock import AsyncMock, MagicMock, patch


def test_optional_setting_returns_default(client, mock_supabase_client):
    """Test that optional settings return default values with is_default flag."""
    # Mock the entire credential_service instance
    mock_service = MagicMock()
    mock_service.get_credential = AsyncMock(return_value=None)

    with patch("src.server.api_routes.settings_api.credential_service", mock_service):
        response = client.get("/api/credentials/DISCONNECT_SCREEN_ENABLED")

        assert response.status_code == 200
        data = response.json()
        assert data["key"] == "DISCONNECT_SCREEN_ENABLED"
        assert data["value"] == "true"
        assert data["is_default"] is True
        assert "category" in data
        assert "description" in data


def test_unknown_credential_returns_404(client, mock_supabase_client):
    """Test that unknown credentials still return 404."""
    # Mock the entire credential_service instance
    mock_service = MagicMock()
    mock_service.get_credential = AsyncMock(return_value=None)

    with patch("src.server.api_routes.settings_api.credential_service", mock_service):
        response = client.get("/api/credentials/UNKNOWN_KEY_THAT_DOES_NOT_EXIST")

        assert response.status_code == 404
        data = response.json()
        assert "error" in data["detail"]
        assert "not found" in data["detail"]["error"].lower()


def test_existing_credential_returns_normally(client, mock_supabase_client):
    """Test that existing credentials return without default flag."""
    mock_value = "user_configured_value"
    # Mock the entire credential_service instance
    mock_service = MagicMock()
    mock_service.get_credential = AsyncMock(return_value=mock_value)

    with patch("src.server.api_routes.settings_api.credential_service", mock_service):
        response = client.get("/api/credentials/SOME_EXISTING_KEY")

        assert response.status_code == 200
        data = response.json()
        assert data["key"] == "SOME_EXISTING_KEY"
        assert data["value"] == "user_configured_value"
        assert data["is_encrypted"] is False
        # Should not have is_default flag for real credentials
        assert "is_default" not in data


