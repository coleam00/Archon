"""
Unit tests for mcp_api.py
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from docker.errors import NotFound
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_docker_container():
    """Mock Docker container."""
    container = MagicMock()
    container.status = "running"
    container.attrs = {
        "State": {
            "StartedAt": "2025-01-01T00:00:00Z"
        }
    }
    return container


def test_get_status_running(client, mock_docker_container):
    """Test MCP status when container is running."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        mock_client.containers.get.return_value = mock_docker_container
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/status")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "running"
        assert "uptime" in data


def test_get_status_stopped(client):
    """Test MCP status when container is stopped."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        container = MagicMock()
        container.status = "exited"
        mock_client.containers.get.return_value = container
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/status")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "stopped"


def test_get_status_not_found(client):
    """Test MCP status when container doesn't exist."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        mock_client.containers.get.side_effect = NotFound("Container not found")
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/status")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "not_found"
        assert "not found" in data["message"]


def test_get_status_error(client):
    """Test MCP status when Docker error occurs."""
    with patch("docker.from_env") as mock_docker:
        mock_docker.side_effect = Exception("Docker daemon not running")

        response = client.get("/api/mcp/status")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "error"
        assert "error" in data


def test_get_mcp_config_success(client):
    """Test getting MCP configuration."""
    with patch("src.server.api_routes.mcp_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(return_value="gpt-4o-mini")

        response = client.get("/api/mcp/config")

        assert response.status_code == 200
        data = response.json()
        assert "host" in data
        assert "port" in data
        assert data["transport"] == "streamable-http"
        assert "model_choice" in data


def test_get_mcp_config_default_model(client):
    """Test MCP config with default model fallback."""
    with patch("src.server.api_routes.mcp_api.credential_service") as mock_service:
        mock_service.get_credential = AsyncMock(side_effect=Exception("DB error"))

        response = client.get("/api/mcp/config")

        assert response.status_code == 200
        data = response.json()
        assert data["model_choice"] == "gpt-4o-mini"  # Fallback


def test_get_mcp_config_custom_port(client):
    """Test MCP config with custom port from environment."""
    with patch.dict("os.environ", {"ARCHON_MCP_PORT": "9999"}):
        with patch("src.server.api_routes.mcp_api.credential_service") as mock_service:
            mock_service.get_credential = AsyncMock(return_value="gpt-4")

            response = client.get("/api/mcp/config")

            assert response.status_code == 200
            data = response.json()
            assert data["port"] == 9999


def test_get_mcp_clients(client):
    """Test getting MCP clients."""
    response = client.get("/api/mcp/clients")

    assert response.status_code == 200
    data = response.json()
    assert "clients" in data
    assert "total" in data
    assert data["total"] == 0  # Currently returns empty


def test_get_mcp_sessions_running(client, mock_docker_container):
    """Test getting MCP sessions when server is running."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        mock_client.containers.get.return_value = mock_docker_container
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/sessions")

        assert response.status_code == 200
        data = response.json()
        assert "active_sessions" in data
        assert "session_timeout" in data
        assert "server_uptime_seconds" in data


def test_get_mcp_sessions_stopped(client):
    """Test getting MCP sessions when server is stopped."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        container = MagicMock()
        container.status = "exited"
        mock_client.containers.get.return_value = container
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/sessions")

        assert response.status_code == 200
        data = response.json()
        assert data["active_sessions"] == 0
        # No uptime when stopped
        assert "server_uptime_seconds" not in data


def test_mcp_health(client):
    """Test MCP health check endpoint."""
    response = client.get("/api/mcp/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "mcp"


def test_container_status_cleanup(client):
    """Test that Docker client is properly closed."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        mock_client.containers.get.side_effect = Exception("Test error")
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/status")

        # Should still return a response
        assert response.status_code == 200
        # Verify close was called
        mock_client.close.assert_called()


def test_get_status_uptime_calculation(client):
    """Test uptime calculation in status endpoint."""
    with patch("docker.from_env") as mock_docker:
        mock_client = MagicMock()
        container = MagicMock()
        container.status = "running"
        container.attrs = {
            "State": {
                "StartedAt": "2025-01-01T00:00:00Z"
            }
        }
        mock_client.containers.get.return_value = container
        mock_docker.return_value = mock_client

        response = client.get("/api/mcp/status")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "running"
        # Uptime should be a positive number or None
        if data["uptime"] is not None:
            assert data["uptime"] >= 0
