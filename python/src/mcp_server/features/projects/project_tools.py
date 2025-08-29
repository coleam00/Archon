"""
Simple project management tools for Archon MCP Server.

Provides separate, focused tools for each project operation.
No complex PRP examples - just straightforward project management.
"""

import asyncio
import json
import logging
from urllib.parse import urljoin

import httpx

from mcp.server.fastmcp import Context, FastMCP
from src.mcp_server.utils.error_handling import MCPErrorFormatter
from src.mcp_server.utils.timeout_config import (
    get_default_timeout,
    get_max_polling_attempts,
    get_polling_interval,
    get_polling_timeout,
)
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def register_project_tools(mcp: FastMCP):
    """Register individual project management tools with the MCP server."""

    @mcp.tool()
    async def create_project(
        ctx: Context,
        title: str,
        description: str = "",
        github_repo: str | None = None,
    ) -> str:
        """
        Create a new project with automatic AI assistance.

        The project creation starts a background process that generates PRP documentation
        and initial tasks based on the title and description.

        Args:
            title: Project title - should be descriptive (required)
            description: Project description explaining goals and scope
            github_repo: GitHub repository URL (e.g., "https://github.com/org/repo")

        Returns:
            JSON with project details:
            {
                "success": true,
                "project": {...},
                "project_id": "550e8400-e29b-41d4-a716-446655440000",
                "message": "Project created successfully"
            }

        Examples:
            # Simple project
            create_project(
                title="Task Management API",
                description="RESTful API for managing tasks and projects"
            )

            # Project with GitHub integration
            create_project(
                title="OAuth2 Authentication System",
                description="Implement secure OAuth2 authentication with multiple providers",
                github_repo="https://github.com/myorg/auth-service"
            )
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/projects"),
                    json={"title": title, "description": description, "github_repo": github_repo},
                )

                if response.status_code == 200:
                    result = response.json()

                    # Handle async project creation
                    if "progress_id" in result:
                        # Poll for completion with proper error handling and backoff
                        max_attempts = get_max_polling_attempts()
                        polling_timeout = get_polling_timeout()

                        for attempt in range(max_attempts):
                            try:
                                # Exponential backoff
                                sleep_interval = get_polling_interval(attempt)
                                await asyncio.sleep(sleep_interval)

                                # Create new client with polling timeout
                                async with httpx.AsyncClient(
                                    timeout=polling_timeout
                                ) as poll_client:
                                    list_response = await poll_client.get(
                                        urljoin(api_url, "/api/projects")
                                    )
                                    list_response.raise_for_status()  # Raise on HTTP errors

                                    response_data = list_response.json()
                                    # Extract projects array from response
                                    projects = response_data.get("projects", [])
                                    # Find project with matching title created recently
                                    for proj in projects:
                                        if proj.get("title") == title:
                                            return json.dumps({
                                                "success": True,
                                                "project": proj,
                                                "project_id": proj["id"],
                                                "message": f"Project created successfully with ID: {proj['id']}",
                                            })

                            except httpx.RequestError as poll_error:
                                logger.warning(
                                    f"Polling attempt {attempt + 1}/{max_attempts} failed: {poll_error}"
                                )
                                if attempt == max_attempts - 1:  # Last attempt
                                    return MCPErrorFormatter.format_error(
                                        error_type="polling_timeout",
                                        message=f"Project creation polling failed after {max_attempts} attempts",
                                        details={
                                            "progress_id": result["progress_id"],
                                            "title": title,
                                            "last_error": str(poll_error),
                                        },
                                        suggestion="The project may still be creating. Use list_projects to check status",
                                    )
                            except Exception as poll_error:
                                logger.warning(
                                    f"Unexpected error during polling attempt {attempt + 1}: {poll_error}"
                                )

                        # If we couldn't find it after polling
                        return json.dumps({
                            "success": True,
                            "progress_id": result["progress_id"],
                            "message": f"Project creation in progress after {max_attempts} checks. Use list_projects to find it once complete.",
                        })
                    else:
                        # Direct response (shouldn't happen with current API)
                        return json.dumps({"success": True, "project": result})
                else:
                    return MCPErrorFormatter.from_http_error(response, "create project")

        except httpx.ConnectError as e:
            return MCPErrorFormatter.from_exception(
                e, "create project", {"title": title, "api_url": api_url}
            )
        except httpx.TimeoutException as e:
            return MCPErrorFormatter.from_exception(
                e, "create project", {"title": title, "timeout": str(timeout)}
            )
        except Exception as e:
            logger.error(f"Error creating project: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "create project", {"title": title})

    @mcp.tool()
    async def list_projects(ctx: Context) -> str:
        """
        List all projects.

        Returns:
            JSON array of all projects with their basic information

        Example:
            list_projects()
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                # CRITICAL: Pass include_content=False for lightweight response
                response = await client.get(
                    urljoin(api_url, "/api/projects"),
                    params={"include_content": False}
                )

                if response.status_code == 200:
                    response_data = response.json()
                    # Response already includes projects array and count
                    return json.dumps({
                        "success": True,
                        "projects": response_data,
                        "count": response_data.get("count", 0),
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "list projects")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "list projects", {"api_url": api_url})
        except Exception as e:
            logger.error(f"Error listing projects: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "list projects")

    @mcp.tool()
    async def get_project(ctx: Context, project_id: str) -> str:
        """
        Get detailed information about a specific project.

        Args:
            project_id: UUID of the project

        Returns:
            JSON with complete project details

        Example:
            get_project(project_id="550e8400-e29b-41d4-a716-446655440000")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(urljoin(api_url, f"/api/projects/{project_id}"))

                if response.status_code == 200:
                    project = response.json()
                    return json.dumps({"success": True, "project": project})
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Project {project_id} not found",
                        suggestion="Verify the project ID is correct",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "get project")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "get project", {"project_id": project_id})
        except Exception as e:
            logger.error(f"Error getting project: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "get project")

    @mcp.tool()
    async def delete_project(ctx: Context, project_id: str) -> str:
        """
        Delete a project.

        Args:
            project_id: UUID of the project to delete

        Returns:
            JSON confirmation of deletion

        Example:
            delete_project(project_id="550e8400-e29b-41d4-a716-446655440000")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.delete(urljoin(api_url, f"/api/projects/{project_id}"))

                if response.status_code == 200:
                    return json.dumps({
                        "success": True,
                        "message": f"Project {project_id} deleted successfully",
                    })
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Project {project_id} not found",
                        suggestion="Verify the project ID is correct",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "delete project")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "delete project", {"project_id": project_id})
        except Exception as e:
            logger.error(f"Error deleting project: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "delete project")

    @mcp.tool()
    async def update_project(
        ctx: Context,
        project_id: str,
        title: str | None = None,
        description: str | None = None,
        github_repo: str | None = None,
    ) -> str:
        """
        Update a project's basic information.

        Args:
            project_id: UUID of the project to update
            title: New title (optional)
            description: New description (optional)
            github_repo: New GitHub repository URL (optional)

        Returns:
            JSON with updated project details

        Example:
            update_project(project_id="550e8400-e29b-41d4-a716-446655440000",
                         title="Updated Project Title")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            # Build update payload with only provided fields
            update_data = {}
            if title is not None:
                update_data["title"] = title
            if description is not None:
                update_data["description"] = description
            if github_repo is not None:
                update_data["github_repo"] = github_repo

            if not update_data:
                return MCPErrorFormatter.format_error(
                    error_type="validation_error",
                    message="No fields to update",
                    suggestion="Provide at least one field to update (title, description, or github_repo)",
                )

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.put(
                    urljoin(api_url, f"/api/projects/{project_id}"), json=update_data
                )

                if response.status_code == 200:
                    project = response.json()
                    return json.dumps({
                        "success": True,
                        "project": project,
                        "message": "Project updated successfully",
                    })
                elif response.status_code == 404:
                    return MCPErrorFormatter.format_error(
                        error_type="not_found",
                        message=f"Project {project_id} not found",
                        suggestion="Verify the project ID is correct",
                        http_status=404,
                    )
                else:
                    return MCPErrorFormatter.from_http_error(response, "update project")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "update project", {"project_id": project_id})
        except Exception as e:
            logger.error(f"Error updating project: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "update project")
