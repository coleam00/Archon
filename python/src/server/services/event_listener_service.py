"""
Event Listener Service for Archon

Subscribes to Redis event channels and updates the whiteboard in real-time.
Processes:
- Task events (created, status_changed, assigned)
- Session events (started, ended)
- Work order events (future)
"""

import asyncio
import json
from typing import Any

import redis.asyncio as redis

from ..config.logfire_config import get_logger
from ..config.redis_config import REDIS_URL
from .whiteboard_service import WhiteboardService

logger = get_logger(__name__)


class EventListenerService:
    """Service that listens to Redis events and updates the whiteboard"""

    def __init__(self, redis_url: str = None):
        """
        Initialize event listener.

        Args:
            redis_url: Redis connection URL (defaults to REDIS_URL env var)
        """
        self.redis_url = redis_url or REDIS_URL
        self._redis: redis.Redis | None = None
        self._pubsub: redis.client.PubSub | None = None
        self._listener_task: asyncio.Task | None = None
        self._running = False
        self.whiteboard_service = WhiteboardService()

    async def _get_redis(self) -> redis.Redis:
        """Get or create Redis connection"""
        if self._redis is None:
            self._redis = await redis.from_url(
                self.redis_url, encoding="utf-8", decode_responses=True
            )
        return self._redis

    async def start(self):
        """Start listening to Redis events"""
        if self._running:
            logger.warning("Event listener already running")
            return

        try:
            logger.info("Starting event listener service")
            self._running = True

            # Get Redis connection and create pubsub
            r = await self._get_redis()
            self._pubsub = r.pubsub()

            # Subscribe to event channels
            await self._pubsub.subscribe("events:task", "events:session")
            logger.info("✅ Subscribed to Redis channels: events:task, events:session")

            # Start background listener task
            self._listener_task = asyncio.create_task(self._listen_loop())
            logger.info("Event listener service started successfully")

        except Exception as e:
            logger.error(f"Failed to start event listener: {e}", exc_info=True)
            self._running = False
            raise

    async def stop(self):
        """Stop listening to Redis events"""
        logger.info("Stopping event listener service")
        self._running = False

        # Cancel listener task
        if self._listener_task:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass

        # Unsubscribe and close connections
        if self._pubsub:
            await self._pubsub.unsubscribe("events:task", "events:session")
            await self._pubsub.aclose()

        if self._redis:
            await self._redis.aclose()

        logger.info("Event listener service stopped")

    async def _listen_loop(self):
        """Background task that listens for events"""
        logger.info("Event listener loop started")

        try:
            async for message in self._pubsub.listen():
                if not self._running:
                    break

                if message["type"] == "message":
                    try:
                        event = json.loads(message["data"])
                        await self._process_event(event, message["channel"])
                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to decode event: {e}")
                    except Exception as e:
                        logger.error(f"Error processing event: {e}", exc_info=True)

        except asyncio.CancelledError:
            logger.info("Event listener loop cancelled")
        except Exception as e:
            logger.error(f"Event listener loop crashed: {e}", exc_info=True)
            self._running = False

    async def _process_event(self, event: dict[str, Any], channel: str):
        """
        Process an event and update the whiteboard.

        Args:
            event: The event data
            channel: The Redis channel it came from
        """
        event_type = event.get("event_type")
        entity_id = event.get("entity_id")
        data = event.get("data", {})
        agent = event.get("agent")

        logger.debug(f"Processing {event_type} event (channel: {channel})")

        try:
            # Handle task events
            if channel == "events:task":
                await self._handle_task_event(event_type, entity_id, data, agent)

            # Handle session events
            elif channel == "events:session":
                await self._handle_session_event(event_type, entity_id, data, agent)

            # Add event to recent events list
            await self.whiteboard_service.add_event(event_type, {
                "entity_id": entity_id,
                "agent": agent,
                **data
            })

        except Exception as e:
            logger.error(f"Error handling {event_type} event: {e}", exc_info=True)

    async def _handle_task_event(
        self, event_type: str, task_id: str, data: dict[str, Any], agent: str
    ):
        """Handle task-related events"""
        if event_type == "task.created":
            # Add task to active tasks if status is 'doing'
            if data.get("status") == "doing":
                await self.whiteboard_service.update_task_status(
                    task_id=task_id,
                    title=data.get("title", "Untitled Task"),
                    status="doing",
                    assignee=data.get("assignee", agent),
                    project_id=data.get("project_id")
                )
                logger.info(f"Added task {task_id} to whiteboard (created as 'doing')")

        elif event_type == "task.status_changed":
            # Update task on whiteboard based on new status
            await self.whiteboard_service.update_task_status(
                task_id=task_id,
                title=data.get("title", "Untitled Task"),
                status=data.get("new_status"),
                assignee=data.get("assignee", agent),
                project_id=data.get("project_id")
            )
            logger.info(
                f"Updated task {task_id} on whiteboard: "
                f"{data.get('old_status')} → {data.get('new_status')}"
            )

        elif event_type == "task.assigned":
            # Update task assignee if it's active
            status = data.get("status", "todo")
            if status == "doing":
                await self.whiteboard_service.update_task_status(
                    task_id=task_id,
                    title=data.get("title", "Untitled Task"),
                    status=status,
                    assignee=data.get("new_assignee", agent),
                    project_id=data.get("project_id")
                )
                logger.info(
                    f"Updated task {task_id} assignee on whiteboard: "
                    f"{data.get('old_assignee')} → {data.get('new_assignee')}"
                )

    async def _handle_session_event(
        self, event_type: str, session_id: str, data: dict[str, Any], agent: str
    ):
        """Handle session-related events"""
        if event_type == "session.started":
            # Add session to active sessions
            await self.whiteboard_service.add_session(
                session_id=session_id,
                agent=agent,
                project_id=data.get("project_id"),
                started_at=data.get("started_at")
            )
            logger.info(f"Added session {session_id} ({agent}) to whiteboard")

        elif event_type == "session.ended":
            # Remove session from active sessions
            await self.whiteboard_service.remove_session(session_id)
            logger.info(f"Removed session {session_id} from whiteboard")


# Singleton instance for use in FastAPI app
_event_listener: EventListenerService | None = None


def get_event_listener() -> EventListenerService:
    """Get the singleton event listener instance"""
    global _event_listener
    if _event_listener is None:
        _event_listener = EventListenerService()
    return _event_listener
