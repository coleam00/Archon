from typing import Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ...services import ServiceRegistryService
from ...infrastructure.dependencies import get_service_registry_service


class DeprecateServiceRequest(BaseModel):
    reason: str = Field(min_length=1)
    replacement_service: Optional[str] = None


router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.post("/services/{service_name}/deprecate")
async def deprecate_service(
    service_name: str,
    payload: DeprecateServiceRequest,
    registry_service: ServiceRegistryService = Depends(get_service_registry_service),
) -> Dict[str, Any]:
    """Mark a service as deprecated"""
    try:
        result = await registry_service.deprecate_service(
            service_name, payload.reason, payload.replacement_service
        )
        if result:
            return {
                "status": "success",
                "service": service_name,
                "reason": payload.reason,
                "replacement_service": payload.replacement_service,
            }
        else:
            raise HTTPException(
                status_code=404,
                detail=f"Service not found: {service_name}"
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to deprecate service: {str(e)}"
        )
