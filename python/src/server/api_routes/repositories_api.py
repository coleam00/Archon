"""Repositories API

Manages GitHub repositories for agent work orders in Supabase.
Separate from agent work orders to avoid proxy conflicts.
"""

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel

from ..config.logfire_config import get_logger
from ..services.agent_work_order_service import AgentWorkOrderService
from ..utils.etag_utils import check_etag, generate_etag

logger = get_logger(__name__)

router = APIRouter(prefix="/api/repositories", tags=["repositories"])


# Request/Response Models
class CreateRepositoryRequest(BaseModel):
    repository_url: str
    repository_display_name: str | None = None


class UpdateRepositoryRequest(BaseModel):
    repository_display_name: str | None = None
    pinned: bool | None = None


# Repository Endpoints

@router.post("/", status_code=201)
async def create_repository(request: CreateRepositoryRequest) -> dict[str, Any]:
    """Create new repository"""
    service = AgentWorkOrderService()
    success, result = service.create_repository(request.repository_url, request.repository_display_name)

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result["repository"]


@router.get("/")
async def list_repositories(response: Response, if_none_match: str | None = Header(None, alias="if-none-match")) -> dict[str, Any]:
    """List all repositories"""
    service = AgentWorkOrderService()
    success, result = service.list_repositories()

    if not success:
        raise HTTPException(status_code=500, detail=result.get("error"))

    current_etag = generate_etag(result)
    if check_etag(if_none_match, current_etag):
        response.status_code = 304
        response.headers["ETag"] = current_etag
        return {}

    response.headers["ETag"] = current_etag
    return {"repositories": result["repositories"], "count": result["total_count"]}


@router.get("/{repository_id}")
async def get_repository(repository_id: str) -> dict[str, Any]:
    """Get single repository"""
    service = AgentWorkOrderService()
    success, result = service.get_repository(repository_id)

    if not success:
        raise HTTPException(status_code=404, detail=result.get("error"))

    return result["repository"]


@router.put("/{repository_id}")
async def update_repository(repository_id: str, request: UpdateRepositoryRequest) -> dict[str, Any]:
    """Update repository"""
    updates = {}
    if request.repository_display_name is not None:
        updates["repository_display_name"] = request.repository_display_name
    if request.pinned is not None:
        updates["pinned"] = request.pinned

    service = AgentWorkOrderService()
    success, result = service.update_repository(repository_id, updates)

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result["repository"]


@router.delete("/{repository_id}", status_code=204)
async def delete_repository(repository_id: str) -> None:
    """Delete repository and all associated work orders"""
    service = AgentWorkOrderService()
    success, result = service.delete_repository(repository_id)

    if not success:
        raise HTTPException(status_code=404, detail=result.get("error"))


@router.get("/{repository_id}/work-orders")
async def list_repository_work_orders(
    repository_id: str,
    response: Response,
    if_none_match: str | None = Header(None, alias="if-none-match")
) -> dict[str, Any]:
    """List work orders for a specific repository"""
    service = AgentWorkOrderService()
    success, result = service.list_work_orders_by_repository(repository_id)

    if not success:
        raise HTTPException(status_code=404, detail=result.get("error"))

    current_etag = generate_etag(result)
    if check_etag(if_none_match, current_etag):
        response.status_code = 304
        response.headers["ETag"] = current_etag
        return {}

    response.headers["ETag"] = current_etag
    return {"work_orders": result["work_orders"], "count": result["total_count"]}
