"""
Task Service Module for Archon

This module provides core business logic for task operations that can be
shared between MCP tools and FastAPI endpoints.
"""

# Removed direct logging import - using unified config
from datetime import datetime
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)

# Import Socket.IO instance directly to avoid circular imports
try:
    from ...socketio_app import get_socketio_instance
    
    _sio = get_socketio_instance()
    _broadcast_available = True
    logger.info("✅ Socket.IO broadcasting is AVAILABLE - real-time updates enabled")
    
    async def broadcast_task_update(project_id: str, event_type: str, task_data: dict):
        """Broadcast task updates to project room."""
        await _sio.emit(event_type, task_data, room=project_id)
        logger.info(
            f"✅ Broadcasted {event_type} for task {task_data.get('id', 'unknown')} to project {project_id}"
        )
        
except ImportError as e:
    logger.warning(f"❌ Socket.IO broadcasting not available - ImportError: {e}")
    _broadcast_available = False
    _sio = None

    # Dummy function when broadcasting is not available
    async def broadcast_task_update(*args, **kwargs):
        logger.debug(f"Socket.IO broadcast skipped - not available")
        pass

except Exception as e:
    logger.warning(f"❌ Socket.IO broadcasting not available - Exception: {type(e).__name__}: {e}")
    import traceback

    logger.warning(f"❌ Full traceback: {traceback.format_exc()}")
    _broadcast_available = False
    _sio = None

    # Dummy function when broadcasting is not available
    async def broadcast_task_update(*args, **kwargs):
        logger.debug(f"Socket.IO broadcast skipped - not available")
        pass


