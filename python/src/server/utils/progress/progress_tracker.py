"""
Progress Tracker Utility

Tracks operation progress in memory and persists to database for restart/resume capability.
"""

import asyncio
from datetime import datetime
from typing import Any

from ...config.logfire_config import safe_logfire_error, safe_logfire_info
from ...utils import get_supabase_client


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

        # Check for existing progress in database (for restart/resume)
        existing = self._restore_from_database(progress_id)

        if existing:
            # Restore from database
            self.state = {
                "progress_id": progress_id,
                "type": existing.get("operation_type", operation_type),
                "start_time": existing.get("created_at"),
                "status": existing.get("status", "in_progress"),
                "progress": existing.get("progress", 0),
                "logs": [],
                "source_id": existing.get("source_id"),
                "current_url": existing.get("current_url"),
                "total_pages": existing.get("total_pages", 0),
                "processed_pages": existing.get("processed_pages", 0),
            }
            # Restore stats
            stats = existing.get("stats", {})
            for key, value in stats.items():
                if value is not None:
                    self.state[key] = value

            safe_logfire_info(
                f"Restored progress from database | progress_id={progress_id} | "
                f"status={self.state.get('status')} | progress={self.state.get('progress')}%"
            )
        else:
            # Fresh start
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
        """Get progress state by ID (checks memory first, then database)."""
        # Check memory first
        if progress_id in cls._progress_states:
            return cls._progress_states.get(progress_id)

        # Fall back to database
        return cls._restore_from_database(progress_id)

    @classmethod
    def clear_progress(cls, progress_id: str) -> None:
        """Remove progress state from memory and database."""
        # Remove from memory
        if progress_id in cls._progress_states:
            del cls._progress_states[progress_id]

        # Remove from database
        try:
            supabase = get_supabase_client()
            supabase.table("archon_operation_progress").delete().eq("progress_id", progress_id).execute()
        except Exception as e:
            safe_logfire_error(f"Failed to clear progress from database: {e}")

    @classmethod
    def list_active(cls) -> dict[str, dict[str, Any]]:
        """Get all active progress states (from both memory and database)."""
        active = {}

        # First, get in-memory states that are active (for tests and current session)
        for progress_id, state in cls._progress_states.items():
            status = state.get("status", "unknown")
            if status not in ["completed", "failed", "error", "cancelled"]:
                active[progress_id] = state

        # Also get from database for operations that survived restart
        try:
            supabase = get_supabase_client()
            result = (
                supabase.table("archon_operation_progress")
                .select("*")
                .in_("status", ["starting", "in_progress", "paused"])
                .execute()
            )

            for record in result.data or []:
                progress_id = record.get("progress_id")
                if progress_id and progress_id not in active:
                    # Convert DB record to state format
                    state = {
                        "progress_id": progress_id,
                        "type": record.get("operation_type"),
                        "status": record.get("status"),
                        "progress": record.get("progress", 0),
                        "source_id": record.get("source_id"),
                        "current_url": record.get("current_url"),
                        "stats": record.get("stats", {}),
                        "created_at": record.get("created_at"),
                        "updated_at": record.get("updated_at"),
                    }
                    active[progress_id] = state

            return active

        except Exception as e:
            safe_logfire_error(f"Failed to list active operations from DB: {e}")
            # Return in-memory states even if DB fails
            return active

    @classmethod
    async def restore_paused_operations(cls) -> int:
        """
        Restore operations that were in progress when the server restarted.
        Changes their status to 'paused' so users can manually resume them.
        Returns the count of restored operations.
        """
        try:
            supabase = get_supabase_client()

            result = (
                supabase.table("archon_operation_progress")
                .select("progress_id, status, operation_type, source_id")
                .in_("status", ["in_progress", "crawling", "starting"])
                .execute()
            )

            if not result.data:
                return 0

            restored_count = 0
            for record in result.data:
                progress_id = record.get("progress_id")
                if progress_id:
                    supabase.table("archon_operation_progress").update(
                        {
                            "status": "paused",
                            "updated_at": datetime.now().isoformat(),
                        }
                    ).eq("progress_id", progress_id).execute()

                    safe_logfire_info(
                        f"Restored operation | progress_id={progress_id} | "
                        f"previous_status={record.get('status')} -> paused"
                    )
                    restored_count += 1

            return restored_count

        except Exception as e:
            safe_logfire_error(f"Failed to restore paused operations: {e}")
            return 0

    @classmethod
    async def auto_resume_paused_operations(cls) -> int:
        """
        Automatically resume all paused operations after server restart.
        Returns the count of resumed operations.
        """
        try:
            supabase = get_supabase_client()

            # Find all paused operations
            result = (
                supabase.table("archon_operation_progress")
                .select("progress_id, status, operation_type, source_id")
                .eq("status", "paused")
                .execute()
            )

            if not result.data:
                return 0

            resumed_count = 0
            for record in result.data:
                progress_id = record.get("progress_id")
                source_id = record.get("source_id")
                operation_type = record.get("operation_type", "crawl")

                if not progress_id or not source_id:
                    continue

                try:
                    # Update status to in_progress
                    supabase.table("archon_operation_progress").update(
                        {
                            "status": "in_progress",
                            "updated_at": datetime.now().isoformat(),
                        }
                    ).eq("progress_id", progress_id).execute()

                    # Restart the crawl operation
                    if operation_type == "crawl":
                        from ...services.crawling.crawling_service import CrawlingService

                        # Get source metadata to reconstruct crawl request
                        source_result = (
                            supabase.table("archon_sources")
                            .select("source_url, metadata")
                            .eq("source_id", source_id)
                            .execute()
                        )

                        if source_result.data and len(source_result.data) > 0:
                            source_url = source_result.data[0].get("source_url")
                            metadata = source_result.data[0].get("metadata", {})

                            crawl_request = {
                                "url": source_url,
                                "knowledge_type": metadata.get("knowledge_type", "website"),
                                "tags": metadata.get("tags", []),
                                "max_depth": metadata.get("max_depth", 3),
                                "allow_external_links": metadata.get("allow_external_links", False),
                            }

                            # Create crawl service and start orchestration in background
                            crawl_service = CrawlingService(supabase_client=supabase, progress_id=progress_id)
                            # Use asyncio.create_task to run in background without awaiting
                            asyncio.create_task(crawl_service.orchestrate_crawl(crawl_request))

                            safe_logfire_info(
                                f"Auto-resumed crawl | progress_id={progress_id} | "
                                f"source_id={source_id} | url={source_url}"
                            )
                            resumed_count += 1

                except Exception as e:
                    safe_logfire_error(
                        f"Failed to auto-resume operation | progress_id={progress_id} | error={str(e)}"
                    )
                    # Continue with next operation even if one fails
                    continue

            return resumed_count

        except Exception as e:
            safe_logfire_error(f"Failed to auto-resume paused operations: {e}")
            return 0

    @classmethod
    async def pause_operation(cls, progress_id: str) -> bool:
        """Pause an operation."""
        try:
            supabase = get_supabase_client()
            supabase.table("archon_operation_progress").update(
                {
                    "status": "paused",
                    "updated_at": datetime.now().isoformat(),
                }
            ).eq("progress_id", progress_id).execute()

            # Also update in-memory
            if progress_id in cls._progress_states:
                cls._progress_states[progress_id]["status"] = "paused"

            safe_logfire_info(f"Operation paused | progress_id={progress_id}")
            return True

        except Exception as e:
            safe_logfire_error(f"Failed to pause operation: {e}")
            return False

    @classmethod
    async def resume_operation(cls, progress_id: str) -> bool:
        """Resume a paused operation."""
        try:
            supabase = get_supabase_client()
            supabase.table("archon_operation_progress").update(
                {
                    "status": "in_progress",
                    "updated_at": datetime.now().isoformat(),
                }
            ).eq("progress_id", progress_id).execute()

            # Also update in-memory
            if progress_id in cls._progress_states:
                cls._progress_states[progress_id]["status"] = "in_progress"

            safe_logfire_info(f"Operation resumed | progress_id={progress_id}")
            return True

        except Exception as e:
            safe_logfire_error(f"Failed to resume operation: {e}")
            return False

    @classmethod
    async def _delayed_cleanup(cls, progress_id: str, delay_seconds: int = 30):
        """
        Remove progress state from memory after a delay.

        This gives clients time to see the final state before cleanup.
        """
        await asyncio.sleep(delay_seconds)
        if progress_id in cls._progress_states:
            status = cls._progress_states[progress_id].get("status", "unknown")
            # Only clean up if still in terminal state (prevent cleanup of reused IDs)
            if status in ["completed", "failed", "error", "cancelled"]:
                del cls._progress_states[progress_id]
                safe_logfire_info(
                    f"Progress state cleaned up after delay | progress_id={progress_id} | status={status}"
                )

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
        safe_logfire_info(f"Progress tracking started | progress_id={self.progress_id} | type={self.operation_type}")

    async def update(self, status: str, progress: int, log: str, **kwargs):
        """
        Update progress with status, progress, and log message.

        Args:
            status: Current status (analyzing, crawling, processing, etc.)
            progress: Progress value (0-100)
            log: Log message describing current operation
            **kwargs: Additional data to include in update
        """
        # Debug logging for document_storage issue
        if status == "document_storage" and progress >= 90:
            safe_logfire_info(
                f"DEBUG: ProgressTracker.update called | status={status} | progress={progress} | "
                f"current_state_progress={self.state.get('progress', 0)} | kwargs_keys={list(kwargs.keys())}"
            )

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

        self.state.update(
            {
                "status": status,
                "progress": actual_progress,
                "log": log,
                "timestamp": datetime.now().isoformat(),
            }
        )

        # DEBUG: Log final state for document_storage
        if status == "document_storage" and actual_progress >= 35:
            safe_logfire_info(
                f"DEBUG ProgressTracker state updated | status={status} | actual_progress={actual_progress} | "
                f"state_progress={self.state.get('progress')} | received_progress={progress}"
            )

        # Add log entry
        if "logs" not in self.state:
            self.state["logs"] = []
        self.state["logs"].append(
            {
                "timestamp": datetime.now().isoformat(),
                "message": log,
                "status": status,
                "progress": actual_progress,  # Use the actual progress after "never go backwards" check
            }
        )
        # Keep only the last 200 log entries
        if len(self.state["logs"]) > 200:
            self.state["logs"] = self.state["logs"][-200:]

        # Add any additional data (but don't allow overriding core fields)
        protected_fields = {"progress", "status", "log", "progress_id", "type", "start_time"}
        for key, value in kwargs.items():
            if key not in protected_fields:
                self.state[key] = value

        self._update_state()

        # Schedule cleanup for terminal states
        if status in ["cancelled", "failed"]:
            asyncio.create_task(self._delayed_cleanup(self.progress_id))

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

        # Schedule cleanup after delay to allow clients to see final state
        asyncio.create_task(self._delayed_cleanup(self.progress_id))

    async def error(self, error_message: str, error_details: dict[str, Any] | None = None):
        """
        Mark progress as failed with error information.

        Args:
            error_message: Error message
            error_details: Optional additional error details
        """
        self.state.update(
            {
                "status": "error",
                "error": error_message,
                "error_time": datetime.now().isoformat(),
            }
        )

        if error_details:
            self.state["error_details"] = error_details

        self._update_state()
        safe_logfire_error(
            f"Progress error | progress_id={self.progress_id} | type={self.operation_type} | error={error_message}"
        )

        # Schedule cleanup after delay to allow clients to see final state
        asyncio.create_task(self._delayed_cleanup(self.progress_id))

    async def update_batch_progress(self, current_batch: int, total_batches: int, batch_size: int, message: str):
        """
        Update progress for batch operations.

        Args:
            current_batch: Current batch number (1-based)
            total_batches: Total number of batches
            batch_size: Size of each batch
            message: Progress message
        """
        progress_val = int((current_batch / max(total_batches, 1)) * 100)
        await self.update(
            status="processing_batch",
            progress=progress_val,
            log=message,
            current_batch=current_batch,
            total_batches=total_batches,
            batch_size=batch_size,
        )

    async def update_crawl_stats(
        self, processed_pages: int, total_pages: int, current_url: str | None = None, pages_found: int | None = None
    ):
        """
        Update crawling statistics with detailed metrics.

        Args:
            processed_pages: Number of pages processed
            total_pages: Total pages to process
            current_url: Currently processing URL
            pages_found: Total pages discovered during crawl
        """
        progress_val = int((processed_pages / max(total_pages, 1)) * 100)
        log = f"Processing page {processed_pages}/{total_pages}"
        if current_url:
            log += f": {current_url}"

        update_data = {
            "status": "crawling",
            "progress": progress_val,
            "log": log,
            "processed_pages": processed_pages,
            "total_pages": total_pages,
            "current_url": current_url,
        }

        if pages_found is not None:
            update_data["pages_found"] = pages_found

        await self.update(**update_data)

    async def update_storage_progress(
        self,
        chunks_stored: int,
        total_chunks: int,
        operation: str = "storing",
        word_count: int | None = None,
        embeddings_created: int | None = None,
    ):
        """
        Update document storage progress with detailed metrics.

        Args:
            chunks_stored: Number of chunks stored
            total_chunks: Total chunks to store
            operation: Storage operation description
            word_count: Total word count processed
            embeddings_created: Number of embeddings created
        """
        progress_val = int((chunks_stored / max(total_chunks, 1)) * 100)

        update_data = {
            "status": "document_storage",
            "progress": progress_val,
            "log": f"{operation}: {chunks_stored}/{total_chunks} chunks",
            "chunks_stored": chunks_stored,
            "total_chunks": total_chunks,
        }

        if word_count is not None:
            update_data["word_count"] = word_count
        if embeddings_created is not None:
            update_data["embeddings_created"] = embeddings_created

        await self.update(**update_data)

    async def update_code_extraction_progress(
        self, completed_summaries: int, total_summaries: int, code_blocks_found: int, current_file: str | None = None
    ):
        """
        Update code extraction progress with detailed metrics.

        Args:
            completed_summaries: Number of code summaries completed
            total_summaries: Total code summaries to generate
            code_blocks_found: Total number of code blocks found
            current_file: Current file being processed
        """
        progress_val = int((completed_summaries / max(total_summaries, 1)) * 100)

        log = f"Extracting code: {completed_summaries}/{total_summaries} summaries"
        if current_file:
            log += f" - {current_file}"

        await self.update(
            status="code_extraction",
            progress=progress_val,
            log=log,
            completed_summaries=completed_summaries,
            total_summaries=total_summaries,
            code_blocks_found=code_blocks_found,
            current_file=current_file,
        )

    def _update_state(self):
        """Update progress state in memory storage and persist to database."""
        # Update the class-level dictionary
        ProgressTracker._progress_states[self.progress_id] = self.state

        # Persist to database for restart/resume capability
        self._persist_to_database()

        safe_logfire_info(
            f"📊 [PROGRESS] Updated {self.operation_type} | ID: {self.progress_id} | "
            f"Status: {self.state.get('status')} | Progress: {self.state.get('progress')}%"
        )

    def _persist_to_database(self):
        """Persist progress state to database (atomic operation)."""
        try:
            supabase = get_supabase_client()
            table_name = "archon_operation_progress"

            # Extract stats from state
            stats = {
                "pages_crawled": self.state.get("processed_pages", 0),
                "pages_found": self.state.get("pages_found", 0),
                "documents_created": self.state.get("documents_created", 0),
                "chunks_stored": self.state.get("chunks_stored", 0),
                "code_blocks": self.state.get("code_blocks_found", 0),
                "errors": self.state.get("errors", 0),
            }

            # Build the record
            record = {
                "progress_id": self.progress_id,
                "operation_type": self.operation_type,
                "source_id": self.state.get("source_id"),
                "status": self.state.get("status", "in_progress"),
                "progress": self.state.get("progress", 0),
                "current_url": self.state.get("current_url"),
                "total_pages": self.state.get("total_pages", 0),
                "processed_pages": self.state.get("processed_pages", 0),
                "documents_created": self.state.get("documents_created", 0),
                "code_blocks_found": self.state.get("code_blocks_found", 0),
                "stats": stats,
                "error_message": self.state.get("error"),
                "updated_at": datetime.now().isoformat(),
            }

            # Upsert - atomic operation
            supabase.table(table_name).upsert(record, on_conflict="progress_id").execute()

        except Exception as e:
            # Log but don't fail - in-memory is primary
            safe_logfire_error(f"Failed to persist progress to database: {e}")

    @classmethod
    def _restore_from_database(cls, progress_id: str) -> dict[str, Any] | None:
        """Restore progress state from database if it exists."""
        try:
            supabase = get_supabase_client()
            result = supabase.table("archon_operation_progress").select("*").eq("progress_id", progress_id).execute()

            if result.data and len(result.data) > 0:
                record = result.data[0]
                safe_logfire_info(f"Restored progress from database | progress_id={progress_id}")
                return record

            return None

        except Exception as e:
            safe_logfire_error(f"Failed to restore progress from database: {e}")
            return None

    @classmethod
    def get_active_operations(cls) -> list[dict[str, Any]]:
        """Get all active operations (in_progress or paused) from database."""
        try:
            supabase = get_supabase_client()
            result = (
                supabase.table("archon_operation_progress")
                .select("*")
                .in_("status", ["in_progress", "paused"])
                .execute()
            )

            operations = result.data or []
            safe_logfire_info(f"Found {len(operations)} active operations from database")
            return operations

        except Exception as e:
            safe_logfire_error(f"Failed to get active operations: {e}")
            return []

    @classmethod
    def get_operation_by_source(cls, source_id: str, operation_type: str | None = None) -> dict[str, Any] | None:
        """Get the most recent operation for a source."""
        try:
            supabase = get_supabase_client()
            query = supabase.table("archon_operation_progress").select("*").eq("source_id", source_id)

            if operation_type:
                query = query.eq("operation_type", operation_type)

            result = query.order("created_at", desc=True).limit(1).execute()

            if result.data and len(result.data) > 0:
                return result.data[0]

            return None

        except Exception as e:
            safe_logfire_error(f"Failed to get operation by source: {e}")
            return None

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
