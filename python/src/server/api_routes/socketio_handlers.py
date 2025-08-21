"""
Socket.IO Event Handlers for Archon

This module contains all Socket.IO event handlers for real-time communication.
Keeps the main projects_api.py file focused on REST endpoints.
"""

# Removed direct logging import - using unified config
import asyncio
import time

from ..config.logfire_config import get_logger
from ..services.background_task_manager import get_task_manager
from ..services.projects.project_service import ProjectService
from ..services.projects.source_linking_service import SourceLinkingService
from ..socketio_app import sio

logger = get_logger(__name__)


# Rate limiting for Socket.IO broadcasts
_last_broadcast_times: dict[str, float] = {}
_min_broadcast_interval = 0.1  # Minimum 100ms between broadcasts per room


# Broadcast helper functions
async def broadcast_task_update(project_id: str, event_type: str, task_data: dict):
    """Broadcast task updates to project room."""
    await sio.emit(event_type, task_data, room=project_id)
    logger.info(f"Broadcasted {event_type} to project {project_id}")


# Enhanced Task-Specific Socket.IO Event Handlers
async def broadcast_task_created(project_id: str, task_data: dict):
    """Broadcast task creation to project room."""
    await sio.emit("task_created", task_data, room=project_id)
    logger.info(
        f"📝 [TASK SOCKET] Broadcasted task_created to project {project_id}: {task_data.get('title', 'Unknown')}"
    )


async def broadcast_task_updated(project_id: str, task_data: dict):
    """Broadcast task update to project room with conflict resolution."""
    # Add timestamp for conflict resolution
    task_data["server_timestamp"] = time.time() * 1000
    await sio.emit("task_updated", task_data, room=project_id)
    logger.info(
        f"📝 [TASK SOCKET] Broadcasted task_updated to project {project_id}: {task_data.get('id', 'Unknown')}"
    )


async def broadcast_task_deleted(project_id: str, task_data: dict):
    """Broadcast task deletion to project room."""
    await sio.emit("task_deleted", task_data, room=project_id)
    logger.info(
        f"🗑️ [TASK SOCKET] Broadcasted task_deleted to project {project_id}: {task_data.get('id', 'Unknown')}"
    )


async def broadcast_task_archived(project_id: str, task_data: dict):
    """Broadcast task archival to project room."""
    await sio.emit("task_archived", task_data, room=project_id)
    logger.info(
        f"📦 [TASK SOCKET] Broadcasted task_archived to project {project_id}: {task_data.get('id', 'Unknown')}"
    )


async def broadcast_tasks_reordered(project_id: str, reorder_data: dict):
    """Broadcast task reordering to project room."""
    await sio.emit("tasks_reordered", reorder_data, room=project_id)
    logger.info(
        f"🔄 [TASK SOCKET] Broadcasted tasks_reordered to project {project_id}: {len(reorder_data.get('tasks', []))} tasks"
    )


async def broadcast_task_batch_update(project_id: str, batch_data: dict):
    """Broadcast batch task updates to project room."""
    batch_data["server_timestamp"] = time.time() * 1000
    await sio.emit("tasks_batch_updated", batch_data, room=project_id)
    logger.info(
        f"📦 [TASK SOCKET] Broadcasted tasks_batch_updated to project {project_id}: {len(batch_data.get('tasks', []))} tasks"
    )


async def broadcast_project_update():
    """Broadcast project list to subscribers."""
    try:
        project_service = ProjectService()
        success, result = project_service.list_projects()

        if not success:
            logger.error(f"Failed to get projects for broadcast: {result}")
            return

        # Use SourceLinkingService to format projects with sources
        source_service = SourceLinkingService()
        formatted_projects = source_service.format_projects_with_sources(result["projects"])

        await sio.emit("projects_update", {"projects": formatted_projects}, room="project_list")
        logger.info(f"Broadcasted project list update with {len(formatted_projects)} projects")

    except Exception as e:
        logger.error(f"Failed to broadcast project update: {e}")


async def broadcast_progress_update(progress_id: str, progress_data: dict):
    """Broadcast progress updates to progress room."""
    await sio.emit("project_progress", progress_data, room=progress_id)
    logger.debug(f"Broadcasted progress update for {progress_id}")


