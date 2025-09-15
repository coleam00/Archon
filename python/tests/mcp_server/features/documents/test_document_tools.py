"""Unit tests for document management tools."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.server.fastmcp import Context

from src.mcp_server.features.documents.document_tools import register_document_tools


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
async def test_create_document_success(mock_mcp, mock_context):
    """Test successful document creation."""
    # Register tools with mock MCP
    register_document_tools(mock_mcp)

    # Get the manage_document function from registered tools
    manage_document = mock_mcp._tools.get("manage_document")
    assert manage_document is not None, "manage_document tool not registered"

    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "document": {"id": "doc-123", "title": "Test Doc"},
        "message": "Document created successfully",
    }

    with patch("src.mcp_server.features.documents.document_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        # Test the function
        result = await manage_document(
            mock_context,
            action="create",
            project_id="project-123",
            title="Test Document",
            document_type="spec",
            content={"test": "content"},
        )

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert result_data["document_id"] == "doc-123"
        assert "Document created successfully" in result_data["message"]


@pytest.mark.asyncio
async def test_find_documents_success(mock_mcp, mock_context):
    """Test successful document listing."""
    register_document_tools(mock_mcp)

    # Get the find_documents function from registered tools
    find_documents = mock_mcp._tools.get("find_documents")
    assert find_documents is not None, "find_documents tool not registered"

    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "documents": [
            {"id": "doc-1", "title": "Doc 1", "document_type": "spec"},
            {"id": "doc-2", "title": "Doc 2", "document_type": "design"},
        ]
    }

    with patch("src.mcp_server.features.documents.document_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_documents(mock_context, project_id="project-123")

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert len(result_data["documents"]) == 2
        assert result_data["count"] == 2


@pytest.mark.asyncio
async def test_update_document_partial_update(mock_mcp, mock_context):
    """Test partial document update."""
    register_document_tools(mock_mcp)

    # Get the manage_document function from registered tools
    manage_document = mock_mcp._tools.get("manage_document")
    assert manage_document is not None, "manage_document tool not registered"

    # Mock HTTP response
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "doc": {"id": "doc-123", "title": "Updated Title"},
        "message": "Document updated successfully",
    }

    with patch("src.mcp_server.features.documents.document_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.put.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        # Update only title
        result = await manage_document(
            mock_context, action="update", project_id="project-123", document_id="doc-123", title="Updated Title"
        )

        result_data = json.loads(result)
        assert result_data["success"] is True
        assert "Document updated successfully" in result_data["message"]

        # Verify only title was sent in update
        call_args = mock_async_client.put.call_args
        sent_data = call_args[1]["json"]
        assert sent_data == {"title": "Updated Title"}


@pytest.mark.asyncio
async def test_delete_document_not_found(mock_mcp, mock_context):
    """Test deleting a non-existent document."""
    register_document_tools(mock_mcp)

    # Get the manage_document function from registered tools
    manage_document = mock_mcp._tools.get("manage_document")
    assert manage_document is not None, "manage_document tool not registered"

    # Mock 404 response
    mock_response = MagicMock()
    mock_response.status_code = 404
    mock_response.text = "Document not found"

    with patch("src.mcp_server.features.documents.document_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.delete.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_document(
            mock_context, action="delete", project_id="project-123", document_id="non-existent"
        )

        result_data = json.loads(result)
        assert result_data["success"] is False
        # Error must be structured format (dict), not string
        assert "error" in result_data
        assert isinstance(result_data["error"], dict), (
            "Error should be structured format, not string"
        )
        assert result_data["error"]["type"] == "http_error"
        assert "404" in result_data["error"]["message"].lower()
