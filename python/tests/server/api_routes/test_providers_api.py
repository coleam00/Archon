"""
Unit tests for providers_api.py
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


def test_get_provider_status_success(client):
    """Test successful provider status check."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        with patch("src.server.api_routes.providers_api.test_openai_connection") as mock_test:
            mock_cred_service.get_credential = AsyncMock(return_value="sk-test-key")
            mock_test.return_value = True

            response = client.get("/api/providers/openai/status")

            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["reason"] == "connected"
            assert data["provider"] == "openai"


def test_get_provider_status_no_key(client):
    """Test provider status when no API key is configured."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        mock_cred_service.get_credential = AsyncMock(return_value=None)

        response = client.get("/api/providers/openai/status")

        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is False
        assert data["reason"] == "no_key"


def test_get_provider_status_connection_failed(client):
    """Test provider status when connection fails."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        with patch("src.server.api_routes.providers_api.test_openai_connection") as mock_test:
            mock_cred_service.get_credential = AsyncMock(return_value="sk-test-key")
            mock_test.return_value = False

            response = client.get("/api/providers/openai/status")

            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is False
            assert data["reason"] == "connection_failed"


def test_get_provider_status_invalid_provider(client):
    """Test provider status with invalid provider name."""
    response = client.get("/api/providers/invalid_provider/status")

    assert response.status_code == 400
    assert "Invalid provider" in response.json()["detail"]


def test_get_provider_status_google(client):
    """Test Google provider status check."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        with patch("src.server.api_routes.providers_api.test_google_connection") as mock_test:
            mock_cred_service.get_credential = AsyncMock(return_value="test-google-key")
            mock_test.return_value = True

            response = client.get("/api/providers/google/status")

            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["provider"] == "google"


def test_get_provider_status_anthropic(client):
    """Test Anthropic provider status check."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        with patch("src.server.api_routes.providers_api.test_anthropic_connection") as mock_test:
            mock_cred_service.get_credential = AsyncMock(return_value="test-anthropic-key")
            mock_test.return_value = True

            response = client.get("/api/providers/anthropic/status")

            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True


def test_get_provider_status_openrouter(client):
    """Test OpenRouter provider status check."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        with patch("src.server.api_routes.providers_api.test_openrouter_connection") as mock_test:
            mock_cred_service.get_credential = AsyncMock(return_value="test-openrouter-key")
            mock_test.return_value = True

            response = client.get("/api/providers/openrouter/status")

            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True


def test_get_provider_status_grok(client):
    """Test Grok provider status check."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        with patch("src.server.api_routes.providers_api.test_grok_connection") as mock_test:
            mock_cred_service.get_credential = AsyncMock(return_value="test-grok-key")
            mock_test.return_value = True

            response = client.get("/api/providers/grok/status")

            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True


def test_provider_status_empty_key(client):
    """Test provider status with empty API key."""
    with patch("src.server.api_routes.providers_api.credential_service") as mock_cred_service:
        mock_cred_service.get_credential = AsyncMock(return_value="   ")  # Empty/whitespace

        response = client.get("/api/providers/openai/status")

        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is False
        assert data["reason"] == "no_key"


def test_provider_status_unsupported_provider(client):
    """Test provider status for unsupported provider."""
    response = client.get("/api/providers/ollama/status")

    # Ollama is in allowed_providers but not in PROVIDER_TESTERS
    assert response.status_code == 400
    assert "not supported for connectivity testing" in response.json()["detail"]
