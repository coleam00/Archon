"""
Telemetry API for Archon Phase 5.

Endpoints:
  GET /api/telemetry/snapshot  — full dashboard snapshot (agents + sprint metrics)
"""

from fastapi import APIRouter, HTTPException, Query, Request, Response

from ..config.logfire_config import get_logger, logfire
from ..services.telemetry_service import get_telemetry_service
from ..utils.etag_utils import check_etag, generate_etag

logger = get_logger(__name__)

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])


@router.get("/snapshot")
async def get_telemetry_snapshot(
    request: Request,
    response: Response,
    sprint_id: str | None = Query(None, description="Sprint ID to include metrics for. Defaults to the active sprint."),
):
    """
    Full telemetry snapshot for the live dashboard.

    Returns agent health metrics and sprint velocity/burn-down data in one
    response. Accepts an optional sprint_id; when omitted the most recent
    active sprint is resolved automatically.

    Supports ETag caching — returns 304 when data has not changed.
    """
    try:
        if_none_match = request.headers.get("If-None-Match")

        svc = get_telemetry_service()
        snapshot = await svc.get_snapshot(sprint_id=sprint_id)

        # ETag is computed from stable fields only.
        # last_seen_seconds_ago increments every second; exclude it so 304 fires
        # correctly when the underlying data (statuses, last_seen timestamps) hasn't changed.
        etag_agents = [
            {k: v for k, v in a.items() if k != "last_seen_seconds_ago"}
            for a in snapshot["agents"]
        ]
        etag_data = {"agents": etag_agents, "sprint": snapshot["sprint"]}
        current_etag = generate_etag(etag_data)

        if check_etag(if_none_match, current_etag):
            response.status_code = 304
            response.headers["ETag"] = current_etag
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
            return None

        response.headers["ETag"] = current_etag
        response.headers["Cache-Control"] = "no-cache, must-revalidate"

        logfire.debug(
            f"Telemetry snapshot served | agents={len(snapshot['agents'])} | "
            f"sprint={snapshot['sprint']['sprint']['id'] if snapshot['sprint'] else None}"
        )
        return snapshot

    except Exception as e:
        logfire.error(f"Failed to serve telemetry snapshot | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})
