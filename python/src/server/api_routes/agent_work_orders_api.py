"""Agent Work Orders API

Manages repositories and work orders in Supabase.
Coordinates with agent work orders microservice for execution.
"""

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel

from ..config.logfire_config import get_logger
from ..services.agent_work_order_service import AgentWorkOrderService
from ..utils.etag_utils import check_etag, generate_etag

logger = get_logger(__name__)

router = APIRouter(prefix="/api/agent-work-orders", tags=["agent-work-orders"])


# Request/Response Models
class CreateRepositoryRequest(BaseModel):
    repository_url: str
    repository_display_name: str | None = None


class UpdateRepositoryRequest(BaseModel):
    repository_display_name: str | None = None
    pinned: bool | None = None


class CreateWorkOrderRequest(BaseModel):
    repository_id: str
    user_request: str
    selected_commands: list[str] = ["create-branch", "planning", "execute", "commit", "create-pr"]
    sandbox_type: str = "git_worktree"
    github_issue_number: str | None = None


class StatusCallbackRequest(BaseModel):
    status: str
    current_phase: str | None = None
    git_branch_name: str | None = None
    github_pull_request_url: str | None = None
    error_message: str | None = None


# Repository Endpoints

@router.post("/repositories/", status_code=201)
async def create_repository(request: CreateRepositoryRequest) -> dict[str, Any]:
    """Create new repository"""
    service = AgentWorkOrderService()
    success, result = service.create_repository(request.repository_url, request.repository_display_name)

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result["repository"]


@router.get("/repositories/")
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


@router.get("/repositories/{repository_id}")
async def get_repository(repository_id: str) -> dict[str, Any]:
    """Get single repository"""
    service = AgentWorkOrderService()
    success, result = service.get_repository(repository_id)

    if not success:
        raise HTTPException(status_code=404, detail=result.get("error"))

    return result["repository"]


@router.put("/repositories/{repository_id}")
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
        raise HTTPException(status_code=404 if "not found" in result.get("error", "").lower() else 400, detail=result.get("error"))

    return result["repository"]


@router.delete("/repositories/{repository_id}", status_code=204)
async def delete_repository(repository_id: str) -> None:
    """Delete repository"""
    service = AgentWorkOrderService()
    success, result = service.delete_repository(repository_id)

    if not success:
        raise HTTPException(status_code=404, detail=result.get("error"))


@router.get("/repositories/{repository_id}/work-orders")
async def list_repository_work_orders(repository_id: str, status: str | None = None) -> dict[str, Any]:
    """List work orders for a repository"""
    service = AgentWorkOrderService()
    success, result = service.list_work_orders(repository_id=repository_id, status=status)

    if not success:
        raise HTTPException(status_code=500, detail=result.get("error"))

    return {"work_orders": result["work_orders"], "count": result["total_count"]}


# ============================================
# Work Order Endpoints
# ============================================

@router.post("/", status_code=201)
async def create_work_order(request: CreateWorkOrderRequest) -> dict[str, Any]:
    """Create work order and start execution"""
    service = AgentWorkOrderService()
    success, result = await service.create_work_order(
        request.repository_id,
        request.user_request,
        request.selected_commands,
        request.sandbox_type,
        request.github_issue_number,
    )

    if not success:
        raise HTTPException(status_code=404 if "not found" in result.get("error", "").lower() else 400, detail=result.get("error"))

    return result["work_order"]


@router.get("/")
async def list_work_orders(response: Response, status: str | None = None, if_none_match: str | None = Header(None, alias="if-none-match")) -> dict[str, Any]:
    """List all work orders"""
    service = AgentWorkOrderService()
    success, result = service.list_work_orders(status=status)

    if not success:
        raise HTTPException(status_code=500, detail=result.get("error"))

    current_etag = generate_etag(result)
    if check_etag(if_none_match, current_etag):
        response.status_code = 304
        response.headers["ETag"] = current_etag
        return {}

    response.headers["ETag"] = current_etag
    return {"work_orders": result["work_orders"], "count": result["total_count"]}


# Internal Callback (from agent service)

@router.put("/internal/{work_order_id}/status")
async def update_work_order_status_callback(work_order_id: str, update: StatusCallbackRequest) -> dict[str, Any]:
    """Callback from agent service to update work order status"""
    status_update = {"status": update.status}

    if update.current_phase is not None:
        status_update["current_phase"] = update.current_phase
    if update.git_branch_name is not None:
        status_update["git_branch_name"] = update.git_branch_name
    if update.github_pull_request_url is not None:
        status_update["github_pull_request_url"] = update.github_pull_request_url
    if update.error_message is not None:
        status_update["error_message"] = update.error_message

    service = AgentWorkOrderService()
    success, result = service.update_work_order_status(work_order_id, status_update)

    if not success:
        raise HTTPException(status_code=404, detail=result.get("error"))

    return {"success": True}
