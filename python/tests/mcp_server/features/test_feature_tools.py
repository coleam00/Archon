"""Unit tests for feature management tools."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.server.fastmcp import Context

from src.mcp_server.features.feature_tools import register_feature_tools


@pytest.fixture
def mock_mcp():
    """Create a mock MCP server for testing."""
    mock = MagicMock()
    # Store registered tools
    mock._tools = {}

    def tool_decorator():
        def decorator(func):
            mock._tools[func.__name__] = func
            return func

        return decorator

    mock.tool = tool_decorator
    return mock


@pytest.fixture
def mock_context():
    """Create a mock context for testing."""
    return MagicMock(spec=Context)


@pytest.mark.asyncio
async def test_get_project_features_success(mock_mcp, mock_context):
    """Test successful retrieval of project features."""
    register_feature_tools(mock_mcp)

    # Get the get_project_features function
    get_project_features = mock_mcp._tools.get("get_project_features")

    assert get_project_features is not None, "get_project_features tool not registered"

    # Mock HTTP response with various feature structures
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "features": [
            {"name": "authentication", "status": "completed", "components": ["oauth", "jwt"]},
            {"name": "api", "status": "in_progress", "endpoints_done": 12, "endpoints_total": 20},
            {"name": "database", "status": "planned"},
            {"name": "payments", "provider": "stripe", "version": "2.0", "enabled": True},
        ]
    }

    with patch("src.mcp_server.features.feature_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await get_project_features(mock_context, project_id="project-123")

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["count"] == 4
        assert len(result_data["features"]) == 4

        # Verify different feature structures are preserved
        features = result_data["features"]
        assert features[0]["components"] == ["oauth", "jwt"]
        assert features[1]["endpoints_done"] == 12
        assert features[2]["status"] == "planned"
        assert features[3]["provider"] == "stripe"


@pytest.mark.asyncio
async def test_get_project_features_empty(mock_mcp, mock_context):
    """Test getting features for a project with no features defined."""
    register_feature_tools(mock_mcp)

    get_project_features = mock_mcp._tools.get("get_project_features")

    # Mock response with empty features
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"features": []}

    with patch("src.mcp_server.features.feature_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await get_project_features(mock_context, project_id="project-123")

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["count"] == 0
        assert result_data["features"] == []


@pytest.mark.asyncio
async def test_get_project_features_not_found(mock_mcp, mock_context):
    """Test getting features for a non-existent project."""
    register_feature_tools(mock_mcp)

    get_project_features = mock_mcp._tools.get("get_project_features")

    # Mock 404 response
    mock_response = MagicMock()
    mock_response.status_code = 404
    mock_response.text = "Project not found"

    with patch("src.mcp_server.features.feature_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await get_project_features(mock_context, project_id="non-existent")

        result_data = json.loads(result)
        assert result_data["success"] is False
        # Error must be structured format (dict), not string
        assert "error" in result_data
        assert isinstance(result_data["error"], dict), (
            "Error should be structured format, not string"
        )
        assert result_data["error"]["type"] == "not_found"
        assert "not found" in result_data["error"]["message"].lower()