class TaskService:
    """Service class for task operations"""

    VALID_STATUSES = ["todo", "doing", "review", "done"]

    def __init__(self, supabase_client=None):
        """Initialize with optional supabase client"""
        self.supabase_client = supabase_client or get_supabase_client()

    def validate_status(self, status: str) -> tuple[bool, str]:
        """Validate task status"""
        if status not in self.VALID_STATUSES:
            return (
                False,
                f"Invalid status '{status}'. Must be one of: {', '.join(self.VALID_STATUSES)}",
            )
        return True, ""

    def validate_assignee(self, assignee: str) -> tuple[bool, str]:
        """Validate task assignee"""
        if not assignee or not isinstance(assignee, str) or len(assignee.strip()) == 0:
            return False, "Assignee must be a non-empty string"
        return True, ""

    async def create_task(
        self,
        project_id: str,
        title: str,
        description: str = "",
        assignee: str = "User",
        task_order: int = 0,
        feature: str | None = None,
        sources: list[dict[str, Any]] = None,
        code_examples: list[dict[str, Any]] = None,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Create a new task under a project with automatic reordering.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Validate inputs
            if not title or not isinstance(title, str) or len(title.strip()) == 0:
                return False, {"error": "Task title is required and must be a non-empty string"}

            if not project_id or not isinstance(project_id, str):
                return False, {"error": "Project ID is required and must be a string"}

            # Validate assignee
            is_valid, error_msg = self.validate_assignee(assignee)
            if not is_valid:
                return False, {"error": error_msg}

            task_status = "todo"

            # REORDERING LOGIC: If inserting at a specific position, increment existing tasks
            if task_order > 0:
                # Get all tasks in the same project and status with task_order >= new task's order
                existing_tasks_response = (
                    self.supabase_client.table("archon_tasks")
                    .select("id, task_order")
                    .eq("project_id", project_id)
                    .eq("status", task_status)
                    .gte("task_order", task_order)
                    .execute()
                )

                if existing_tasks_response.data:
                    logger.info(f"Reordering {len(existing_tasks_response.data)} existing tasks")

                    # Increment task_order for all affected tasks
                    for existing_task in existing_tasks_response.data:
                        new_order = existing_task["task_order"] + 1
                        self.supabase_client.table("archon_tasks").update({
                            "task_order": new_order,
                            "updated_at": datetime.now().isoformat(),
                        }).eq("id", existing_task["id"]).execute()

            task_data = {
                "project_id": project_id,
                "title": title,
                "description": description,
                "status": task_status,
                "assignee": assignee,
                "task_order": task_order,
                "sources": sources or [],
                "code_examples": code_examples or [],
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
            }

            if feature:
                task_data["feature"] = feature

            response = self.supabase_client.table("archon_tasks").insert(task_data).execute()

            if response.data:
                task = response.data[0]

                # Broadcast Socket.IO update for new task
                if _broadcast_available:
                    try:
                        await broadcast_task_update(
                            project_id=task["project_id"], event_type="task_created", task_data=task
                        )
                        logger.info(f"Socket.IO broadcast sent for new task {task['id']}")
                    except Exception as ws_error:
                        logger.warning(
                            f"Failed to broadcast Socket.IO update for new task {task['id']}: {ws_error}"
                        )

                return True, {
                    "task": {
                        "id": task["id"],
                        "project_id": task["project_id"],
                        "title": task["title"],
                        "description": task["description"],
                        "status": task["status"],
                        "assignee": task["assignee"],
                        "task_order": task["task_order"],
                        "created_at": task["created_at"],
                    }
                }
            else:
                return False, {"error": "Failed to create task"}

        except Exception as e:
            logger.error(f"Error creating task: {e}")
            return False, {"error": f"Error creating task: {str(e)}"}

    def list_tasks(
        self, project_id: str = None, status: str = None, include_closed: bool = False
    ) -> tuple[bool, dict[str, Any]]:
        """
        List tasks with various filters.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Start with base query
            query = self.supabase_client.table("archon_tasks").select("*")

            # Track filters for debugging
            filters_applied = []

            # Apply filters
            if project_id:
                query = query.eq("project_id", project_id)
                filters_applied.append(f"project_id={project_id}")

            if status:
                # Validate status
                is_valid, error_msg = self.validate_status(status)
                if not is_valid:
                    return False, {"error": error_msg}
                query = query.eq("status", status)
                filters_applied.append(f"status={status}")
                # When filtering by specific status, don't apply include_closed filter
                # as it would be redundant or potentially conflicting
            elif not include_closed:
                # Only exclude done tasks if no specific status filter is applied
                query = query.neq("status", "done")
                filters_applied.append("exclude done tasks")

            # Filter out archived tasks using is null or is false
            query = query.or_("archived.is.null,archived.is.false")
            filters_applied.append("exclude archived tasks (null or false)")

            logger.info(f"Listing tasks with filters: {', '.join(filters_applied)}")

            # Execute query and get raw response
            response = (
                query.order("task_order", desc=False).order("created_at", desc=False).execute()
            )

            # Debug: Log task status distribution and filter effectiveness
            if response.data:
                status_counts = {}
                archived_counts = {"null": 0, "true": 0, "false": 0}

                for task in response.data:
                    task_status = task.get("status", "unknown")
                    status_counts[task_status] = status_counts.get(task_status, 0) + 1

                    # Check archived field
                    archived_value = task.get("archived")
                    if archived_value is None:
                        archived_counts["null"] += 1
                    elif archived_value is True:
                        archived_counts["true"] += 1
                    else:
                        archived_counts["false"] += 1

                logger.info(
                    f"Retrieved {len(response.data)} tasks. Status distribution: {status_counts}"
                )
                logger.info(f"Archived field distribution: {archived_counts}")

                # If we're filtering by status and getting wrong results, log sample
                if status and len(response.data) > 0:
                    first_task = response.data[0]
                    logger.warning(
                        f"Status filter: {status}, First task status: {first_task.get('status')}, archived: {first_task.get('archived')}"
                    )
            else:
                logger.info("No tasks found with current filters")

            tasks = []
            for task in response.data:
                tasks.append({
                    "id": task["id"],
                    "project_id": task["project_id"],
                    "title": task["title"],
                    "description": task["description"],
                    "status": task["status"],
                    "assignee": task.get("assignee", "User"),
                    "task_order": task.get("task_order", 0),
                    "feature": task.get("feature"),
                    "created_at": task["created_at"],
                    "updated_at": task["updated_at"],
                })

            filter_info = []
            if project_id:
                filter_info.append(f"project_id={project_id}")
            if status:
                filter_info.append(f"status={status}")
            if not include_closed:
                filter_info.append("excluding closed tasks")

            return True, {
                "tasks": tasks,
                "total_count": len(tasks),
                "filters_applied": ", ".join(filter_info) if filter_info else "none",
                "include_closed": include_closed,
            }

        except Exception as e:
            logger.error(f"Error listing tasks: {e}")
            return False, {"error": f"Error listing tasks: {str(e)}"}

    def get_task(self, task_id: str) -> tuple[bool, dict[str, Any]]:
        """
        Get a specific task by ID.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            response = (
                self.supabase_client.table("archon_tasks").select("*").eq("id", task_id).execute()
            )

            if response.data:
                task = response.data[0]
                return True, {"task": task}
            else:
                return False, {"error": f"Task with ID {task_id} not found"}

        except Exception as e:
            logger.error(f"Error getting task: {e}")
            return False, {"error": f"Error getting task: {str(e)}"}

    async def update_task(
        self, task_id: str, update_fields: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        """
        Update task with specified fields.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Build update data
            update_data = {"updated_at": datetime.now().isoformat()}

            # Validate and add fields
            if "title" in update_fields:
                update_data["title"] = update_fields["title"]

            if "description" in update_fields:
                update_data["description"] = update_fields["description"]

            if "status" in update_fields:
                is_valid, error_msg = self.validate_status(update_fields["status"])
                if not is_valid:
                    return False, {"error": error_msg}
                update_data["status"] = update_fields["status"]

            if "assignee" in update_fields:
                is_valid, error_msg = self.validate_assignee(update_fields["assignee"])
                if not is_valid:
                    return False, {"error": error_msg}
                update_data["assignee"] = update_fields["assignee"]

            if "task_order" in update_fields:
                update_data["task_order"] = update_fields["task_order"]

            if "feature" in update_fields:
                update_data["feature"] = update_fields["feature"]

            # Update task
            response = (
                self.supabase_client.table("archon_tasks")
                .update(update_data)
                .eq("id", task_id)
                .execute()
            )

            if response.data:
                task = response.data[0]

                # Broadcast Socket.IO update
                if _broadcast_available:
                    try:
                        logger.info(
                            f"Broadcasting task_updated for task {task_id} to project room {task['project_id']}"
                        )
                        await broadcast_task_update(
                            project_id=task["project_id"], event_type="task_updated", task_data=task
                        )
                        logger.info(f"✅ Socket.IO broadcast successful for task {task_id}")
                    except Exception as ws_error:
                        # Don't fail the task update if Socket.IO broadcasting fails
                        logger.error(
                            f"❌ Failed to broadcast Socket.IO update for task {task_id}: {ws_error}"
                        )
                        import traceback

                        logger.error(f"Traceback: {traceback.format_exc()}")
                else:
                    logger.warning(
                        f"⚠️ Socket.IO broadcasting not available - task {task_id} update won't be real-time"
                    )

                return True, {"task": task, "message": "Task updated successfully"}
            else:
                return False, {"error": f"Task with ID {task_id} not found"}

        except Exception as e:
            logger.error(f"Error updating task: {e}")
            return False, {"error": f"Error updating task: {str(e)}"}

    async def archive_task(
        self, task_id: str, archived_by: str = "mcp"
    ) -> tuple[bool, dict[str, Any]]:
        """
        Archive a task and all its subtasks (soft delete).

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # First, check if task exists and is not already archived
            task_response = (
                self.supabase_client.table("archon_tasks").select("*").eq("id", task_id).execute()
            )
            if not task_response.data:
                return False, {"error": f"Task with ID {task_id} not found"}

            task = task_response.data[0]
            if task.get("archived") is True:
                return False, {"error": f"Task with ID {task_id} is already archived"}

            # Archive the task
            archive_data = {
                "archived": True,
                "archived_at": datetime.now().isoformat(),
                "archived_by": archived_by,
                "updated_at": datetime.now().isoformat(),
            }

            # Archive the main task
            response = (
                self.supabase_client.table("archon_tasks")
                .update(archive_data)
                .eq("id", task_id)
                .execute()
            )

            if response.data:
                # Broadcast Socket.IO update for archived task
                if _broadcast_available:
                    try:
                        await broadcast_task_update(
                            project_id=task["project_id"],
                            event_type="task_archived",
                            task_data={"id": task_id, "project_id": task["project_id"]},
                        )
                        logger.info(f"Socket.IO broadcast sent for archived task {task_id}")
                    except Exception as ws_error:
                        logger.warning(
                            f"Failed to broadcast Socket.IO update for archived task {task_id}: {ws_error}"
                        )

                return True, {"task_id": task_id, "message": "Task archived successfully"}
            else:
                return False, {"error": f"Failed to archive task {task_id}"}

        except Exception as e:
            logger.error(f"Error archiving task: {e}")
            return False, {"error": f"Error archiving task: {str(e)}"}
