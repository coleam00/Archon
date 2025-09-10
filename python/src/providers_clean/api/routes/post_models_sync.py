from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from typing import Dict, Any

from ...services import ModelSyncService
from ...infrastructure.dependencies import get_model_sync_service


router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.post("/models/sync")
async def sync_models_from_sources(
    background_tasks: BackgroundTasks,
    force_refresh: bool = Query(False, description="Force a full refresh of all models from external sources"),
    sync_service: ModelSyncService = Depends(get_model_sync_service)
) -> Dict[str, Any]:
    """Manually trigger a sync of all models from external sources"""
    try:
        # Run sync in background to avoid blocking
        background_tasks.add_task(sync_service.full_sync, force_refresh=force_refresh)
        return {"message": "Model sync started in background", "force_refresh": force_refresh}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start model sync: {str(e)}"
        )
