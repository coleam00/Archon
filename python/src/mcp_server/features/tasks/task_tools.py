"""
Consolidated task management tools for Archon MCP Server.

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
MAX_DESCRIPTION_LENGTH = 1000
DEFAULT_PAGE_SIZE = 10  # Reduced from 50

def truncate_text(text: str, max_length: int = MAX_DESCRIPTION_LENGTH) -> str:
    """Truncate text to maximum length with ellipsis."""
    if text and len(text) > max_length:
        return text[:max_length - 3] + "..."
    return text

def optimize_task_response(task: dict) -> dict:
    """Optimize task object for MCP response."""
    task = task.copy()  # Don't modify original

    # Truncate description if present
    if "description" in task and task["description"]:
        task["description"] = truncate_text(task["description"])

    # Replace arrays with counts
    if "sources" in task and isinstance(task["sources"], list):
        task["sources_count"] = len(task["sources"])
        del task["sources"]

    if "code_examples" in task and isinstance(task["code_examples"], list):
        task["code_examples_count"] = len(task["code_examples"])
        del task["code_examples"]

    return task


def register_task_tools(mcp: FastMCP):
    """Register consolidated task management tools with the MCP server."""

    @mcp.tool()
    async def find_tasks(
        ctx: Context,
        query: str | None = None,  # Add search capability
        task_id: str | None = None,  # For getting single task
        filter_by: str | None = None,
        filter_value: str | None = None,
        project_id: str | None = None,
        include_closed: bool = True,
        page: int = 1,
        per_page: int = DEFAULT_PAGE_SIZE,  # Use optimized default
    ) -> str:
        """
        Find and search tasks (consolidated: list + search + get).
        
        Args:
            query: Keyword search in title, description, feature (optional)
            task_id: Get specific task by ID (returns full details)
            filter_by: "status" | "project" | "assignee" (optional)
            filter_value: Filter value (e.g., "todo", "doing", "review", "done")
            project_id: Project UUID (optional, for additional filtering)
            include_closed: Include done tasks in results
            page: Page number for pagination
            per_page: Items per page (default: 10)
        
        Returns:
            JSON array of tasks or single task (optimized payloads for lists)
        
        Examples:
            find_tasks() # All tasks
            find_tasks(query="auth") # Search for "auth"
            find_tasks(task_id="task-123") # Get specific task (full details)
            find_tasks(filter_by="status", filter_value="todo") # Only todo tasks
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            # Single task get mode
            if task_id:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.get(urljoin(api_url, f"/api/tasks/{task_id}"))

                    if response.status_code == 200:
                        task = response.json()
                        # Don't optimize single task get - return full details
                        return json.dumps({"success": True, "task": task})
                    elif response.status_code == 404:
                        return MCPErrorFormatter.format_error(
                            error_type="not_found",
                            message=f"Task {task_id} not found",
                            suggestion="Verify the task ID is correct",
                            http_status=404,
                        )
                    else:
                        return MCPErrorFormatter.from_http_error(response, "get task")

            # List mode with search and filters
            params: dict[str, Any] = {
                "page": page,
                "per_page": per_page,
                "exclude_large_fields": True,  # Always exclude large fields in MCP responses
            }

            # Add search query if provided
            if query:
                params["q"] = query

            if filter_by == "project" and filter_value:
                # Use project-specific endpoint for project filtering
                url = urljoin(api_url, f"/api/projects/{filter_value}/tasks")
                params["include_archived"] = False  # For backward compatibility
            elif filter_by == "status" and filter_value:
                # Use generic tasks endpoint for status filtering
                url = urljoin(api_url, "/api/tasks")
                params["status"] = filter_value
                params["include_closed"] = include_closed
                if project_id:
                    params["project_id"] = project_id
            elif filter_by == "assignee" and filter_value:
                # Use generic tasks endpoint for assignee filtering
                url = urljoin(api_url, "/api/tasks")
                params["assignee"] = filter_value
                params["include_closed"] = include_closed
                if project_id:
                    params["project_id"] = project_id
            elif project_id:
                # Direct project_id parameter provided
                url = urljoin(api_url, "/api/tasks")
                params["project_id"] = project_id
                params["include_closed"] = include_closed
            else:
                # No specific filters - get all tasks
                url = urljoin(api_url, "/api/tasks")
                params["include_closed"] = include_closed

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()

                result = response.json()

                # Normalize response format
                if isinstance(result, list):
                    tasks = result
                    total_count = len(result)
                elif isinstance(result, dict):
                    if "tasks" in result:
                        tasks = result["tasks"]
                        total_count = result.get("total_count", len(tasks))
                    elif "data" in result:
                        tasks = result["data"]
                        total_count = result.get("total", len(tasks))
                    else:
                        return MCPErrorFormatter.format_error(
                            error_type="invalid_response",
                            message="Unexpected response format from API",
                            details={"response_keys": list(result.keys())},
                        )
                else:
                    return MCPErrorFormatter.format_error(
                        error_type="invalid_response",
                        message="Invalid response type from API",
                        details={"response_type": type(result).__name__},
                    )

                # Optimize task responses
                optimized_tasks = [optimize_task_response(task) for task in tasks]

                return json.dumps({
                    "success": True,
                    "tasks": optimized_tasks,
                    "total_count": total_count,
                    "count": len(optimized_tasks),
                    "query": query,  # Include search query in response
                })

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, "list tasks", {"filter_by": filter_by, "filter_value": filter_value}
            )
        except Exception as e:
            logger.error(f"Error listing tasks: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "list tasks")

    @mcp.tool()
    async def manage_task(
        ctx: Context,
        action: str,  # "create" | "update" | "delete"
        task_id: str | None = None,
        project_id: str | None = None,
        title: str | None = None,
        description: str | None = None,
        status: str | None = None,
        assignee: str | None = None,
        task_order: int | None = None,
        feature: str | None = None
    ) -> str:
        """
        Manage tasks (consolidated: create/update/delete).

        TASK GRANULARITY GUIDANCE:
        - For feature-specific projects: Create detailed implementation tasks (setup, implement, test, document)
        - For codebase-wide projects: Create feature-level tasks
        - Default to more granular tasks when project scope is unclear
        - Each task should represent 30 minutes to 4 hours of work

        Args:
            action: "create" | "update" | "delete"
            task_id: Task UUID for update/delete
            project_id: Project UUID for create
            title: Task title text
            description: Detailed task description with clear completion criteria
            status: "todo" | "doing" | "review" | "done"
            assignee: String name of the assignee. Can be any agent name,
                     "User" for human assignment, or custom agent identifiers
                     created by your system (e.g., "ResearchAgent-1", "CodeReviewer").
                     Common values: "User", "Archon", "Coding Agent"
                     Default: "User"
            task_order: Priority 0-100 (higher = more priority)
            feature: Feature label for grouping

        Examples:
          manage_task("create", project_id="p-1", title="Research existing patterns", description="Study codebase for similar implementations")
          manage_task("create", project_id="p-1", title="Write unit tests", description="Cover all edge cases with 80% coverage")
          manage_task("update", task_id="t-1", status="doing", assignee="User")
          manage_task("delete", task_id="t-1")

        Returns: {success: bool, task?: object, message: string}
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                if action == "create":
                    if not project_id or not title:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "project_id and title required for create",
                            suggestion="Provide both project_id and title"
                        )

                    response = await client.post(
                        urljoin(api_url, "/api/tasks"),
                        json={
                            "project_id": project_id,
                            "title": title,
                            "description": description or "",
                            "assignee": assignee or "User",
                            "task_order": task_order or 0,
                            "feature": feature,
                            "sources": [],
                            "code_examples": [],
                        },
                    )

                    if response.status_code == 200:
                        result = response.json()
                        task = result.get("task")

                        # Optimize task response
                        if task:
                            task = optimize_task_response(task)

                        return json.dumps({
                            "success": True,
                            "task": task,
                            "task_id": task.get("id") if task else None,
                            "message": result.get("message", "Task created successfully"),
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "create task")

                elif action == "update":
                    if not task_id:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "task_id required for update",
                            suggestion="Provide task_id to update"
                        )

                    # Build update fields
                    update_fields = {}
                    if title is not None:
                        update_fields["title"] = title
                    if description is not None:
                        update_fields["description"] = description
                    if status is not None:
                        update_fields["status"] = status
                    if assignee is not None:
                        update_fields["assignee"] = assignee
                    if task_order is not None:
                        update_fields["task_order"] = task_order
                    if feature is not None:
                        update_fields["feature"] = feature

                    if not update_fields:
                        return MCPErrorFormatter.format_error(
                            error_type="validation_error",
                            message="No fields to update",
                            suggestion="Provide at least one field to update",
                        )

                    response = await client.put(
                        urljoin(api_url, f"/api/tasks/{task_id}"),
                        json=update_fields
                    )

                    if response.status_code == 200:
                        result = response.json()
                        task = result.get("task")

                        # Optimize task response
                        if task:
                            task = optimize_task_response(task)

                        return json.dumps({
                            "success": True,
                            "task": task,
                            "message": result.get("message", "Task updated successfully"),
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "update task")

                elif action == "delete":
                    if not task_id:
                        return MCPErrorFormatter.format_error(
                            "validation_error",
                            "task_id required for delete",
                            suggestion="Provide task_id to delete"
                        )

                    response = await client.delete(
                        urljoin(api_url, f"/api/tasks/{task_id}")
                    )

                    if response.status_code == 200:
                        result = response.json()
                        return json.dumps({
                            "success": True,
                            "message": result.get("message", "Task deleted successfully"),
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "delete task")

                else:
                    return MCPErrorFormatter.format_error(
                        "invalid_action",
                        f"Unknown action: {action}",
                        suggestion="Use 'create', 'update', or 'delete'"
                    )

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(
                e, f"{action} task", {"task_id": task_id, "project_id": project_id}
            )
        except Exception as e:
            logger.error(f"Error managing task ({action}): {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, f"{action} task")
