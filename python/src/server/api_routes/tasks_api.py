"""
Tasks API endpoints (isolated)

Provides dedicated endpoints for task-specific operations that should not live in the projects router.
"""

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from ..config.logfire_config import get_logger, logfire
from ..services.projects import TaskService

router = APIRouter(prefix="/api", tags=["tasks"])  # Separate tag from projects

logger = get_logger(__name__)


@router.get("/tasks/{task_id}/details")
async def get_task_details(task_id: str):
    """Return full task details.

    - 200 with {"task": {...}} when found
    - 404 when task not found (standardized format)
    - 500 for internal errors (no details exposed)
    """
    try:
        # Wrap synchronous service call in run_in_threadpool to avoid blocking
        ok, result = await run_in_threadpool(TaskService().get_task_details, task_id)
        if not ok:
            error_msg = result.get("error") if isinstance(result, dict) else None
            # Check if it's a not-found error
            if isinstance(error_msg, str) and "not found" in error_msg.lower():
                raise HTTPException(status_code=404, detail="Task not found")
            # Internal error - log details but don't expose
            logfire.error("Task service error", extra={"task_id": task_id, "error": error_msg})
            raise HTTPException(status_code=500, detail="Internal Server Error")

        return {"task": result["task"]}

    except HTTPException:
        # Re-raise HTTPExceptions directly
        raise
    except Exception:
        # Unexpected error - log with context and return generic error
        logfire.error("Failed to get task details", extra={"task_id": task_id}, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal Server Error") from None

