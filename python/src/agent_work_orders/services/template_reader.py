"""Template Reader Service for Agent Work Orders

Provides READ-ONLY access to Context Hub templates from Supabase.
AWO uses this to execute workflows based on templates but NEVER modifies them.

Phase 3 will use this service to:
- Load workflow templates for a repository
- Load step templates with sub-workflows
- Load agent templates for execution
- Apply repository-specific overrides

NOTE: This service only READS from Context Hub tables. All template CRUD
happens in the main server (src/server/services/template_service.py).
"""

from typing import Any

from ..state_manager.repository_config_repository import get_supabase_client
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class TemplateReader:
    """Read-only access to Context Hub templates

    This service provides AWO with access to templates stored in the Context Hub
    (core Archon). It queries Supabase directly but never modifies template data.
    """

    def __init__(self):
        """Initialize template reader with Supabase client"""
        self.client = get_supabase_client()

    async def get_workflow_template(self, workflow_template_id: str) -> dict[str, Any] | None:
        """Get workflow template by ID

        Args:
            workflow_template_id: UUID of workflow template

        Returns:
            Workflow template dict or None if not found
        """
        try:
            response = self.client.table("archon_workflow_templates").select("*").eq("id", workflow_template_id).eq("is_active", True).execute()

            if response.data and len(response.data) > 0:
                logger.info("workflow_template_loaded", workflow_template_id=workflow_template_id)
                return response.data[0]

            logger.warning("workflow_template_not_found", workflow_template_id=workflow_template_id)
            return None
        except Exception as e:
            logger.exception("workflow_template_load_failed", workflow_template_id=workflow_template_id, error=str(e))
            return None

    async def get_step_template(self, step_template_slug: str) -> dict[str, Any] | None:
        """Get step template by slug

        Args:
            step_template_slug: Slug of step template

        Returns:
            Step template dict or None if not found
        """
        try:
            response = self.client.table("archon_step_templates").select("*").eq("slug", step_template_slug).eq("is_active", True).order("version", desc=True).limit(1).execute()

            if response.data and len(response.data) > 0:
                logger.info("step_template_loaded", step_template_slug=step_template_slug)
                return response.data[0]

            logger.warning("step_template_not_found", step_template_slug=step_template_slug)
            return None
        except Exception as e:
            logger.exception("step_template_load_failed", step_template_slug=step_template_slug, error=str(e))
            return None

    async def get_agent_template(self, agent_template_slug: str) -> dict[str, Any] | None:
        """Get agent template by slug

        Args:
            agent_template_slug: Slug of agent template

        Returns:
            Agent template dict or None if not found
        """
        try:
            response = self.client.table("archon_agent_templates").select("*").eq("slug", agent_template_slug).eq("is_active", True).order("version", desc=True).limit(1).execute()

            if response.data and len(response.data) > 0:
                logger.info("agent_template_loaded", agent_template_slug=agent_template_slug)
                return response.data[0]

            logger.warning("agent_template_not_found", agent_template_slug=agent_template_slug)
            return None
        except Exception as e:
            logger.exception("agent_template_load_failed", agent_template_slug=agent_template_slug, error=str(e))
            return None

    async def get_repository_workflow(self, repository_id: str) -> dict[str, Any] | None:
        """Get workflow template assigned to repository

        Args:
            repository_id: UUID of configured repository

        Returns:
            Workflow template dict or None if not assigned
        """
        try:
            # Get repository's workflow_template_id
            repo_response = self.client.table("archon_configured_repositories").select("default_workflow_template_id").eq("id", repository_id).execute()

            if not repo_response.data or len(repo_response.data) == 0:
                logger.warning("repository_not_found", repository_id=repository_id)
                return None

            workflow_template_id = repo_response.data[0].get("default_workflow_template_id")
            if not workflow_template_id:
                logger.info("repository_no_workflow_assigned", repository_id=repository_id)
                return None

            # Load workflow template
            return await self.get_workflow_template(workflow_template_id)
        except Exception as e:
            logger.exception("repository_workflow_load_failed", repository_id=repository_id, error=str(e))
            return None

    async def get_repository_agent_overrides(self, repository_id: str) -> list[dict[str, Any]]:
        """Get repository-specific agent overrides

        Args:
            repository_id: UUID of configured repository

        Returns:
            List of agent override dicts
        """
        try:
            response = self.client.table("archon_repository_agent_overrides").select("*").eq("configured_repository_id", repository_id).eq("is_active", True).execute()

            logger.info("repository_agent_overrides_loaded", repository_id=repository_id, count=len(response.data))
            return response.data
        except Exception as e:
            logger.exception("repository_agent_overrides_load_failed", repository_id=repository_id, error=str(e))
            return []
