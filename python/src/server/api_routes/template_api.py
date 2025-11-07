"""Template API Routes

FastAPI routes for managing agent templates.
"""

import logging

from fastapi import APIRouter, HTTPException

from ..models.template_models import (
    AgentTemplate,
    CreateAgentTemplateRequest,
    UpdateAgentTemplateRequest,
)
from ..services.template_service import (
    DuplicateTemplateError,
    TemplateNotFoundError,
    TemplateService,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/templates/agents", tags=["Agent Templates"])


@router.get("/", response_model=list[AgentTemplate])
async def list_agent_templates(
    is_active: bool | None = None,
    latest_only: bool = True,
) -> list[AgentTemplate]:
    """List agent templates

    Args:
        is_active: Filter by active status (None = all)
        latest_only: Only return latest version of each slug

    Returns:
        List of agent templates

    Raises:
        HTTPException: If database query fails
    """
    logger.info("List agent templates endpoint called: is_active=%s, latest_only=%s", is_active, latest_only)

    try:
        service = TemplateService()
        templates = await service.list_agent_templates(is_active=is_active, latest_only=latest_only)
        logger.info("List agent templates endpoint completed: count=%s", len(templates))
        return templates

    except Exception as e:
        logger.exception("List agent templates endpoint failed: error=%s", str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/{slug}", response_model=AgentTemplate)
async def get_agent_template(slug: str, version: int | None = None) -> AgentTemplate:
    """Get agent template by slug

    Args:
        slug: Template slug
        version: Specific version (None = latest)

    Returns:
        Agent template

    Raises:
        HTTPException: If template not found or query fails
    """
    logger.info("Get agent template endpoint called: slug=%s, version=%s", slug, version)

    try:
        service = TemplateService()
        template = await service.get_agent_template(slug, version=version)
        logger.info("Get agent template endpoint completed: slug=%s, version=%s", slug, template.version)
        return template

    except TemplateNotFoundError as e:
        logger.warning("Get agent template not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.exception("Get agent template endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/", response_model=AgentTemplate, status_code=201)
async def create_agent_template(request: CreateAgentTemplateRequest) -> AgentTemplate:
    """Create new agent template

    Args:
        request: Template creation request

    Returns:
        Created agent template

    Raises:
        HTTPException: If slug already exists or creation fails
    """
    logger.info("Create agent template endpoint called: slug=%s", request.slug)

    try:
        service = TemplateService()
        template = await service.create_agent_template(request)
        logger.info("Create agent template endpoint completed: slug=%s, id=%s", template.slug, template.id)
        return template

    except DuplicateTemplateError as e:
        logger.warning("Create agent template duplicate: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=409, detail=str(e)) from e
    except Exception as e:
        logger.exception("Create agent template endpoint failed: slug=%s, error=%s", request.slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.put("/{slug}", response_model=AgentTemplate)
async def update_agent_template(slug: str, request: UpdateAgentTemplateRequest) -> AgentTemplate:
    """Update agent template (creates new version)

    Args:
        slug: Template slug to update
        request: Update request

    Returns:
        New template version

    Raises:
        HTTPException: If template not found or update fails
    """
    logger.info("Update agent template endpoint called: slug=%s", slug)

    try:
        service = TemplateService()
        template = await service.update_agent_template(slug, request)
        logger.info("Update agent template endpoint completed: slug=%s, new_version=%s", slug, template.version)
        return template

    except TemplateNotFoundError as e:
        logger.warning("Update agent template not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.exception("Update agent template endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/{slug}/versions", response_model=list[AgentTemplate])
async def get_template_versions(slug: str) -> list[AgentTemplate]:
    """Get all versions of a template

    Args:
        slug: Template slug

    Returns:
        List of all template versions, newest first

    Raises:
        HTTPException: If template not found or query fails
    """
    logger.info("Get template versions endpoint called: slug=%s", slug)

    try:
        service = TemplateService()
        templates = await service.get_template_versions(slug)
        logger.info("Get template versions endpoint completed: slug=%s, count=%s", slug, len(templates))
        return templates

    except TemplateNotFoundError as e:
        logger.warning("Get template versions not found: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.exception("Get template versions endpoint failed: slug=%s, error=%s", slug, str(e))
        raise HTTPException(status_code=500, detail=str(e)) from e
