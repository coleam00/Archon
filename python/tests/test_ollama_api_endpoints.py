"""
Comprehensive Tests for Ollama API Endpoints

Tests the FastAPI endpoints for Ollama model discovery, health checking,
instance validation, and embedding routing operations.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.api_routes.ollama_api import router


class TestOllamaAPIEndpoints:
    """Test suite for Ollama API endpoints"""

    @pytest.fixture
    def mock_model_discovery_service(self):
        """Mock ModelDiscoveryService for testing"""
        mock_service = MagicMock()
        mock_service.discover_models = AsyncMock()
        mock_service.health_check = AsyncMock()
        mock_service.test_model_capabilities = AsyncMock()
        return mock_service

    @pytest.fixture
    def mock_embedding_router(self):
        """Mock EmbeddingRouter for testing"""
        mock_router = MagicMock()
        mock_router.route_embedding = AsyncMock()
        mock_router.get_embedding_routes_summary = AsyncMock()
        return mock_router

    @pytest.fixture
    def sample_discovered_models(self):
        """Sample model discovery results"""
        return [
            {
                "name": "llama2:7b",
                "tag": "7b", 
                "size": 3825819519,
                "digest": "sha256:abc123",
                "capabilities": ["chat"],
                "embedding_dimensions": None,
                "parameters": {
                    "family": "llama",
                    "parameter_size": "7B",
                    "quantization": "Q4_0"
                },
                "instance_url": "http://localhost:11434",
                "last_updated": "2024-01-15T10:30:00Z"
            },
            {
                "name": "nomic-embed-text:latest",
                "tag": "latest",
                "size": 274301568, 
                "digest": "sha256:def456",
                "capabilities": ["embedding"],
                "embedding_dimensions": 768,
                "parameters": {
                    "family": "nomic-embed",
                    "parameter_size": "137M",
                    "quantization": "Q4_0"
                },
                "instance_url": "http://localhost:11434",
                "last_updated": "2024-01-15T11:45:00Z"
            }
        ]

    @pytest.fixture
    def sample_health_results(self):
        """Sample health check results"""
        return {
            "http://localhost:11434": {
                "is_healthy": True,
                "response_time_ms": 150,
                "models_available": 8,
                "error_message": None,
                "last_checked": "2024-01-15T12:00:00Z"
            },
            "http://localhost:11435": {
                "is_healthy": False,
                "response_time_ms": None,
                "models_available": None,
                "error_message": "Connection timeout",
                "last_checked": "2024-01-15T12:00:00Z"
            }
        }

    @pytest.mark.asyncio
    async def test_discover_models_success(self, client, mock_model_discovery_service, sample_discovered_models):
        """Test successful model discovery endpoint"""
        # Mock the discovery service
        mock_model_discovery_service.discover_models.return_value = sample_discovered_models
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/models?instance_urls=http://localhost:11434")
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["total_models"] == 2
        assert len(data["chat_models"]) == 1
        assert len(data["embedding_models"]) == 1
        
        # Check chat model structure
        chat_model = data["chat_models"][0]
        assert chat_model["name"] == "llama2:7b"
        assert chat_model["instance_url"] == "http://localhost:11434"
        assert chat_model["size"] == 3825819519
        
        # Check embedding model structure
        embedding_model = data["embedding_models"][0]
        assert embedding_model["name"] == "nomic-embed-text:latest"
        assert embedding_model["dimensions"] == 768

    @pytest.mark.asyncio
    async def test_discover_models_multiple_instances(self, client, mock_model_discovery_service):
        """Test model discovery from multiple instances"""
        # Mock different results from different instances
        def mock_discover_side_effect(instance_url, **kwargs):
            if "11434" in instance_url:
                return [
                    {
                        "name": "llama2:7b",
                        "tag": "7b",
                        "size": 3825819519,
                        "digest": "sha256:abc123",
                        "capabilities": ["chat"],
                        "embedding_dimensions": None,
                        "parameters": {"family": "llama"},
                        "instance_url": instance_url,
                        "last_updated": "2024-01-15T10:30:00Z"
                    }
                ]
            else:  # 11435
                return [
                    {
                        "name": "nomic-embed-text:latest",
                        "tag": "latest",
                        "size": 274301568,
                        "digest": "sha256:def456",
                        "capabilities": ["embedding"],
                        "embedding_dimensions": 768,
                        "parameters": {"family": "nomic-embed"},
                        "instance_url": instance_url,
                        "last_updated": "2024-01-15T11:45:00Z"
                    }
                ]
        
        mock_model_discovery_service.discover_models.side_effect = mock_discover_side_effect
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/models?instance_urls=http://localhost:11434&instance_urls=http://localhost:11435")
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["total_models"] == 2
        assert len(data["chat_models"]) == 1
        assert len(data["embedding_models"]) == 1
        
        # Check that models come from different instances
        chat_model = data["chat_models"][0]
        embedding_model = data["embedding_models"][0]
        assert chat_model["instance_url"] != embedding_model["instance_url"]

    @pytest.mark.asyncio
    async def test_discover_models_missing_instance_urls(self, client):
        """Test model discovery with missing instance URLs"""
        response = client.get("/api/ollama/models")
        
        assert response.status_code == 400
        data = response.json()
        assert "At least one instance URL is required" in data["detail"]

    @pytest.mark.asyncio
    async def test_discover_models_invalid_url(self, client, mock_model_discovery_service):
        """Test model discovery with invalid URL"""
        from src.server.services.ollama.model_discovery_service import DiscoveryError
        
        mock_model_discovery_service.discover_models.side_effect = DiscoveryError("Invalid URL format")
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/models?instance_urls=invalid-url")
            
        assert response.status_code == 500
        data = response.json()
        assert "Invalid URL format" in data["detail"]

    @pytest.mark.asyncio
    async def test_health_check_success(self, client, mock_model_discovery_service, sample_health_results):
        """Test successful health check endpoint"""
        def mock_health_check_side_effect(instance_url):
            health_data = sample_health_results.get(instance_url, {})
            result = MagicMock()
            result.is_healthy = health_data.get("is_healthy", False)
            result.response_time_ms = health_data.get("response_time_ms")
            result.error = health_data.get("error_message")
            return result
        
        mock_model_discovery_service.health_check.side_effect = mock_health_check_side_effect
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/instances/health?instance_urls=http://localhost:11434&instance_urls=http://localhost:11435")
            
        assert response.status_code == 200
        data = response.json()
        
        assert "summary" in data
        assert data["summary"]["total_instances"] == 2
        assert data["summary"]["healthy_instances"] == 1
        assert data["summary"]["unhealthy_instances"] == 1
        
        assert "instance_status" in data
        assert len(data["instance_status"]) == 2
        
        # Check healthy instance
        healthy_status = data["instance_status"]["http://localhost:11434"]
        assert healthy_status["is_healthy"] is True
        assert healthy_status["response_time_ms"] == 150
        
        # Check unhealthy instance
        unhealthy_status = data["instance_status"]["http://localhost:11435"]
        assert unhealthy_status["is_healthy"] is False
        assert unhealthy_status["error_message"] == "Connection timeout"

    @pytest.mark.asyncio
    async def test_health_check_with_models(self, client, mock_model_discovery_service):
        """Test health check with model count included"""
        mock_health_result = MagicMock()
        mock_health_result.is_healthy = True
        mock_health_result.response_time_ms = 150
        mock_health_result.error = None
        mock_model_discovery_service.health_check.return_value = mock_health_result
        
        # Mock model discovery for model count
        mock_model_discovery_service.discover_models.return_value = [
            {"name": "model1", "capabilities": ["chat"]},
            {"name": "model2", "capabilities": ["embedding"]}
        ]
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/instances/health?instance_urls=http://localhost:11434&include_models=true")
            
        assert response.status_code == 200
        data = response.json()
        
        # Should include model count
        instance_status = data["instance_status"]["http://localhost:11434"]
        assert "models_available" in instance_status
        assert instance_status["models_available"] == 2

    @pytest.mark.asyncio
    async def test_validate_instance_success(self, client, mock_model_discovery_service):
        """Test successful instance validation"""
        mock_health_result = MagicMock()
        mock_health_result.is_healthy = True
        mock_health_result.response_time_ms = 150
        mock_health_result.error = None
        mock_model_discovery_service.health_check.return_value = mock_health_result
        
        mock_capabilities = {
            "chat": True,
            "embedding": 768
        }
        mock_model_discovery_service.test_model_capabilities.return_value = mock_capabilities
        
        # Mock model discovery for capabilities
        mock_model_discovery_service.discover_models.return_value = [
            {
                "name": "llama2:7b",
                "capabilities": ["chat"],
                "embedding_dimensions": None
            },
            {
                "name": "nomic-embed-text:latest",
                "capabilities": ["embedding"],
                "embedding_dimensions": 768
            }
        ]
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.post("/api/ollama/validate", json={
                "instance_url": "http://localhost:11434",
                "instance_type": "both",
                "timeout_seconds": 30
            })
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["is_valid"] is True
        assert data["instance_url"] == "http://localhost:11434"
        assert data["response_time_ms"] == 150
        assert data["models_available"] == 2
        assert data["error_message"] is None
        
        # Check capabilities
        assert "capabilities" in data
        capabilities = data["capabilities"]
        assert len(capabilities["chat_models"]) == 1
        assert len(capabilities["embedding_models"]) == 1
        assert capabilities["supported_dimensions"] == [768]

    @pytest.mark.asyncio
    async def test_validate_instance_failure(self, client, mock_model_discovery_service):
        """Test instance validation failure"""
        mock_health_result = MagicMock()
        mock_health_result.is_healthy = False
        mock_health_result.response_time_ms = None
        mock_health_result.error = "Connection refused"
        mock_model_discovery_service.health_check.return_value = mock_health_result
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.post("/api/ollama/validate", json={
                "instance_url": "http://unreachable:11434",
                "instance_type": "chat"
            })
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["is_valid"] is False
        assert data["error_message"] == "Connection refused"
        assert data["models_available"] == 0

    @pytest.mark.asyncio
    async def test_analyze_embedding_route_success(self, client, mock_embedding_router):
        """Test successful embedding route analysis"""
        from src.server.services.ollama.embedding_router import RoutingDecision, RoutingStrategy
        
        mock_decision = RoutingDecision(
            model_name="nomic-embed-text:latest",
            instance_url="http://localhost:11434",
            dimensions=768,
            target_column="embedding_768",
            confidence=0.95,
            fallback_applied=False,
            routing_strategy=RoutingStrategy.OPTIMAL,
            performance_score=88.5
        )
        mock_embedding_router.route_embedding.return_value = mock_decision
        
        with patch('src.server.api_routes.ollama_api.EmbeddingRouter', return_value=mock_embedding_router):
            response = client.post("/api/ollama/embedding/route", json={
                "model_name": "nomic-embed-text:latest",
                "instance_url": "http://localhost:11434",
                "text_sample": "Sample text for embedding"
            })
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["model_name"] == "nomic-embed-text:latest"
        assert data["instance_url"] == "http://localhost:11434"
        assert data["dimensions"] == 768
        assert data["target_column"] == "embedding_768"
        assert data["confidence"] == 0.95
        assert data["fallback_applied"] is False
        assert data["routing_strategy"] == "optimal"
        assert data["performance_score"] == 88.5

    @pytest.mark.asyncio
    async def test_analyze_embedding_route_fallback(self, client, mock_embedding_router):
        """Test embedding route analysis with fallback"""
        from src.server.services.ollama.embedding_router import RoutingDecision, RoutingStrategy
        
        mock_decision = RoutingDecision(
            model_name="embed-model:latest",
            instance_url="http://localhost:11435",  # Fallback instance
            dimensions=1536,
            target_column="embedding_1536",
            confidence=0.75,
            fallback_applied=True,
            routing_strategy=RoutingStrategy.FALLBACK,
            performance_score=65.0
        )
        mock_embedding_router.route_embedding.return_value = mock_decision
        
        with patch('src.server.api_routes.ollama_api.EmbeddingRouter', return_value=mock_embedding_router):
            response = client.post("/api/ollama/embedding/route", json={
                "model_name": "embed-model:latest",
                "instance_url": "http://unreachable:11434"
            })
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["fallback_applied"] is True
        assert data["routing_strategy"] == "fallback"
        assert data["instance_url"] == "http://localhost:11435"  # Fallback URL

    @pytest.mark.asyncio
    async def test_get_embedding_routes_success(self, client, mock_embedding_router):
        """Test successful embedding routes retrieval"""
        mock_routes_summary = {
            "total_routes": 2,
            "routes": [
                {
                    "model_name": "nomic-embed-text:latest",
                    "instance_url": "http://localhost:11434",
                    "dimensions": 768,
                    "column_name": "embedding_768",
                    "performance_score": 88.5,
                    "index_type": "ivfflat"
                },
                {
                    "model_name": "text-embedding-ada-002",
                    "instance_url": "http://localhost:11435",
                    "dimensions": 1536,
                    "column_name": "embedding_1536",
                    "performance_score": 92.1,
                    "index_type": "hnsw"
                }
            ],
            "dimension_analysis": {
                "768": {
                    "count": 1,
                    "models": ["nomic-embed-text:latest"],
                    "avg_performance": 88.5
                },
                "1536": {
                    "count": 1,
                    "models": ["text-embedding-ada-002"],
                    "avg_performance": 92.1
                }
            },
            "routing_statistics": {
                "total_routes_created": 2,
                "fallback_routes": 0,
                "optimal_routes": 2
            }
        }
        mock_embedding_router.get_embedding_routes_summary.return_value = mock_routes_summary
        
        with patch('src.server.api_routes.ollama_api.EmbeddingRouter', return_value=mock_embedding_router):
            response = client.get("/api/ollama/embedding/routes?instance_urls=http://localhost:11434&instance_urls=http://localhost:11435")
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["total_routes"] == 2
        assert len(data["routes"]) == 2
        assert "dimension_analysis" in data
        assert "routing_statistics" in data

    @pytest.mark.asyncio
    async def test_clear_cache_success(self, client):
        """Test successful cache clearing"""
        with patch('src.server.api_routes.ollama_api.clear_all_caches') as mock_clear:
            mock_clear.return_value = {"caches_cleared": 3, "total_items_removed": 150}
            
            response = client.delete("/api/ollama/cache")
            
        assert response.status_code == 200
        data = response.json()
        
        assert "message" in data
        assert "successfully cleared" in data["message"].lower()
        mock_clear.assert_called_once()

    @pytest.mark.asyncio
    async def test_error_handling_service_unavailable(self, client, mock_model_discovery_service):
        """Test error handling when services are unavailable"""
        from src.server.services.ollama.model_discovery_service import DiscoveryError
        
        mock_model_discovery_service.discover_models.side_effect = DiscoveryError("Service unavailable")
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/models?instance_urls=http://localhost:11434")
            
        assert response.status_code == 500
        data = response.json()
        assert "Service unavailable" in data["detail"]

    @pytest.mark.asyncio
    async def test_request_validation_errors(self, client):
        """Test request validation errors"""
        # Test missing required fields
        response = client.post("/api/ollama/validate", json={})
        assert response.status_code == 422
        
        # Test invalid instance URL
        response = client.post("/api/ollama/validate", json={
            "instance_url": "not-a-url",
            "instance_type": "chat"
        })
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_concurrent_requests_handling(self, client, mock_model_discovery_service, sample_discovered_models):
        """Test handling of concurrent requests to the same endpoint"""
        import threading
        import time
        
        # Mock service with slight delay to simulate concurrent access
        def mock_discover_with_delay(*args, **kwargs):
            time.sleep(0.1)  # Small delay to simulate processing
            return sample_discovered_models
        
        mock_model_discovery_service.discover_models.side_effect = mock_discover_with_delay
        
        responses = []
        
        def make_request():
            with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
                response = client.get("/api/ollama/models?instance_urls=http://localhost:11434")
                responses.append(response)
        
        # Create multiple concurrent requests
        threads = [threading.Thread(target=make_request) for _ in range(3)]
        
        for thread in threads:
            thread.start()
        
        for thread in threads:
            thread.join()
        
        # All requests should succeed
        assert len(responses) == 3
        for response in responses:
            assert response.status_code == 200
            data = response.json()
            assert data["total_models"] == 2

    @pytest.mark.asyncio
    async def test_response_caching_headers(self, client, mock_model_discovery_service, sample_discovered_models):
        """Test appropriate caching headers in responses"""
        mock_model_discovery_service.discover_models.return_value = sample_discovered_models
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService', return_value=mock_model_discovery_service):
            response = client.get("/api/ollama/models?instance_urls=http://localhost:11434")
            
        assert response.status_code == 200
        
        # Check for appropriate caching headers for model discovery
        # (Model discovery results can be cached briefly)
        headers = response.headers
        assert "cache-control" in headers or "Cache-Control" in headers

    @pytest.mark.asyncio
    async def test_api_versioning_and_compatibility(self, client):
        """Test API versioning and backward compatibility"""
        # Test that the API endpoints are properly versioned under /api/ollama/
        endpoints_to_test = [
            "/api/ollama/models?instance_urls=http://localhost:11434",
            "/api/ollama/instances/health?instance_urls=http://localhost:11434",
            "/api/ollama/embedding/routes?instance_urls=http://localhost:11434"
        ]
        
        with patch('src.server.api_routes.ollama_api.ModelDiscoveryService') as mock_service:
            mock_instance = mock_service.return_value
            mock_instance.discover_models.return_value = []
            mock_instance.health_check.return_value = MagicMock(is_healthy=True, response_time_ms=100, error=None)
            
            with patch('src.server.api_routes.ollama_api.EmbeddingRouter') as mock_router:
                mock_router.return_value.get_embedding_routes_summary.return_value = {
                    "total_routes": 0,
                    "routes": [],
                    "dimension_analysis": {},
                    "routing_statistics": {}
                }
                
                for endpoint in endpoints_to_test:
                    response = client.get(endpoint)
                    # All endpoints should return valid responses (200 or 4xx for validation errors)
                    assert response.status_code in [200, 400, 422]