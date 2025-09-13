"""Unit tests for version management tools."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.server.fastmcp import Context

from src.mcp_server.features.documents.version_tools import register_version_tools


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
async def test_create_version_success(mock_mcp, mock_context):
    """Test successful version creation."""
    register_version_tools(mock_mcp)

    # Get the manage_version function
    manage_version = mock_mcp._tools.get("manage_version")

    assert manage_version is not None, "manage_version tool not registered"

    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "version": {"version_number": 3, "field_name": "docs"},
        "message": "Version created successfully",
    }

    with patch("src.mcp_server.features.documents.version_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_version(
            mock_context,
            action="create",
            project_id="project-123",
            field_name="docs",
            content=[{"id": "doc-1", "title": "Test Doc"}],
            change_summary="Added test document",
        )

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["version"]["version_number"] == 3
        assert "Version created successfully" in result_data["message"]


@pytest.mark.asyncio
async def test_create_version_invalid_field(mock_mcp, mock_context):
    """Test version creation with invalid field name."""
    register_version_tools(mock_mcp)

    manage_version = mock_mcp._tools.get("manage_version")

    # Mock 400 response for invalid field
    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.text = "invalid field_name"

    with patch("src.mcp_server.features.documents.version_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_version(
            mock_context, action="create", project_id="project-123", field_name="invalid", content={"test": "data"}
        )

        result_data = json.loads(result)
        assert result_data["success"] is False
        # Error must be structured format (dict), not string
        assert "error" in result_data
        assert isinstance(result_data["error"], dict), (
            "Error should be structured format, not string"
        )
        assert result_data["error"]["type"] == "http_error"


@pytest.mark.asyncio
async def test_restore_version_success(mock_mcp, mock_context):
    """Test successful version restoration."""
    register_version_tools(mock_mcp)

    # Get the manage_version function
    manage_version = mock_mcp._tools.get("manage_version")

    assert manage_version is not None, "manage_version tool not registered"

    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"message": "Version 2 restored successfully"}

    with patch("src.mcp_server.features.documents.version_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_version(
            mock_context,
            action="restore",
            project_id="project-123",
            field_name="docs",
            version_number=2,
        )

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert "restored successfully" in result_data["message"]


@pytest.mark.asyncio
async def test_find_versions_with_filter(mock_mcp, mock_context):
    """Test listing versions with field name filter."""
    register_version_tools(mock_mcp)

    # Get the find_versions function
    find_versions = mock_mcp._tools.get("find_versions")

    assert find_versions is not None, "find_versions tool not registered"

    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "versions": [
            {"version_number": 1, "field_name": "docs", "change_summary": "Initial"},
            {"version_number": 2, "field_name": "docs", "change_summary": "Updated"},
        ]
    }

    with patch("src.mcp_server.features.documents.version_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_versions(mock_context, project_id="project-123", field_name="docs")

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["count"] == 2
        assert len(result_data["versions"]) == 2

        # Verify filter was passed
        call_args = mock_async_client.get.call_args
        assert call_args[1]["params"]["field_name"] == "docs"
