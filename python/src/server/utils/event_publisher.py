"""
Event Publisher Utility for Archon

Publishes structured events to Redis for whiteboard integration and real-time monitoring.
Events are published as JSON to different channels based on entity type.

Channels:
- events:task - Task-related events (created, status_changed, etc.)
- events:session - Session lifecycle events (created, ended, etc.)
- events:work_order - Work order events
- events:error - Error events for critical monitoring
"""

import redis.asyncio as redis
import json
from datetime import datetime, timezone
from typing import Optional, Dict, Any
import logfire

from ..config.redis_config import REDIS_URL


class EventPublisher:
    """
    Centralized event publishing service for Archon.

    Publishes structured JSON events to Redis pub/sub for consumption by:
    - Whiteboard updater service
    - Real-time dashboards
    - Event logging systems
    """

    def __init__(self, redis_url: Optional[str] = None):
        """
        Initialize EventPublisher with Redis connection.

        Args:
            redis_url: Redis connection URL. Defaults to REDIS_URL env var or localhost.
        """
        self.redis_url = redis_url or REDIS_URL
        self._redis: Optional[redis.Redis] = None

    async def _get_redis(self) -> redis.Redis:
        """Get or create Redis connection (lazy initialization)"""
        if self._redis is None:
            self._redis = await redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True
            )
        return self._redis

    async def close(self):
        """Close Redis connection"""
        if self._redis:
            await self._redis.close()
            self._redis = None

    async def publish_task_event(
        self,
        event_type: str,
        task_id: str,
        data: Dict[str, Any],
        agent: Optional[str] = None
    ) -> bool:
        """
        Publish a task-related event.

        Args:
            event_type: Type of event (e.g., "task.created", "task.status_changed")
            task_id: UUID of the task
            data: Event-specific data (title, assignee, status, etc.)
            agent: Optional agent identifier (claude, gemini, gpt, user)

        Returns:
            True if published successfully, False otherwise

        Example:
            await publisher.publish_task_event(
                event_type="task.status_changed",
                task_id="uuid-123",
                data={
                    "old_status": "todo",
                    "new_status": "doing",
                    "task_title": "Implement feature X",
                    "assignee": "claude"
                }
            )
        """
        event = {
            "event_type": event_type,
            "entity_type": "task",
            "entity_id": task_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data
        }

        if agent:
            event["agent"] = agent

        return await self._publish("events:task", event)

    async def publish_session_event(
        self,
        event_type: str,
        session_id: str,
        agent: str,
        data: Dict[str, Any]
    ) -> bool:
        """
        Publish a session lifecycle event.

        Args:
            event_type: Type of event (e.g., "session.created", "session.ended")
            session_id: UUID of the session
            agent: Agent identifier (claude, gemini, gpt, user)
            data: Event-specific data (project_id, context, summary, etc.)

        Returns:
            True if published successfully, False otherwise

        Example:
            await publisher.publish_session_event(
                event_type="session.created",
                session_id="uuid-456",
                agent="claude",
                data={
                    "project_id": "proj-uuid",
                    "context": {"working_on": "feature implementation"}
                }
            )
        """
        event = {
            "event_type": event_type,
            "entity_type": "session",
            "entity_id": session_id,
            "agent": agent,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data
        }

        return await self._publish("events:session", event)

    async def publish_work_order_event(
        self,
        event_type: str,
        work_order_id: str,
        data: Dict[str, Any],
        agent: Optional[str] = None
    ) -> bool:
        """
        Publish a work order event.

        Args:
            event_type: Type of event (e.g., "work_order.started", "work_order.completed")
            work_order_id: UUID of the work order
            data: Event-specific data
            agent: Optional agent identifier

        Returns:
            True if published successfully, False otherwise
        """
        event = {
            "event_type": event_type,
            "entity_type": "work_order",
            "entity_id": work_order_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data
        }

        if agent:
            event["agent"] = agent

        return await self._publish("events:work_order", event)

    async def publish_error_event(
        self,
        service: str,
        error_message: str,
        severity: str = "error",
        additional_data: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Publish an error event for critical monitoring.

        Args:
            service: Name of the service where error occurred
            error_message: Error message or description
            severity: Severity level (info, warning, error, critical)
            additional_data: Optional additional context

        Returns:
            True if published successfully, False otherwise
        """
        event = {
            "event_type": "error",
            "entity_type": "system",
            "service": service,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "severity": severity,
            "data": {
                "message": error_message,
                **(additional_data or {})
            }
        }

        return await self._publish("events:error", event)

    async def _publish(self, channel: str, event: Dict[str, Any]) -> bool:
        """
        Internal method to publish event to Redis channel.

        Args:
            channel: Redis pub/sub channel name
            event: Event dictionary to publish as JSON

        Returns:
            True if published successfully, False otherwise
        """
        try:
            redis_client = await self._get_redis()
            event_json = json.dumps(event)

            # Publish to Redis
            subscribers = await redis_client.publish(channel, event_json)

            # Log the event publication
            logfire.info(
                "Event published",
                channel=channel,
                event_type=event.get("event_type"),
                entity_id=event.get("entity_id"),
                subscribers=subscribers
            )

            return True

        except Exception as e:
            logfire.error(
                "Failed to publish event",
                channel=channel,
                event_type=event.get("event_type"),
                error=str(e)
            )
            return False


# Singleton instance for convenience
_publisher_instance: Optional[EventPublisher] = None


def get_event_publisher() -> EventPublisher:
    """
    Get singleton EventPublisher instance.

    Returns:
        Global EventPublisher instance
    """
    global _publisher_instance
    if _publisher_instance is None:
        _publisher_instance = EventPublisher()
    return _publisher_instance
