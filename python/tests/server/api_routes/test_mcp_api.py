"""
Tests for MCP API endpoints with HTTP and Docker socket modes.
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.server.api_routes.mcp_api import (
    get_container_status,
    get_container_status_docker,
    get_container_status_http,
)
from src.server.config.config import MCPMonitoringConfig


@pytest.fixture
def mock_mcp_url():
    """Mock MCP URL for testing."""
    return "http://test-mcp:8051"


@pytest.fixture
def mock_config_http():
    """Mock configuration with HTTP mode enabled."""
    return MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)


@pytest.fixture
def mock_config_docker():
    """Mock configuration with Docker socket mode enabled."""
    return MCPMonitoringConfig(enable_docker_socket=True, health_check_timeout=5)


# HTTP Mode Tests


@pytest.mark.asyncio
async def test_get_container_status_http_running(mock_mcp_url):
    """Test HTTP health check when MCP server is running."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"success": True, "uptime_seconds": 123.45, "health": {}}
    mock_response.status_code = 200

    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        # Create mock async context manager
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status_http()

        assert result["status"] == "running"
        assert result["uptime"] == 123
        assert result["logs"] == []
        mock_client.get.assert_called_once_with(f"{mock_mcp_url}/health")


@pytest.mark.asyncio
async def test_get_container_status_http_unreachable(mock_mcp_url):
    """Test HTTP health check when MCP server is unreachable."""
    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        # Mock connection error
        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status_http()

        assert result["status"] == "unreachable"
        assert result["uptime"] is None
        assert result["logs"] == []


@pytest.mark.asyncio
async def test_get_container_status_http_timeout(mock_mcp_url):
    """Test HTTP health check when MCP server times out."""
    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        # Mock timeout error
        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("Timeout"))
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status_http()

        assert result["status"] == "unhealthy"
        assert result["uptime"] is None
        assert result["logs"] == []


@pytest.mark.asyncio
async def test_get_container_status_http_unhealthy(mock_mcp_url):
    """Test HTTP health check when MCP server reports unhealthy."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"success": False, "error": "Service unavailable"}
    mock_response.status_code = 200

    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status_http()

        assert result["status"] == "unhealthy"
        assert result["uptime"] is None
        assert result["logs"] == []


@pytest.mark.asyncio
async def test_get_container_status_http_zero_uptime(mock_mcp_url):
    """Test HTTP health check preserves 0 uptime for freshly-launched MCP."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"success": True, "uptime_seconds": 0, "health": {}}
    mock_response.status_code = 200

    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status_http()

        assert result["status"] == "running"
        assert result["uptime"] == 0  # Important: 0 should be preserved, not None
        assert result["logs"] == []
        mock_client.get.assert_called_once_with(f"{mock_mcp_url}/health")


@pytest.mark.asyncio
async def test_get_container_status_http_error(mock_mcp_url):
    """Test HTTP health check when an unexpected error occurs."""
    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        # Mock unexpected error
        mock_client = MagicMock()
        mock_client.get = AsyncMock(side_effect=Exception("Unexpected error"))
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status_http()

        assert result["status"] == "error"
        assert result["uptime"] is None
        assert result["logs"] == []


# Docker Mode Tests


def test_get_container_status_docker_running():
    """Test Docker socket check when container is running."""
    mock_container = MagicMock()
    mock_container.status = "running"
    mock_container.attrs = {
        "State": {"StartedAt": "2025-01-01T00:00:00.000000000Z"},
    }

    mock_docker_client = MagicMock()
    mock_docker_client.containers.get.return_value = mock_container

    # Create mock docker module with errors submodule
    mock_docker = MagicMock()
    mock_docker.from_env.return_value = mock_docker_client
    mock_docker_errors = MagicMock()
    mock_docker_errors.NotFound = type("NotFound", (Exception,), {})

    with patch.dict("sys.modules", {"docker": mock_docker, "docker.errors": mock_docker_errors}):
        result = get_container_status_docker()

        assert result["status"] == "running"
        assert result["uptime"] is not None  # Uptime should be calculated
        assert result["logs"] == []
        mock_docker_client.containers.get.assert_called_once_with("archon-mcp")
        mock_docker_client.close.assert_called_once()


def test_get_container_status_docker_stopped():
    """Test Docker socket check when container is stopped."""
    mock_container = MagicMock()
    mock_container.status = "exited"

    mock_docker_client = MagicMock()
    mock_docker_client.containers.get.return_value = mock_container

    # Create mock docker module with errors submodule
    mock_docker = MagicMock()
    mock_docker.from_env.return_value = mock_docker_client
    mock_docker_errors = MagicMock()
    mock_docker_errors.NotFound = type("NotFound", (Exception,), {})

    with patch.dict("sys.modules", {"docker": mock_docker, "docker.errors": mock_docker_errors}):
        result = get_container_status_docker()

        assert result["status"] == "stopped"
        assert result["uptime"] is None
        assert result["logs"] == []
        mock_docker_client.close.assert_called_once()


