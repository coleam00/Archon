"""Unit tests for the ProgressTracker class."""

import pytest
from datetime import datetime
from unittest.mock import patch

from src.server.utils.progress.progress_tracker import ProgressTracker


class TestProgressTracker:
    """Test cases for ProgressTracker functionality."""

    @pytest.fixture
    def progress_tracker(self):
        """Create a fresh ProgressTracker for each test."""
        return ProgressTracker("test-progress-id", "crawl")

    def test_init_creates_initial_state(self, progress_tracker):
        """Test that initialization creates correct initial state."""
        assert progress_tracker.progress_id == "test-progress-id"
        assert progress_tracker.operation_type == "crawl"
        assert progress_tracker.state["progress_id"] == "test-progress-id"
        assert progress_tracker.state["type"] == "crawl"
        assert progress_tracker.state["status"] == "initializing"
        assert progress_tracker.state["progress"] == 0
        assert isinstance(progress_tracker.state["logs"], list)
        assert len(progress_tracker.state["logs"]) == 0

    def test_get_progress_returns_state(self, progress_tracker):
        """Test that get_progress returns the correct state."""
        state = ProgressTracker.get_progress("test-progress-id")
        assert state is not None
        assert state["progress_id"] == "test-progress-id"
        assert state["type"] == "crawl"

    def test_clear_progress_removes_state(self, progress_tracker):
        """Test that clear_progress removes the state from memory."""
        # Verify state exists
        assert ProgressTracker.get_progress("test-progress-id") is not None
        
        # Clear progress
        ProgressTracker.clear_progress("test-progress-id")
        
        # Verify state is gone
        assert ProgressTracker.get_progress("test-progress-id") is None

    @pytest.mark.asyncio
    async def test_start_updates_status_and_time(self, progress_tracker):
        """Test that start() updates status and start time."""
        initial_data = {"test_key": "test_value"}
        
        await progress_tracker.start(initial_data)
        
        assert progress_tracker.state["status"] == "starting"
        assert "start_time" in progress_tracker.state
        assert progress_tracker.state["test_key"] == "test_value"

    @pytest.mark.asyncio
    async def test_update_progress_and_logs(self, progress_tracker):
        """Test that update() correctly updates progress and adds logs."""
        await progress_tracker.update(
            status="crawling",
            progress=25,
            log="Processing page 5/20",
            total_pages=20,
            processed_pages=5
        )
        
        assert progress_tracker.state["status"] == "crawling"
        assert progress_tracker.state["progress"] == 25
        assert progress_tracker.state["log"] == "Processing page 5/20"
        assert progress_tracker.state["total_pages"] == 20
        assert progress_tracker.state["processed_pages"] == 5
        
        # Check log entry was added
        assert len(progress_tracker.state["logs"]) == 1
        log_entry = progress_tracker.state["logs"][0]
        assert log_entry["message"] == "Processing page 5/20"
        assert log_entry["status"] == "crawling"
        assert log_entry["progress"] == 25

    @pytest.mark.asyncio
    async def test_progress_never_goes_backwards(self, progress_tracker):
        """Test that progress values cannot decrease."""
        # Set initial progress
        await progress_tracker.update("crawling", 50, "Halfway done")
        assert progress_tracker.state["progress"] == 50
        
        # Try to set lower progress
        await progress_tracker.update("crawling", 30, "Should not decrease")
        
        # Progress should remain at 50
        assert progress_tracker.state["progress"] == 50
        # But status and message should update
        assert progress_tracker.state["log"] == "Should not decrease"

    @pytest.mark.asyncio
    async def test_progress_clamped_to_0_100(self, progress_tracker):
        """Test that progress values are clamped to 0-100 range."""
        # Test negative progress
        await progress_tracker.update("starting", -10, "Negative progress")
        assert progress_tracker.state["progress"] == 0
        
        # Test progress over 100
        await progress_tracker.update("running", 150, "Over 100 progress")
        assert progress_tracker.state["progress"] == 100

    @pytest.mark.asyncio
    async def test_complete_sets_100_percent_and_duration(self, progress_tracker):
        """Test that complete() sets progress to 100% and calculates duration."""
        completion_data = {"chunks_stored": 500, "word_count": 10000}
        
        await progress_tracker.complete(completion_data)
        
        assert progress_tracker.state["status"] == "completed"
        assert progress_tracker.state["progress"] == 100
        assert progress_tracker.state["chunks_stored"] == 500
        assert progress_tracker.state["word_count"] == 10000
        assert "end_time" in progress_tracker.state
        assert "duration" in progress_tracker.state
        assert "duration_formatted" in progress_tracker.state

    @pytest.mark.asyncio
    async def test_error_sets_error_status(self, progress_tracker):
        """Test that error() sets error status and details."""
        error_details = {"error_code": 500, "component": "embedding_service"}
        
        await progress_tracker.error("Failed to create embeddings", error_details)
        
        assert progress_tracker.state["status"] == "error"
        assert progress_tracker.state["error"] == "Failed to create embeddings"
        assert progress_tracker.state["error_details"]["error_code"] == 500
        assert "error_time" in progress_tracker.state

    @pytest.mark.asyncio
    async def test_update_batch_progress(self, progress_tracker):
        """Test batch progress calculation and updates."""
        await progress_tracker.update_batch_progress(
            current_batch=3,
            total_batches=6,
            batch_size=25,
            message="Processing batch 3 of 6"
        )
        
        expected_progress = int((3 / 6) * 100)  # 50%
        assert progress_tracker.state["progress"] == expected_progress
        assert progress_tracker.state["status"] == "processing_batch"
        assert progress_tracker.state["current_batch"] == 3
        assert progress_tracker.state["total_batches"] == 6
        assert progress_tracker.state["batch_size"] == 25

    @pytest.mark.asyncio
    async def test_update_crawl_stats(self, progress_tracker):
        """Test crawling statistics updates."""
        await progress_tracker.update_crawl_stats(
            processed_pages=15,
            total_pages=30,
            current_url="https://example.com/page15"
        )
        
        expected_progress = int((15 / 30) * 100)  # 50%
        assert progress_tracker.state["progress"] == expected_progress
        assert progress_tracker.state["status"] == "crawling"
        assert progress_tracker.state["processed_pages"] == 15
        assert progress_tracker.state["total_pages"] == 30
        assert progress_tracker.state["current_url"] == "https://example.com/page15"
        assert "Processing page 15/30: https://example.com/page15" in progress_tracker.state["log"]

    @pytest.mark.asyncio
    async def test_update_storage_progress(self, progress_tracker):
        """Test document storage progress updates."""
        await progress_tracker.update_storage_progress(
            chunks_stored=75,
            total_chunks=100,
            operation="storing embeddings"
        )
        
        expected_progress = int((75 / 100) * 100)  # 75%
        assert progress_tracker.state["progress"] == expected_progress
        assert progress_tracker.state["status"] == "document_storage"
        assert progress_tracker.state["chunks_stored"] == 75
        assert progress_tracker.state["total_chunks"] == 100
        assert "storing embeddings: 75/100 chunks" in progress_tracker.state["log"]

    def test_format_duration(self, progress_tracker):
        """Test duration formatting for different time ranges."""
        # Test seconds
        formatted = progress_tracker._format_duration(45.5)
        assert "45.5 seconds" in formatted
        
        # Test minutes
        formatted = progress_tracker._format_duration(125.0)
        assert "2.1 minutes" in formatted
        
        # Test hours
        formatted = progress_tracker._format_duration(7200.0)
        assert "2.0 hours" in formatted

    def test_get_state_returns_copy(self, progress_tracker):
        """Test that get_state returns a copy, not the original state."""
        state_copy = progress_tracker.get_state()
        
        # Modify the copy
        state_copy["test_modification"] = "should not affect original"
        
        # Original state should be unchanged
        assert "test_modification" not in progress_tracker.state

    def test_multiple_trackers_independent(self):
        """Test that multiple trackers maintain independent state."""
        tracker1 = ProgressTracker("id-1", "crawl")
        tracker2 = ProgressTracker("id-2", "upload")
        
        # Verify they have different states
        assert tracker1.progress_id != tracker2.progress_id
        assert tracker1.state["progress_id"] != tracker2.state["progress_id"]
        assert tracker1.state["type"] != tracker2.state["type"]
        
        # Verify they can be retrieved independently
        state1 = ProgressTracker.get_progress("id-1")
        state2 = ProgressTracker.get_progress("id-2")
        
        assert state1["progress_id"] == "id-1"
        assert state2["progress_id"] == "id-2"
        assert state1["type"] == "crawl"
        assert state2["type"] == "upload"