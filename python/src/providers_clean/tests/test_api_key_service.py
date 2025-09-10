"""Tests for API Key Service."""

import pytest
import os
from unittest.mock import patch
from typing import Dict, Any
from pydantic import SecretStr

from providers_clean.services.api_key_service import APIKeyService
from providers_clean.tests.conftest import MockUnitOfWork


class TestAPIKeyService:
    """Test cases for API Key Service."""

    @pytest.mark.asyncio
    async def test_set_api_key_success(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test successful API key storage."""
        service = APIKeyService(mock_uow)

        result = await service.set_api_key("openai", sample_api_key)

        assert result is True
        # Verify key was stored
        stored_key = await mock_uow.api_keys.get_key("openai")
        assert stored_key is not None
        assert "encrypted_key" in stored_key

    @pytest.mark.asyncio
    async def test_set_api_key_with_base_url(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test API key storage with custom base URL."""
        service = APIKeyService(mock_uow)
        custom_url = "https://custom.openai.com/v1"

        result = await service.set_api_key("openai", sample_api_key, custom_url)

        assert result is True
        stored_key = await mock_uow.api_keys.get_key("openai")
        assert stored_key["metadata"]["base_url"] == custom_url

    @pytest.mark.asyncio
    async def test_get_api_key_success(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test successful API key retrieval."""
        service = APIKeyService(mock_uow)

        # First store the key
        await service.set_api_key("openai", sample_api_key)

        # Then retrieve it
        retrieved_key = await service.get_api_key("openai")

        assert retrieved_key == sample_api_key

    @pytest.mark.asyncio
    async def test_get_api_key_not_found(self, mock_uow: MockUnitOfWork):
        """Test API key retrieval when key doesn't exist."""
        service = APIKeyService(mock_uow)

        result = await service.get_api_key("nonexistent")

        assert result is None

    @pytest.mark.asyncio
    async def test_get_api_key_fallback_to_env(self, mock_uow: MockUnitOfWork):
        """Test fallback to environment variable when key not in database."""
        service = APIKeyService(mock_uow)
        env_key = "sk-env123456789"

        with patch.dict(os.environ, {"OPENAI_API_KEY": env_key}):
            result = await service.get_api_key("openai")

        assert result == env_key

    @pytest.mark.asyncio
    async def test_get_active_providers(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test getting list of active providers."""
        service = APIKeyService(mock_uow)

        # Store keys for multiple providers
        await service.set_api_key("openai", sample_api_key)
        await service.set_api_key("anthropic", "sk-ant-test123")

        providers = await service.get_active_providers()

        assert "openai" in providers
        assert "anthropic" in providers
        assert "ollama" in providers  # Always included

    @pytest.mark.asyncio
    async def test_get_active_providers_with_env(self, mock_uow: MockUnitOfWork):
        """Test active providers includes environment variables."""
        service = APIKeyService(mock_uow)

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
            providers = await service.get_active_providers()

        assert "openai" in providers

    @pytest.mark.asyncio
    async def test_deactivate_api_key(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test API key deactivation."""
        service = APIKeyService(mock_uow)

        # Store and then deactivate
        await service.set_api_key("openai", sample_api_key)
        result = await service.deactivate_api_key("openai")

        assert result is True
        # Verify key is gone
        retrieved = await service.get_api_key("openai")
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_deactivate_nonexistent_key(self, mock_uow: MockUnitOfWork):
        """Test deactivation of non-existent key."""
        service = APIKeyService(mock_uow)

        result = await service.deactivate_api_key("nonexistent")

        assert result is False

    @pytest.mark.asyncio
    async def test_rotate_api_key(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test API key rotation."""
        service = APIKeyService(mock_uow)
        new_key = "sk-new123456789"

        # Store original key
        await service.set_api_key("openai", sample_api_key)

        # Rotate to new key
        result = await service.rotate_api_key("openai", new_key)

        assert result is True
        # Verify new key is stored
        retrieved = await service.get_api_key("openai")
        assert retrieved == new_key

    @pytest.mark.asyncio
    async def test_rotate_nonexistent_key(self, mock_uow: MockUnitOfWork):
        """Test rotation of non-existent key."""
        service = APIKeyService(mock_uow)

        result = await service.rotate_api_key("nonexistent", "new-key")

        assert result is False

    @pytest.mark.asyncio
    async def test_test_provider_key_valid(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test provider key validation for valid key."""
        service = APIKeyService(mock_uow)

        await service.set_api_key("openai", sample_api_key)
        result = await service.test_provider_key("openai")

        assert result is True

    @pytest.mark.asyncio
    async def test_test_provider_key_ollama(self, mock_uow: MockUnitOfWork):
        """Test provider key validation for Ollama (no key required)."""
        service = APIKeyService(mock_uow)

        result = await service.test_provider_key("ollama")

        assert result is True

    @pytest.mark.asyncio
    async def test_test_provider_key_invalid(self, mock_uow: MockUnitOfWork):
        """Test provider key validation for invalid/short key."""
        service = APIKeyService(mock_uow)

        await service.set_api_key("openai", "short")
        result = await service.test_provider_key("openai")

        assert result is False

    @pytest.mark.asyncio
    async def test_setup_environment(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test environment variable setup."""
        service = APIKeyService(mock_uow)

        await service.set_api_key("openai", sample_api_key)
        await service.set_api_key("anthropic", "sk-ant-test123")

        with patch.dict(os.environ, {}, clear=True):
            status = await service.setup_environment()

        assert status["openai"] is True
        assert status["anthropic"] is True
        # SECURITY: API keys are no longer stored in environment variables
        # Only base URLs are set for providers that have them configured
        assert os.environ.get("OPENAI_API_KEY") is None
        assert os.environ.get("ANTHROPIC_API_KEY") is None

    @pytest.mark.asyncio
    async def test_get_provider_config(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test getting full provider configuration."""
        service = APIKeyService(mock_uow)
        custom_url = "https://custom.openai.com/v1"

        await service.set_api_key("openai", sample_api_key, custom_url)
        config = await service.get_provider_config("openai")

        assert config["provider"] == "openai"
        assert config["has_api_key"] is True
        assert isinstance(config["api_key"], SecretStr)
        assert config["api_key"].get_secret_value() == sample_api_key
        assert config["base_url"] == custom_url

    @pytest.mark.asyncio
    async def test_get_provider_config_env_fallback(self, mock_uow: MockUnitOfWork):
        """Test provider config with environment fallback."""
        service = APIKeyService(mock_uow)
        env_key = "sk-env123456789"

        with patch.dict(os.environ, {"OPENAI_API_KEY": env_key}):
            config = await service.get_provider_config("openai")

        assert config["provider"] == "openai"
        assert config["has_api_key"] is True
        assert config["api_key"].get_secret_value() == env_key
        assert config["from_env"] is True

    @pytest.mark.asyncio
    async def test_get_provider_config_no_key(self, mock_uow: MockUnitOfWork):
        """Test provider config when no key exists."""
        service = APIKeyService(mock_uow)

        config = await service.get_provider_config("nonexistent")

        assert config["provider"] == "nonexistent"
        assert config["has_api_key"] is False
        assert config["api_key"] is None

    @pytest.mark.asyncio
    async def test_environment_mappings(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test that all provider environment mappings work."""
        service = APIKeyService(mock_uow)

        test_cases = [
            ("openai", "OPENAI_API_KEY"),
            ("anthropic", "ANTHROPIC_API_KEY"),
            ("groq", "GROQ_API_KEY"),
            ("mistral", "MISTRAL_API_KEY"),
        ]

        for provider, env_var in test_cases:
            await service.set_api_key(provider, sample_api_key)

            with patch.dict(os.environ, {}, clear=True):
                status = await service.setup_environment()

            # SECURITY: API keys are no longer stored in environment variables
            assert status[provider] is True
            assert os.environ.get(env_var) is None

    @pytest.mark.asyncio
    async def test_base_url_mappings(self, mock_uow: MockUnitOfWork, sample_api_key: str):
        """Test that base URL mappings work correctly."""
        service = APIKeyService(mock_uow)

        # Test with custom base URL
        custom_url = "https://custom.openai.com/v1"
        result = await service.set_api_key("openai", sample_api_key, custom_url)

        # Verify the key was stored successfully
        assert result is True

        # Verify we can retrieve the key
        retrieved_key = await service.get_api_key("openai")
        assert retrieved_key == sample_api_key