def test_get_container_status_docker_not_found():
    """Test Docker socket check when container is not found."""
    # Create a mock NotFound exception
    mock_not_found = type("NotFound", (Exception,), {})

    mock_docker_client = MagicMock()
    mock_docker_client.containers.get.side_effect = mock_not_found("Container not found")

    mock_docker = MagicMock()
    mock_docker.from_env.return_value = mock_docker_client
    mock_docker.errors = MagicMock()
    mock_docker.errors.NotFound = mock_not_found

    with patch.dict("sys.modules", {"docker": mock_docker, "docker.errors": mock_docker.errors}):
        result = get_container_status_docker()

        assert result["status"] == "not_found"
        assert result["uptime"] is None
        assert result["logs"] == []
        assert "message" in result
        mock_docker_client.close.assert_called_once()


def test_get_container_status_docker_error():
    """Test Docker socket check when an error occurs."""
    mock_docker_client = MagicMock()
    mock_docker_client.containers.get.side_effect = Exception("Docker error")

    # Create mock docker module with errors submodule
    mock_docker = MagicMock()
    mock_docker.from_env.return_value = mock_docker_client
    mock_docker_errors = MagicMock()
    mock_docker_errors.NotFound = type("NotFound", (Exception,), {})

    with patch.dict("sys.modules", {"docker": mock_docker, "docker.errors": mock_docker_errors}):
        result = get_container_status_docker()

        assert result["status"] == "error"
        assert result["uptime"] is None
        assert result["logs"] == []
        assert "error" in result
        mock_docker_client.close.assert_called_once()


# Routing Tests


@pytest.mark.asyncio
async def test_get_container_status_routes_to_http(mock_mcp_url):
    """Test that get_container_status routes to HTTP mode by default."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"success": True, "uptime_seconds": 100, "health": {}}
    mock_response.status_code = 200

    with (
        patch("src.server.api_routes.mcp_api.get_mcp_url", return_value=mock_mcp_url),
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch("httpx.AsyncClient") as mock_client_class,
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=False, health_check_timeout=5)

        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client_class.return_value.__aenter__.return_value = mock_client
        mock_client_class.return_value.__aexit__.return_value = None

        result = await get_container_status()

        assert result["status"] == "running"
        assert result["uptime"] == 100
        mock_client.get.assert_called_once()


@pytest.mark.asyncio
async def test_get_container_status_routes_to_docker():
    """Test that get_container_status routes to Docker mode when enabled."""
    mock_container = MagicMock()
    mock_container.status = "running"
    mock_container.attrs = {
        "State": {"StartedAt": "2025-01-01T00:00:00.000000000Z"},
    }

    mock_docker_client = MagicMock()
    mock_docker_client.containers.get.return_value = mock_container

    # Create mock docker module with errors submodule
    mock_docker = MagicMock()
    mock_docker.from_env.return_value = mock_docker_client
    mock_docker_errors = MagicMock()
    mock_docker_errors.NotFound = type("NotFound", (Exception,), {})

    with (
        patch("src.server.api_routes.mcp_api.get_mcp_monitoring_config") as mock_get_config,
        patch.dict("sys.modules", {"docker": mock_docker, "docker.errors": mock_docker_errors}),
    ):
        mock_get_config.return_value = MCPMonitoringConfig(enable_docker_socket=True, health_check_timeout=5)

        result = await get_container_status()

        assert result["status"] == "running"
        mock_docker_client.containers.get.assert_called_once_with("archon-mcp")
        mock_docker_client.close.assert_called_once()


# Environment Variable Tests


@pytest.mark.asyncio
async def test_config_defaults_to_http_mode():
    """Test that configuration defaults to secure HTTP mode."""
    # Clear any environment variables
    os.environ.pop("ENABLE_DOCKER_SOCKET_MONITORING", None)
    os.environ.pop("MCP_HEALTH_CHECK_TIMEOUT", None)

    from src.server.config.config import get_mcp_monitoring_config

    config = get_mcp_monitoring_config()

    assert config.enable_docker_socket is False
    assert config.health_check_timeout == 5


@pytest.mark.asyncio
async def test_config_respects_environment_variables():
    """Test that configuration respects environment variables."""
    os.environ["ENABLE_DOCKER_SOCKET_MONITORING"] = "true"
    os.environ["MCP_HEALTH_CHECK_TIMEOUT"] = "10"

    from src.server.config.config import get_mcp_monitoring_config

    config = get_mcp_monitoring_config()

    assert config.enable_docker_socket is True
    assert config.health_check_timeout == 10

    # Cleanup
    os.environ.pop("ENABLE_DOCKER_SOCKET_MONITORING", None)
    os.environ.pop("MCP_HEALTH_CHECK_TIMEOUT", None)
