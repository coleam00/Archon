"""
Simple Socket.IO Broadcasting Functions

This module contains only the core broadcast functions to avoid circular imports.
No other modules should import from this file.
"""

import asyncio

from ..config.logfire_config import get_logger
from ..socketio_app import sio

logger = get_logger(__name__)



# Core broadcast functions
async def broadcast_task_update(project_id: str, event_type: str, task_data: dict):
    """Broadcast task updates to project room."""
    # Get room members for debugging
    room_members = []
    try:
        if hasattr(sio.manager, "get_participants"):
            room_members = await sio.manager.get_participants("/", project_id)
        logger.info(
            f"Broadcasting {event_type} to project room {project_id} with {len(room_members)} members"
        )
    except:
        logger.info(f"Broadcasting {event_type} to project room {project_id}")

    await sio.emit(event_type, task_data, room=project_id)
    logger.info(
        f"✅ Broadcasted {event_type} for task {task_data.get('id', 'unknown')} to project {project_id}"
    )


async def broadcast_project_update_simple(projects_data: list):
    """Broadcast project list to subscribers."""
    await sio.emit("projects_update", {"projects": projects_data}, room="project_list")
    logger.info(f"Broadcasted project list update with {len(projects_data)} projects")


async def broadcast_progress_update(progress_id: str, progress_data: dict):
    """Broadcast progress updates to progress room."""
    await sio.emit("project_progress", progress_data, room=progress_id)
    logger.debug(f"Broadcasted progress update for {progress_id}")


async def broadcast_crawl_progress(progress_id: str, data: dict):
    """Broadcast crawl progress to subscribers."""
    data["progressId"] = progress_id
    await sio.emit("crawl_progress", data, room=progress_id)
    await asyncio.sleep(0)  # Yield control to event loop
    logger.info(f"✅ [SOCKETIO] Broadcasted crawl progress for {progress_id}")
