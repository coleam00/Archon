"""Coding Standard API Routes

FastAPI routes for coding standard CRUD operations.
"""

import logging

from fastapi import APIRouter, HTTPException, Query

from ..models.template_models import CodingStandard, CreateCodingStandardRequest, UpdateCodingStandardRequest
from ..services.coding_standard_service import (
    CodingStandardNotFoundError,
    CodingStandardService,
    DuplicateCodingStandardError,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/coding-standards", tags=["coding-standards"])


@router.get("/", response_model=list[CodingStandard])
async def list_coding_standards(
    language: str | None = Query(None, description="Filter by programming language"),
    is_active: bool | None = Query(None, description="Filter by active status"),
) -> list[CodingStandard]:
    """List all coding standards with optional filtering

    Query params:
    - language: Filter by language (e.g., 'python', 'typescript')
    - is_active: Filter by active status

    Returns:
        List of coding standards
    """
    logger.info("List coding standards endpoint called")

    try:
        service = CodingStandardService()
        standards = await service.list_coding_standards(language=language, is_active=is_active)
        return standards

    except Exception as e:
        logger.error("Failed to list coding standards: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to list coding standards: {str(e)}") from e


@router.get("/{slug}", response_model=CodingStandard)
async def get_coding_standard(slug: str) -> CodingStandard:
    """Get coding standard by slug

    Args:
        slug: Coding standard slug

    Returns:
        CodingStandard if found

    Raises:
        404: If standard not found
    """
    logger.info("Get coding standard endpoint called: slug=%s", slug)

    try:
        service = CodingStandardService()
        standard = await service.get_coding_standard(slug)

        if standard is None:
            raise HTTPException(status_code=404, detail=f"Coding standard not found: {slug}")

        return standard

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get coding standard %s: %s", slug, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get coding standard: {str(e)}") from e


@router.post("/", response_model=CodingStandard, status_code=201)
async def create_coding_standard(request: CreateCodingStandardRequest) -> CodingStandard:
    """Create new coding standard

    Args:
        request: Coding standard creation request

    Returns:
        Created coding standard

    Raises:
        400: If slug already exists
        422: If validation fails
    """
    logger.info("Create coding standard endpoint called: slug=%s", request.slug)

    try:
        service = CodingStandardService()
        standard = await service.create_coding_standard(request)
        return standard

    except DuplicateCodingStandardError as e:
        logger.warning("Duplicate coding standard slug: %s", request.slug)
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("Failed to create coding standard: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create coding standard: {str(e)}") from e


@router.put("/{slug}", response_model=CodingStandard)
async def update_coding_standard(slug: str, request: UpdateCodingStandardRequest) -> CodingStandard:
    """Update existing coding standard

    Args:
        slug: Coding standard slug to update
        request: Update request with fields to change

    Returns:
        Updated coding standard

    Raises:
        404: If standard not found
    """
    logger.info("Update coding standard endpoint called: slug=%s", slug)

    try:
        service = CodingStandardService()
        standard = await service.update_coding_standard(slug, request)
        return standard

    except CodingStandardNotFoundError as e:
        logger.warning("Coding standard not found for update: %s", slug)
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error("Failed to update coding standard %s: %s", slug, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update coding standard: {str(e)}") from e


@router.delete("/{slug}", status_code=204)
async def delete_coding_standard(slug: str) -> None:
    """Soft delete coding standard

    Args:
        slug: Coding standard slug to delete

    Raises:
        404: If standard not found
    """
    logger.info("Delete coding standard endpoint called: slug=%s", slug)

    try:
        service = CodingStandardService()
        await service.delete_coding_standard(slug)

    except CodingStandardNotFoundError as e:
        logger.warning("Coding standard not found for delete: %s", slug)
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error("Failed to delete coding standard %s: %s", slug, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete coding standard: {str(e)}") from e
