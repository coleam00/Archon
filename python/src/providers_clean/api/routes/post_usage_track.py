from typing import Any, Dict
from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_usage_service
from ..schemas import UsageTrackRequest
from ...services import UsageService


router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.post("/usage/track")
async def track_usage(
    request: UsageTrackRequest,
    tracker: UsageService = Depends(get_usage_service)
) -> Dict[str, Any]:
    """Track usage for a service"""
    try:
        result = await tracker.track_usage(
            service_name=request.service_name,
            model_string=request.model_string,
            input_tokens=request.input_tokens,
            output_tokens=request.output_tokens,
            metadata=request.metadata
        )
        if result:
            return {"status": "success", "tracked": True}
        else:
            raise HTTPException(
                status_code=500,
                detail="Failed to track usage"
            )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to track usage: {str(e)}"
        )

