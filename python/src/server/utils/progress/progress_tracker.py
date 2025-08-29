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
            "progressId": progress_id,
            "startTime": datetime.now().isoformat(),
            "status": "initializing",
            "percentage": 0,
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
        self.state["startTime"] = datetime.now().isoformat()

        if initial_data:
            self.state.update(initial_data)

        self._update_state()
        safe_logfire_info(
            f"Progress tracking started | progress_id={self.progress_id} | type={self.operation_type}"
        )

    async def update(self, status: str, percentage: int, log: str, **kwargs):
        """
        Update progress with status, percentage, and log message.

        Args:
            status: Current status (analyzing, crawling, processing, etc.)
            percentage: Progress percentage (0-100)
            log: Log message describing current operation
            **kwargs: Additional data to include in update
        """
        self.state.update({
            "status": status,
            "percentage": min(100, max(0, percentage)),  # Ensure 0-100
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
            "percentage": percentage,
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
        self.state["percentage"] = 100
        self.state["endTime"] = datetime.now().isoformat()

        if completion_data:
            self.state.update(completion_data)

        # Calculate duration
        if "startTime" in self.state:
            start = datetime.fromisoformat(self.state["startTime"])
            end = datetime.fromisoformat(self.state["endTime"])
            duration = (end - start).total_seconds()
            self.state["duration"] = duration
            self.state["durationFormatted"] = self._format_duration(duration)

        self._update_state()
        safe_logfire_info(
            f"Progress completed | progress_id={self.progress_id} | type={self.operation_type} | duration={self.state.get('durationFormatted', 'unknown')}"
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
            "errorTime": datetime.now().isoformat(),
        })

        if error_details:
            self.state["errorDetails"] = error_details

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
        percentage = int((current_batch / total_batches) * 100)
        await self.update(
            status="processing_batch",
            percentage=percentage,
            log=message,
            currentBatch=current_batch,
            totalBatches=total_batches,
            batchSize=batch_size,
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
        percentage = int((processed_pages / max(total_pages, 1)) * 100)
        log = f"Processing page {processed_pages}/{total_pages}"
        if current_url:
            log += f": {current_url}"

        await self.update(
            status="crawling",
            percentage=percentage,
            log=log,
            processedPages=processed_pages,
            totalPages=total_pages,
            currentUrl=current_url,
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
        percentage = int((chunks_stored / max(total_chunks, 1)) * 100)
        await self.update(
            status="document_storage",
            percentage=percentage,
            log=f"{operation}: {chunks_stored}/{total_chunks} chunks",
            chunksStored=chunks_stored,
            totalChunks=total_chunks,
        )

    def _update_state(self):
        """Update progress state in memory storage."""
        # Update the class-level dictionary
        ProgressTracker._progress_states[self.progress_id] = self.state

        safe_logfire_info(
            f"📊 [PROGRESS] Updated {self.operation_type} | ID: {self.progress_id} | "
            f"Status: {self.state.get('status')} | Percentage: {self.state.get('percentage')}%"
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
