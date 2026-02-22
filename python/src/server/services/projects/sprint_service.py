"""
Sprint Service Module for Archon

Provides business logic for sprint operations: listing, getting, creating,
updating, and deleting sprints within a project.
"""

from datetime import datetime
from typing import Any

from src.server.utils import get_supabase_client
from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class SprintService:
    """Service class for sprint operations"""

    VALID_STATUSES = ["planning", "active", "completed", "cancelled"]

    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def _validate_status(self, status: str) -> tuple[bool, str]:
        if status not in self.VALID_STATUSES:
            return (
                False,
                f"Invalid status '{status}'. Must be one of: {', '.join(self.VALID_STATUSES)}",
            )
        return True, ""

    def list_sprints(self, project_id: str) -> tuple[bool, dict[str, Any]]:
        """List all sprints for a project, ordered by start_date then created_at."""
        try:
            response = (
                self.supabase_client.table("archon_sprints")
                .select("*")
                .eq("project_id", project_id)
                .order("start_date", desc=False, nullsfirst=True)
                .order("created_at", desc=False)
                .execute()
            )
            return True, {"sprints": response.data or [], "total_count": len(response.data or [])}
        except Exception as e:
            logger.error(f"Error listing sprints for project {project_id}: {e}")
            return False, {"error": f"Error listing sprints: {str(e)}"}

    def get_sprint(self, sprint_id: str) -> tuple[bool, dict[str, Any]]:
        """Get a single sprint by ID."""
        try:
            response = (
                self.supabase_client.table("archon_sprints")
                .select("*")
                .eq("id", sprint_id)
                .execute()
            )
            if response.data:
                return True, {"sprint": response.data[0]}
            return False, {"error": f"Sprint with ID {sprint_id} not found"}
        except Exception as e:
            logger.error(f"Error getting sprint {sprint_id}: {e}")
            return False, {"error": f"Error getting sprint: {str(e)}"}

    def create_sprint(
        self,
        project_id: str,
        name: str,
        goal: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        status: str = "planning",
    ) -> tuple[bool, dict[str, Any]]:
        """Create a new sprint for a project."""
        try:
            if not name or not isinstance(name, str) or not name.strip():
                return False, {"error": "Sprint name is required and must be a non-empty string"}

            if not project_id:
                return False, {"error": "Project ID is required"}

            is_valid, error_msg = self._validate_status(status)
            if not is_valid:
                return False, {"error": error_msg}

            sprint_data: dict[str, Any] = {
                "project_id": project_id,
                "name": name.strip(),
                "status": status,
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
            }
            if goal is not None:
                sprint_data["goal"] = goal
            if start_date is not None:
                sprint_data["start_date"] = start_date
            if end_date is not None:
                sprint_data["end_date"] = end_date

            response = self.supabase_client.table("archon_sprints").insert(sprint_data).execute()
            if response.data:
                return True, {"sprint": response.data[0]}
            return False, {"error": "Failed to create sprint"}
        except Exception as e:
            logger.error(f"Error creating sprint: {e}")
            return False, {"error": f"Error creating sprint: {str(e)}"}

    def update_sprint(self, sprint_id: str, update_fields: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        """Update a sprint with specified fields."""
        try:
            update_data: dict[str, Any] = {"updated_at": datetime.now().isoformat()}

            if "name" in update_fields:
                if not update_fields["name"] or not str(update_fields["name"]).strip():
                    return False, {"error": "Sprint name must be a non-empty string"}
                update_data["name"] = str(update_fields["name"]).strip()

            if "goal" in update_fields:
                update_data["goal"] = update_fields["goal"]

            if "status" in update_fields:
                is_valid, error_msg = self._validate_status(update_fields["status"])
                if not is_valid:
                    return False, {"error": error_msg}
                update_data["status"] = update_fields["status"]

            if "start_date" in update_fields:
                update_data["start_date"] = update_fields["start_date"]

            if "end_date" in update_fields:
                update_data["end_date"] = update_fields["end_date"]

            response = (
                self.supabase_client.table("archon_sprints")
                .update(update_data)
                .eq("id", sprint_id)
                .execute()
            )

            if response.data:
                return True, {"sprint": response.data[0], "message": "Sprint updated successfully"}
            return False, {"error": f"Sprint with ID {sprint_id} not found"}
        except Exception as e:
            logger.error(f"Error updating sprint {sprint_id}: {e}")
            return False, {"error": f"Error updating sprint: {str(e)}"}

    def delete_sprint(self, sprint_id: str) -> tuple[bool, dict[str, Any]]:
        """Delete a sprint. Tasks with this sprint_id will have sprint_id set to NULL."""
        try:
            check = (
                self.supabase_client.table("archon_sprints")
                .select("id")
                .eq("id", sprint_id)
                .execute()
            )
            if not check.data:
                return False, {"error": f"Sprint with ID {sprint_id} not found"}

            self.supabase_client.table("archon_sprints").delete().eq("id", sprint_id).execute()
            return True, {"sprint_id": sprint_id, "message": "Sprint deleted successfully"}
        except Exception as e:
            logger.error(f"Error deleting sprint {sprint_id}: {e}")
            return False, {"error": f"Error deleting sprint: {str(e)}"}
