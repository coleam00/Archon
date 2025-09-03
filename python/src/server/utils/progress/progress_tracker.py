"""
Progress Tracker Utility

Tracks operation progress in memory for HTTP polling access.
"""

from datetime import datetime
from typing import Any

from ...config.logfire_config import safe_logfire_error, safe_logfire_info


class ProgressTracker:
    """
    Utility class for tracking progress updates in memory.
    State can be accessed via HTTP polling endpoints.
    """

    # Class-level storage for all progress states
    _progress_states: dict[str, dict[str, Any]] = {}

    def __init__(self, progress_id: str, operation_type: str = "crawl"):
        """
        Initialize the progress tracker.

        Args:
            progress_id: Unique progress identifier
            operation_type: Type of operation (crawl, upload, etc.)
        """
        self.progress_id = progress_id
        self.operation_type = operation_type
        self.state = {
            "progress_id": progress_id,
            "type": operation_type,  # Store operation type for progress model selection
            "start_time": datetime.now().isoformat(),
            "status": "initializing",
            "progress": 0,
            "logs": [],
        }
        # Store in class-level dictionary
        ProgressTracker._progress_states[progress_id] = self.state

    @classmethod
    def get_progress(cls, progress_id: str) -> dict[str, Any] | None:
        """Get progress state by ID."""
        return cls._progress_states.get(progress_id)

    @classmethod
    def clear_progress(cls, progress_id: str) -> None:
        """Remove progress state from memory."""
        if progress_id in cls._progress_states:
            del cls._progress_states[progress_id]

    async def start(self, initial_data: dict[str, Any] | None = None):
        """
        Start progress tracking with initial data.

        Args:
            initial_data: Optional initial data to include
        """
        self.state["status"] = "starting"
        self.state["start_time"] = datetime.now().isoformat()

        if initial_data:
            self.state.update(initial_data)

        self._update_state()
        safe_logfire_info(
            f"Progress tracking started | progress_id={self.progress_id} | type={self.operation_type}"
        )

    async def update(self, status: str, progress: int, log: str, **kwargs):
        """
        Update progress with status, progress, and log message.

        Args:
            status: Current status (analyzing, crawling, processing, etc.)
            progress: Progress value (0-100)
            log: Log message describing current operation
            **kwargs: Additional data to include in update
        """
        # CRITICAL: Never allow progress to go backwards
        current_progress = self.state.get("progress", 0)
        new_progress = min(100, max(0, progress))  # Ensure 0-100

        # Only update if new progress is greater than or equal to current
        # (equal allows status updates without progress regression)
        if new_progress < current_progress:
            safe_logfire_info(
                f"Progress backwards prevented: {current_progress}% -> {new_progress}% | "
                f"progress_id={self.progress_id} | status={status}"
            )
            # Keep the higher progress value
            actual_progress = current_progress
        else:
            actual_progress = new_progress

        self.state.update({
            "status": status,
            "progress": actual_progress,
            "log": log,
            "timestamp": datetime.now().isoformat(),
        })

        # Add log entry
        if "logs" not in self.state:
            self.state["logs"] = []
        self.state["logs"].append({
            "timestamp": datetime.now().isoformat(),
            "message": log,
            "status": status,
            "progress": progress,
        })

        # Add any additional data
        for key, value in kwargs.items():
            self.state[key] = value
        

        self._update_state()

    async def complete(self, completion_data: dict[str, Any] | None = None):
        """
        Mark progress as completed with optional completion data.

        Args:
            completion_data: Optional data about the completed operation
        """
        self.state["status"] = "completed"
        self.state["progress"] = 100
        self.state["end_time"] = datetime.now().isoformat()

        if completion_data:
            self.state.update(completion_data)

        # Calculate duration
        if "start_time" in self.state:
            start = datetime.fromisoformat(self.state["start_time"])
            end = datetime.fromisoformat(self.state["end_time"])
            duration = (end - start).total_seconds()
            self.state["duration"] = str(duration)  # Convert to string for Pydantic model
            self.state["duration_formatted"] = self._format_duration(duration)

        self._update_state()
        safe_logfire_info(
            f"Progress completed | progress_id={self.progress_id} | type={self.operation_type} | duration={self.state.get('duration_formatted', 'unknown')}"
        )

    async def error(self, error_message: str, error_details: dict[str, Any] | None = None):
        """
        Mark progress as failed with error information.

        Args:
            error_message: Error message
            error_details: Optional additional error details
        """
        self.state.update({
            "status": "error",
            "error": error_message,
            "error_time": datetime.now().isoformat(),
        })

        if error_details:
            self.state["error_details"] = error_details

        self._update_state()
        safe_logfire_error(
            f"Progress error | progress_id={self.progress_id} | type={self.operation_type} | error={error_message}"
        )

    async def update_batch_progress(
        self, current_batch: int, total_batches: int, batch_size: int, message: str
    ):
        """
        Update progress for batch operations.

        Args:
            current_batch: Current batch number (1-based)
            total_batches: Total number of batches
            batch_size: Size of each batch
            message: Progress message
        """
        progress_val = int((current_batch / total_batches) * 100)
        await self.update(
            status="processing_batch",
            progress=progress_val,
            log=message,
            current_batch=current_batch,
            total_batches=total_batches,
            batch_size=batch_size,
        )

    async def update_crawl_stats(
        self, processed_pages: int, total_pages: int, current_url: str | None = None
    ):
        """
        Update crawling statistics.

        Args:
            processed_pages: Number of pages processed
            total_pages: Total pages to process
            current_url: Currently processing URL
        """
        progress_val = int((processed_pages / max(total_pages, 1)) * 100)
        log = f"Processing page {processed_pages}/{total_pages}"
        if current_url:
            log += f": {current_url}"

        await self.update(
            status="crawling",
            progress=progress_val,
            log=log,
            processed_pages=processed_pages,
            total_pages=total_pages,
            current_url=current_url,
        )

    async def update_storage_progress(
        self, chunks_stored: int, total_chunks: int, operation: str = "storing"
    ):
        """
        Update document storage progress.

        Args:
            chunks_stored: Number of chunks stored
            total_chunks: Total chunks to store
            operation: Storage operation description
        """
        progress_val = int((chunks_stored / max(total_chunks, 1)) * 100)
        await self.update(
            status="document_storage",
            progress=progress_val,
            log=f"{operation}: {chunks_stored}/{total_chunks} chunks",
            chunks_stored=chunks_stored,
            total_chunks=total_chunks,
        )

    def _update_state(self):
        """Update progress state in memory storage."""
        # Update the class-level dictionary
        ProgressTracker._progress_states[self.progress_id] = self.state

        safe_logfire_info(
            f"📊 [PROGRESS] Updated {self.operation_type} | ID: {self.progress_id} | "
            f"Status: {self.state.get('status')} | Progress: {self.state.get('progress')}%"
        )

    def _format_duration(self, seconds: float) -> str:
        """Format duration in seconds to human-readable string."""
        if seconds < 60:
            return f"{seconds:.1f} seconds"
        elif seconds < 3600:
            minutes = seconds / 60
            return f"{minutes:.1f} minutes"
        else:
            hours = seconds / 3600
            return f"{hours:.1f} hours"

    def get_state(self) -> dict[str, Any]:
        """Get current progress state."""
        return self.state.copy()
