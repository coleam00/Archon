"""In-Memory Log Buffer for Agent Work Orders

Thread-safe circular buffer to store recent logs for SSE streaming.
Automatically cleans up old work orders to prevent memory leaks.
"""

import asyncio
import threading
import time
from collections import defaultdict, deque
from datetime import UTC, datetime
from typing import Any


class WorkOrderLogBuffer:
    """Thread-safe circular buffer for work order logs.

    Stores up to MAX_LOGS_PER_WORK_ORDER logs per work order in memory.
    Automatically removes work orders older than cleanup threshold.
    Supports filtering by log level, step name, and timestamp.
    """

    MAX_LOGS_PER_WORK_ORDER = 1000
    CLEANUP_THRESHOLD_HOURS = 1

    def __init__(self) -> None:
        """Initialize the log buffer with thread safety."""
        self._buffers: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=self.MAX_LOGS_PER_WORK_ORDER)
        )
        self._last_activity: dict[str, float] = {}
        self._lock = threading.Lock()
        self._cleanup_task: asyncio.Task[None] | None = None

    def add_log(
        self,
        work_order_id: str,
        level: str,
        event: str,
        timestamp: str | None = None,
        **extra: Any,
    ) -> None:
        """Add a log entry to the buffer.

        Args:
            work_order_id: ID of the work order this log belongs to
            level: Log level (debug, info, warning, error)
            event: Event name describing what happened
            timestamp: ISO format timestamp (auto-generated if not provided)
            **extra: Additional structured log fields

        Examples:
            buffer.add_log(
                "wo-123",
                "info",
                "step_started",
                step="planning",
                progress="2/5"
            )
        """
        with self._lock:
            log_entry = {
                "work_order_id": work_order_id,
                "level": level,
                "event": event,
                "timestamp": timestamp or datetime.now(UTC).isoformat(),
                **extra,
            }
            self._buffers[work_order_id].append(log_entry)
            self._last_activity[work_order_id] = time.time()

    def get_logs(
        self,
        work_order_id: str,
        level: str | None = None,
        step: str | None = None,
        since: str | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Retrieve logs for a work order with optional filtering.

        Args:
            work_order_id: ID of the work order
            level: Filter by log level (case-insensitive)
            step: Filter by step name (exact match)
            since: ISO timestamp - only return logs after this time
            limit: Maximum number of logs to return
            offset: Number of logs to skip (for pagination)

        Returns:
            List of log entries matching filters, in chronological order

        Examples:
            # Get all logs
            logs = buffer.get_logs("wo-123")

            # Get recent error logs
            errors = buffer.get_logs("wo-123", level="error", since="2025-10-23T12:00:00Z")

            # Get logs for specific step
            planning_logs = buffer.get_logs("wo-123", step="planning")
        """
        with self._lock:
            logs = list(self._buffers.get(work_order_id, []))

        # Apply filters
        if level:
            level_lower = level.lower()
            logs = [log for log in logs if log.get("level", "").lower() == level_lower]

        if step:
            logs = [log for log in logs if log.get("step") == step]

        if since:
            logs = [log for log in logs if log.get("timestamp", "") > since]

        # Apply pagination
        if offset > 0:
            logs = logs[offset:]

        if limit is not None and limit > 0:
            logs = logs[:limit]

        return logs

    def get_logs_since(
        self,
        work_order_id: str,
        since_timestamp: str,
        level: str | None = None,
        step: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get logs after a specific timestamp.

        Convenience method for streaming use cases.

        Args:
            work_order_id: ID of the work order
            since_timestamp: ISO timestamp - only return logs after this time
            level: Optional log level filter
            step: Optional step name filter

        Returns:
            List of log entries after the timestamp
        """
        return self.get_logs(
            work_order_id=work_order_id, level=level, step=step, since=since_timestamp
        )

    def clear_work_order(self, work_order_id: str) -> None:
        """Remove all logs for a specific work order.

        Args:
            work_order_id: ID of the work order to clear

        Examples:
            buffer.clear_work_order("wo-123")
        """
        with self._lock:
            if work_order_id in self._buffers:
                del self._buffers[work_order_id]
            if work_order_id in self._last_activity:
                del self._last_activity[work_order_id]

    def cleanup_old_work_orders(self) -> int:
        """Remove work orders older than CLEANUP_THRESHOLD_HOURS.

        Returns:
            Number of work orders removed

        Examples:
            removed_count = buffer.cleanup_old_work_orders()
        """
        threshold = time.time() - (self.CLEANUP_THRESHOLD_HOURS * 3600)
        removed_count = 0

        with self._lock:
            # Find work orders to remove
            to_remove = [
                work_order_id
                for work_order_id, last_time in self._last_activity.items()
                if last_time < threshold
            ]

            # Remove them
            for work_order_id in to_remove:
                if work_order_id in self._buffers:
                    del self._buffers[work_order_id]
                if work_order_id in self._last_activity:
                    del self._last_activity[work_order_id]
                removed_count += 1

        return removed_count

    async def start_cleanup_task(self, interval_seconds: int = 300) -> None:
        """Start automatic cleanup task in background.

        Args:
            interval_seconds: How often to run cleanup (default: 5 minutes)

        Examples:
            await buffer.start_cleanup_task()
        """
        if self._cleanup_task is not None:
            return

        async def cleanup_loop() -> None:
            while True:
                await asyncio.sleep(interval_seconds)
                removed = self.cleanup_old_work_orders()
                if removed > 0:
                    # Note: We don't log here to avoid circular dependency
                    # The cleanup is logged by the caller if needed
                    pass

        self._cleanup_task = asyncio.create_task(cleanup_loop())

    async def stop_cleanup_task(self) -> None:
        """Stop the automatic cleanup task.

        Examples:
            await buffer.stop_cleanup_task()
        """
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    def get_work_order_count(self) -> int:
        """Get the number of work orders currently in the buffer.

        Returns:
            Count of work orders being tracked
        """
        with self._lock:
            return len(self._buffers)

    def get_log_count(self, work_order_id: str) -> int:
        """Get the number of logs for a specific work order.

        Args:
            work_order_id: ID of the work order

        Returns:
            Number of logs for this work order
        """
        with self._lock:
            return len(self._buffers.get(work_order_id, []))
