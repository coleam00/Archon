"""
Simple feature management tools for Archon MCP Server.

Provides tools to retrieve and manage project features.
"""

import json
import logging
from urllib.parse import urljoin

import httpx

from mcp.server.fastmcp import Context, FastMCP
from src.mcp_server.utils.error_handling import MCPErrorFormatter
from src.mcp_server.utils.timeout_config import get_default_timeout
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def register_feature_tools(mcp: FastMCP):
    """Register feature management tools with the MCP server."""

    @mcp.tool()
    async def get_project_features(ctx: Context, project_id: str) -> str:
        """
        Get features from a project's features field.

        Features track functional components and capabilities of a project.
        Features are typically populated through project updates or task completion.

        Args:
            project_id: Project UUID (required)

        Returns:
            JSON with list of project features:
            {
                "success": true,
                "features": [
                    {"name": "authentication", "status": "completed", "components": ["oauth", "jwt"]},
                    {"name": "api", "status": "in_progress", "endpoints": 12},
                    {"name": "database", "status": "planned"}
                ],
                "count": 3
            }

            Note: Returns empty array if no features are defined yet.

        Examples:
            get_project_features(project_id="550e8400-e29b-41d4-a716-446655440000")

        Feature Structure Examples:
            Features can have various structures depending on your needs:

            1. Simple status tracking:
               {"name": "feature_name", "status": "todo|in_progress|done"}

            2. Component tracking:
               {"name": "auth", "status": "done", "components": ["oauth", "jwt", "sessions"]}

            3. Progress tracking:
               {"name": "api", "status": "in_progress", "endpoints_done": 12, "endpoints_total": 20}

            4. Metadata rich:
               {"name": "payments", "provider": "stripe", "version": "2.0", "enabled": true}

        How Features Are Populated:
            - Features are typically added via update_project() with features field
            - Can be automatically populated by AI during project creation
            - May be updated when tasks are completed
            - Can track any project capabilities or components you need
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/projects/{project_id}/features")
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "features": result.get("features", []),
                        "count": len(result.get("features", [])),
                    })
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Project {project_id} not found",
                        suggestion="Verify the project ID is correct",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "get project features")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "get project features", {"project_id": project_id}
            )
        except Exception as e:
            logger.error(f"Error getting project features: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "get project features")
