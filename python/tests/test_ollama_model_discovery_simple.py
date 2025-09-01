"""
Simple Tests for Ollama Model Discovery Service

Basic functionality tests to verify the service initializes and methods exist.
"""

import pytest
from src.server.services.ollama.model_discovery_service import (
    ModelDiscoveryService,
    OllamaModel,
    ModelCapabilities,
    InstanceHealthStatus
)


class TestOllamaModelDiscoverySimple:
    """Simple test suite for ModelDiscoveryService"""
    
    @pytest.fixture
    def discovery_service(self):
        """Create a discovery service instance for testing."""
        return ModelDiscoveryService()
    
    def test_service_initialization(self, discovery_service):
        """Test that service initializes correctly."""
        assert discovery_service is not None
        assert hasattr(discovery_service, 'model_cache')
        assert hasattr(discovery_service, 'cache_ttl')
        assert hasattr(discovery_service, 'health_cache')
    
    def test_models_data_structure(self):
        """Test that data structures can be created."""
        model = OllamaModel(
            name="llama2:7b",
            tag="7b", 
            size=3800000000,
            digest="sha256:abc123",
            capabilities=["chat"],
            instance_url="http://localhost:11434"
        )
        assert model.name == "llama2:7b"
        assert model.instance_url == "http://localhost:11434"
        assert "chat" in model.capabilities
        
        capabilities = ModelCapabilities(
            supports_chat=True,
            supports_embedding=False,
            embedding_dimensions=None,
            parameter_count=7000000000
        )
        assert capabilities.supports_chat is True
        assert capabilities.supports_embedding is False
        
        health = InstanceHealthStatus(
            is_healthy=True,
            response_time_ms=150,
            last_checked="2025-01-15T10:00:00Z"
        )
        assert health.is_healthy is True
        assert health.response_time_ms == 150
    
    def test_service_methods_exist(self, discovery_service):
        """Test that required methods exist on the service."""
        assert hasattr(discovery_service, 'discover_models')
        assert hasattr(discovery_service, 'validate_model_capabilities')
        assert hasattr(discovery_service, 'get_model_info')
        assert hasattr(discovery_service, 'check_instance_health')
        assert hasattr(discovery_service, 'discover_models_from_multiple_instances')
    
    def test_cache_methods_exist(self, discovery_service):
        """Test that cache methods exist."""
        assert hasattr(discovery_service, '_get_cached_models')
        assert hasattr(discovery_service, '_cache_models')