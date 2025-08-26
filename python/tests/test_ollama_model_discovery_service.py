"""
Comprehensive Tests for Ollama Model Discovery Service

Tests model discovery across multiple instances, caching behavior,
error handling, and capability detection for chat and embedding models.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import aiohttp

from src.server.services.ollama.model_discovery_service import (
    ModelDiscoveryService,
    OllamaModel,
    ModelCapabilities,
    InstanceHealthStatus
)


class TestModelDiscoveryService:
    """Test suite for ModelDiscoveryService"""

    @pytest.fixture
    def mock_session(self):
        """Mock aiohttp session for HTTP requests"""
        mock_session = AsyncMock()
        return mock_session

    @pytest.fixture
    def discovery_service(self):
        """Create ModelDiscoveryService instance for testing"""
        return ModelDiscoveryService()

    @pytest.fixture
    def sample_ollama_models(self):
        """Sample Ollama API response with models"""
        return {
            "models": [
                {
                    "name": "llama2:7b",
                    "size": 3825819519,
                    "digest": "sha256:1a2b3c4d",
                    "details": {
                        "format": "gguf",
                        "family": "llama",
                        "parameter_size": "7B",
                        "quantization_level": "Q4_0"
                    },
                    "modified_at": "2024-01-15T10:30:00Z"
                },
                {
                    "name": "nomic-embed-text:latest",
                    "size": 274301568,
                    "digest": "sha256:5e6f7g8h",
                    "details": {
                        "format": "gguf", 
                        "family": "nomic-embed",
                        "parameter_size": "137M",
                        "quantization_level": "Q4_0"
                    },
                    "modified_at": "2024-01-15T11:45:00Z"
                },
                {
                    "name": "mistral:instruct",
                    "size": 4109364224,
                    "digest": "sha256:9i0j1k2l",
                    "details": {
                        "format": "gguf",
                        "family": "mistral", 
                        "parameter_size": "7B",
                        "quantization_level": "Q4_0"
                    },
                    "modified_at": "2024-01-15T12:00:00Z"
                }
            ]
        }

    @pytest.fixture
    def sample_embedding_test_response(self):
        """Sample embedding test response"""
        return {
            "embedding": [0.1, 0.2, 0.3] * 256  # 768 dimensions
        }

    @pytest.mark.asyncio
    async def test_discover_models_success(self, discovery_service, mock_session, sample_ollama_models):
        """Test successful model discovery from a single instance"""
        instance_url = "http://localhost:11434"
        
        # Mock successful API responses
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_ollama_models)
        mock_session.get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            models = await discovery_service.discover_models(instance_url)
            
        assert len(models) == 3
        
        # Check llama2 model
        llama_model = next(m for m in models if m.name == "llama2:7b")
        assert llama_model.tag == "7b"
        assert llama_model.size == 3825819519
        assert llama_model.digest == "sha256:1a2b3c4d"
        assert llama_model.instance_url == instance_url
        assert llama_model.parameters.family == "llama"
        assert llama_model.parameters.parameter_size == "7B"
        
        # Check embedding model
        embed_model = next(m for m in models if m.name == "nomic-embed-text:latest")
        assert embed_model.tag == "latest"
        assert embed_model.instance_url == instance_url

    @pytest.mark.asyncio
    async def test_discover_models_with_capabilities(self, discovery_service, mock_session, sample_ollama_models, sample_embedding_test_response):
        """Test model discovery with capability detection"""
        instance_url = "http://localhost:11434"
        
        # Mock models list response
        mock_models_response = AsyncMock()
        mock_models_response.status = 200
        mock_models_response.json = AsyncMock(return_value=sample_ollama_models)
        
        # Mock embedding test response
        mock_embed_response = AsyncMock()
        mock_embed_response.status = 200
        mock_embed_response.json = AsyncMock(return_value=sample_embedding_test_response)
        
        # Mock chat test response (success indicates chat capability)
        mock_chat_response = AsyncMock()
        mock_chat_response.status = 200
        mock_chat_response.json = AsyncMock(return_value={"message": {"role": "assistant", "content": "test"}})
        
        # Configure session to return appropriate responses
        def mock_request_side_effect(*args, **kwargs):
            url = args[1] if len(args) > 1 else kwargs.get('url', '')
            if '/api/embeddings' in url:
                return mock_embed_response
            elif '/api/chat' in url:
                return mock_chat_response
            elif '/api/tags' in url:
                return mock_models_response
            else:
                return mock_models_response
        
        mock_session.get.return_value.__aenter__ = AsyncMock(side_effect=mock_request_side_effect)
        mock_session.post.return_value.__aenter__ = AsyncMock(side_effect=mock_request_side_effect)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            models = await discovery_service.discover_models(instance_url, include_capabilities=True)
        
        # Find models with detected capabilities
        llama_model = next(m for m in models if m.name == "llama2:7b")
        embed_model = next(m for m in models if "embed" in m.name)
        
        # llama2 should support chat
        assert ModelCapabilities.CHAT in llama_model.capabilities
        
        # embedding model should support embedding and have dimensions
        assert ModelCapabilities.EMBEDDING in embed_model.capabilities
        assert embed_model.embedding_dimensions == 768

    @pytest.mark.asyncio
    async def test_discover_models_network_error(self, discovery_service, mock_session):
        """Test handling of network errors during discovery"""
        instance_url = "http://unreachable:11434"
        
        # Mock network error
        mock_session.get.side_effect = aiohttp.ClientConnectorError(
            connection_key=None, os_error=None
        )
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(DiscoveryError, match="Failed to connect to Ollama instance"):
                await discovery_service.discover_models(instance_url)

    @pytest.mark.asyncio
    async def test_discover_models_http_error(self, discovery_service, mock_session):
        """Test handling of HTTP errors during discovery"""
        instance_url = "http://localhost:11434"
        
        # Mock HTTP error
        mock_response = AsyncMock()
        mock_response.status = 500
        mock_response.text = AsyncMock(return_value="Internal Server Error")
        mock_session.get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(DiscoveryError, match="HTTP 500"):
                await discovery_service.discover_models(instance_url)

    @pytest.mark.asyncio
    async def test_discover_models_invalid_json(self, discovery_service, mock_session):
        """Test handling of invalid JSON responses"""
        instance_url = "http://localhost:11434"
        
        # Mock invalid JSON response
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json.side_effect = json.JSONDecodeError("Invalid JSON", "", 0)
        mock_session.get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with pytest.raises(DiscoveryError, match="Invalid JSON response"):
                await discovery_service.discover_models(instance_url)

    @pytest.mark.asyncio
    async def test_discover_models_multiple_instances(self, discovery_service, mock_session, sample_ollama_models):
        """Test discovery across multiple instances"""
        instance_urls = ["http://localhost:11434", "http://localhost:11435"]
        
        # Mock different responses for each instance
        def create_response(models):
            mock_response = AsyncMock()
            mock_response.status = 200
            mock_response.json = AsyncMock(return_value=models)
            return mock_response
        
        # First instance has all models, second has subset
        responses = {
            "http://localhost:11434": create_response(sample_ollama_models),
            "http://localhost:11435": create_response({
                "models": sample_ollama_models["models"][:1]  # Only llama2
            })
        }
        
        def mock_get_side_effect(url, **kwargs):
            instance_url = url.rsplit('/api', 1)[0]  # Extract base URL
            return responses[instance_url].__aenter__()
        
        mock_session.get.return_value.__aenter__ = AsyncMock(side_effect=mock_get_side_effect)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            all_models = []
            for url in instance_urls:
                models = await discovery_service.discover_models(url)
                all_models.extend(models)
        
        # Should have models from both instances
        instance1_models = [m for m in all_models if m.instance_url == "http://localhost:11434"]
        instance2_models = [m for m in all_models if m.instance_url == "http://localhost:11435"]
        
        assert len(instance1_models) == 3
        assert len(instance2_models) == 1
        assert instance2_models[0].name == "llama2:7b"

    @pytest.mark.asyncio
    async def test_test_model_capabilities_chat(self, discovery_service, mock_session):
        """Test chat capability detection for a model"""
        instance_url = "http://localhost:11434"
        model_name = "llama2:7b"
        
        # Mock successful chat response
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={
            "message": {"role": "assistant", "content": "Hello! I'm working correctly."}
        })
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            capabilities = await discovery_service.test_model_capabilities(instance_url, model_name)
        
        assert ModelCapabilities.CHAT in capabilities
        assert capabilities[ModelCapabilities.CHAT] is True

    @pytest.mark.asyncio
    async def test_test_model_capabilities_embedding(self, discovery_service, mock_session, sample_embedding_test_response):
        """Test embedding capability detection for a model"""
        instance_url = "http://localhost:11434"
        model_name = "nomic-embed-text:latest"
        
        # Mock successful embedding response
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_embedding_test_response)
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            capabilities = await discovery_service.test_model_capabilities(instance_url, model_name)
        
        assert ModelCapabilities.EMBEDDING in capabilities
        assert capabilities[ModelCapabilities.EMBEDDING] == 768  # Dimension count

    @pytest.mark.asyncio
    async def test_test_model_capabilities_both(self, discovery_service, mock_session, sample_embedding_test_response):
        """Test model that supports both chat and embedding"""
        instance_url = "http://localhost:11434"
        model_name = "universal-model:latest"
        
        # Mock successful responses for both capabilities
        mock_chat_response = AsyncMock()
        mock_chat_response.status = 200
        mock_chat_response.json = AsyncMock(return_value={
            "message": {"role": "assistant", "content": "I support chat"}
        })
        
        mock_embed_response = AsyncMock()
        mock_embed_response.status = 200
        mock_embed_response.json = AsyncMock(return_value=sample_embedding_test_response)
        
        def mock_post_side_effect(url, **kwargs):
            if '/api/embeddings' in url:
                return mock_embed_response.__aenter__()
            elif '/api/chat' in url:
                return mock_chat_response.__aenter__()
            else:
                return mock_chat_response.__aenter__()
        
        mock_session.post.return_value.__aenter__ = AsyncMock(side_effect=mock_post_side_effect)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            capabilities = await discovery_service.test_model_capabilities(instance_url, model_name)
        
        assert ModelCapabilities.CHAT in capabilities
        assert ModelCapabilities.EMBEDDING in capabilities
        assert capabilities[ModelCapabilities.CHAT] is True
        assert capabilities[ModelCapabilities.EMBEDDING] == 768

    @pytest.mark.asyncio
    async def test_test_model_capabilities_failure(self, discovery_service, mock_session):
        """Test capability detection when model doesn't support either capability"""
        instance_url = "http://localhost:11434"
        model_name = "unsupported-model:latest"
        
        # Mock failed responses
        mock_response = AsyncMock()
        mock_response.status = 400
        mock_response.text = AsyncMock(return_value="Model not found")
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            capabilities = await discovery_service.test_model_capabilities(instance_url, model_name)
        
        # Should return empty capabilities dict
        assert capabilities == {}

    @pytest.mark.asyncio
    async def test_health_check_success(self, discovery_service, mock_session):
        """Test successful health check"""
        instance_url = "http://localhost:11434"
        
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"status": "ok"})
        mock_session.get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            result = await discovery_service.health_check(instance_url)
        
        assert result.is_healthy is True
        assert result.response_time_ms > 0
        assert result.error is None

    @pytest.mark.asyncio
    async def test_health_check_failure(self, discovery_service, mock_session):
        """Test health check failure"""
        instance_url = "http://unreachable:11434"
        
        mock_session.get.side_effect = aiohttp.ClientConnectorError(
            connection_key=None, os_error=None
        )
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            result = await discovery_service.health_check(instance_url)
        
        assert result.is_healthy is False
        assert result.error is not None
        assert "connection" in result.error.lower()

    @pytest.mark.asyncio
    async def test_caching_behavior(self, discovery_service, mock_session, sample_ollama_models):
        """Test that model discovery results are cached"""
        instance_url = "http://localhost:11434"
        
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_ollama_models)
        mock_session.get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            # First call should hit the API
            models1 = await discovery_service.discover_models(instance_url, use_cache=True)
            
            # Second call should use cache (no additional HTTP call)
            models2 = await discovery_service.discover_models(instance_url, use_cache=True)
        
        assert len(models1) == len(models2) == 3
        # Should only call the API once due to caching
        assert mock_session.get.call_count == 1

    @pytest.mark.asyncio
    async def test_cache_bypass(self, discovery_service, mock_session, sample_ollama_models):
        """Test cache bypass functionality"""
        instance_url = "http://localhost:11434"
        
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_ollama_models)
        mock_session.get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            # First call with cache
            await discovery_service.discover_models(instance_url, use_cache=True)
            
            # Second call bypassing cache
            await discovery_service.discover_models(instance_url, use_cache=False)
        
        # Should call API twice due to cache bypass
        assert mock_session.get.call_count == 2

    @pytest.mark.asyncio
    async def test_parse_model_name(self, discovery_service):
        """Test model name parsing into name and tag"""
        test_cases = [
            ("llama2:7b", ("llama2", "7b")),
            ("nomic-embed-text:latest", ("nomic-embed-text", "latest")),
            ("mistral", ("mistral", "latest")),  # No tag defaults to latest
            ("custom/model:v1.0", ("custom/model", "v1.0")),
        ]
        
        for full_name, expected in test_cases:
            name, tag = discovery_service._parse_model_name(full_name)
            assert (name, tag) == expected

    def test_validate_instance_url(self, discovery_service):
        """Test instance URL validation"""
        valid_urls = [
            "http://localhost:11434",
            "https://ollama.example.com",
            "http://192.168.1.100:11434",
        ]
        
        invalid_urls = [
            "not-a-url",
            "ftp://invalid.com",
            "http://",
            "",
        ]
        
        for url in valid_urls:
            # Should not raise exception
            discovery_service._validate_instance_url(url)
        
        for url in invalid_urls:
            with pytest.raises(ValueError):
                discovery_service._validate_instance_url(url)