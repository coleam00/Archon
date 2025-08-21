"""
Progress Service Module for Archon

This module provides progress tracking functionality for long-running operations,
particularly project creation with AI assistance. It manages progress states
and broadcasts updates via Socket.IO.
"""

# Removed direct logging import - using unified config
from datetime import datetime
from typing import Any

from ...config.logfire_config import get_logger
from ...socketio_app import sio

logger = get_logger(__name__)



class ProgressService:
    """Service class for progress tracking with Socket.IO broadcasting"""

    def __init__(self):
        """Initialize progress tracking storage"""
        self.active_operations: dict[str, dict[str, Any]] = {}

    def start_operation(
        self, progress_id: str, operation_type: str, initial_data: dict[str, Any]
    ) -> None:
        """
        Start tracking a new operation.

        Args:
            progress_id: Unique identifier for this operation
            operation_type: Type of operation (e.g., 'project_creation')
            initial_data: Initial data for the operation
        """
        self.active_operations[progress_id] = {
            "type": operation_type,
            "status": "starting",
            "percentage": 0,
            "start_time": datetime.now(),
            "logs": [f"🚀 Starting {operation_type}..."],
            "step": "initialization",
            **initial_data,
        }
        logger.info(f"🎬 [PROGRESS] Started tracking {operation_type} operation: {progress_id}")
        logger.info(f"🎬 [PROGRESS] Active operations: {list(self.active_operations.keys())}")

    async def update_progress(self, progress_id: str, update_data: dict[str, Any]) -> None:
        """
        Update operation progress and broadcast via Socket.IO.

        Args:
            progress_id: Operation identifier
            update_data: Progress update data
        """
        logger.info(
            f"📊 [PROGRESS] update_progress called for {progress_id} with data: {update_data}"
        )
        if progress_id not in self.active_operations:
            logger.warning(f"📊 [PROGRESS] Attempted to update unknown operation: {progress_id}")
            logger.warning(
                f"📊 [PROGRESS] Active operations: {list(self.active_operations.keys())}"
            )
            return

        # Update progress data
        self.active_operations[progress_id].update(update_data)

        # Add log if provided
        if "log" in update_data:
            self.active_operations[progress_id]["logs"].append(update_data["log"])
            # Keep only last 50 logs to prevent memory issues
            if len(self.active_operations[progress_id]["logs"]) > 50:
                self.active_operations[progress_id]["logs"] = self.active_operations[progress_id][
                    "logs"
                ][-50:]

        # Broadcast update
        await self._broadcast_progress(progress_id)

    async def complete_operation(self, progress_id: str, completion_data: dict[str, Any]) -> None:
        """
        Mark an operation as completed and send final update.

        Args:
            progress_id: Operation identifier
            completion_data: Final completion data
        """
        if progress_id not in self.active_operations:
            logger.warning(f"Attempted to complete unknown operation: {progress_id}")
            return

        operation = self.active_operations[progress_id]
        duration = datetime.now() - operation["start_time"]

        completion_data.update({
            "status": "completed",
            "percentage": 100,
            "step": "finished",
            "log": f"✅ {operation['type']} completed successfully!",
            "duration": str(duration),
        })

        self.active_operations[progress_id].update(completion_data)
        await self._broadcast_progress(progress_id)

        # Clean up after a longer delay to give frontend time to connect
        import asyncio

        logger.info(f"🧹 [PROGRESS] Scheduling cleanup for {progress_id} in 30 seconds")
        await asyncio.sleep(30)  # Increased from 5 to 30 seconds
        if progress_id in self.active_operations:
            logger.info(f"🧹 [PROGRESS] Cleaning up completed operation: {progress_id}")
            del self.active_operations[progress_id]
        else:
            logger.info(f"🧹 [PROGRESS] Operation {progress_id} already cleaned up")

    async def error_operation(self, progress_id: str, error_message: str) -> None:
        """
        Mark an operation as failed and send error update.

        Args:
            progress_id: Operation identifier
            error_message: Error description
        """
        if progress_id not in self.active_operations:
            logger.warning(f"Attempted to error unknown operation: {progress_id}")
            return

        self.active_operations[progress_id].update({
            "status": "error",
            "error": error_message,
            "log": f"❌ Error: {error_message}",
            "step": "failed",
        })

        await self._broadcast_progress(progress_id)

    def get_operation_status(self, progress_id: str) -> dict[str, Any] | None:
        """
        Get current status of an operation.

        Args:
            progress_id: Operation identifier

        Returns:
            Operation status data or None if not found
        """
        return self.active_operations.get(progress_id)

    async def _broadcast_progress(self, progress_id: str) -> None:
        """
        Broadcast progress update via Socket.IO.

        Args:
            progress_id: Operation identifier
        """
        progress_data = self.active_operations.get(progress_id, {}).copy()
        progress_data["progressId"] = progress_id

        # Convert datetime to ISO string for JSON serialization
        if "start_time" in progress_data and hasattr(progress_data["start_time"], "isoformat"):
            progress_data["start_time"] = progress_data["start_time"].isoformat()

        # Determine event type based on status and operation type
        operation_type = progress_data.get("type", "operation")
        status = progress_data.get("status", "progress")

        if operation_type == "project_creation":
            event_type = "project_progress"
            if status == "completed":
                event_type = "project_completed"
            elif status == "error":
                event_type = "project_error"
        else:
            # Generic events for other operation types
            event_type = f"{operation_type}_progress"
            if status == "completed":
                event_type = f"{operation_type}_completed"
            elif status == "error":
                event_type = f"{operation_type}_error"

        try:
            logger.info(
                f"🚀 [PROGRESS] About to emit {event_type} to room {progress_id} with data: {progress_data}"
            )
            await sio.emit(event_type, progress_data, room=progress_id)
            logger.info(
                f"✅ [PROGRESS] Successfully emitted {event_type} for progress {progress_id}"
            )
        except Exception as e:
            logger.error(f"❌ [PROGRESS] Error broadcasting progress via Socket.IO: {e}")


# Global progress service instance
progress_service = ProgressService()