async def broadcast_crawl_progress(progress_id: str, data: dict):
    """Broadcast crawl progress to subscribers with resilience and rate limiting."""
    # Ensure progressId is included in the data
    data["progressId"] = progress_id

    # Rate limiting: Check if we've broadcasted too recently
    current_time = time.time()
    last_broadcast = _last_broadcast_times.get(progress_id, 0)
    time_since_last = current_time - last_broadcast

    # Skip this update if it's too soon (except for important statuses)
    important_statuses = ["error", "completed", "complete", "starting"]
    current_status = data.get("status", "")

    if time_since_last < _min_broadcast_interval and current_status not in important_statuses:
        # Skip this update - too frequent
        return

    # Update last broadcast time
    _last_broadcast_times[progress_id] = current_time

    # Clean up old entries (older than 5 minutes)
    if len(_last_broadcast_times) > 100:  # Only clean when it gets large
        cutoff_time = current_time - 300  # 5 minutes
        old_keys = [pid for pid, t in _last_broadcast_times.items() if t <= cutoff_time]
        for key in old_keys:
            del _last_broadcast_times[key]

    # Add resilience - don't let Socket.IO errors crash the crawl
    try:
        # Get detailed room info for debugging
        room_sids = []
        all_rooms = {}
        if hasattr(sio.manager, "rooms"):
            # Get all rooms for all namespaces
            for namespace in sio.manager.rooms:
                all_rooms[namespace] = {}
                for room, sids in sio.manager.rooms[namespace].items():
                    all_rooms[namespace][room] = list(sids)
                    if namespace == "/" and room == progress_id:
                        room_sids = list(sids)

        logger.debug(f"Broadcasting to room '{progress_id}'")
        logger.debug(f"Room {progress_id} has {len(room_sids)} subscribers: {room_sids}")
        logger.debug(f"All rooms in namespace '/': {list(all_rooms.get('/', {}).keys())}")

        # Log if the room doesn't exist
        if not room_sids:
            logger.warning(f"Room '{progress_id}' has no subscribers!")
            logger.warning(
                f"Room '{progress_id}' has no subscribers when broadcasting crawl progress"
            )

    except Exception as e:
        logger.debug(f"Could not get room info: {e}")
        import traceback

        traceback.print_exc()

    # Log only important broadcasts (reduce log spam)
    if current_status in important_statuses or data.get("percentage", 0) % 10 == 0:
        logger.info(
            f"📢 [SOCKETIO] Broadcasting crawl_progress to room: {progress_id} | status={current_status} | progress={data.get('percentage', 'N/A')}%"
        )

    # Emit the event with error handling
    try:
        await sio.emit("crawl_progress", data, room=progress_id)
        logger.info(f"✅ [SOCKETIO] Broadcasted crawl progress for {progress_id}")
    except Exception as e:
        # Don't let Socket.IO errors crash the crawl
        logger.error(f"❌ [SOCKETIO] Failed to emit crawl_progress: {e}")
        logger.error(f"Error type: {type(e).__name__}")
        import traceback

        logger.error(f"Traceback: {traceback.format_exc()}")
        # Continue execution - crawl should not fail due to Socket.IO issues


# Crawl progress helper functions for knowledge API
async def start_crawl_progress(progress_id: str, data: dict):
    """Start crawl progress tracking."""
    data["status"] = "starting"
    await broadcast_crawl_progress(progress_id, data)


async def update_crawl_progress(progress_id: str, data: dict):
    """Update crawl progress."""
    await broadcast_crawl_progress(progress_id, data)


async def complete_crawl_progress(progress_id: str, data: dict):
    """Complete crawl progress tracking."""
    data["status"] = "completed"
    data["percentage"] = 100  # Ensure we show 100% when complete
    await broadcast_crawl_progress(progress_id, data)


async def error_crawl_progress(progress_id: str, error_msg: str):
    """Signal crawl progress error."""
    data = {"status": "error", "error": error_msg, "progressId": progress_id}
    await broadcast_crawl_progress(progress_id, data)


