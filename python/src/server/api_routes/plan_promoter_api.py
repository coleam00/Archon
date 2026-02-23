"""
Plan Promoter API

Endpoints for listing plans from PLANS_INDEX.md and promoting
them to Archon projects with AI-generated tasks.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config.logfire_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/plan-promoter", tags=["plan-promoter"])


class PromoteRequest(BaseModel):
    plan_path: str
    plan_name: str


class DemoteRequest(BaseModel):
    plan_path: str
    plan_name: str
    notes: str = ""
    section: str = ""


@router.get("/plans")
async def list_plans():
    """List all plans from PLANS_INDEX.md with promotion status."""
    from ..services.plan_promoter_service import PlanPromoterService

    service = PlanPromoterService()
    try:
        plans = service.list_plans()
        return {"plans": plans, "count": len(plans)}
    except FileNotFoundError as e:
        return {"error": str(e), "plans": [], "count": 0}
    except Exception as e:
        logger.error(f"Error listing plans: {e}", exc_info=True)
        return {"error": str(e), "plans": [], "count": 0}


@router.get("/content")
async def get_plan_content(path: str):
    """Return the raw markdown content of a plan file."""
    from ..services.plan_promoter_service import PlanPromoterService

    service = PlanPromoterService()
    try:
        content = service._read_plan_file(path)
        return {"content": content, "path": path}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error reading plan file: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/demote")
async def demote_plan_to_idea(request: DemoteRequest):
    """Send a plan back to the idea-capture system as a new idea."""
    import httpx

    idea_payload = {
        "title": request.plan_name,
        "idea": f"Demoted from plan: {request.plan_path}\n\n{request.notes}".strip(),
        "category": request.section or "plans",
        "status": "captured",
    }

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post("http://localhost:3001/api/ideas", json=idea_payload, timeout=5.0)
            resp.raise_for_status()
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="Idea capture service is not running (port 3001)")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Idea capture returned {e.response.status_code}")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Idea capture service timed out")

    return {"success": True, "plan_name": request.plan_name}


@router.post("/promote")
async def promote_plan(request: PromoteRequest):
    """Promote a plan to an Archon project with AI-generated tasks."""
    from ..services.plan_promoter_service import PlanPromoterService

    service = PlanPromoterService()
    success, result = await service.promote_plan(
        plan_path=request.plan_path,
        plan_name=request.plan_name,
    )

    if not success:
        raise HTTPException(status_code=400, detail=result)

    return result
