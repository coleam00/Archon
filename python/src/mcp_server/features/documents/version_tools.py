"""
Simple version management tools for Archon MCP Server.

Provides separate, focused tools for version control operations.
Supports versioning of documents, features, and other project data.
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


def register_version_tools(mcp: FastMCP):
    """Register individual version management tools with the MCP server."""

    @mcp.tool()
    async def create_version(
        ctx: Context,
        project_id: str,
        field_name: str,
        content: dict[str, Any] | list[dict[str, Any]],
        change_summary: str | None = None,
        document_id: str | None = None,
        created_by: str = "system",
    ) -> str:
        """
        Create a new version snapshot of project data.

        Creates an immutable snapshot that can be restored later. The content format
        depends on which field_name you're versioning.

        Args:
            project_id: Project UUID (e.g., "550e8400-e29b-41d4-a716-446655440000")
            field_name: Which field to version - must be one of:
                - "docs": For document arrays
                - "features": For feature status objects
                - "data": For general data objects
                - "prd": For product requirement documents
            content: Complete content to snapshot. Format depends on field_name:

                For "docs" - pass array of document objects:
                    [{"id": "doc-123", "title": "API Guide", "content": {...}}]

                For "features" - pass dictionary of features:
                    {"auth": {"status": "done"}, "api": {"status": "in_progress"}}

                For "data" - pass any JSON object:
                    {"config": {"theme": "dark"}, "settings": {...}}

                For "prd" - pass PRD object:
                    {"vision": "...", "features": [...], "metrics": [...]}

            change_summary: Description of what changed (e.g., "Added OAuth docs")
            document_id: Optional - for versioning specific doc in docs array
            created_by: Who created this version (default: "system")

        Returns:
            JSON with version details:
            {
                "success": true,
                "version": {"version_number": 3, "field_name": "docs"},
                "message": "Version created successfully"
            }

        Examples:
            # Version documents
            create_version(
                project_id="550e8400-e29b-41d4-a716-446655440000",
                field_name="docs",
                content=[{"id": "doc-1", "title": "Guide", "content": {"text": "..."}}],
                change_summary="Updated user guide"
            )

            # Version features
            create_version(
                project_id="550e8400-e29b-41d4-a716-446655440000",
                field_name="features",
                content={"auth": {"status": "done"}, "api": {"status": "todo"}},
                change_summary="Completed authentication"
            )
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, f"/api/projects/{project_id}/versions"),
                    json={
                        "field_name": field_name,
                        "content": content,
                        "change_summary": change_summary,
                        "change_type": "manual",
                        "document_id": document_id,
                        "created_by": created_by,
                    },
                )

                if response.status_code == 200:
                    result = response.json()
                    version_num = result.get("version", {}).get("version_number")
                    return json.dumps({
                        "success": True,
                        "version": result.get("version"),
                        "version_number": version_num,
                        "message": f"Version {version_num} created successfully for {field_name} field",
                    })
                elif response.status_code == 400:
                    error_text = response.text.lower()
                    if "invalid field_name" in error_text:
                        return MCPErrorFormatter.format_error(
                            error_type="validation_error",
                            message=f"Invalid field_name '{field_name}'. Must be one of: docs, features, data, or prd",
                            suggestion="Use one of the valid field names: docs, features, data, or prd",
                            http_status=400,
                        )
                    elif "content" in error_text and "required" in error_text:
                        return MCPErrorFormatter.format_error(
                            error_type="validation_error",
                            message="Content is required and cannot be empty. Provide the complete data to version.",
                            suggestion="Provide the complete data to version",
                            http_status=400,
                        )
                    elif "format" in error_text or "type" in error_text:
                        if field_name == "docs":
                            return MCPErrorFormatter.format_error(
                                error_type="validation_error",
                                message="For field_name='docs', content must be an array. Example: [{'id': 'doc1', 'title': 'Guide', 'content': {...}}]",
                                suggestion="Ensure content is an array of document objects",
                                http_status=400,
                            )
                        else:
                            return MCPErrorFormatter.format_error(
                                error_type="validation_error",
                                message=f"For field_name='{field_name}', content must be a dictionary/object. Example: {{'key': 'value'}}",
                                suggestion="Ensure content is a dictionary/object",
                                http_status=400,
                            )
                    return MCPErrorFormatter.format_error(
                        error_type="validation_error",
                        message=f"Invalid request: {response.text}",
                        suggestion="Check that all required fields are provided and valid",
                        http_status=400,
                    )
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Project {project_id} not found",
                        suggestion="Please check the project ID is correct",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "create version")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "create version", {"project_id": project_id, "field_name": field_name}
            )
        except Exception as e:
            logger.error(f"Error creating version: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "create version")

    @mcp.tool()
    async def list_versions(ctx: Context, project_id: str, field_name: str | None = None) -> str:
        """
        List version history for a project.

        Args:
            project_id: Project UUID (required)
            field_name: Filter by field name - "docs", "features", "data", "prd" (optional)

        Returns:
            JSON array of versions with metadata

        Example:
            list_versions(project_id="uuid", field_name="docs")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            params = {}
            if field_name:
                params["field_name"] = field_name

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/projects/{project_id}/versions"), params=params
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "versions": result.get("versions", []),
                        "count": len(result.get("versions", [])),
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "list versions")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "list versions", {"project_id": project_id, "field_name": field_name}
            )
        except Exception as e:
            logger.error(f"Error listing versions: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "list versions")

    @mcp.tool()
    async def get_version(
        ctx: Context, project_id: str, field_name: str, version_number: int
    ) -> str:
        """
        Get detailed information about a specific version.

        Args:
            project_id: Project UUID (required)
            field_name: Field name - "docs", "features", "data", "prd" (required)
            version_number: Version number to retrieve (required)

        Returns:
            JSON with complete version details and content

        Example:
            get_version(project_id="uuid", field_name="docs", version_number=3)
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(
                        api_url,
                        f"/api/projects/{project_id}/versions/{field_name}/{version_number}",
                    )
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "version": result.get("version"),
                        "content": result.get("content"),
                    })
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Version {version_number} not found for field {field_name}",
                        suggestion="Check that the version number and field name are correct",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "get version")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e,
                "get version",
                {
                    "project_id": project_id,
                    "field_name": field_name,
                    "version_number": version_number,
                },
            )
        except Exception as e:
            logger.error(f"Error getting version: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "get version")

    @mcp.tool()
    async def restore_version(
        ctx: Context,
        project_id: str,
        field_name: str,
        version_number: int,
        restored_by: str = "system",
    ) -> str:
        """
        Restore a previous version.

        Args:
            project_id: Project UUID (required)
            field_name: Field name - "docs", "features", "data", "prd" (required)
            version_number: Version number to restore (required)
            restored_by: Identifier of who is restoring (optional, defaults to "system")

        Returns:
            JSON confirmation of restoration

        Example:
            restore_version(project_id="uuid", field_name="docs", version_number=2)
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(
                        api_url,
                        f"/api/projects/{project_id}/versions/{field_name}/{version_number}/restore",
                    ),
                    json={"restored_by": restored_by},
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "message": result.get(
                            "message", f"Version {version_number} restored successfully"
                        ),
                    })
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Version {version_number} not found for field {field_name}",
                        suggestion="Check that the version number exists for this field",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "restore version")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e,
                "restore version",
                {
                    "project_id": project_id,
                    "field_name": field_name,
                    "version_number": version_number,
                },
            )
        except Exception as e:
            logger.error(f"Error restoring version: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "restore version")
