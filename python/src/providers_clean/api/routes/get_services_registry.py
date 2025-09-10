from typing import List, Optional
from enum import Enum
from fastapi import APIRouter, Depends, HTTPException, Query

from ...services import ServiceRegistryService, ServiceInfo
from ...infrastructure.dependencies import get_service_registry_service


class ServiceCategory(str, Enum):
    """Enumeration of valid service categories."""
    AGENT = "agent"
    SERVICE = "service"


router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.get("/services/registry", response_model=List[ServiceInfo])
async def get_service_registry(
    active_only: bool = True,
    category: Optional[ServiceCategory] = Query(
        None, description="Filter by service category"),
    registry_service: ServiceRegistryService = Depends(
        get_service_registry_service)
):
    """Get all registered services and agents"""
    try:
        services = await registry_service.get_all_services(active_only=active_only, category=category.value if category else None)
        return services
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get service registry: {str(e)}"
        )
