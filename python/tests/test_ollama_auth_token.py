"""
Tests for Ollama Auth Token Fix

Verifies that auth tokens are properly passed through the validation chain:
1. /api/ollama/validate endpoint receives auth token from RAG settings
2. validate_provider_instance() passes auth_token to check_instance_health()
3. check_instance_health() includes auth_token in HTTP requests
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestOllamaAuthTokenValidation:
    """Test suite for Ollama auth token validation flow."""

    @pytest.fixture
    def mock_model_discovery_service(self):
        """Mock the model discovery service."""
        mock_service = MagicMock()
        mock_health_status = MagicMock()
        mock_health_status.is_healthy = True
        mock_health_status.response_time_ms = 50.0
        mock_health_status.models_available = 5
        mock_health_status.error_message = None
        mock_service.check_instance_health = AsyncMock(return_value=mock_health_status)
        return mock_service

    @pytest.fixture
    def mock_credential_service(self):
        """Mock credential service with auth token settings."""
        mock_service = MagicMock()
        mock_service.get_credentials_by_category = AsyncMock(return_value={
            "LLM_BASE_URL": "http://localhost:11434",
            "OLLAMA_EMBEDDING_URL": "http://localhost:11434",
            "OLLAMA_CHAT_AUTH_TOKEN": "test-chat-token",
            "OLLAMA_EMBEDDING_AUTH_TOKEN": "test-embedding-token",
        })
        return mock_service

    @pytest.mark.asyncio
    async def test_validate_provider_instance_passes_auth_token(self, mock_model_discovery_service):
        """Test that validate_provider_instance() passes auth_token to check_instance_health()."""
        from src.server.services.llm_provider_service import validate_provider_instance

        # Patch the model_discovery_service module where it's imported from
        with patch(
            "src.server.services.ollama.model_discovery_service.model_discovery_service",
            mock_model_discovery_service
        ):
            result = await validate_provider_instance(
                provider="ollama",
                instance_url="http://localhost:11434",
                auth_token="test-auth-token"
            )

            # Verify auth_token was passed to check_instance_health
            mock_model_discovery_service.check_instance_health.assert_called_once()
            call_args = mock_model_discovery_service.check_instance_health.call_args

            # Check that auth_token was passed as keyword argument
            assert call_args.kwargs.get("auth_token") == "test-auth-token" or \
                   (len(call_args.args) > 1 and call_args.args[1] == "test-auth-token")

            # Verify result structure
            assert result["provider"] == "ollama"
            assert result["is_available"] is True

    @pytest.mark.asyncio
    async def test_validate_provider_instance_without_auth_token(self, mock_model_discovery_service):
        """Test that validate_provider_instance() works without auth_token."""
        from src.server.services.llm_provider_service import validate_provider_instance

        with patch(
            "src.server.services.ollama.model_discovery_service.model_discovery_service",
            mock_model_discovery_service
        ):
            result = await validate_provider_instance(
                provider="ollama",
                instance_url="http://localhost:11434"
            )

            # Verify check_instance_health was called
            mock_model_discovery_service.check_instance_health.assert_called_once()

            # Verify result
            assert result["provider"] == "ollama"
            assert result["is_available"] is True

    @pytest.mark.asyncio
    async def test_validate_provider_instance_returns_error_on_failure(self, mock_model_discovery_service):
        """Test that validate_provider_instance() handles errors correctly."""
        from src.server.services.llm_provider_service import validate_provider_instance

        # Set up health check to return unhealthy status
        mock_health_status = MagicMock()
        mock_health_status.is_healthy = False
        mock_health_status.response_time_ms = None
        mock_health_status.models_available = 0
        mock_health_status.error_message = "Connection refused"
        mock_model_discovery_service.check_instance_health = AsyncMock(return_value=mock_health_status)

        with patch(
            "src.server.services.ollama.model_discovery_service.model_discovery_service",
            mock_model_discovery_service
        ):
            result = await validate_provider_instance(
                provider="ollama",
                instance_url="http://localhost:11434",
                auth_token="invalid-token"
            )

            # Verify result indicates failure
            assert result["provider"] == "ollama"
            assert result["is_available"] is False
            assert result["error_message"] == "Connection refused"


class TestModelDiscoveryServiceAuthToken:
    """Test suite for model discovery service auth token handling."""

    @pytest.mark.asyncio
    async def test_check_instance_health_includes_auth_header(self):
        """Test that check_instance_health includes Authorization header when token provided."""
        from src.server.services.ollama.model_discovery_service import ModelDiscoveryService

        service = ModelDiscoveryService()

        # Clear any cached health data
        service.health_cache.clear()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)

            # Mock successful response
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"models": []}
            mock_client.get = AsyncMock(return_value=mock_response)

            mock_client_class.return_value = mock_client

            result = await service.check_instance_health(
                instance_url="http://localhost:11434",
                auth_token="my-secret-token"
            )

            # Verify the get request was made
            mock_client.get.assert_called()

            # Check that Authorization header was included
            call_args = mock_client.get.call_args
            headers = call_args.kwargs.get("headers", {})

            # The auth token should be in the headers
            assert "Authorization" in headers
            assert headers["Authorization"] == "Bearer my-secret-token"

    @pytest.mark.asyncio
    async def test_check_instance_health_no_auth_header_when_no_token(self):
        """Test that check_instance_health doesn't include Authorization header when no token."""
        from src.server.services.ollama.model_discovery_service import ModelDiscoveryService

        service = ModelDiscoveryService()
        service.health_cache.clear()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)

            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"models": []}
            mock_client.get = AsyncMock(return_value=mock_response)

            mock_client_class.return_value = mock_client

            result = await service.check_instance_health(
                instance_url="http://localhost:11434"
                # No auth_token provided
            )

            # Verify the get request was made
            mock_client.get.assert_called()

            # Check that no Authorization header was included
            call_args = mock_client.get.call_args
            headers = call_args.kwargs.get("headers", {})

            # Authorization should not be in headers when no token provided
            assert "Authorization" not in headers or headers.get("Authorization") is None
