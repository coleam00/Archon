"""
Project Service Module for Archon

This module provides core business logic for project operations that can be
shared between MCP tools and FastAPI endpoints. It follows the pattern of
separating business logic from transport-specific code.
"""

# Removed direct logging import - using unified config
from datetime import datetime
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class ProjectService:
    """Service class for project operations"""

    def __init__(self, supabase_client=None):
        """Initialize with optional supabase client"""
        self.supabase_client = supabase_client or get_supabase_client()

    def create_project(self, title: str, github_repo: str = None) -> tuple[bool, dict[str, Any]]:
        """
        Create a new project with optional PRD and GitHub repo.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Validate inputs
            if not title or not isinstance(title, str) or len(title.strip()) == 0:
                return False, {"error": "Project title is required and must be a non-empty string"}

            # Create project data
            project_data = {
                "title": title.strip(),
                "docs": [],  # Will add PRD document after creation
                "features": [],
                "data": [],
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
            }

            if github_repo and isinstance(github_repo, str) and len(github_repo.strip()) > 0:
                project_data["github_repo"] = github_repo.strip()

            # Insert project
            response = self.supabase_client.table("archon_projects").insert(project_data).execute()

            if not response.data:
                logger.error("Supabase returned empty data for project creation")
                return False, {"error": "Failed to create project - database returned no data"}

            project = response.data[0]
            project_id = project["id"]
            logger.info(f"Project created successfully with ID: {project_id}")

            return True, {
                "project": {
                    "id": project_id,
                    "title": project["title"],
                    "github_repo": project.get("github_repo"),
                    "created_at": project["created_at"],
                }
            }

        except Exception as e:
            logger.error(f"Error creating project: {e}")
            return False, {"error": f"Database error: {str(e)}"}

    def list_projects(self, include_content: bool = True) -> tuple[bool, dict[str, Any]]:
        """
        List all projects.

        Args:
            include_content: If True (default), includes docs, features, data fields.
                           If False, returns lightweight metadata only with counts.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            if include_content:
                # Current behavior - maintain backward compatibility
                response = (
                    self.supabase_client.table("archon_projects")
                    .select("*")
                    .order("created_at", desc=True)
                    .execute()
                )

                projects = []
                for project in response.data:
                    projects.append({
                        "id": project["id"],
                        "title": project["title"],
                        "github_repo": project.get("github_repo"),
                        "created_at": project["created_at"],
                        "updated_at": project["updated_at"],
                        "pinned": project.get("pinned", False),
                        "description": project.get("description", ""),
                        "docs": project.get("docs", []),
                        "features": project.get("features", []),
                        "data": project.get("data", []),
                    })
            else:
                # Lightweight response for MCP - fetch all data but only return metadata + stats
                # FIXED: N+1 query problem - now using single query
                response = (
                    self.supabase_client.table("archon_projects")
                    .select("*")  # Fetch all fields in single query
                    .order("created_at", desc=True)
                    .execute()
                )

                projects = []
                for project in response.data:
                    # Calculate counts from fetched data (no additional queries)
                    docs_count = len(project.get("docs", []))
                    features_count = len(project.get("features", []))
                    has_data = bool(project.get("data", []))

                    # Return only metadata + stats, excluding large JSONB fields
                    projects.append({
                        "id": project["id"],
                        "title": project["title"],
                        "github_repo": project.get("github_repo"),
                        "created_at": project["created_at"],
                        "updated_at": project["updated_at"],
                        "pinned": project.get("pinned", False),
                        "description": project.get("description", ""),
                        "stats": {
                            "docs_count": docs_count,
                            "features_count": features_count,
                            "has_data": has_data
                        }
                    })

            return True, {"projects": projects, "total_count": len(projects)}

        except Exception as e:
            logger.error(f"Error listing projects: {e}")
            return False, {"error": f"Error listing projects: {str(e)}"}

    def get_project(self, project_id: str) -> tuple[bool, dict[str, Any]]:
        """
        Get a specific project by ID.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            response = (
                self.supabase_client.table("archon_projects")
                .select("*")
                .eq("id", project_id)
                .execute()
            )

            if response.data:
                project = response.data[0]

                # Get linked sources
                technical_sources = []
                business_sources = []

                try:
                    # Get source IDs from project_sources table
                    sources_response = (
                        self.supabase_client.table("archon_project_sources")
                        .select("source_id, notes")
                        .eq("project_id", project["id"])
                        .execute()
                    )

                    # Collect source IDs by type
                    technical_source_ids = []
                    business_source_ids = []

                    for source_link in sources_response.data:
                        if source_link.get("notes") == "technical":
                            technical_source_ids.append(source_link["source_id"])
                        elif source_link.get("notes") == "business":
                            business_source_ids.append(source_link["source_id"])

                    # Fetch full source objects
                    if technical_source_ids:
                        tech_sources_response = (
                            self.supabase_client.table("archon_sources")
                            .select("*")
                            .in_("source_id", technical_source_ids)
                            .execute()
                        )
                        technical_sources = tech_sources_response.data

                    if business_source_ids:
                        biz_sources_response = (
                            self.supabase_client.table("archon_sources")
                            .select("*")
                            .in_("source_id", business_source_ids)
                            .execute()
                        )
                        business_sources = biz_sources_response.data

                except Exception as e:
                    logger.warning(
                        f"Failed to retrieve linked sources for project {project['id']}: {e}"
                    )

                # Add sources to project data
                project["technical_sources"] = technical_sources
                project["business_sources"] = business_sources

                return True, {"project": project}
            else:
                return False, {"error": f"Project with ID {project_id} not found"}

        except Exception as e:
            logger.error(f"Error getting project: {e}")
            return False, {"error": f"Error getting project: {str(e)}"}

    def delete_project(self, project_id: str) -> tuple[bool, dict[str, Any]]:
        """
        Delete a project and all its associated tasks.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # First, check if project exists
            check_response = (
                self.supabase_client.table("archon_projects")
                .select("id")
                .eq("id", project_id)
                .execute()
            )
            if not check_response.data:
                return False, {"error": f"Project with ID {project_id} not found"}

            # Get task count for reporting
            tasks_response = (
                self.supabase_client.table("archon_tasks")
                .select("id")
                .eq("project_id", project_id)
                .execute()
            )
            tasks_count = len(tasks_response.data) if tasks_response.data else 0

            # Delete the project (tasks will be deleted by cascade)
            response = (
                self.supabase_client.table("archon_projects")
                .delete()
                .eq("id", project_id)
                .execute()
            )

            # For DELETE operations, success is indicated by no error, not by response.data content
            # response.data will be empty list [] even on successful deletion
            return True, {
                "project_id": project_id,
                "deleted_tasks": tasks_count,
                "message": "Project deleted successfully",
            }

        except Exception as e:
            logger.error(f"Error deleting project: {e}")
            return False, {"error": f"Error deleting project: {str(e)}"}

    def get_project_features(self, project_id: str) -> tuple[bool, dict[str, Any]]:
        """
        Get features from a project's features JSONB field.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            response = (
                self.supabase_client.table("archon_projects")
                .select("features")
                .eq("id", project_id)
                .single()
                .execute()
            )

            if not response.data:
                return False, {"error": "Project not found"}

            features = response.data.get("features", [])

            # Extract feature labels for dropdown options
            feature_options = []
            for feature in features:
                if isinstance(feature, dict) and "data" in feature and "label" in feature["data"]:
                    feature_options.append({
                        "id": feature.get("id", ""),
                        "label": feature["data"]["label"],
                        "type": feature["data"].get("type", ""),
                        "feature_type": feature.get("type", "page"),
                    })

            return True, {"features": feature_options, "count": len(feature_options)}

        except Exception as e:
            # Check if it's a "no rows found" error from PostgREST
            error_message = str(e)
            if "The result contains 0 rows" in error_message or "PGRST116" in error_message:
                return False, {"error": "Project not found"}

            logger.error(f"Error getting project features: {e}")
            return False, {"error": f"Error getting project features: {str(e)}"}

    def update_project(
        self, project_id: str, update_fields: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        """
        Update a project with specified fields.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Build update data
            update_data = {"updated_at": datetime.now().isoformat()}

            # Add allowed fields
            allowed_fields = [
                "title",
                "description",
                "github_repo",
                "docs",
                "features",
                "data",
                "technical_sources",
                "business_sources",
                "pinned",
            ]

            for field in allowed_fields:
                if field in update_fields:
                    update_data[field] = update_fields[field]

            # Handle pinning logic - only one project can be pinned at a time
            if update_fields.get("pinned") is True:
                # Unpin any other pinned projects first
                unpin_response = (
                    self.supabase_client.table("archon_projects")
                    .update({"pinned": False})
                    .neq("id", project_id)
                    .eq("pinned", True)
                    .execute()
                )
                logger.debug(f"Unpinned {len(unpin_response.data or [])} other projects before pinning {project_id}")

            # Update the target project
            response = (
                self.supabase_client.table("archon_projects")
                .update(update_data)
                .eq("id", project_id)
                .execute()
            )

            if response.data and len(response.data) > 0:
                project = response.data[0]
                return True, {"project": project, "message": "Project updated successfully"}
            else:
                # If update didn't return data, fetch the project to ensure it exists and get current state
                get_response = (
                    self.supabase_client.table("archon_projects")
                    .select("*")
                    .eq("id", project_id)
                    .execute()
                )
                if get_response.data and len(get_response.data) > 0:
                    project = get_response.data[0]
                    return True, {"project": project, "message": "Project updated successfully"}
                else:
                    return False, {"error": f"Project with ID {project_id} not found"}

        except Exception as e:
            logger.error(f"Error updating project: {e}")
            return False, {"error": f"Error updating project: {str(e)}"}
