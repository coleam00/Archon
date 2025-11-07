"""Template Service

Provides business logic for managing agent templates with versioning support.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from ..models.template_models import AgentTemplate, CreateAgentTemplateRequest, UpdateAgentTemplateRequest
from ..utils import get_supabase_client

logger = logging.getLogger(__name__)


class TemplateNotFoundError(Exception):
    """Raised when template is not found"""

    pass


class DuplicateTemplateError(Exception):
    """Raised when template slug already exists"""

    pass


class TemplateService:
    """Service for managing agent templates

    Handles CRUD operations for agent templates with version control.
    Updates create new versions instead of modifying existing templates.
    """

    def __init__(self) -> None:
        """Initialize template service with Supabase client"""
        self.client = get_supabase_client()
        self.table_name = "archon_agent_templates"
        logger.info("Template service initialized for table: %s", self.table_name)

    def _row_to_model(self, row: dict[str, Any]) -> AgentTemplate:
        """Convert database row to AgentTemplate model

        Args:
            row: Database row dictionary

        Returns:
            AgentTemplate model instance
        """
        return AgentTemplate(
            id=row["id"],
            slug=row["slug"],
            name=row["name"],
            description=row.get("description"),
            system_prompt=row["system_prompt"],
            model=row.get("model", "sonnet"),
            temperature=row.get("temperature", 0.0),
            tools=row.get("tools", []),
            standards=row.get("standards", {}),
            metadata=row.get("metadata", {}),
            is_active=row.get("is_active", True),
            version=row.get("version", 1),
            parent_template_id=row.get("parent_template_id"),
            created_by=row.get("created_by"),
            created_at=datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")),
        )

    async def list_agent_templates(
        self, is_active: bool | None = None, latest_only: bool = True
    ) -> list[AgentTemplate]:
        """List agent templates with optional filtering

        Args:
            is_active: Filter by active status (None = all)
            latest_only: Only return latest version of each slug

        Returns:
            List of agent templates

        Raises:
            Exception: If database query fails
        """
        logger.info("List agent templates called: is_active=%s, latest_only=%s", is_active, latest_only)

        try:
            query = self.client.table(self.table_name).select("*")

            if is_active is not None:
                query = query.eq("is_active", is_active)

            if latest_only:
                query = query.order("version", desc=True)

            response = query.execute()
            templates = [self._row_to_model(row) for row in response.data]

            if latest_only:
                # Group by slug and keep only latest version
                latest_templates: dict[str, AgentTemplate] = {}
                for template in templates:
                    if template.slug not in latest_templates or template.version > latest_templates[template.slug].version:
                        latest_templates[template.slug] = template
                templates = list(latest_templates.values())

            logger.info("List agent templates completed: count=%s", len(templates))
            return templates

        except Exception as e:
            logger.exception("List agent templates failed: error=%s", str(e))
            raise

    async def get_agent_template(self, slug: str, version: int | None = None) -> AgentTemplate:
        """Get agent template by slug

        Args:
            slug: Template slug
            version: Specific version (None = latest)

        Returns:
            Agent template

        Raises:
            TemplateNotFoundError: If template not found
        """
        logger.info("Get agent template called: slug=%s, version=%s", slug, version)

        try:
            query = self.client.table(self.table_name).select("*").eq("slug", slug)

            if version is not None:
                query = query.eq("version", version)
            else:
                query = query.order("version", desc=True).limit(1)

            response = query.execute()

            if not response.data:
                logger.warning("Template not found: slug=%s, version=%s", slug, version)
                raise TemplateNotFoundError(f"Template not found: {slug}")

            template = self._row_to_model(response.data[0])
            logger.info("Get agent template completed: slug=%s, version=%s", slug, template.version)
            return template

        except TemplateNotFoundError:
            raise
        except Exception as e:
            logger.exception("Get agent template failed: slug=%s, error=%s", slug, str(e))
            raise

    async def create_agent_template(self, request: CreateAgentTemplateRequest) -> AgentTemplate:
        """Create new agent template

        Args:
            request: Template creation request

        Returns:
            Created agent template

        Raises:
            DuplicateTemplateError: If slug already exists
        """
        logger.info("Create agent template called: slug=%s", request.slug)

        try:
            # Check if slug exists
            existing = self.client.table(self.table_name).select("id").eq("slug", request.slug).execute()
            if existing.data:
                raise DuplicateTemplateError(f"Template slug already exists: {request.slug}")

            # Insert new template
            now = datetime.now(UTC).isoformat()
            data = {
                "slug": request.slug,
                "name": request.name,
                "description": request.description,
                "system_prompt": request.system_prompt,
                "model": request.model,
                "temperature": request.temperature,
                "tools": request.tools,
                "standards": request.standards,
                "metadata": request.metadata,
                "is_active": True,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            }

            response = self.client.table(self.table_name).insert(data).execute()
            template = self._row_to_model(response.data[0])

            logger.info("Create agent template completed: slug=%s, id=%s", template.slug, template.id)
            return template

        except DuplicateTemplateError:
            raise
        except Exception as e:
            logger.exception("Create agent template failed: slug=%s, error=%s", request.slug, str(e))
            raise

    async def update_agent_template(self, slug: str, request: UpdateAgentTemplateRequest) -> AgentTemplate:
        """Update agent template

        Args:
            slug: Template slug to update
            request: Update request

        Returns:
            Updated template

        Raises:
            TemplateNotFoundError: If template not found
        """
        logger.info("Update agent template called: slug=%s", slug)

        try:
            # Check if template exists
            current = await self.get_agent_template(slug)
            if not current:
                raise TemplateNotFoundError(f"Template not found: {slug}")

            # Build update data with only provided fields
            update_data: dict[str, Any] = {"updated_at": datetime.now(UTC).isoformat()}

            if request.name is not None:
                update_data["name"] = request.name
            if request.description is not None:
                update_data["description"] = request.description
            if request.system_prompt is not None:
                update_data["system_prompt"] = request.system_prompt
            if request.model is not None:
                update_data["model"] = request.model
            if request.temperature is not None:
                update_data["temperature"] = request.temperature
            if request.tools is not None:
                update_data["tools"] = request.tools
            if request.standards is not None:
                update_data["standards"] = request.standards
            if request.metadata is not None:
                update_data["metadata"] = request.metadata
            if request.is_active is not None:
                update_data["is_active"] = request.is_active

            # Update existing template
            response = self.client.table(self.table_name).update(update_data).eq("slug", slug).eq("is_active", True).execute()

            if not response.data:
                raise TemplateNotFoundError(f"Template not found: {slug}")

            template = self._row_to_model(response.data[0])

            logger.info("Update agent template completed: slug=%s", slug)
            return template

        except TemplateNotFoundError:
            raise
        except Exception as e:
            logger.exception("Update agent template failed: slug=%s, error=%s", slug, str(e))
            raise

    async def get_template_versions(self, slug: str) -> list[AgentTemplate]:
        """Get all versions of a template

        Args:
            slug: Template slug

        Returns:
            List of all template versions, newest first

        Raises:
            TemplateNotFoundError: If template not found
        """
        logger.info("Get template versions called: slug=%s", slug)

        try:
            response = (
                self.client.table(self.table_name).select("*").eq("slug", slug).order("version", desc=True).execute()
            )

            if not response.data:
                raise TemplateNotFoundError(f"Template not found: {slug}")

            templates = [self._row_to_model(row) for row in response.data]
            logger.info("Get template versions completed: slug=%s, count=%s", slug, len(templates))
            return templates

        except TemplateNotFoundError:
            raise
        except Exception as e:
            logger.exception("Get template versions failed: slug=%s, error=%s", slug, str(e))
            raise
