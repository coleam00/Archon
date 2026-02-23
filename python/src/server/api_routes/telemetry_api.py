"""
Telemetry API for Archon Phase 5.

Endpoints:
  GET  /api/telemetry/snapshot  — full dashboard snapshot (agents + sprint metrics)
  WS   /ws/telemetry            — live partial-update stream via Supabase Realtime
"""

import asyncio
import os

from fastapi import APIRouter, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect

from ..config.logfire_config import get_logger, logfire
from ..services.telemetry_service import get_telemetry_service
from ..utils.etag_utils import check_etag, generate_etag

logger = get_logger(__name__)

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

# Separate router with no prefix so the WebSocket path is exactly /ws/telemetry
ws_router = APIRouter(tags=["telemetry"])


# ── WebSocket connection manager ───────────────────────────────────────────────


class _ConnectionManager:
    """Tracks all active /ws/telemetry connections and broadcasts JSON events."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.add(ws)
        logger.info(f"WS telemetry client connected | total={len(self._connections)}")

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.discard(ws)
        logger.info(f"WS telemetry client disconnected | total={len(self._connections)}")

    async def broadcast(self, event: dict) -> None:
        """Send event to all connected clients; silently drop dead connections."""
        dead: set[WebSocket] = set()
        for ws in self._connections.copy():
            try:
                await ws.send_json(event)
            except Exception:
                dead.add(ws)
        self._connections -= dead


_manager = _ConnectionManager()


# ── Supabase Realtime listener (background task) ───────────────────────────────


async def run_telemetry_realtime_listener() -> None:
    """
    Subscribe to archon_agent_registry and archon_tasks via Supabase Realtime.
    Broadcasts partial-update events to all connected /ws/telemetry clients.

    Designed to run as a long-lived asyncio background task started during app
    lifespan. Retries automatically on connection errors.
    """
    from supabase import acreate_client  # async client

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not url or not key:
        logger.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set — realtime listener not started")
        return

    while True:
        client = None
        channel = None
        try:
            client = await acreate_client(url, key)
            channel = client.channel("telemetry-broadcast")

            def _make_handler(event_type: str):
                def _handler(payload) -> None:
                    # payload may be a dict or a dataclass depending on realtime-py version
                    if isinstance(payload, dict):
                        record = payload.get("new") or payload.get("old") or {}
                        event_name = payload.get("eventType", "UNKNOWN")
                    else:
                        record = getattr(payload, "record", None) or getattr(payload, "old_record", None) or {}
                        event_name = str(getattr(payload, "type", "UNKNOWN"))

                    try:
                        loop = asyncio.get_event_loop()
                        loop.create_task(
                            _manager.broadcast(
                                {"type": event_type, "event": event_name, "data": record}
                            )
                        )
                    except Exception as exc:
                        logger.warning(f"Failed to schedule broadcast: {exc}")

                return _handler

            channel.on_postgres_changes(
                event="*",
                schema="public",
                table="archon_agent_registry",
                callback=_make_handler("agent_update"),
            )
            channel.on_postgres_changes(
                event="*",
                schema="public",
                table="archon_tasks",
                callback=_make_handler("task_update"),
            )

            await channel.subscribe()
            logger.info("✅ Supabase Realtime listener active on archon_agent_registry + archon_tasks")

            # Keep alive — the channel drives itself via callbacks
            while True:
                await asyncio.sleep(30)

        except asyncio.CancelledError:
            logger.info("Telemetry Realtime listener cancelled")
            return
        except Exception as exc:
            logger.error(f"Telemetry Realtime listener error: {exc} — retrying in 5s")
            await asyncio.sleep(5)
        finally:
            if client and channel:
                try:
                    await client.remove_channel(channel)
                except Exception:
                    pass


# ── WebSocket endpoint ─────────────────────────────────────────────────────────


@ws_router.websocket("/ws/telemetry")
async def telemetry_websocket(websocket: WebSocket) -> None:
    """
    Live telemetry WebSocket.

    On connect:
    1. Sends an initial full snapshot: { "type": "snapshot", "data": { agents, sprint, generated_at } }
    2. Subsequently pushes partial-update events from Supabase Realtime:
       { "type": "agent_update", "event": "INSERT|UPDATE|DELETE", "data": {...} }
       { "type": "task_update",  "event": "INSERT|UPDATE|DELETE", "data": {...} }
    3. Sends keepalive pings every 30 s when the client is idle.

    Auth: Supabase service key is used on the backend — no per-client auth required.
    """
    await _manager.connect(websocket)
    try:
        # Send full snapshot immediately so the client has data before the first change event
        svc = get_telemetry_service()
        snapshot = await svc.get_snapshot()
        await websocket.send_json({"type": "snapshot", "data": snapshot})

        # Hold the connection open; Realtime callbacks push updates via _manager.broadcast
        while True:
            try:
                # Wait for any incoming message (ping/pong, or explicit close)
                await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning(f"WS telemetry error: {exc}")
    finally:
        _manager.disconnect(websocket)


# ── HTTP snapshot endpoint (unchanged) ────────────────────────────────────────


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
