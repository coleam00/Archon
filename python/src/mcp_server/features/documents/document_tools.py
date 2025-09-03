"""
Simple document management tools for Archon MCP Server.

Provides separate, focused tools for each document operation.
Supports various document types including specs, designs, notes, and PRPs.
"""

import json
import logging
from typing import Any
from urllib.parse import urljoin

import httpx

from mcp.server.fastmcp import Context, FastMCP
from src.mcp_server.utils.error_handling import MCPErrorFormatter
from src.mcp_server.utils.timeout_config import get_default_timeout
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def register_document_tools(mcp: FastMCP):
    """Register individual document management tools with the MCP server."""

    @mcp.tool()
    async def create_document(
        ctx: Context,
        project_id: str,
        title: str,
        document_type: str,
        content: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        author: str | None = None,
    ) -> str:
        """
        Create a new document with automatic versioning.

        Args:
            project_id: Project UUID (required)
            title: Document title (required)
            document_type: Type of document. Common types:
                - "spec": Technical specifications
                - "design": Design documents
                - "note": General notes
                - "prp": Product requirement prompts
                - "api": API documentation
                - "guide": User guides
            content: Document content as structured JSON (optional).
                     Can be any JSON structure that fits your needs.
            tags: List of tags for categorization (e.g., ["backend", "auth"])
            author: Document author name (optional)

        Returns:
            JSON with document details:
            {
                "success": true,
                "document": {...},
                "document_id": "doc-123",
                "message": "Document created successfully"
            }

        Examples:
            # Create API specification
            create_document(
                project_id="550e8400-e29b-41d4-a716-446655440000",
                title="REST API Specification",
                document_type="spec",
                content={
                    "endpoints": [
                        {"path": "/users", "method": "GET", "description": "List users"},
                        {"path": "/users/{id}", "method": "GET", "description": "Get user"}
                    ],
                    "authentication": "Bearer token",
                    "version": "1.0.0"
                },
                tags=["api", "backend"],
                author="API Team"
            )

            # Create design document
            create_document(
                project_id="550e8400-e29b-41d4-a716-446655440000",
                title="Authentication Flow Design",
                document_type="design",
                content={
                    "overview": "OAuth2 implementation design",
                    "components": ["AuthProvider", "TokenManager", "UserSession"],
                    "flow": {"step1": "Redirect to provider", "step2": "Exchange code"}
                }
            )
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, f"/api/projects/{project_id}/docs"),
                    json={
                        "document_type": document_type,
                        "title": title,
                        "content": content or {},
                        "tags": tags,
                        "author": author,
                    },
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "document": result.get("document"),
                        "document_id": result.get("document", {}).get("id"),
                        "message": result.get("message", "Document created successfully"),
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "create document")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "create document", {"project_id": project_id, "title": title}
            )
        except Exception as e:
            logger.error(f"Error creating document: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "create document")

    @mcp.tool()
    async def list_documents(ctx: Context, project_id: str) -> str:
        """
        List all documents for a project.

        Args:
            project_id: Project UUID (required)

        Returns:
            JSON array of documents

        Example:
            list_documents(project_id="uuid")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                # Pass include_content=False for lightweight response
                response = await client.get(
                    urljoin(api_url, f"/api/projects/{project_id}/docs"),
                    params={"include_content": False}
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "documents": result.get("documents", []),
                        "count": len(result.get("documents", [])),
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "list documents")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "list documents", {"project_id": project_id})
        except Exception as e:
            logger.error(f"Error listing documents: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "list documents")

    @mcp.tool()
    async def get_document(ctx: Context, project_id: str, doc_id: str) -> str:
        """
        Get detailed information about a specific document.

        Args:
            project_id: Project UUID (required)
            doc_id: Document UUID (required)

        Returns:
            JSON with complete document details

        Example:
            get_document(project_id="uuid", doc_id="doc-uuid")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/projects/{project_id}/docs/{doc_id}")
                )

                if response.status_code == 200:
                    document = response.json()
                    return json.dumps({"success": True, "document": document})
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Document {doc_id} not found",
                        suggestion="Verify the document ID is correct and exists in this project",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "get document")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "get document", {"project_id": project_id, "doc_id": doc_id}
            )
        except Exception as e:
            logger.error(f"Error getting document: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "get document")

    @mcp.tool()
    async def update_document(
        ctx: Context,
        project_id: str,
        doc_id: str,
        title: str | None = None,
        content: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        author: str | None = None,
    ) -> str:
        """
        Update a document's properties.

        Args:
            project_id: Project UUID (required)
            doc_id: Document UUID (required)
            title: New document title (optional)
            content: New document content (optional)
            tags: New tags list (optional)
            author: New author (optional)

        Returns:
            JSON with updated document details

        Example:
            update_document(project_id="uuid", doc_id="doc-uuid", title="New Title",
                          content={"updated": "content"})
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            # Build update fields
            update_fields: dict[str, Any] = {}
            if title is not None:
                update_fields["title"] = title
            if content is not None:
                update_fields["content"] = content
            if tags is not None:
                update_fields["tags"] = tags
            if author is not None:
                update_fields["author"] = author

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.put(
                    urljoin(api_url, f"/api/projects/{project_id}/docs/{doc_id}"),
                    json=update_fields,
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "document": result.get("document"),
                        "message": result.get("message", "Document updated successfully"),
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "update document")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "update document", {"project_id": project_id, "doc_id": doc_id}
            )
        except Exception as e:
            logger.error(f"Error updating document: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "update document")

    @mcp.tool()
    async def delete_document(ctx: Context, project_id: str, doc_id: str) -> str:
        """
        Delete a document.

        Args:
            project_id: Project UUID (required)
            doc_id: Document UUID (required)

        Returns:
            JSON confirmation of deletion

        Example:
            delete_document(project_id="uuid", doc_id="doc-uuid")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.delete(
                    urljoin(api_url, f"/api/projects/{project_id}/docs/{doc_id}")
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "message": result.get("message", f"Document {doc_id} deleted successfully"),
                    })
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Document {doc_id} not found",
                        suggestion="Verify the document ID is correct and exists in this project",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "delete document")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "delete document", {"project_id": project_id, "doc_id": doc_id}
            )
        except Exception as e:
            logger.error(f"Error deleting document: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "delete document")
