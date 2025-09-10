from typing import Dict
import logging
from fastapi import APIRouter, Depends, HTTPException, status

from ..deps import get_model_service
from ...services import ModelConfigService


router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.get("/models/configs", response_model=Dict[str, str])
async def get_all_model_configs(
    service: ModelConfigService = Depends(get_model_service)
):
    """Get all service model configurations"""
    try:
        configs = await service.get_all_configs()
        return configs
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        logging.error(f"Failed to get configurations: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get configurations"
        )

