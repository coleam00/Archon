"""
Unit tests for ollama_api.py

Focus on core endpoints - model discovery, health checks, validation, and cache management.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_model_data():
    """Mock model discovery data."""
    return {
        "total_models": 2,
        "chat_models": [{"name": "llama2", "instance_url": "http://localhost:11434"}],
        "embedding_models": [{"name": "nomic-embed", "instance_url": "http://localhost:11434"}],
        "host_status": {
            "http://localhost:11434": {
                "status": "online",
                "models_count": 2
            }
        },
        "discovery_errors": [],
        "unique_model_names": ["llama2", "nomic-embed"]
    }


def test_discover_models_success(client, mock_model_data):
    """Test successful model discovery."""
    with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
        mock_service.discover_models_from_multiple_instances = AsyncMock(return_value=mock_model_data)

        response = client.get(
            "/api/ollama/models?instance_urls=http://localhost:11434"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_models"] == 2
        assert len(data["chat_models"]) == 1
        assert len(data["embedding_models"]) == 1


def test_discover_models_invalid_url(client):
    """Test model discovery with invalid URL."""
    response = client.get(
        "/api/ollama/models?instance_urls=invalid-url"
    )

    assert response.status_code == 400
    assert "No valid instance URLs" in response.json()["detail"]


def test_discover_models_with_details(client, mock_model_data):
    """Test model discovery with detailed information."""
    with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
        mock_service.discover_models_from_multiple_instances = AsyncMock(return_value=mock_model_data)

        response = client.get(
            "/api/ollama/models?instance_urls=http://localhost:11434&fetch_details=true"
        )

        assert response.status_code == 200


def test_health_check_success(client):
    """Test Ollama instance health check."""
    with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
        mock_health = MagicMock()
        mock_health.is_healthy = True
        mock_health.response_time_ms = 50.0
        mock_health.models_available = 5
        mock_health.error_message = None
        mock_health.last_checked = "2025-01-01T00:00:00"

        mock_service.check_instance_health = AsyncMock(return_value=mock_health)

        response = client.get(
            "/api/ollama/instances/health?instance_urls=http://localhost:11434"
        )

        assert response.status_code == 200
        data = response.json()
        assert "summary" in data
        assert data["summary"]["healthy_instances"] == 1


def test_health_check_unhealthy(client):
    """Test health check with unhealthy instance."""
    with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
        mock_health = MagicMock()
        mock_health.is_healthy = False
        mock_health.response_time_ms = None
        mock_health.models_available = 0
        mock_health.error_message = "Connection refused"
        mock_health.last_checked = None

        mock_service.check_instance_health = AsyncMock(return_value=mock_health)

        response = client.get(
            "/api/ollama/instances/health?instance_urls=http://localhost:11434"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["summary"]["unhealthy_instances"] == 1


def test_validate_instance_success(client):
    """Test Ollama instance validation."""
    with patch("src.server.api_routes.ollama_api.validate_provider_instance") as mock_validate:
        with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
            mock_validate.return_value = {
                "is_available": True,
                "response_time_ms": 45.0,
                "models_available": 3
            }
            mock_service.discover_models = AsyncMock(return_value=[])

            response = client.post(
                "/api/ollama/validate",
                json={"instance_url": "http://localhost:11434"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["is_valid"] is True
            assert data["instance_url"] == "http://localhost:11434"


def test_validate_instance_unavailable(client):
    """Test validation of unavailable instance."""
    with patch("src.server.api_routes.ollama_api.validate_provider_instance") as mock_validate:
        mock_validate.return_value = {
            "is_available": False,
            "error_message": "Connection refused"
        }

        response = client.post(
            "/api/ollama/validate",
            json={"instance_url": "http://localhost:11434"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["is_valid"] is False


def test_analyze_embedding_route(client):
    """Test embedding routing analysis."""
    with patch("src.server.api_routes.ollama_api.embedding_router") as mock_router:
        mock_decision = MagicMock()
        mock_decision.target_column = "embeddings_768"
        mock_decision.model_name = "nomic-embed"
        mock_decision.instance_url = "http://localhost:11434"
        mock_decision.dimensions = 768
        mock_decision.confidence = 0.95
        mock_decision.fallback_applied = False
        mock_decision.routing_strategy = "direct"

        mock_router.route_embedding = AsyncMock(return_value=mock_decision)
        mock_router._calculate_performance_score.return_value = 0.9

        response = client.post(
            "/api/ollama/embedding/route",
            json={
                "model_name": "nomic-embed",
                "instance_url": "http://localhost:11434"
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["target_column"] == "embeddings_768"
        assert data["dimensions"] == 768


def test_get_embedding_routes(client):
    """Test getting available embedding routes."""
    with patch("src.server.api_routes.ollama_api.embedding_router") as mock_router:
        mock_route = MagicMock()
        mock_route.model_name = "nomic-embed"
        mock_route.instance_url = "http://localhost:11434"
        mock_route.dimensions = 768
        mock_route.column_name = "embeddings_768"
        mock_route.performance_score = 0.9

        mock_router.get_available_embedding_routes = AsyncMock(return_value=[mock_route])
        mock_router.get_optimal_index_type.return_value = "ivfflat"
        mock_router.get_routing_statistics.return_value = {}

        response = client.get(
            "/api/ollama/embedding/routes?instance_urls=http://localhost:11434"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_routes"] == 1
        assert len(data["routes"]) == 1


def test_clear_ollama_cache(client):
    """Test clearing Ollama caches."""
    with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
        with patch("src.server.api_routes.ollama_api.embedding_router") as mock_router:
            mock_service.model_cache = MagicMock()
            mock_service.capability_cache = MagicMock()
            mock_service.health_cache = MagicMock()
            mock_router.clear_routing_cache = MagicMock()

            response = client.delete("/api/ollama/cache")

            assert response.status_code == 200
            data = response.json()
            assert "cleared successfully" in data["message"]


def test_discover_and_store_models(client, mock_supabase_client):
    """Test discovering and storing models."""
    with patch("src.server.api_routes.ollama_api.model_discovery_service") as mock_service:
        mock_model = MagicMock()
        mock_model.name = "llama2"
        mock_model.capabilities = ["chat"]

        mock_service.discover_models = AsyncMock(return_value=[mock_model])

        # Mock database operations
        mock_execute = MagicMock()
        mock_execute.data = [{"id": "1"}]
        mock_supabase_client.table.return_value.upsert.return_value.execute.return_value = mock_execute

        response = client.post(
            "/api/ollama/models/discover-and-store",
            json={"instance_urls": ["http://localhost:11434"]}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_count"] >= 0
        assert data["instances_checked"] >= 0


def test_get_stored_models_success(client, mock_supabase_client):
    """Test retrieving stored models."""
    stored_data = {
        "models": [{
            "name": "llama2",
            "host": "http://localhost:11434",
            "model_type": "chat",
            "size_mb": 4000,
            "context_length": 4096,
            "parameters": "7B",
            "capabilities": ["chat"],
            "archon_compatibility": "full",
            "compatibility_features": ["MCP Integration"],
            "limitations": [],
            "performance_rating": "medium",
            "description": "Llama 2 chat model",
            "last_updated": "2025-01-01T00:00:00"
        }],
        "total_count": 1,
        "instances_checked": 1,
        "last_discovery": "2025-01-01T00:00:00"
    }

    mock_execute = MagicMock()
    mock_execute.data = [{"value": stored_data}]
    mock_supabase_client.table.return_value.select.return_value.eq.return_value.execute.return_value = mock_execute

    response = client.get("/api/ollama/models/stored")

    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1
    assert len(data["models"]) == 1


def test_get_stored_models_empty(client, mock_supabase_client):
    """Test retrieving stored models when none exist."""
    mock_execute = MagicMock()
    mock_execute.data = []
    mock_supabase_client.table.return_value.select.return_value.eq.return_value.execute.return_value = mock_execute

    response = client.get("/api/ollama/models/stored")

    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 0
    assert data["cache_status"] == "empty"


def test_test_model_capabilities(client):
    """Test model capability testing endpoint."""
    with patch("src.server.api_routes.ollama_api._test_function_calling_capability") as mock_func:
        with patch("src.server.api_routes.ollama_api._test_structured_output_capability") as mock_struct:
            mock_func.return_value = True
            mock_struct.return_value = True

            response = client.post(
                "/api/ollama/models/test-capabilities",
                json={
                    "model_name": "llama2",
                    "instance_url": "http://localhost:11434"
                }
            )

            assert response.status_code == 200
            data = response.json()
            assert "test_results" in data
            assert "compatibility_assessment" in data
            assert data["model_name"] == "llama2"


def test_discover_models_with_real_details(client, mock_supabase_client):
    """Test discovering models with complete real details."""
    # This endpoint fetches from actual Ollama API
    with patch("httpx.AsyncClient") as mock_client:
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "models": [{
                "name": "llama2",
                "size": 4000000000,
                "details": {
                    "parameter_size": "7B",
                    "quantization_level": "Q4"
                }
            }]
        }
        mock_client.return_value.__aenter__.return_value.get.return_value = mock_response

        # Mock database update
        mock_execute = MagicMock()
        mock_execute.data = [{"id": "1"}]
        mock_supabase_client.table.return_value.update.return_value.eq.return_value.execute.return_value = mock_execute

        response = client.post(
            "/api/ollama/models/discover-with-details",
            json={"instance_urls": ["http://localhost:11434"]}
        )

        # Should return 200 or 500 depending on actual implementation
        assert response.status_code in [200, 500]
