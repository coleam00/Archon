import logging

from fastapi import APIRouter, Depends, HTTPException

from ...services import ServiceRegistryService, ServiceRegistration
from ...infrastructure.dependencies import get_service_registry_service


router = APIRouter(prefix="/api/providers", tags=["providers"])

logger = logging.getLogger(__name__)


@router.post("/services/register")
async def register_service(
    registration: ServiceRegistration,
    registry_service: ServiceRegistryService = Depends(
        get_service_registry_service)
):
    """Register a new service or update existing one"""
    try:
        service_info = await registry_service.register_service(registration)
        return service_info
    except HTTPException:
        raise
    except Exception:
        logger.error("Failed to register service", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Internal server error"
        )
