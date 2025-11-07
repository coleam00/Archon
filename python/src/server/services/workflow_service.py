"""Workflow Service

Provides business logic for managing step and workflow templates with validation.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from ..models.template_models import (
    CreateStepTemplateRequest,
    CreateWorkflowTemplateRequest,
    StepTemplate,
    UpdateStepTemplateRequest,
    UpdateWorkflowTemplateRequest,
    WorkflowTemplate,
)
from ..utils import get_supabase_client

logger = logging.getLogger(__name__)


class TemplateNotFoundError(Exception):
    """Raised when template is not found"""

    pass


class DuplicateTemplateError(Exception):
    """Raised when template slug already exists"""

    pass


class ValidationError(Exception):
    """Raised when template validation fails"""

    pass


class WorkflowService:
    """Service for managing step and workflow templates

    Handles CRUD operations with validation for step templates (with sub-workflow support)
    and workflow templates (with required step type validation).
    """

    def __init__(self) -> None:
        """Initialize workflow service with Supabase client"""
        self.client = get_supabase_client()
        self.step_table = "archon_step_templates"
        self.workflow_table = "archon_workflow_templates"
        logger.info("Workflow service initialized")

    # =====================================================
    # STEP TEMPLATE METHODS
    # =====================================================

    def _step_row_to_model(self, row: dict[str, Any]) -> StepTemplate:
        """Convert database row to StepTemplate model

        Args:
            row: Database row dictionary

        Returns:
            StepTemplate model instance
        """
        return StepTemplate(
            id=row["id"],
            step_type=row["step_type"],
            slug=row["slug"],
            name=row["name"],
            description=row.get("description"),
            prompt_template=row["prompt_template"],
            agent_template_id=row.get("agent_template_id"),
            sub_steps=row.get("sub_steps", []),
            metadata=row.get("metadata", {}),
            is_active=row.get("is_active", True),
            version=row.get("version", 1),
            parent_template_id=row.get("parent_template_id"),
            created_by=row.get("created_by"),
            created_at=datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")),
        )

    def _validate_sub_steps(self, sub_steps: list[dict[str, Any]]) -> None:
        """Validate sub-steps structure

        Args:
            sub_steps: Sub-steps array to validate

        Raises:
            ValidationError: If validation fails
        """
        if not sub_steps:
            return  # Empty sub_steps is valid (single-agent mode)

        # Check required fields
        required_fields = ["order", "name", "agent_template_slug", "prompt_template", "required"]
        for i, sub_step in enumerate(sub_steps):
            for field in required_fields:
                if field not in sub_step:
                    raise ValidationError(f"Sub-step {i} missing required field: {field}")

        # Check unique order values
        orders = [s["order"] for s in sub_steps]
        if len(orders) != len(set(orders)):
            raise ValidationError("Sub-steps must have unique order values")

        # Check order is sequential starting from 1
        sorted_orders = sorted(orders)
        if sorted_orders != list(range(1, len(orders) + 1)):
            raise ValidationError("Sub-steps order must be sequential starting from 1")

    async def list_step_templates(
        self, step_type: str | None = None, is_active: bool | None = None, latest_only: bool = True
    ) -> list[StepTemplate]:
        """List step templates with optional filtering

        Args:
            step_type: Filter by step type
            is_active: Filter by active status
            latest_only: Only return latest version of each slug

        Returns:
            List of step templates

        Raises:
            Exception: If database query fails
        """
        logger.info("List step templates called: step_type=%s, is_active=%s, latest_only=%s", step_type, is_active, latest_only)

        try:
            query = self.client.table(self.step_table).select("*")

            if step_type is not None:
                query = query.eq("step_type", step_type)

            if is_active is not None:
                query = query.eq("is_active", is_active)

            if latest_only:
                query = query.order("version", desc=True)

            response = query.execute()
            templates = [self._step_row_to_model(row) for row in response.data]

            if latest_only:
                # Group by slug and keep only latest version
                latest_templates: dict[str, StepTemplate] = {}
                for template in templates:
                    if template.slug not in latest_templates or template.version > latest_templates[template.slug].version:
                        latest_templates[template.slug] = template
                templates = list(latest_templates.values())

            logger.info("List step templates completed: count=%s", len(templates))
            return templates

        except Exception as e:
            logger.exception("List step templates failed: error=%s", str(e))
            raise

    async def get_step_template(self, slug: str, version: int | None = None) -> StepTemplate:
        """Get step template by slug

        Args:
            slug: Template slug
            version: Specific version (None = latest)

        Returns:
            Step template

        Raises:
            TemplateNotFoundError: If template not found
        """
        logger.info("Get step template called: slug=%s, version=%s", slug, version)

        try:
            query = self.client.table(self.step_table).select("*").eq("slug", slug)

            if version is not None:
                query = query.eq("version", version)
            else:
                query = query.order("version", desc=True).limit(1)

            response = query.execute()

            if not response.data:
                logger.warning("Step template not found: slug=%s, version=%s", slug, version)
                raise TemplateNotFoundError(f"Step template not found: {slug}")

            template = self._step_row_to_model(response.data[0])
            logger.info("Get step template completed: slug=%s, version=%s", slug, template.version)
            return template

        except TemplateNotFoundError:
            raise
        except Exception as e:
            logger.exception("Get step template failed: slug=%s, error=%s", slug, str(e))
            raise

    async def create_step_template(self, request: CreateStepTemplateRequest) -> StepTemplate:
        """Create new step template

        Args:
            request: Template creation request

        Returns:
            Created step template

        Raises:
            DuplicateTemplateError: If slug already exists
            ValidationError: If sub-steps validation fails
        """
        logger.info("Create step template called: slug=%s, step_type=%s", request.slug, request.step_type)

        try:
            # Validate sub-steps
            self._validate_sub_steps(request.sub_steps)

            # Check if slug exists
            existing = self.client.table(self.step_table).select("id").eq("slug", request.slug).execute()
            if existing.data:
                raise DuplicateTemplateError(f"Step template slug already exists: {request.slug}")

            # Insert new template
            now = datetime.now(UTC).isoformat()
            data = {
                "step_type": request.step_type,
                "slug": request.slug,
                "name": request.name,
                "description": request.description,
                "prompt_template": request.prompt_template,
                "agent_template_id": request.agent_template_id,
                "sub_steps": request.sub_steps,
                "metadata": request.metadata,
                "is_active": True,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            }

            response = self.client.table(self.step_table).insert(data).execute()
            template = self._step_row_to_model(response.data[0])

            logger.info("Create step template completed: slug=%s, id=%s", template.slug, template.id)
            return template

        except (DuplicateTemplateError, ValidationError):
            raise
        except Exception as e:
            logger.exception("Create step template failed: slug=%s, error=%s", request.slug, str(e))
            raise

    async def update_step_template(self, slug: str, request: UpdateStepTemplateRequest) -> StepTemplate:
        """Update step template (creates new version)

        Args:
            slug: Template slug to update
            request: Update request

        Returns:
            New template version

        Raises:
            TemplateNotFoundError: If template not found
            ValidationError: If sub-steps validation fails
        """
        logger.info("Update step template called: slug=%s", slug)

        try:
            # Get current template
            current = await self.get_step_template(slug)

            # Validate sub-steps if provided
            if request.sub_steps is not None:
                self._validate_sub_steps(request.sub_steps)

            # Prepare new version data
            now = datetime.now(UTC).isoformat()
            data = {
                "step_type": current.step_type,  # Cannot change step type
                "slug": slug,
                "name": request.name if request.name is not None else current.name,
                "description": request.description if request.description is not None else current.description,
                "prompt_template": request.prompt_template if request.prompt_template is not None else current.prompt_template,
                "agent_template_id": request.agent_template_id if request.agent_template_id is not None else current.agent_template_id,
                "sub_steps": request.sub_steps if request.sub_steps is not None else current.sub_steps,
                "metadata": request.metadata if request.metadata is not None else current.metadata,
                "is_active": request.is_active if request.is_active is not None else current.is_active,
                "version": current.version + 1,
                "parent_template_id": current.id,
                "created_at": now,
                "updated_at": now,
            }

            # Insert new version
            response = self.client.table(self.step_table).insert(data).execute()
            template = self._step_row_to_model(response.data[0])

            logger.info(
                "Update step template completed: slug=%s, old_version=%s, new_version=%s", slug, current.version, template.version
            )
            return template

        except (TemplateNotFoundError, ValidationError):
            raise
        except Exception as e:
            logger.exception("Update step template failed: slug=%s, error=%s", slug, str(e))
            raise

    # =====================================================
    # WORKFLOW TEMPLATE METHODS
    # =====================================================

    def _workflow_row_to_model(self, row: dict[str, Any]) -> WorkflowTemplate:
        """Convert database row to WorkflowTemplate model

        Args:
            row: Database row dictionary

        Returns:
            WorkflowTemplate model instance
        """
        return WorkflowTemplate(
            id=row["id"],
            slug=row["slug"],
            name=row["name"],
            description=row.get("description"),
            steps=row["steps"],
            metadata=row.get("metadata", {}),
            is_active=row.get("is_active", True),
            created_by=row.get("created_by"),
            created_at=datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")),
        )

    def _validate_workflow_steps(self, steps: list[dict[str, Any]]) -> None:
        """Validate workflow steps structure

        Workflow must have at least one planning, implement, and validate step.

        Args:
            steps: Steps array to validate

        Raises:
            ValidationError: If validation fails
        """
        if not steps:
            raise ValidationError("Workflow must have at least one step")

        # Check required fields
        required_fields = ["step_type", "order", "step_template_slug"]
        for i, step in enumerate(steps):
            for field in required_fields:
                if field not in step:
                    raise ValidationError(f"Step {i} missing required field: {field}")

        # Check unique order values
        orders = [s["order"] for s in steps]
        if len(orders) != len(set(orders)):
            raise ValidationError("Steps must have unique order values")

        # Check for required step types
        step_types = {s["step_type"] for s in steps}
        required_types = {"planning", "implement", "validate"}
        missing_types = required_types - step_types

        if missing_types:
            raise ValidationError(f"Workflow missing required step types: {', '.join(sorted(missing_types))}")

    async def list_workflow_templates(self, is_active: bool | None = None) -> list[WorkflowTemplate]:
        """List workflow templates with optional filtering

        Args:
            is_active: Filter by active status

        Returns:
            List of workflow templates

        Raises:
            Exception: If database query fails
        """
        logger.info("List workflow templates called: is_active=%s", is_active)

        try:
            query = self.client.table(self.workflow_table).select("*")

            if is_active is not None:
                query = query.eq("is_active", is_active)

            response = query.execute()
            templates = [self._workflow_row_to_model(row) for row in response.data]

            logger.info("List workflow templates completed: count=%s", len(templates))
            return templates

        except Exception as e:
            logger.exception("List workflow templates failed: error=%s", str(e))
            raise

    async def get_workflow_template(self, slug: str) -> WorkflowTemplate:
        """Get workflow template by slug

        Args:
            slug: Template slug

        Returns:
            Workflow template

        Raises:
            TemplateNotFoundError: If template not found
        """
        logger.info("Get workflow template called: slug=%s", slug)

        try:
            response = self.client.table(self.workflow_table).select("*").eq("slug", slug).execute()

            if not response.data:
                logger.warning("Workflow template not found: slug=%s", slug)
                raise TemplateNotFoundError(f"Workflow template not found: {slug}")

            template = self._workflow_row_to_model(response.data[0])
            logger.info("Get workflow template completed: slug=%s", slug)
            return template

        except TemplateNotFoundError:
            raise
        except Exception as e:
            logger.exception("Get workflow template failed: slug=%s, error=%s", slug, str(e))
            raise

    async def create_workflow_template(self, request: CreateWorkflowTemplateRequest) -> WorkflowTemplate:
        """Create new workflow template

        Args:
            request: Template creation request

        Returns:
            Created workflow template

        Raises:
            DuplicateTemplateError: If slug already exists
            ValidationError: If workflow validation fails
        """
        logger.info("Create workflow template called: slug=%s", request.slug)

        try:
            # Validate workflow steps
            self._validate_workflow_steps(request.steps)

            # Check if slug exists
            existing = self.client.table(self.workflow_table).select("id").eq("slug", request.slug).execute()
            if existing.data:
                raise DuplicateTemplateError(f"Workflow template slug already exists: {request.slug}")

            # Insert new template
            now = datetime.now(UTC).isoformat()
            data = {
                "slug": request.slug,
                "name": request.name,
                "description": request.description,
                "steps": request.steps,
                "metadata": request.metadata,
                "is_active": True,
                "created_at": now,
                "updated_at": now,
            }

            response = self.client.table(self.workflow_table).insert(data).execute()
            template = self._workflow_row_to_model(response.data[0])

            logger.info("Create workflow template completed: slug=%s, id=%s", template.slug, template.id)
            return template

        except (DuplicateTemplateError, ValidationError):
            raise
        except Exception as e:
            logger.exception("Create workflow template failed: slug=%s, error=%s", request.slug, str(e))
            raise

    async def update_workflow_template(self, slug: str, request: UpdateWorkflowTemplateRequest) -> WorkflowTemplate:
        """Update workflow template

        Args:
            slug: Template slug to update
            request: Update request

        Returns:
            Updated workflow template

        Raises:
            TemplateNotFoundError: If template not found
            ValidationError: If workflow validation fails
        """
        logger.info("Update workflow template called: slug=%s", slug)

        try:
            # Get current template
            current = await self.get_workflow_template(slug)

            # Validate steps if provided
            steps = request.steps if request.steps is not None else current.steps
            self._validate_workflow_steps(steps)

            # Prepare update data
            now = datetime.now(UTC).isoformat()
            data = {
                "name": request.name if request.name is not None else current.name,
                "description": request.description if request.description is not None else current.description,
                "steps": steps,
                "metadata": request.metadata if request.metadata is not None else current.metadata,
                "is_active": request.is_active if request.is_active is not None else current.is_active,
                "updated_at": now,
            }

            # Update template
            response = self.client.table(self.workflow_table).update(data).eq("slug", slug).execute()
            template = self._workflow_row_to_model(response.data[0])

            logger.info("Update workflow template completed: slug=%s", slug)
            return template

        except (TemplateNotFoundError, ValidationError):
            raise
        except Exception as e:
            logger.exception("Update workflow template failed: slug=%s, error=%s", slug, str(e))
            raise
