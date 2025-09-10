from fastapi import APIRouter, Depends, HTTPException, status
import logging

from ...services import ServiceRegistryService
from ...infrastructure.dependencies import get_service_registry_service


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.post("/services/registry/sync")
async def sync_registry_with_configs(
    registry_service: ServiceRegistryService = Depends(
        get_service_registry_service)
):
    """Sync service registry with current model configurations"""
    try:
        result = await registry_service.sync_registry_with_model_configs()
        return result
    except Exception:
        logger.exception("Failed to sync registry")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to sync registry"
        )
