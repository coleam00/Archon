"""
Sprints API endpoints for Archon

Handles sprint CRUD operations scoped to projects.
"""

from datetime import datetime

from fastapi import APIRouter, Header, Request, Response, HTTPException
from pydantic import BaseModel

from ..config.logfire_config import get_logger, logfire
from ..utils.etag_utils import check_etag, generate_etag
from ..services.projects.sprint_service import SprintService

logger = get_logger(__name__)

router = APIRouter(prefix="/api", tags=["sprints"])


class CreateSprintRequest(BaseModel):
    project_id: str
    name: str
    goal: str | None = None
    status: str | None = "planning"
    start_date: str | None = None
    end_date: str | None = None


class UpdateSprintRequest(BaseModel):
    name: str | None = None
    goal: str | None = None
    status: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    requested_by: str | None = None  # Agent name required when activating a sprint


@router.get("/projects/{project_id}/sprints")
async def list_project_sprints(
    project_id: str,
    request: Request,
    response: Response,
):
    """List all sprints for a project with ETag support."""
    try:
        if_none_match = request.headers.get("If-None-Match")

        sprint_service = SprintService()
        success, result = sprint_service.list_sprints(project_id)

        if not success:
            raise HTTPException(status_code=500, detail=result)

        sprints = result.get("sprints", [])

        etag_data = {"sprints": sprints, "project_id": project_id, "count": len(sprints)}
        current_etag = generate_etag(etag_data)

        if check_etag(if_none_match, current_etag):
            response.status_code = 304
            response.headers["ETag"] = current_etag
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return None

        response.headers["ETag"] = current_etag
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        response.headers["Last-Modified"] = datetime.utcnow().isoformat()

        logfire.debug(f"Sprints listed | project_id={project_id} | count={len(sprints)}")
        return sprints

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to list sprints | project_id={project_id} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/sprints")
async def create_sprint(request: CreateSprintRequest):
    """Create a new sprint."""
    try:
        sprint_service = SprintService()
        success, result = sprint_service.create_sprint(
            project_id=request.project_id,
            name=request.name,
            goal=request.goal,
            start_date=request.start_date,
            end_date=request.end_date,
            status=request.status or "planning",
        )

        if not success:
            raise HTTPException(status_code=400, detail=result)

        logfire.info(f"Sprint created | sprint_id={result['sprint']['id']} | project_id={request.project_id}")
        return {"message": "Sprint created successfully", "sprint": result["sprint"]}

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to create sprint | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/sprints/{sprint_id}")
async def get_sprint(sprint_id: str):
    """Get a specific sprint by ID."""
    try:
        sprint_service = SprintService()
        success, result = sprint_service.get_sprint(sprint_id)

        if not success:
            if "not found" in result.get("error", "").lower():
                raise HTTPException(status_code=404, detail=result.get("error"))
            raise HTTPException(status_code=500, detail=result)

        return result["sprint"]

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get sprint | sprint_id={sprint_id} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.put("/sprints/{sprint_id}")
async def update_sprint(sprint_id: str, request: UpdateSprintRequest):
    """Update a sprint."""
    try:
        update_fields = {}
        if request.name is not None:
            update_fields["name"] = request.name
        if request.goal is not None:
            update_fields["goal"] = request.goal
        if request.status is not None:
            update_fields["status"] = request.status
        if request.start_date is not None:
            update_fields["start_date"] = request.start_date
        if request.end_date is not None:
            update_fields["end_date"] = request.end_date
        if request.requested_by is not None:
            update_fields["requested_by"] = request.requested_by

        sprint_service = SprintService()
        success, result = sprint_service.update_sprint(sprint_id, update_fields)

        if not success:
            error_msg = result.get("error", "")
            if "not found" in error_msg.lower():
                raise HTTPException(status_code=404, detail=error_msg)
            if "only the product owner" in error_msg.lower() or "invalid transition" in error_msg.lower():
                raise HTTPException(status_code=403, detail=error_msg)
            raise HTTPException(status_code=500, detail=result)

        logfire.info(f"Sprint updated | sprint_id={sprint_id}")
        return {"message": "Sprint updated successfully", "sprint": result["sprint"]}

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to update sprint | sprint_id={sprint_id} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.delete("/sprints/{sprint_id}")
async def delete_sprint(sprint_id: str):
    """Delete a sprint. Tasks in the sprint will have sprint_id set to NULL."""
    try:
        sprint_service = SprintService()
        success, result = sprint_service.delete_sprint(sprint_id)

        if not success:
            if "not found" in result.get("error", "").lower():
                raise HTTPException(status_code=404, detail=result.get("error"))
            raise HTTPException(status_code=500, detail=result)

        logfire.info(f"Sprint deleted | sprint_id={sprint_id}")
        return {"message": result.get("message", "Sprint deleted successfully")}

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to delete sprint | sprint_id={sprint_id} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})
