"""
Versioning Service Module for Archon

This module provides core business logic for document versioning operations
that can be shared between MCP tools and FastAPI endpoints.
"""

# Removed direct logging import - using unified config
from datetime import datetime
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class VersioningService:
    """Service class for document versioning operations"""

    def __init__(self, supabase_client=None):
        """Initialize with optional supabase client"""
        self.supabase_client = supabase_client or get_supabase_client()

    def create_version(
        self,
        project_id: str,
        field_name: str,
        content: Any,
        change_summary: str = None,
        change_type: str = "update",
        document_id: str = None,
        created_by: str = "system",
    ) -> tuple[bool, dict[str, Any]]:
        """
        Create a version snapshot for a project JSONB field.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Get current highest version number for this project/field
            existing_versions = (
                self.supabase_client.table("archon_document_versions")
                .select("version_number")
                .eq("project_id", project_id)
                .eq("field_name", field_name)
                .order("version_number", desc=True)
                .limit(1)
                .execute()
            )

            next_version = 1
            if existing_versions.data:
                next_version = existing_versions.data[0]["version_number"] + 1

            # Create new version record
            version_data = {
                "project_id": project_id,
                "field_name": field_name,
                "version_number": next_version,
                "content": content,
                "change_summary": change_summary or f"{change_type.capitalize()} {field_name}",
                "change_type": change_type,
                "document_id": document_id,
                "created_by": created_by,
                "created_at": datetime.now().isoformat(),
            }

            result = (
                self.supabase_client.table("archon_document_versions")
                .insert(version_data)
                .execute()
            )

            if result.data:
                return True, {
                    "version": result.data[0],
                    "project_id": project_id,
                    "field_name": field_name,
                    "version_number": next_version,
                }
            else:
                return False, {"error": "Failed to create version snapshot"}

        except Exception as e:
            logger.error(f"Error creating version: {e}")
            return False, {"error": f"Error creating version: {str(e)}"}

    def list_versions(self, project_id: str, field_name: str = None) -> tuple[bool, dict[str, Any]]:
        """
        Get version history for project JSONB fields.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Build query
            query = (
                self.supabase_client.table("archon_document_versions")
                .select("*")
                .eq("project_id", project_id)
            )

            if field_name:
                query = query.eq("field_name", field_name)

            # Get versions ordered by version number descending
            result = query.order("version_number", desc=True).execute()

            if result.data is not None:
                return True, {
                    "project_id": project_id,
                    "field_name": field_name,
                    "versions": result.data,
                    "total_count": len(result.data),
                }
            else:
                return False, {"error": "Failed to retrieve version history"}

        except Exception as e:
            logger.error(f"Error getting version history: {e}")
            return False, {"error": f"Error getting version history: {str(e)}"}

    def get_version_content(
        self, project_id: str, field_name: str, version_number: int
    ) -> tuple[bool, dict[str, Any]]:
        """
        Get the content of a specific version.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Query for specific version
            result = (
                self.supabase_client.table("archon_document_versions")
                .select("*")
                .eq("project_id", project_id)
                .eq("field_name", field_name)
                .eq("version_number", version_number)
                .execute()
            )

            if result.data:
                version = result.data[0]
                return True, {
                    "version": version,
                    "field_name": field_name,
                    "version_number": version_number,
                }
            else:
                return False, {"error": f"Version {version_number} not found for {field_name}"}

        except Exception as e:
            logger.error(f"Error getting version content: {e}")
            return False, {"error": f"Error getting version content: {str(e)}"}

    def restore_version(
        self, project_id: str, field_name: str, version_number: int, restored_by: str = "system"
    ) -> tuple[bool, dict[str, Any]]:
        """
        Restore a project JSONB field to a specific version.

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # Get the version to restore
            version_result = (
                self.supabase_client.table("archon_document_versions")
                .select("*")
                .eq("project_id", project_id)
                .eq("field_name", field_name)
                .eq("version_number", version_number)
                .execute()
            )

            if not version_result.data:
                return False, {
                    "error": f"Version {version_number} not found for {field_name} in project {project_id}"
                }

            version_to_restore = version_result.data[0]
            content_to_restore = version_to_restore["content"]

            # Get current content to create backup
            current_project = (
                self.supabase_client.table("archon_projects")
                .select(field_name)
                .eq("id", project_id)
                .execute()
            )
            if current_project.data:
                current_content = current_project.data[0].get(field_name, {})

                # Create backup version before restore
                backup_result = self.create_version(
                    project_id=project_id,
                    field_name=field_name,
                    content=current_content,
                    change_summary=f"Backup before restoring to version {version_number}",
                    change_type="backup",
                    created_by=restored_by,
                )

                if not backup_result[0]:
                    logger.warning(f"Failed to create backup version: {backup_result[1]}")

            # Restore the content to project
            update_data = {field_name: content_to_restore, "updated_at": datetime.now().isoformat()}

            restore_result = (
                self.supabase_client.table("archon_projects")
                .update(update_data)
                .eq("id", project_id)
                .execute()
            )

            if restore_result.data:
                # Create restore version record
                restore_version_result = self.create_version(
                    project_id=project_id,
                    field_name=field_name,
                    content=content_to_restore,
                    change_summary=f"Restored to version {version_number}",
                    change_type="restore",
                    created_by=restored_by,
                )

                return True, {
                    "project_id": project_id,
                    "field_name": field_name,
                    "restored_version": version_number,
                    "restored_by": restored_by,
                }
            else:
                return False, {"error": "Failed to restore version"}

        except Exception as e:
            logger.error(f"Error restoring version: {e}")
            return False, {"error": f"Error restoring version: {str(e)}"}