@sio.event
async def connect(sid, environ):
    """Handle client connection."""
    client_address = environ.get("REMOTE_ADDR", "unknown")
    query_params = environ.get("QUERY_STRING", "")
    headers = {k: v for k, v in environ.items() if k.startswith("HTTP_")}

    logger.info(f"🔌 [SOCKETIO] Client connected: {sid} from {client_address}")
    logger.info(f"🔌 [SOCKETIO] Query params: {query_params}")
    logger.info(f"🔌 [SOCKETIO] User-Agent: {headers.get('HTTP_USER_AGENT', 'unknown')}")

    logger.debug("🔌 New connection:")
    logger.debug(f"  - SID: {sid}")
    logger.debug(f"  - Address: {client_address}")
    logger.debug(f"  - Query: {query_params}")
    logger.debug(f"  - Transport: {headers.get('HTTP_UPGRADE', 'unknown')}")

    # Parse query params to check for session_id
    if query_params:
        import urllib.parse

        params = urllib.parse.parse_qs(query_params)
        session_id = params.get("session_id", [None])[0]
        if session_id:
            logger.debug(f"  - Session ID: {session_id}")

    # Log total connected clients
    try:
        if hasattr(sio.manager, "rooms"):
            all_sids = set()
            for namespace_rooms in sio.manager.rooms.values():
                for room_sids in namespace_rooms.values():
                    all_sids.update(room_sids)
            logger.debug(f"Total connected clients: {len(all_sids)}")
    except:
        pass


@sio.event
async def disconnect(sid):
    """Handle client disconnection."""
    # Log which rooms the client was in before disconnecting
    rooms = sio.rooms(sid) if hasattr(sio, "rooms") else []
    logger.info(f"🔌 [SOCKETIO] Client disconnected: {sid}, was in rooms: {rooms}")
    logger.info(f"Client disconnected: {sid}, was in rooms: {rooms}")


@sio.event
async def join_project(sid, data):
    """Join a project room to receive task updates."""
    project_id = data.get("project_id")
    if not project_id:
        await sio.emit("error", {"message": "project_id required"}, to=sid)
        return

    # Join the room for this project
    await sio.enter_room(sid, project_id)
    logger.info(f"📥 [SOCKETIO] Client {sid} joined project room: {project_id}")
    logger.info(f"Client {sid} joined project {project_id}")

    # Send confirmation - let frontend request initial tasks via API
    await sio.emit("joined_project", {"project_id": project_id}, to=sid)


@sio.event
async def leave_project(sid, data):
    """Leave a project room."""
    project_id = data.get("project_id")
    if project_id:
        await sio.leave_room(sid, project_id)
        logger.info(f"Client {sid} left project {project_id}")


@sio.event
async def subscribe_projects(sid, data=None):
    """Subscribe to project list updates."""
    await sio.enter_room(sid, "project_list")
    logger.info(f"📥 [SOCKETIO] Client {sid} joined project_list room")
    logger.info(f"Client {sid} subscribed to project list")

    # Send current project list using ProjectService
    try:
        project_service = ProjectService()
        success, result = project_service.list_projects()

        if not success:
            await sio.emit(
                "error", {"message": result.get("error", "Failed to load projects")}, to=sid
            )
            return

        # Use SourceLinkingService to format projects with sources
        source_service = SourceLinkingService()
        formatted_projects = source_service.format_projects_with_sources(result["projects"])

        await sio.emit("projects_update", {"projects": formatted_projects}, to=sid)
        logger.info(f"Sent {len(formatted_projects)} projects to client {sid}")

    except Exception as e:
        await sio.emit("error", {"message": str(e)}, to=sid)


@sio.event
async def unsubscribe_projects(sid, data=None):
    """Unsubscribe from project list updates."""
    await sio.leave_room(sid, "project_list")
    logger.info(f"Client {sid} unsubscribed from project list")


@sio.event
async def subscribe_progress(sid, data):
    """Subscribe to project creation progress."""
    logger.info(f"🔔 [SOCKETIO] Received subscribe_progress from {sid} with data: {data}")
    progress_id = data.get("progress_id")
    if not progress_id:
        logger.error(f"🔔 [SOCKETIO] No progress_id provided by {sid}")
        await sio.emit("error", {"message": "progress_id required"}, to=sid)
        return

    await sio.enter_room(sid, progress_id)
    logger.info(f"📥 [SOCKETIO] Client {sid} joined progress room: {progress_id}")

    # Send current progress state if operation exists
    try:
        from ..services.projects.progress_service import progress_service

        current_status = progress_service.get_operation_status(progress_id)
        if current_status:
            logger.info(
                f"📤 [SOCKETIO] Sending current progress state to new subscriber {sid}: {current_status}"
            )
            # Send the current state immediately to the new subscriber
            current_status_copy = current_status.copy()
            current_status_copy["progressId"] = progress_id

            # Convert datetime to ISO string for JSON serialization
            if "start_time" in current_status_copy and hasattr(
                current_status_copy["start_time"], "isoformat"
            ):
                current_status_copy["start_time"] = current_status_copy["start_time"].isoformat()

            await sio.emit("project_progress", current_status_copy, to=sid)
        else:
            logger.warning(f"📤 [SOCKETIO] No progress operation found for {progress_id}")
    except Exception as e:
        logger.error(f"📤 [SOCKETIO] Error sending current progress state: {e}")

    logger.info(f"Client {sid} subscribed to progress {progress_id}")


