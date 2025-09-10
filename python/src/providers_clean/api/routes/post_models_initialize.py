import logging
from typing import Dict, Any, cast
from fastapi import APIRouter, Depends, HTTPException

from ...services import ModelSyncService
from ...infrastructure.dependencies import get_model_sync_service


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.post("/models/initialize")
async def initialize_models_database(
    force_refresh: bool = False,
    sync_service: ModelSyncService = Depends(get_model_sync_service)
) -> Dict[str, Any]:
    """Initialize the models database with data from external sources"""
    try:
        logger.info("Initializing models database...")
        result: Any = await sync_service.full_sync(force_refresh=force_refresh)
        status: Dict[str, Any] = await sync_service.get_sync_status() or {}
        providers_raw = status.get('providers')
        providers: Dict[str, Any] = cast(Dict[str, Any], providers_raw) if isinstance(providers_raw, dict) else {}
        return {
            "status": "initialized",
            "sync_result": result,
            "total_models": status.get('active_models', 0),
            "providers": len(providers),
            "message": "Models database initialized successfully"
        }
    except Exception as e:
        logger.error(f"Failed to initialize models database: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to initialize models database: {str(e)}"
        )
