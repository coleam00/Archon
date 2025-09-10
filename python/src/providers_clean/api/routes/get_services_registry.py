from typing import List, Optional
from enum import Enum
from fastapi import APIRouter, Depends, HTTPException, Query
import logging

from ...services import ServiceRegistryService, ServiceInfo
from ...infrastructure.dependencies import get_service_registry_service


logger = logging.getLogger(__name__)


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
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid request parameters")
    except LookupError:
        raise HTTPException(status_code=404, detail="Services not found")
    except Exception:
        logger.exception("Internal error in get_service_registry")
        raise HTTPException(status_code=500, detail="Internal server error")