@sio.event
async def unsubscribe_progress(sid, data):
    """Unsubscribe from project creation progress."""
    progress_id = data.get("progress_id")
    if progress_id:
        await sio.leave_room(sid, progress_id)
        logger.info(f"Client {sid} unsubscribed from progress {progress_id}")


@sio.event
async def crawl_subscribe(sid, data=None):
    """Subscribe to crawl progress updates."""
    logger.info(f"📥 [SOCKETIO] Received crawl_subscribe from {sid} with data: {data}")
    logger.debug(f"crawl_subscribe event - sid: {sid}, data: {data}")
    progress_id = data.get("progress_id") if data else None
    if not progress_id:
        logger.error(f"❌ [SOCKETIO] No progress_id in crawl_subscribe from {sid}")
        await sio.emit("error", {"message": "progress_id required"}, to=sid)
        return

    # Enter the room
    await sio.enter_room(sid, progress_id)
    logger.info(f"✅ [SOCKETIO] Client {sid} subscribed to crawl progress room: {progress_id}")
    logger.info(f"Client {sid} subscribed to crawl progress {progress_id}")

    # Verify room membership
    try:
        # Get all rooms for this client
        client_rooms = []
        if hasattr(sio, "rooms") and callable(sio.rooms):
            try:
                rooms_result = sio.rooms(sid)
                # Handle different return types from rooms()
                if rooms_result is None:
                    client_rooms = []
                elif isinstance(rooms_result, (list, set, tuple)):
                    client_rooms = list(rooms_result)
                elif isinstance(rooms_result, dict):
                    client_rooms = list(rooms_result.keys())
                else:
                    # Assume it's a single room ID
                    client_rooms = [str(rooms_result)]
            except Exception as e:
                logger.debug(f"Could not get rooms for sid {sid}: {e}")
        elif hasattr(sio.manager, "rooms"):
            # Alternative method to check rooms
            for room, sids in sio.manager.rooms.get("/", {}).items():
                if sid in sids:
                    client_rooms.append(room)

        logger.debug(f"Client {sid} is now in rooms: {client_rooms}")
        logger.debug(f"Room '{progress_id}' membership confirmed: {progress_id in client_rooms}")

        # Double-check room membership by listing all members
        if hasattr(sio.manager, "rooms"):
            room_members = list(sio.manager.rooms.get("/", {}).get(progress_id, []))
            logger.debug(
                f"Room '{progress_id}' now has {len(room_members)} members: {room_members}"
            )
            logger.debug(f"Client {sid} is in room: {sid in room_members}")

    except Exception as e:
        logger.debug(f"Error checking room membership: {e}")
        import traceback

        traceback.print_exc()

    # Check if there's an active task for this progress_id
    task_manager = get_task_manager()
    task_status = await task_manager.get_task_status(progress_id)

    if "error" not in task_status:
        # There's an active task - send current progress state
        current_progress = task_status.get("progress", 0)
        current_status = task_status.get("status", "running")
        last_update = task_status.get("last_update", {})

        logger.info(
            f"📤 [SOCKETIO] Found active task for {progress_id}: status={current_status}, progress={current_progress}%"
        )

        # Send the complete last update state to the reconnecting client
        # This includes all the fields like logs, currentUrl, etc.
        current_state_data = last_update.copy() if last_update else {}
        current_state_data.update({
            "progressId": progress_id,
            "status": current_status,
            "percentage": current_progress,
            "isReconnect": True,
        })

        # If no last_update, provide minimal data
        if not last_update:
            current_state_data["message"] = "Reconnected to active crawl"

        await sio.emit("crawl_progress", current_state_data, to=sid)
        logger.info(f"📤 [SOCKETIO] Sent current crawl state to reconnecting client {sid}")
    else:
        # No active task - just send acknowledgment
        logger.info(f"📤 [SOCKETIO] No active task found for {progress_id}")

    # Send acknowledgment
    ack_data = {"progress_id": progress_id, "status": "subscribed"}
    await sio.emit("crawl_subscribe_ack", ack_data, to=sid)
    logger.info(f"📤 [SOCKETIO] Sent subscription acknowledgment to {sid} for {progress_id}")


