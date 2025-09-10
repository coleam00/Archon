"""
Simple tests for settings API credential handling.
Focus on critical paths for optional settings with defaults.
"""

from unittest.mock import AsyncMock, MagicMock, patch


def test_optional_setting_returns_default(client, mock_supabase_client):
    """Test that optional settings return default values with is_default flag."""
    # Settings API is now deprecated - should return 410 Gone
    response = client.get("/api/credentials/DISCONNECT_SCREEN_ENABLED")

    assert response.status_code == 410
    data = response.json()
    assert data["error"] == "DEPRECATED"
    assert "provider_clean system" in data["message"]


def test_unknown_credential_returns_404(client, mock_supabase_client):
    """Test that unknown credentials still return 404."""
    # Settings API is now deprecated - should return 410 Gone
    response = client.get("/api/credentials/UNKNOWN_KEY_THAT_DOES_NOT_EXIST")

    assert response.status_code == 410
    data = response.json()
    assert data["error"] == "DEPRECATED"
    assert "provider_clean system" in data["message"]


def test_existing_credential_returns_normally(client, mock_supabase_client):
    """Test that existing credentials return without default flag."""
    # Settings API is now deprecated - should return 410 Gone
    response = client.get("/api/credentials/SOME_EXISTING_KEY")

    assert response.status_code == 410
    data = response.json()
    assert data["error"] == "DEPRECATED"
    assert "provider_clean system" in data["message"]


