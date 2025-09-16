"""
Comprehensive Tests for Async LLM Provider Service

Tests all aspects of the async LLM provider service after sync function removal.
Covers different providers (OpenAI, Ollama, Google) and error scenarios.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.llm_provider_service import (
    _get_cached_settings,
    _set_cached_settings,
    get_embedding_model,
    get_llm_client,
)


class AsyncContextManager:
    """Helper class for properly mocking async context managers"""

    def __init__(self, return_value):
        self.return_value = return_value

    async def __aenter__(self):
        return self.return_value

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


class TestAsyncLLMProviderService:
    """Test suite for async LLM provider service functions"""

    @pytest.fixture(autouse=True)
    def clear_cache(self):
        """Clear cache before each test"""
        import src.server.services.llm_provider_service as llm_module

        llm_module._settings_cache.clear()
        yield
        llm_module._settings_cache.clear()

    @pytest.fixture
    def mock_credential_service(self):
        """Mock credential service"""
        mock_service = MagicMock()
        mock_service.get_active_provider = AsyncMock()
        mock_service.get_credentials_by_category = AsyncMock()
        mock_service._get_provider_api_key = AsyncMock()
        mock_service._get_provider_base_url = MagicMock()
        return mock_service

    @pytest.fixture
    def openai_provider_config(self):
        """Standard OpenAI provider config"""
        return {
            "provider": "openai",
            "api_key": "test-openai-key",
            "base_url": None,
            "chat_model": "gpt-4.1-nano",
            "embedding_model": "text-embedding-3-small",
        }

    @pytest.fixture
    def ollama_provider_config(self):
        """Standard Ollama provider config"""
        return {
            "provider": "ollama",
            "api_key": "ollama",
            "base_url": "http://localhost:11434/v1",
            "chat_model": "llama2",
            "embedding_model": "nomic-embed-text",
        }

    @pytest.fixture
    def google_provider_config(self):
        """Standard Google provider config"""
        return {
            "provider": "google",
            "api_key": "test-google-key",
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
            "chat_model": "gemini-pro",
            "embedding_model": "text-embedding-004",
        }

    @pytest.mark.asyncio
    async def test_get_llm_client_openai_success(
        self, mock_credential_service, openai_provider_config
    ):
        """Test successful OpenAI client creation"""
        mock_credential_service.get_active_provider.return_value = openai_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                async with get_llm_client() as client:
                    assert client == mock_client
                    mock_openai.assert_called_once_with(api_key="test-openai-key")

                # Verify provider config was fetched
                mock_credential_service.get_active_provider.assert_called_once_with("llm")

    @pytest.mark.asyncio
    async def test_get_llm_client_ollama_success(
        self, mock_credential_service, ollama_provider_config
    ):
        """Test successful Ollama client creation"""
        mock_credential_service.get_active_provider.return_value = ollama_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                async with get_llm_client() as client:
                    assert client == mock_client
                    mock_openai.assert_called_once_with(
                        api_key="ollama", base_url="http://localhost:11434/v1"
                    )

    @pytest.mark.asyncio
    async def test_get_llm_client_google_success(
        self, mock_credential_service, google_provider_config
    ):
        """Test successful Google client creation"""
        mock_credential_service.get_active_provider.return_value = google_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                async with get_llm_client() as client:
                    assert client == mock_client
                    mock_openai.assert_called_once_with(
                        api_key="test-google-key",
                        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
                    )

    @pytest.mark.asyncio
    async def test_get_llm_client_with_provider_override(self, mock_credential_service):
        """Test client creation with explicit provider override (OpenAI)"""
        mock_credential_service._get_provider_api_key.return_value = "override-key"
        mock_credential_service.get_credentials_by_category.return_value = {"LLM_BASE_URL": ""}
        mock_credential_service._get_provider_base_url.return_value = None

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                async with get_llm_client(provider="openai") as client:
                    assert client == mock_client
                    mock_openai.assert_called_once_with(api_key="override-key")

                # Verify explicit provider API key was requested
                mock_credential_service._get_provider_api_key.assert_called_once_with("openai")

    @pytest.mark.asyncio
    async def test_get_llm_client_use_embedding_provider(self, mock_credential_service):
        """Test client creation with embedding provider preference"""
        embedding_config = {
            "provider": "openai",
            "api_key": "embedding-key",
            "base_url": None,
            "chat_model": "gpt-4",
            "embedding_model": "text-embedding-3-large",
        }
        mock_credential_service.get_active_provider.return_value = embedding_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                async with get_llm_client(use_embedding_provider=True) as client:
                    assert client == mock_client
                    mock_openai.assert_called_once_with(api_key="embedding-key")

                # Verify embedding provider was requested
                mock_credential_service.get_active_provider.assert_called_once_with("embedding")

    @pytest.mark.asyncio
    async def test_get_llm_client_missing_openai_key_with_ollama_fallback(self, mock_credential_service):
        """Test successful fallback to Ollama when OpenAI API key is missing"""
        config_without_key = {
            "provider": "openai",
            "api_key": None,
            "base_url": None,
            "chat_model": "gpt-4",
            "embedding_model": "text-embedding-3-small",
        }
        mock_credential_service.get_active_provider.return_value = config_without_key
        mock_credential_service.get_credentials_by_category = AsyncMock(return_value={
            "LLM_BASE_URL": "http://localhost:11434"
        })

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                # Should fallback to Ollama instead of raising an error
                async with get_llm_client() as client:
                    assert client == mock_client
                    # Verify it created an Ollama client with correct params
                    mock_openai.assert_called_once_with(
                        api_key="ollama",
                        base_url="http://localhost:11434/v1"
                    )

    @pytest.mark.asyncio
    async def test_get_llm_client_missing_openai_key(self, mock_credential_service):
        """Test error when OpenAI API key is missing and Ollama fallback fails"""
        config_without_key = {
            "provider": "openai",
            "api_key": None,
            "base_url": None,
            "chat_model": "gpt-4",
            "embedding_model": "text-embedding-3-small",
        }
        mock_credential_service.get_active_provider.return_value = config_without_key
        # Mock get_credentials_by_category to raise an exception, simulating Ollama fallback failure
        mock_credential_service.get_credentials_by_category = AsyncMock(side_effect=Exception("Database error"))

        # Mock openai.AsyncOpenAI to fail when creating Ollama client with fallback URL
        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ), patch("src.server.services.llm_provider_service.openai.AsyncOpenAI") as mock_openai:
            mock_openai.side_effect = Exception("Connection failed")

            with pytest.raises(ValueError, match="OpenAI API key not found and Ollama fallback failed"):
                async with get_llm_client():
                    pass

    @pytest.mark.asyncio
    async def test_get_llm_client_missing_google_key(self, mock_credential_service):
        """Test error handling when Google API key is missing"""
        config_without_key = {
            "provider": "google",
            "api_key": None,
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
            "chat_model": "gemini-pro",
            "embedding_model": "text-embedding-004",
        }
        mock_credential_service.get_active_provider.return_value = config_without_key

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with pytest.raises(ValueError, match="Google API key not found"):
                async with get_llm_client():
                    pass

    @pytest.mark.asyncio
    async def test_get_llm_client_unsupported_provider_error(self, mock_credential_service):
        """Test error when unsupported provider is configured"""
        unsupported_config = {
            "provider": "unsupported",
            "api_key": "some-key",
            "base_url": None,
            "chat_model": "some-model",
            "embedding_model": "",
        }
        mock_credential_service.get_active_provider.return_value = unsupported_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with pytest.raises(ValueError, match="Unsupported LLM provider: unsupported"):
                async with get_llm_client():
                    pass

    @pytest.mark.asyncio
    async def test_get_llm_client_with_unsupported_provider_override(self, mock_credential_service):
        """Test error when unsupported provider is explicitly requested"""
        mock_credential_service._get_provider_api_key.return_value = "some-key"
        mock_credential_service.get_credentials_by_category.return_value = {}
        mock_credential_service._get_provider_base_url.return_value = None

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with pytest.raises(ValueError, match="Unsupported LLM provider: custom-unsupported"):
                async with get_llm_client(provider="custom-unsupported"):
                    pass

    @pytest.mark.asyncio
    async def test_get_embedding_model_openai_success(
        self, mock_credential_service, openai_provider_config
    ):
        """Test getting embedding model for OpenAI provider"""
        mock_credential_service.get_active_provider.return_value = openai_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            model = await get_embedding_model()
            assert model == "text-embedding-3-small"

            mock_credential_service.get_active_provider.assert_called_once_with("embedding")

    @pytest.mark.asyncio
    async def test_get_embedding_model_ollama_success(
        self, mock_credential_service, ollama_provider_config
    ):
        """Test getting embedding model for Ollama provider"""
        mock_credential_service.get_active_provider.return_value = ollama_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            model = await get_embedding_model()
            assert model == "nomic-embed-text"

    @pytest.mark.asyncio
    async def test_get_embedding_model_google_success(
        self, mock_credential_service, google_provider_config
    ):
        """Test getting embedding model for Google provider"""
        mock_credential_service.get_active_provider.return_value = google_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            model = await get_embedding_model()
            assert model == "text-embedding-004"

    @pytest.mark.asyncio
    async def test_get_embedding_model_with_provider_override(self, mock_credential_service):
        """Test getting embedding model with provider override"""
        rag_settings = {"EMBEDDING_MODEL": "custom-embedding-model"}
        mock_credential_service.get_credentials_by_category.return_value = rag_settings

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            model = await get_embedding_model(provider="custom-provider")
            assert model == "custom-embedding-model"

            mock_credential_service.get_credentials_by_category.assert_called_once_with(
                "rag_strategy"
            )

    @pytest.mark.asyncio
    async def test_get_embedding_model_custom_model_override(self, mock_credential_service):
        """Test custom embedding model override"""
        config_with_custom = {
            "provider": "openai",
            "api_key": "test-key",
            "base_url": None,
            "chat_model": "gpt-4",
            "embedding_model": "text-embedding-custom-large",
        }
        mock_credential_service.get_active_provider.return_value = config_with_custom

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            model = await get_embedding_model()
            assert model == "text-embedding-custom-large"

    @pytest.mark.asyncio
    async def test_get_embedding_model_error_fallback(self, mock_credential_service):
        """Test fallback when error occurs getting embedding model"""
        mock_credential_service.get_active_provider.side_effect = Exception("Database error")

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            model = await get_embedding_model()
            # Should fallback to OpenAI default
            assert model == "text-embedding-3-small"

    def test_cache_functionality(self):
        """Test settings cache functionality"""
        # Test setting and getting cache
        test_value = {"test": "data"}
        _set_cached_settings("test_key", test_value)

        cached_result = _get_cached_settings("test_key")
        assert cached_result == test_value

        # Test cache expiry (would require time manipulation in real test)
        # For now just test that non-existent key returns None
        assert _get_cached_settings("non_existent") is None

    @pytest.mark.asyncio
    async def test_cache_usage_in_get_llm_client(
        self, mock_credential_service, openai_provider_config
    ):
        """Test that cache is used to avoid repeated credential service calls"""
        mock_credential_service.get_active_provider.return_value = openai_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                # First call should hit the credential service
                async with get_llm_client():
                    pass

                # Second call should use cache
                async with get_llm_client():
                    pass

                # Should only call get_active_provider once due to caching
                assert mock_credential_service.get_active_provider.call_count == 1

    def test_deprecated_functions_removed(self):
        """Test that deprecated sync functions are no longer available"""
        import src.server.services.llm_provider_service as llm_module

        # These functions should no longer exist
        assert not hasattr(llm_module, "get_llm_client_sync")
        assert not hasattr(llm_module, "get_embedding_model_sync")
        assert not hasattr(llm_module, "_get_active_provider_sync")

        # The async versions should be the primary functions
        assert hasattr(llm_module, "get_llm_client")
        assert hasattr(llm_module, "get_embedding_model")

    @pytest.mark.asyncio
    async def test_context_manager_cleanup(self, mock_credential_service, openai_provider_config):
        """Test that async context manager properly handles cleanup"""
        mock_credential_service.get_active_provider.return_value = openai_provider_config

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                client_ref = None
                async with get_llm_client() as client:
                    client_ref = client
                    assert client == mock_client

                # After context manager exits, should still have reference to client
                assert client_ref == mock_client

    @pytest.mark.asyncio
    async def test_multiple_providers_in_sequence(self, mock_credential_service):
        """Test creating clients for different providers in sequence"""
        configs = [
            {"provider": "openai", "api_key": "openai-key", "base_url": None},
            {"provider": "ollama", "api_key": "ollama", "base_url": "http://localhost:11434/v1"},
            {
                "provider": "google",
                "api_key": "google-key",
                "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
            },
        ]

        with patch(
            "src.server.services.llm_provider_service.credential_service", mock_credential_service
        ):
            with patch(
                "src.server.services.llm_provider_service.openai.AsyncOpenAI"
            ) as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client

                for config in configs:
                    # Clear cache between tests to force fresh credential service calls
                    import src.server.services.llm_provider_service as llm_module

                    llm_module._settings_cache.clear()

                    mock_credential_service.get_active_provider.return_value = config

                    async with get_llm_client() as client:
                        assert client == mock_client

                # Should have been called once for each provider
                assert mock_credential_service.get_active_provider.call_count == 3