@sio.event
async def crawl_unsubscribe(sid, data):
    """Unsubscribe from crawl progress updates."""
    progress_id = data.get("progress_id")
    if progress_id:
        # Log why the client is unsubscribing
        logger.info(
            f"📤 [SOCKETIO] crawl_unsubscribe event received | sid={sid} | progress_id={progress_id} | data={data}"
        )
        logger.debug(f"Client {sid} requesting to unsubscribe from crawl progress {progress_id}")
        logger.debug(f"Unsubscribe data: {data}")

        await sio.leave_room(sid, progress_id)
        logger.info(f"📤 [SOCKETIO] Client {sid} left crawl progress room: {progress_id}")
        logger.info(f"Client {sid} unsubscribed from crawl progress {progress_id}")


# Background Task Management Socket.IO Events
@sio.event
async def cancel_crawl(sid, data):
    """Cancel a running crawl operation."""
    task_id = data.get("task_id")
    if task_id:
        task_manager = get_task_manager()
        cancelled = await task_manager.cancel_task(task_id)
        return {"success": cancelled, "task_id": task_id}
    return {"success": False, "error": "No task_id provided"}


@sio.event
async def get_task_status(sid, data):
    """Get status of a background task."""
    task_id = data.get("task_id")
    if task_id:
        task_manager = get_task_manager()
        status = await task_manager.get_task_status(task_id)
        return status
    return {"error": "No task_id provided"}


@sio.event
async def crawl_stop(sid, data):
    """Handle crawl stop request via Socket.IO."""
    progress_id = data.get("progress_id")
    if not progress_id:
        await sio.emit("error", {"message": "progress_id required"}, to=sid)
        return {"success": False, "error": "progress_id required"}

    logger.info(
        f"🛑 [SOCKETIO] Received crawl_stop request | sid={sid} | progress_id={progress_id}"
    )

    # Emit stopping status immediately
    await sio.emit(
        "crawl:stopping",
        {
            "progressId": progress_id,
            "message": "Stopping crawl operation...",
            "timestamp": time.time(),
        },
        room=progress_id,
    )

    logger.info(f"📤 [SOCKETIO] Emitted crawl:stopping event to room {progress_id}")

    try:
        # Get the orchestration service
        from ..services.crawling import get_active_orchestration, unregister_orchestration
        orchestration = get_active_orchestration(progress_id)

        if orchestration:
            # Cancel the orchestration
            orchestration.cancel()
            logger.info(f"✅ [SOCKETIO] Cancelled orchestration for {progress_id}")
        else:
            logger.warning(f"⚠️  [SOCKETIO] No active orchestration found for {progress_id}")

        # Cancel the asyncio task if it exists
        from ..api_routes.knowledge_api import active_crawl_tasks

        if progress_id in active_crawl_tasks:
            task = active_crawl_tasks[progress_id]
            if not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(task, timeout=2.0)
                except (TimeoutError, asyncio.CancelledError):
                    pass
            del active_crawl_tasks[progress_id]
            logger.info(f"✅ [SOCKETIO] Cancelled asyncio task for {progress_id}")

        # Remove from active orchestrations registry
        unregister_orchestration(progress_id)

        # Broadcast cancellation to all clients in the room
        await sio.emit(
            "crawl:stopped",
            {
                "progressId": progress_id,
                "status": "cancelled",
                "message": "Crawl operation cancelled",
                "timestamp": time.time(),
            },
            room=progress_id,
        )

        logger.info(f"📤 [SOCKETIO] Emitted crawl:stopped event to room {progress_id}")

        return {"success": True, "progressId": progress_id}

    except Exception as e:
        logger.error(
            f"❌ [SOCKETIO] Failed to stop crawl | error={str(e)} | progress_id={progress_id}"
        )
        await sio.emit(
            "crawl:error",
            {
                "progressId": progress_id,
                "error": str(e),
                "message": "Failed to stop crawl operation",
            },
            room=progress_id,
        )
        return {"success": False, "error": str(e)}


