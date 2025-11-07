"""Workflow API Routes

FastAPI routes for managing step and workflow templates.
"""

import logging

from fastapi import APIRouter, HTTPException

from ..models.template_models import (
    CreateStepTemplateRequest,
    CreateWorkflowTemplateRequest,
    StepTemplate,
    UpdateStepTemplateRequest,
    UpdateWorkflowTemplateRequest,
    WorkflowTemplate,
)
from ..services.workflow_service import (
    DuplicateTemplateError,
    TemplateNotFoundError,
    ValidationError,
    WorkflowService,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/templates", tags=["Workflow Templates"])


# =====================================================
# WORKFLOW TEMPLATE ENDPOINTS
# =====================================================


@router.get("/workflows", response_model=list[WorkflowTemplate])
async def list_workflow_templates(is_active: bool | None = None) -> list[WorkflowTemplate]:
    """List workflow templates

    Args:
        is_active: Filter by active status

    Returns:
        List of workflow templates

    Raises:
        HTTPException: If database query fails
    """
    logger.info("List workflow templates endpoint called: is_active=%s", is_active)

    try:
        service = WorkflowService()
        templates = await service.list_workflow_templates(is_active=is_active)
        logger.info("List workflow templates endpoint completed: count=%s", len(templates))
        return templates

    except Exception as e:
        logger.exception("List workflow templates endpoint failed: error=%s", str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/workflows/{slug}", response_model=WorkflowTemplate)
async def get_workflow_template(slug: str) -> WorkflowTemplate:
    """Get workflow template by slug

    Args:
        slug: Template slug

    Returns:
        Workflow template

    Raises:
        HTTPException: If template not found or query fails
    """
    logger.info("Get workflow template endpoint called: slug=%s", slug)

    try:
        service = WorkflowService()
        template = await service.get_workflow_template(slug)
        logger.info("Get workflow template endpoint completed: slug=%s", slug)
        return template

    except TemplateNotFoundError as e:
        logger.warning("Get workflow template not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.exception("Get workflow template endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/workflows", response_model=WorkflowTemplate, status_code=201)
async def create_workflow_template(request: CreateWorkflowTemplateRequest) -> WorkflowTemplate:
    """Create new workflow template

    Args:
        request: Template creation request

    Returns:
        Created workflow template

    Raises:
        HTTPException: If slug already exists, validation fails, or creation fails
    """
    logger.info("Create workflow template endpoint called: slug=%s", request.slug)

    try:
        service = WorkflowService()
        template = await service.create_workflow_template(request)
        logger.info("Create workflow template endpoint completed: slug=%s, id=%s", template.slug, template.id)
        return template

    except DuplicateTemplateError as e:
        logger.warning("Create workflow template duplicate: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValidationError as e:
        logger.warning("Create workflow template validation error: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Create workflow template endpoint failed: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.put("/workflows/{slug}", response_model=WorkflowTemplate)
async def update_workflow_template(slug: str, request: UpdateWorkflowTemplateRequest) -> WorkflowTemplate:
    """Update workflow template

    Args:
        slug: Template slug to update
        request: Update request

    Returns:
        Updated workflow template

    Raises:
        HTTPException: If template not found, validation fails, or update fails
    """
    logger.info("Update workflow template endpoint called: slug=%s", slug)

    try:
        service = WorkflowService()
        template = await service.update_workflow_template(slug, request)
        logger.info("Update workflow template endpoint completed: slug=%s", slug)
        return template

    except TemplateNotFoundError as e:
        logger.warning("Update workflow template not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValidationError as e:
        logger.warning("Update workflow template validation error: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Update workflow template endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


# =====================================================
# STEP TEMPLATE ENDPOINTS
# =====================================================


@router.get("/steps", response_model=list[StepTemplate])
async def list_step_templates(
    step_type: str | None = None,
    is_active: bool | None = None,
    latest_only: bool = True,
) -> list[StepTemplate]:
    """List step templates

    Args:
        step_type: Filter by step type (planning, implement, validate, prime, git)
        is_active: Filter by active status
        latest_only: Only return latest version of each slug

    Returns:
        List of step templates

    Raises:
        HTTPException: If database query fails
    """
    logger.info("List step templates endpoint called: step_type=%s, is_active=%s, latest_only=%s", step_type, is_active, latest_only)

    try:
        service = WorkflowService()
        templates = await service.list_step_templates(step_type=step_type, is_active=is_active, latest_only=latest_only)
        logger.info("List step templates endpoint completed: count=%s", len(templates))
        return templates

    except Exception as e:
        logger.exception("List step templates endpoint failed: error=%s", str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/steps/{slug}", response_model=StepTemplate)
async def get_step_template(slug: str, version: int | None = None) -> StepTemplate:
    """Get step template by slug

    Args:
        slug: Template slug
        version: Specific version (None = latest)

    Returns:
        Step template

    Raises:
        HTTPException: If template not found or query fails
    """
    logger.info("Get step template endpoint called: slug=%s, version=%s", slug, version)

    try:
        service = WorkflowService()
        template = await service.get_step_template(slug, version=version)
        logger.info("Get step template endpoint completed: slug=%s, version=%s", slug, template.version)
        return template

    except TemplateNotFoundError as e:
        logger.warning("Get step template not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.exception("Get step template endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/steps", response_model=StepTemplate, status_code=201)
async def create_step_template(request: CreateStepTemplateRequest) -> StepTemplate:
    """Create new step template

    Args:
        request: Template creation request

    Returns:
        Created step template

    Raises:
        HTTPException: If slug already exists, validation fails, or creation fails
    """
    logger.info("Create step template endpoint called: slug=%s, step_type=%s", request.slug, request.step_type)

    try:
        service = WorkflowService()
        template = await service.create_step_template(request)
        logger.info("Create step template endpoint completed: slug=%s, id=%s", template.slug, template.id)
        return template

    except DuplicateTemplateError as e:
        logger.warning("Create step template duplicate: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValidationError as e:
        logger.warning("Create step template validation error: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Create step template endpoint failed: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.put("/steps/{slug}", response_model=StepTemplate)
async def update_step_template(slug: str, request: UpdateStepTemplateRequest) -> StepTemplate:
    """Update step template (creates new version)

    Args:
        slug: Template slug to update
        request: Update request

    Returns:
        New template version

    Raises:
        HTTPException: If template not found, validation fails, or update fails
    """
    logger.info("Update step template endpoint called: slug=%s", slug)

    try:
        service = WorkflowService()
        template = await service.update_step_template(slug, request)
        logger.info("Update step template endpoint completed: slug=%s, new_version=%s", slug, template.version)
        return template

    except TemplateNotFoundError as e:
        logger.warning("Update step template not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValidationError as e:
        logger.warning("Update step template validation error: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("Update step template endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e
