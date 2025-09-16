"""
Consolidated project management tools for Archon MCP Server.

Reduces the number of individual CRUD operations while maintaining full functionality.
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

# Optimization constants
MAX_DESCRIPTION_LENGTH = 1000
DEFAULT_PAGE_SIZE = 10  # Reduced from 50

def truncate_text(text: str, max_length: int = MAX_DESCRIPTION_LENGTH) -> str:
    """Truncate text to maximum length with ellipsis."""
    if text and len(text) > max_length:
        return text[:max_length - 3] + "..."
    return text

def optimize_project_response(project: dict) -> dict:
    """Optimize project object for MCP response."""
    project = project.copy()  # Don't modify original
    
    # Truncate description if present
    if "description" in project and project["description"]:
        project["description"] = truncate_text(project["description"])
    
    # Remove or summarize large fields
    if "features" in project and isinstance(project["features"], list):
        project["features_count"] = len(project["features"])
        if len(project["features"]) > 3:
            project["features"] = project["features"][:3]  # Keep first 3
    
    return project


def register_project_tools(mcp: FastMCP):
    """Register consolidated project management tools with the MCP server."""

    @mcp.tool()
    async def find_projects(
        ctx: Context,
        project_id: str | None = None,  # For getting single project
        query: str | None = None,  # Search capability
        page: int = 1,
        per_page: int = DEFAULT_PAGE_SIZE,
    ) -> str:
        """
        List and search projects (consolidated: list + search + get).
        
        Args:
            project_id: Get specific project by ID (returns full details)
            query: Keyword search in title/description
            page: Page number for pagination  
            per_page: Items per page (default: 10)
        
        Returns:
            JSON array of projects or single project (optimized payloads for lists)
        
        Examples:
            list_projects()  # All projects
            list_projects(query="auth")  # Search projects
            list_projects(project_id="proj-123")  # Get specific project
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()
            
            # Single project get mode
            if project_id:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.get(urljoin(api_url, f"/api/projects/{project_id}"))
                    
                    if response.status_code == 200:
                        project = response.json()
                        # Don't optimize single project get - return full details
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
            
            # List mode
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(urljoin(api_url, "/api/projects"))
                
                if response.status_code == 200:
                    data = response.json()
                    projects = data.get("projects", [])
                    
                    # Apply search filter if provided
                    if query:
                        query_lower = query.lower()
                        projects = [
                            p for p in projects
                            if query_lower in p.get("title", "").lower()
                            or query_lower in p.get("description", "").lower()
                        ]
                    
                    # Apply pagination
                    start_idx = (page - 1) * per_page
                    end_idx = start_idx + per_page
                    paginated = projects[start_idx:end_idx]
                    
                    # Optimize project responses
                    optimized = [optimize_project_response(p) for p in paginated]
                    
                    return json.dumps({
                        "success": True,
                        "projects": optimized,
                        "count": len(optimized),
                        "total": len(projects),
                        "page": page,
                        "per_page": per_page,
                        "query": query
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "list projects")
                    
        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "list projects")
        except Exception as e:
            logger.error(f"Error listing projects: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "list projects")

    @mcp.tool()
    async def manage_project(
        ctx: Context,
        action: str,  # "create" | "update" | "delete"
        project_id: str | None = None,
        title: str | None = None,
        description: str | None = None,
        github_repo: str | None = None,
    ) -> str:
        """
        Manage projects (consolidated: create/update/delete).
        
        Args:
            action: "create" | "update" | "delete"
            project_id: Project UUID for update/delete
            title: Project title (required for create)
            description: Project goals and scope
            github_repo: GitHub URL (e.g. "https://github.com/org/repo")
        
        Examples:
            manage_project("create", title="Auth System")
            manage_project("update", project_id="p-1", description="Updated")
            manage_project("delete", project_id="p-1")
        
        Returns: {success: bool, project?: object, message: string}
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                if action == "create":
                    if not title:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "title required for create"
                        )
                    
                    response = await client.post(
                        urljoin(api_url, "/api/projects"),
                        json={
                            "title": title,
                            "description": description or "",
                            "github_repo": github_repo
                        }
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        
                        # Handle async project creation with polling
                        if "progress_id" in result:
                            max_attempts = get_max_polling_attempts()
                            polling_timeout = get_polling_timeout()
                            
                            for attempt in range(max_attempts):
                                try:
                                    # Exponential backoff
                                    sleep_interval = get_polling_interval(attempt)
                                    await asyncio.sleep(sleep_interval)
                                    
                                    async with httpx.AsyncClient(timeout=polling_timeout) as poll_client:
                                        poll_response = await poll_client.get(
                                            urljoin(api_url, f"/api/progress/{result['progress_id']}")
                                        )
                                        
                                        if poll_response.status_code == 200:
                                            poll_data = poll_response.json()
                                            
                                            if poll_data.get("status") == "completed":
                                                project = poll_data.get("result", {}).get("project", {})
                                                return json.dumps({
                                                    "success": True,
                                                    "project": optimize_project_response(project),
                                                    "project_id": project.get("id"),
                                                    "message": poll_data.get("result", {}).get("message", "Project created successfully")
                                                })
                                            elif poll_data.get("status") == "failed":
                                                error_msg = poll_data.get("error", "Project creation failed")
                                                return MCPErrorFormatter.format_error(
                                                    "creation_failed",
                                                    error_msg,
                                                    details=poll_data.get("details")
                                                )
                                            # Continue polling if still processing
                                            
                                except httpx.RequestError as poll_error:
                                    logger.warning(f"Polling attempt {attempt + 1} failed: {poll_error}")
                                    if attempt == max_attempts - 1:
                                        return MCPErrorFormatter.format_error(
                                            "timeout",
                                            "Project creation timed out",
                                            suggestion="Check project status manually"
                                        )
                            
                            return MCPErrorFormatter.format_error(
                                "timeout",
                                "Project creation timed out after maximum attempts",
                                details={"progress_id": result.get("progress_id")}
                            )
                        else:
                            # Synchronous response
                            project = result.get("project", {})
                            return json.dumps({
                                "success": True,
                                "project": optimize_project_response(project),
                                "project_id": project.get("id"),
                                "message": result.get("message", "Project created successfully")
                            })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "create project")
                        
                elif action == "update":
                    if not project_id:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "project_id required for update"
                        )
                    
                    update_data = {}
                    if title is not None:
                        update_data["title"] = title
                    if description is not None:
                        update_data["description"] = description
                    if github_repo is not None:
                        update_data["github_repo"] = github_repo
                    
                    if not update_data:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "No fields to update"
                        )
                    
                    response = await client.put(
                        urljoin(api_url, f"/api/projects/{project_id}"),
                        json=update_data
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        project = result.get("project")
                        
                        if project:
                            project = optimize_project_response(project)
                        
                        return json.dumps({
                            "success": True,
                            "project": project,
                            "message": result.get("message", "Project updated successfully")
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "update project")
                        
                elif action == "delete":
                    if not project_id:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "project_id required for delete"
                        )
                    
                    response = await client.delete(
                        urljoin(api_url, f"/api/projects/{project_id}")
                    )
                    
                    if response.status_code == 200:
                        result = response.json()
                        return json.dumps({
                            "success": True,
                            "message": result.get("message", "Project deleted successfully")
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "delete project")
                        
                else:
                    return MCPErrorFormatter.format_error(
                        "invalid_action",
                        f"Unknown action: {action}"
                    )
                    
        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, f"{action} project")
        except Exception as e:
            logger.error(f"Error managing project ({action}): {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, f"{action} project")