# Document Synchronization Socket.IO Event Handlers
# Real-time document collaboration with conflict resolution

from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class DocumentChange:
    """Document change data structure."""

    id: str
    project_id: str
    document_id: str
    change_type: str  # 'content', 'title', 'metadata', 'delete'
    data: Any
    user_id: str
    timestamp: float
    version: int
    patch: Any | None = None


@dataclass
class DocumentState:
    """Document state for synchronization."""

    id: str
    project_id: str
    title: str
    content: Any
    metadata: Any
    version: int
    last_modified: float
    last_modified_by: str
    is_locked: bool = False
    lock_expiry: float | None = None


# In-memory document state storage (in production, use Redis or database)
document_states: dict[str, DocumentState] = {}
document_locks: dict[str, dict[str, Any]] = {}


@sio.event
async def join_document_room(sid, data):
    """Join a document room for real-time collaboration."""
    project_id = data.get("project_id")
    document_id = data.get("document_id")

    if not project_id or not document_id:
        await sio.emit("error", {"message": "project_id and document_id required"}, to=sid)
        return

    room_name = f"doc_{project_id}_{document_id}"
    await sio.enter_room(sid, room_name)

    logger.info(f"📄 [DOCUMENT SYNC] Client {sid} joined document room: {room_name}")

    # Send current document state if exists
    if document_id in document_states:
        state = document_states[document_id]
        await sio.emit("document_state", asdict(state), to=sid)

    await sio.emit(
        "joined_document",
        {"project_id": project_id, "document_id": document_id, "room": room_name},
        to=sid,
    )


@sio.event
async def leave_document_room(sid, data):
    """Leave a document room."""
    project_id = data.get("project_id")
    document_id = data.get("document_id")

    if project_id and document_id:
        room_name = f"doc_{project_id}_{document_id}"
        await sio.leave_room(sid, room_name)
        logger.info(f"📄 [DOCUMENT SYNC] Client {sid} left document room: {room_name}")


@sio.event
async def request_document_states(sid, data):
    """Request all document states for a project."""
    project_id = data.get("project_id")
    if not project_id:
        await sio.emit("error", {"message": "project_id required"}, to=sid)
        return

    # Get all documents for the project
    project_docs = [
        asdict(state) for state in document_states.values() if state.project_id == project_id
    ]

    await sio.emit("document_states", project_docs, to=sid)
    logger.info(f"📄 [DOCUMENT SYNC] Sent {len(project_docs)} document states to {sid}")


@sio.event
async def document_change(sid, data):
    """Handle single document change."""
    try:
        change_data = data.get("change")
        if not change_data:
            await sio.emit("error", {"message": "change data required"}, to=sid)
            return

        change = DocumentChange(**change_data)
        await process_document_change(sid, change)

    except Exception as e:
        logger.error(f"📄 [DOCUMENT SYNC] Error processing document change: {e}")
        await sio.emit("error", {"message": f"Failed to process change: {str(e)}"}, to=sid)


@sio.event
async def document_batch_update(sid, data):
    """Handle batched document changes."""
    try:
        project_id = data.get("project_id")
        document_id = data.get("document_id")
        changes_data = data.get("changes", [])

        if not all([project_id, document_id, changes_data]):
            await sio.emit(
                "error", {"message": "project_id, document_id, and changes required"}, to=sid
            )
            return

        # Process each change in the batch
        changes = [DocumentChange(**change_data) for change_data in changes_data]
        conflicts = []

        for change in changes:
            conflict = await process_document_change(sid, change, broadcast=False)
            if conflict:
                conflicts.append(conflict)

        # Broadcast the final state after all changes
        if document_id in document_states:
            room_name = f"doc_{project_id}_{document_id}"
            state = document_states[document_id]

            await sio.emit(
                "document_updated",
                {
                    "type": "document_updated",
                    "document_id": document_id,
                    "project_id": project_id,
                    "user_id": changes[-1].user_id,
                    "timestamp": changes[-1].timestamp,
                    "data": asdict(state),
                    "version": state.version,
                    "batch_size": len(changes),
                },
                room=room_name,
                skip_sid=sid,
            )

        # Handle conflicts if any
        if conflicts:
            await sio.emit(
                "conflicts_detected", {"conflicts": conflicts, "document_id": document_id}, to=sid
            )

        logger.info(
            f"📄 [DOCUMENT SYNC] Processed batch of {len(changes)} changes for {document_id}"
        )

    except Exception as e:
        logger.error(f"📄 [DOCUMENT SYNC] Error processing document batch: {e}")
        await sio.emit("error", {"message": f"Failed to process batch: {str(e)}"}, to=sid)


