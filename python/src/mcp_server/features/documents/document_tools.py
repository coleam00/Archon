"""
Consolidated document management tools for Archon MCP Server.

Reduces the number of individual CRUD operations while maintaining full functionality.
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

# Optimization constants
DEFAULT_PAGE_SIZE = 10

def optimize_document_response(doc: dict) -> dict:
    """Optimize document object for MCP response."""
    doc = doc.copy()  # Don't modify original
    
    # Remove full content in list views
    if "content" in doc:
        del doc["content"]
    
    return doc


def register_document_tools(mcp: FastMCP):
    """Register consolidated document management tools with the MCP server."""

    @mcp.tool()
    async def find_documents(
        ctx: Context,
        project_id: str,
        document_id: str | None = None,  # For getting single document
        query: str | None = None,  # Search capability
        document_type: str | None = None,  # Filter by type
        page: int = 1,
        per_page: int = DEFAULT_PAGE_SIZE,
    ) -> str:
        """
        Find and search documents (consolidated: list + search + get).
        
        Args:
            project_id: Project UUID (required)
            document_id: Get specific document (returns full content)
            query: Search in title/content
            document_type: Filter by type (spec/design/note/prp/api/guide)
            page: Page number for pagination
            per_page: Items per page (default: 10)
        
        Returns:
            JSON array of documents or single document
        
        Examples:
            find_documents(project_id="p-1")  # All project docs
            find_documents(project_id="p-1", query="api")  # Search
            find_documents(project_id="p-1", document_id="d-1")  # Get one
            find_documents(project_id="p-1", document_type="spec")  # Filter
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()
            
            # Single document get mode
            if document_id:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.get(
                        urljoin(api_url, f"/api/projects/{project_id}/docs/{document_id}")
                    )
                    
                    if response.status_code == 200:
                        document = response.json()
                        # Don't optimize single document - return full content
                        return json.dumps({"success": True, "document": document})
                    elif response.status_code == 404:
                        return MCPErrorFormatter.format_error(
                            error_type="not_found",
                            message=f"Document {document_id} not found",
                            suggestion="Verify the document ID is correct",
                            http_status=404,
                        )
                    else:
                        return MCPErrorFormatter.from_http_error(response, "get document")
            
            # List mode
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/projects/{project_id}/docs")
                )
                
                if response.status_code == 200:
                    data = response.json()
                    documents = data.get("documents", [])
                    
                    # Apply filters
                    if document_type:
                        documents = [d for d in documents if d.get("document_type") == document_type]
                    
                    if query:
                        query_lower = query.lower()
                        documents = [
                            d for d in documents
                            if query_lower in d.get("title", "").lower()
                            or query_lower in str(d.get("content", "")).lower()
                        ]
                    
                    # Apply pagination
                    start_idx = (page - 1) * per_page
                    end_idx = start_idx + per_page
                    paginated = documents[start_idx:end_idx]
                    
                    # Optimize document responses - remove content from list views
                    optimized = [optimize_document_response(d) for d in paginated]
                    
                    return json.dumps({
                        "success": True,
                        "documents": optimized,
                        "count": len(optimized),
                        "total": len(documents),
                        "project_id": project_id,
                        "query": query,
                        "document_type": document_type
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "list documents")
                    
        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "list documents")
        except Exception as e:
            logger.error(f"Error listing documents: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "list documents")

    @mcp.tool()
    async def manage_document(
        ctx: Context,
        action: str,  # "create" | "update" | "delete"
        project_id: str,
        document_id: str | None = None,
        title: str | None = None,
        document_type: str | None = None,
        content: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        author: str | None = None,
    ) -> str:
        """
        Manage documents (consolidated: create/update/delete).
        
        Args:
            action: "create" | "update" | "delete"
            project_id: Project UUID (required)
            document_id: Document UUID for update/delete
            title: Document title
            document_type: spec/design/note/prp/api/guide
            content: Structured JSON content
            tags: List of tags (e.g. ["backend", "auth"])
            author: Document author name
        
        Examples:
            manage_document("create", project_id="p-1", title="API Spec", document_type="spec")
            manage_document("update", project_id="p-1", document_id="d-1", content={...})
            manage_document("delete", project_id="p-1", document_id="d-1")
        
        Returns: {success: bool, document?: object, message: string}
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                if action == "create":
                    if not title or not document_type:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "title and document_type required for create"
                        )
                    
                    response = await client.post(
                        urljoin(api_url, f"/api/projects/{project_id}/docs"),
                        json={
                            "title": title,
                            "document_type": document_type,
                            "content": content or {},
                            "tags": tags or [],
                            "author": author or "User",
                        }
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        document = result.get("document")
                        
                        # Don't optimize for create - return full document
                        return json.dumps({
                            "success": True,
                            "document": document,
                            "document_id": document.get("id") if document else None,
                            "message": result.get("message", "Document created successfully")
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "create document")
                        
                elif action == "update":
                    if not document_id:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "document_id required for update"
                        )
                    
                    update_data = {}
                    if title is not None:
                        update_data["title"] = title
                    if content is not None:
                        update_data["content"] = content
                    if tags is not None:
                        update_data["tags"] = tags
                    if author is not None:
                        update_data["author"] = author
                    
                    if not update_data:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "No fields to update"
                        )
                    
                    response = await client.put(
                        urljoin(api_url, f"/api/projects/{project_id}/docs/{document_id}"),
                        json=update_data
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        document = result.get("document")
                        
                        # Don't optimize for update - return full document
                        
                        return json.dumps({
                            "success": True,
                            "document": document,
                            "message": result.get("message", "Document updated successfully")
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "update document")
                        
                elif action == "delete":
                    if not document_id:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "document_id required for delete"
                        )
                    
                    response = await client.delete(
                        urljoin(api_url, f"/api/projects/{project_id}/docs/{document_id}")
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        return json.dumps({
                            "success": True,
                            "message": result.get("message", "Document deleted successfully")
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "delete document")
                        
                else:
                    return MCPErrorFormatter.format_error(
                        "invalid_action",
                        f"Unknown action: {action}"
                    )
                    
        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, f"{action} document")
        except Exception as e:
            logger.error(f"Error managing document ({action}): {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, f"{action} document")
