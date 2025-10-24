"""Work Orders API

Manages work orders in Supabase (CRUD operations).
Coordinates with agent service for execution when status changes to 'in_progress'.
"""

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel

from ..config.logfire_config import get_logger
from ..services.agent_work_order_service import AgentWorkOrderService
from ..utils.etag_utils import check_etag, generate_etag

logger = get_logger(__name__)

router = APIRouter(prefix="/api/work-orders", tags=["work-orders"])


# Request/Response Models
class CreateWorkOrderRequest(BaseModel):
    repository_id: str
    user_request: str
    selected_commands: list[str] = ["create-branch", "planning", "execute", "commit", "create-pr"]
    sandbox_type: str = "git_worktree"
    github_issue_number: str | None = None


class UpdateStatusRequest(BaseModel):
    status: str


# Work Order Endpoints

@router.post("/", status_code=201)
async def create_work_order(request: CreateWorkOrderRequest) -> dict[str, Any]:
    """Create work order in Supabase (status='todo', not executed yet)"""
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
async def list_work_orders(
    response: Response,
    status: str | None = None,
    if_none_match: str | None = Header(None, alias="if-none-match")
) -> dict[str, Any]:
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


@router.get("/{work_order_id}")
async def get_work_order(work_order_id: str) -> dict[str, Any]:
    """Get single work order"""
    service = AgentWorkOrderService()

    # Try to get from Supabase first
    wo_response = service.supabase.table("agent_work_orders").select("*").eq("agent_work_order_id", work_order_id).execute()

    if not wo_response.data:
        raise HTTPException(status_code=404, detail="Work order not found")

    return wo_response.data[0]


@router.put("/{work_order_id}/status")
async def update_work_order_status(work_order_id: str, request: UpdateStatusRequest) -> dict[str, Any]:
    """
    Update work order status.
    When status changes to 'in_progress', triggers agent execution.
    """
    service = AgentWorkOrderService()
    success, result = await service.update_work_order_status(work_order_id, request.status)

    if not success:
        raise HTTPException(status_code=404 if "not found" in result.get("error", "").lower() else 400, detail=result.get("error"))

    return result["work_order"]


@router.delete("/{work_order_id}", status_code=204)
async def delete_work_order(work_order_id: str) -> None:
    """Delete work order from Supabase"""
    service = AgentWorkOrderService()

    # Delete from Supabase
    response = service.supabase.table("agent_work_orders").delete().eq("agent_work_order_id", work_order_id).execute()

    if not response.data:
        raise HTTPException(status_code=404, detail="Work order not found")