async def process_document_change(
    sid: str, change: DocumentChange, broadcast: bool = True
) -> dict | None:
    """Process a single document change with conflict detection."""
    document_id = change.document_id
    project_id = change.project_id

    # Get or create document state
    if document_id not in document_states:
        document_states[document_id] = DocumentState(
            id=document_id,
            project_id=project_id,
            title="",
            content={},
            metadata={},
            version=0,
            last_modified=change.timestamp,
            last_modified_by=change.user_id,
        )

    state = document_states[document_id]

    # Check for conflicts (version or timestamp-based)
    conflict = None
    if change.version <= state.version:
        # Version conflict - resolve based on timestamp
        if change.timestamp > state.last_modified:
            # Remote change is newer, apply it
            logger.warning(
                f"📄 [CONFLICT] Version conflict resolved by timestamp for {document_id}"
            )
        else:
            # Local state is newer, reject the change
            conflict = {
                "type": "version_conflict",
                "document_id": document_id,
                "local_version": state.version,
                "remote_version": change.version,
                "resolution": "rejected",
            }
            return conflict

    # Check for simultaneous edits (within 1 second)
    time_diff = abs(state.last_modified - change.timestamp)
    if time_diff < 1000 and state.last_modified_by != change.user_id:
        logger.warning(f"📄 [CONFLICT] Simultaneous edit detected for {document_id}")
        conflict = {
            "type": "simultaneous_edit",
            "document_id": document_id,
            "time_diff": time_diff,
            "resolution": "last_write_wins",
        }

    # Apply the change
    if change.change_type == "content":
        if isinstance(change.data, dict) and isinstance(state.content, dict):
            state.content.update(change.data)
        else:
            state.content = change.data
    elif change.change_type == "title":
        state.title = change.data.get("title", state.title)
    elif change.change_type == "metadata":
        if isinstance(change.data, dict) and isinstance(state.metadata, dict):
            state.metadata.update(change.data)
        else:
            state.metadata = change.data
    elif change.change_type == "delete":
        # Mark for deletion - in practice, you might want to soft delete
        state.metadata["deleted"] = True
        state.metadata["deleted_by"] = change.user_id
        state.metadata["deleted_at"] = change.timestamp

    # Update state metadata
    state.version = max(state.version, change.version)
    state.last_modified = change.timestamp
    state.last_modified_by = change.user_id

    # Broadcast change to other clients in the room if enabled
    if broadcast:
        room_name = f"doc_{project_id}_{document_id}"

        event_data = {
            "type": "document_updated",
            "document_id": document_id,
            "project_id": project_id,
            "user_id": change.user_id,
            "timestamp": change.timestamp,
            "data": change.data,
            "version": state.version,
            "change_type": change.change_type,
        }

        await sio.emit("document_updated", event_data, room=room_name, skip_sid=sid)
        logger.info(f"📄 [DOCUMENT SYNC] Broadcasted {change.change_type} change for {document_id}")

    return conflict


@sio.event
async def lock_document(sid, data):
    """Lock a document for exclusive editing."""
    document_id = data.get("document_id")
    user_id = data.get("user_id")
    lock_duration = data.get("duration", 300000)  # 5 minutes default

    if not document_id or not user_id:
        await sio.emit("error", {"message": "document_id and user_id required"}, to=sid)
        return

    current_time = time.time() * 1000  # Convert to milliseconds
    lock_expiry = current_time + lock_duration

    # Check if document is already locked
    if document_id in document_locks:
        existing_lock = document_locks[document_id]
        if existing_lock["expiry"] > current_time and existing_lock["user_id"] != user_id:
            await sio.emit(
                "lock_failed",
                {
                    "document_id": document_id,
                    "reason": "already_locked",
                    "locked_by": existing_lock["user_id"],
                    "expires_at": existing_lock["expiry"],
                },
                to=sid,
            )
            return

    # Create lock
    document_locks[document_id] = {"user_id": user_id, "expiry": lock_expiry, "sid": sid}

    # Update document state
    if document_id in document_states:
        state = document_states[document_id]
        state.is_locked = True
        state.lock_expiry = lock_expiry

    # Broadcast lock event
    project_id = data.get("project_id", "")
    room_name = f"doc_{project_id}_{document_id}"

    await sio.emit(
        "document_locked",
        {
            "type": "document_locked",
            "document_id": document_id,
            "project_id": project_id,
            "user_id": user_id,
            "timestamp": current_time,
            "data": {"expiry": lock_expiry},
        },
        room=room_name,
    )

    logger.info(f"📄 [DOCUMENT SYNC] Document {document_id} locked by {user_id}")


