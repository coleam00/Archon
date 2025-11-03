"""Tests for standalone agent work orders server

Tests the server entry point, health checks, and service discovery configuration.
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.mark.unit
def test_server_health_endpoint():
    """Test health check endpoint returns correct structure"""
    from src.agent_work_orders.server import app

    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()

    assert data["service"] == "agent-work-orders"
    assert data["version"] == "0.1.0"
    assert "status" in data
    assert "dependencies" in data


@pytest.mark.unit
def test_server_root_endpoint():
    """Test root endpoint returns service information"""
    from src.agent_work_orders.server import app

    client = TestClient(app)
    response = client.get("/")

    assert response.status_code == 200
    data = response.json()

    assert data["service"] == "agent-work-orders"
    assert data["version"] == "0.1.0"
    assert "docs" in data
    assert "health" in data
    assert "api" in data


@pytest.mark.unit
@patch("src.agent_work_orders.server.subprocess.run")
@patch.dict("os.environ", {"ENABLE_AGENT_WORK_ORDERS": "true"})
def test_health_check_claude_cli_available(mock_run):
    """Test health check detects Claude CLI availability"""
    from src.agent_work_orders.server import app

    # Mock successful Claude CLI execution
    mock_run.return_value = Mock(returncode=0, stdout="2.0.21\n", stderr="")

    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()

    assert data["dependencies"]["claude_cli"]["available"] is True
    assert "version" in data["dependencies"]["claude_cli"]


@pytest.mark.unit
@patch("src.agent_work_orders.server.subprocess.run")
@patch.dict("os.environ", {"ENABLE_AGENT_WORK_ORDERS": "true"})
def test_health_check_claude_cli_unavailable(mock_run):
    """Test health check handles missing Claude CLI"""
    from src.agent_work_orders.server import app

    # Mock Claude CLI not found
    mock_run.side_effect = FileNotFoundError("claude not found")

    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()

    assert data["dependencies"]["claude_cli"]["available"] is False
    assert "error" in data["dependencies"]["claude_cli"]


@pytest.mark.unit
@patch("src.agent_work_orders.server.shutil.which")
@patch.dict("os.environ", {"ENABLE_AGENT_WORK_ORDERS": "true"})
def test_health_check_git_availability(mock_which):
    """Test health check detects git availability"""
    from src.agent_work_orders.server import app

    # Mock git available
    mock_which.return_value = "/usr/bin/git"

    client = TestClient(app)
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()

    assert data["dependencies"]["git"]["available"] is True


@pytest.mark.unit
@patch("src.agent_work_orders.server.httpx.AsyncClient")
@patch.dict("os.environ", {"ARCHON_SERVER_URL": "http://localhost:8181", "ENABLE_AGENT_WORK_ORDERS": "true"})
async def test_health_check_server_connectivity(mock_client_class):
    """Test health check validates server connectivity"""
    from src.agent_work_orders.server import health_check

    # Mock successful server response
    mock_response = Mock(status_code=200)
    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client_class.return_value.__aenter__.return_value = mock_client

    result = await health_check()

    assert result["dependencies"]["archon_server"]["available"] is True
    assert result["dependencies"]["archon_server"]["url"] == "http://localhost:8181"


@pytest.mark.unit
@patch("src.agent_work_orders.server.httpx.AsyncClient")
@patch.dict("os.environ", {"ARCHON_MCP_URL": "http://localhost:8051", "ENABLE_AGENT_WORK_ORDERS": "true"})
async def test_health_check_mcp_connectivity(mock_client_class):
    """Test health check validates MCP connectivity"""
    from src.agent_work_orders.server import health_check

    # Mock successful MCP response
    mock_response = Mock(status_code=200)
    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client_class.return_value.__aenter__.return_value = mock_client

    result = await health_check()

    assert result["dependencies"]["archon_mcp"]["available"] is True
    assert result["dependencies"]["archon_mcp"]["url"] == "http://localhost:8051"


@pytest.mark.unit
@patch("src.agent_work_orders.server.httpx.AsyncClient")
@patch.dict("os.environ", {"ARCHON_SERVER_URL": "http://localhost:8181", "ENABLE_AGENT_WORK_ORDERS": "true"})
async def test_health_check_server_unavailable(mock_client_class):
    """Test health check handles unavailable server"""
    from src.agent_work_orders.server import health_check

    # Mock connection error
    mock_client = AsyncMock()
    mock_client.get.side_effect = Exception("Connection refused")
    mock_client_class.return_value.__aenter__.return_value = mock_client

    result = await health_check()

    assert result["dependencies"]["archon_server"]["available"] is False
    assert "error" in result["dependencies"]["archon_server"]


@pytest.mark.unit
def test_cors_middleware_configured():
    """Test CORS middleware is properly configured"""
    from src.agent_work_orders.server import app

    # Check CORS middleware is in middleware stack
    middleware_classes = [m.cls.__name__ for m in app.user_middleware]
    assert "CORSMiddleware" in middleware_classes


@pytest.mark.unit
def test_router_included_with_prefix():
    """Test API routes are included with correct prefix"""
    from src.agent_work_orders.server import app

    # Check routes are mounted with /api/agent-work-orders prefix
    routes = [route.path for route in app.routes]
    assert any("/api/agent-work-orders" in route for route in routes)


@pytest.mark.unit
@patch.dict("os.environ", {"SERVICE_DISCOVERY_MODE": "local"})
def test_startup_logs_local_mode(caplog):
    """Test startup logs service discovery mode"""
    from src.agent_work_orders.config import config

    # Verify config is set to local mode
    assert config.SERVICE_DISCOVERY_MODE == "local"


@pytest.mark.unit
@patch.dict("os.environ", {"SERVICE_DISCOVERY_MODE": "docker_compose"})
def test_startup_logs_docker_mode(caplog):
    """Test startup logs docker_compose mode"""
    import importlib

    import src.agent_work_orders.config as config_module
    importlib.reload(config_module)
    from src.agent_work_orders.config import AgentWorkOrdersConfig

    # Create fresh config instance with env var
    config = AgentWorkOrdersConfig()

    # Verify config is set to docker_compose mode
    assert config.SERVICE_DISCOVERY_MODE == "docker_compose"
