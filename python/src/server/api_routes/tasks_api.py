"""
Tasks API endpoints (isolated)

Provides dedicated endpoints for task-specific operations that should not live in the projects router.
"""

from fastapi import APIRouter, HTTPException

from ..config.logfire_config import get_logger, logfire
from ..services.projects import TaskService

router = APIRouter(prefix="/api", tags=["tasks"])  # Separate tag from projects

logger = get_logger(__name__)


@router.get("/tasks/{task_id}/details")
async def get_task_details(task_id: str):
    """Return full task details.

    - 200 with {"task": {...}} when found
    - 404 when explicitly not found
    - 500 for internal errors (logged with stacktrace)
    """
    try:
        ok, result = TaskService().get_task_details(task_id)
        if not ok:
            detail = result.get("error") if isinstance(result, dict) else None
            # Distinguish not-found from internal errors based on service message
            if isinstance(detail, str) and "not found" in detail.lower():
                raise HTTPException(status_code=404, detail=detail)
            # Treat anything else as internal error and log with traceback
            try:
                if logfire:
                    logfire.error("Failed to get task details", exc_info=True)
                else:
                    logger.error("Failed to get task details", exc_info=True)
            except Exception:
                pass
            raise HTTPException(status_code=500, detail={"error": detail or "Unknown error"})
        return {"task": result["task"]}
    except HTTPException:
        raise
    except Exception as e:
        try:
            if logfire:
                logfire.error("Failed to get task details", exc_info=True)
            else:
                logger.error("Failed to get task details", exc_info=True)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail={"error": str(e)})