@sio.event
async def unlock_document(sid, data):
    """Unlock a document."""
    document_id = data.get("document_id")
    user_id = data.get("user_id")

    if not document_id or not user_id:
        await sio.emit("error", {"message": "document_id and user_id required"}, to=sid)
        return

    # Check if user owns the lock
    if document_id in document_locks:
        existing_lock = document_locks[document_id]
        if existing_lock["user_id"] != user_id:
            await sio.emit(
                "unlock_failed",
                {
                    "document_id": document_id,
                    "reason": "not_lock_owner",
                    "locked_by": existing_lock["user_id"],
                },
                to=sid,
            )
            return

        # Remove lock
        del document_locks[document_id]

    # Update document state
    if document_id in document_states:
        state = document_states[document_id]
        state.is_locked = False
        state.lock_expiry = None

    # Broadcast unlock event
    project_id = data.get("project_id", "")
    room_name = f"doc_{project_id}_{document_id}"

    await sio.emit(
        "document_unlocked",
        {
            "type": "document_unlocked",
            "document_id": document_id,
            "project_id": project_id,
            "user_id": user_id,
            "timestamp": time.time() * 1000,
            "data": {},
        },
        room=room_name,
    )

    logger.info(f"📄 [DOCUMENT SYNC] Document {document_id} unlocked by {user_id}")


@sio.event
async def delete_document(sid, data):
    """Delete a document with synchronization."""
    document_id = data.get("document_id")
    project_id = data.get("project_id")
    user_id = data.get("user_id")

    if not all([document_id, project_id, user_id]):
        await sio.emit(
            "error", {"message": "document_id, project_id, and user_id required"}, to=sid
        )
        return

    # Remove from local state
    if document_id in document_states:
        del document_states[document_id]

    if document_id in document_locks:
        del document_locks[document_id]

    # Broadcast deletion
    room_name = f"doc_{project_id}_{document_id}"

    await sio.emit(
        "document_deleted",
        {
            "type": "document_deleted",
            "document_id": document_id,
            "project_id": project_id,
            "user_id": user_id,
            "timestamp": time.time() * 1000,
            "data": {},
        },
        room=room_name,
    )

    logger.info(f"📄 [DOCUMENT SYNC] Document {document_id} deleted by {user_id}")


# Periodic cleanup of expired locks
async def cleanup_expired_locks():
    """Clean up expired document locks."""
    current_time = time.time() * 1000
    expired_locks = []

    for document_id, lock_info in document_locks.items():
        if lock_info["expiry"] <= current_time:
            expired_locks.append(document_id)

    for document_id in expired_locks:
        logger.info(f"📄 [DOCUMENT SYNC] Cleaning up expired lock for {document_id}")

        # Update document state
        if document_id in document_states:
            state = document_states[document_id]
            state.is_locked = False
            state.lock_expiry = None

        # Remove lock
        del document_locks[document_id]

        # Broadcast unlock event (find project_id from state)
        if document_id in document_states:
            project_id = document_states[document_id].project_id
            room_name = f"doc_{project_id}_{document_id}"

            await sio.emit(
                "document_unlocked",
                {
                    "type": "document_unlocked",
                    "document_id": document_id,
                    "project_id": project_id,
                    "user_id": "system",
                    "timestamp": current_time,
                    "data": {"reason": "expired"},
                },
                room=room_name,
            )


# Start periodic cleanup task
async def start_document_sync_cleanup():
    """Start the document synchronization cleanup task."""
    while True:
        try:
            await cleanup_expired_locks()
        except Exception as e:
            logger.error(f"📄 [DOCUMENT SYNC] Error in cleanup task: {e}")

        # Run cleanup every 60 seconds
        await asyncio.sleep(60)


# Initialize cleanup task on module load
logger.info("📄 [DOCUMENT SYNC] Document synchronization handlers initialized")
