"""
Tests for ProgressTracker
"""

import pytest
from datetime import datetime

from src.server.utils.progress import ProgressTracker


class TestProgressTracker:
    """Test suite for ProgressTracker"""

    def test_initialization(self):
        """Test ProgressTracker initialization"""
        progress_id = "test-123"
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        
        assert tracker.progress_id == progress_id
        assert tracker.operation_type == "crawl"
        assert tracker.state["status"] == "initializing"
        assert tracker.state["progress"] == 0
        assert "start_time" in tracker.state
        
    def test_get_progress(self):
        """Test getting progress by ID"""
        progress_id = "test-456"
        tracker = ProgressTracker(progress_id, operation_type="upload")
        
        # Should be able to get progress by ID
        retrieved = ProgressTracker.get_progress(progress_id)
        assert retrieved is not None
        assert retrieved["progress_id"] == progress_id
        assert retrieved["type"] == "upload"
        
    def test_clear_progress(self):
        """Test clearing progress from memory"""
        progress_id = "test-789"
        ProgressTracker(progress_id, operation_type="crawl")
        
        # Verify it exists
        assert ProgressTracker.get_progress(progress_id) is not None
        
        # Clear it
        ProgressTracker.clear_progress(progress_id)
        
        # Verify it's gone
        assert ProgressTracker.get_progress(progress_id) is None
        
    @pytest.mark.asyncio
    async def test_start(self):
        """Test starting progress tracking"""
        tracker = ProgressTracker("test-start", operation_type="crawl")
        
        initial_data = {
            "url": "https://example.com",
            "crawl_type": "normal"
        }
        
        await tracker.start(initial_data)
        
        assert tracker.state["status"] == "starting"
        assert tracker.state["url"] == "https://example.com"
        assert tracker.state["crawl_type"] == "normal"
        
    @pytest.mark.asyncio
    async def test_update(self):
        """Test updating progress"""
        tracker = ProgressTracker("test-update", operation_type="crawl")
        
        await tracker.update(
            status="crawling",
            progress=50,
            log="Processing page 5/10",
            current_url="https://example.com/page5"
        )
        
        assert tracker.state["status"] == "crawling"
        assert tracker.state["progress"] == 50
        assert tracker.state["log"] == "Processing page 5/10"
        assert tracker.state["current_url"] == "https://example.com/page5"
        assert len(tracker.state["logs"]) == 1
        
    @pytest.mark.asyncio
    async def test_progress_never_goes_backwards(self):
        """Test that progress never decreases"""
        tracker = ProgressTracker("test-backwards", operation_type="crawl")
        
        # Set progress to 50%
        await tracker.update(status="crawling", progress=50, log="Half way")
        assert tracker.state["progress"] == 50
        
        # Try to set it to 30% - should stay at 50%
        await tracker.update(status="crawling", progress=30, log="Should not go back")
        assert tracker.state["progress"] == 50  # Should not decrease
        
        # Can increase to 70%
        await tracker.update(status="crawling", progress=70, log="Moving forward")
        assert tracker.state["progress"] == 70
        
    @pytest.mark.asyncio
    async def test_complete(self):
        """Test marking progress as completed"""
        tracker = ProgressTracker("test-complete", operation_type="crawl")
        
        await tracker.complete({
            "chunks_stored": 100,
            "source_id": "source-123",
            "log": "Crawl completed successfully"
        })
        
        assert tracker.state["status"] == "completed"
        assert tracker.state["progress"] == 100
        assert tracker.state["chunks_stored"] == 100
        assert tracker.state["source_id"] == "source-123"
        assert "end_time" in tracker.state
        assert "duration" in tracker.state
        
    @pytest.mark.asyncio
    async def test_error(self):
        """Test marking progress as error"""
        tracker = ProgressTracker("test-error", operation_type="crawl")
        
        await tracker.error(
            "Failed to connect to URL",
            error_details={"code": 404, "url": "https://example.com"}
        )
        
        assert tracker.state["status"] == "error"
        assert tracker.state["error"] == "Failed to connect to URL"
        assert tracker.state["error_details"]["code"] == 404
        assert "error_time" in tracker.state
        
    @pytest.mark.asyncio
    async def test_update_crawl_stats(self):
        """Test updating crawl statistics"""
        tracker = ProgressTracker("test-crawl-stats", operation_type="crawl")
        
        await tracker.update_crawl_stats(
            processed_pages=5,
            total_pages=10,
            current_url="https://example.com/page5",
            pages_found=15
        )
        
        assert tracker.state["status"] == "crawling"
        assert tracker.state["progress"] == 50  # 5/10 = 50%
        assert tracker.state["processed_pages"] == 5
        assert tracker.state["total_pages"] == 10
        assert tracker.state["current_url"] == "https://example.com/page5"
        assert tracker.state["pages_found"] == 15
        
    @pytest.mark.asyncio
    async def test_update_storage_progress(self):
        """Test updating storage progress"""
        tracker = ProgressTracker("test-storage", operation_type="crawl")
        
        await tracker.update_storage_progress(
            chunks_stored=25,
            total_chunks=100,
            operation="Storing embeddings",
            word_count=5000,
            embeddings_created=25
        )
        
        assert tracker.state["status"] == "document_storage"
        assert tracker.state["progress"] == 25  # 25/100 = 25%
        assert tracker.state["chunks_stored"] == 25
        assert tracker.state["total_chunks"] == 100
        assert tracker.state["word_count"] == 5000
        assert tracker.state["embeddings_created"] == 25
        
    @pytest.mark.asyncio
    async def test_update_code_extraction_progress(self):
        """Test updating code extraction progress"""
        tracker = ProgressTracker("test-code", operation_type="crawl")
        
        await tracker.update_code_extraction_progress(
            completed_summaries=3,
            total_summaries=10,
            code_blocks_found=15,
            current_file="main.py"
        )
        
        assert tracker.state["status"] == "code_extraction"
        assert tracker.state["progress"] == 30  # 3/10 = 30%
        assert tracker.state["completed_summaries"] == 3
        assert tracker.state["total_summaries"] == 10
        assert tracker.state["code_blocks_found"] == 15
        assert tracker.state["current_file"] == "main.py"
        
    @pytest.mark.asyncio
    async def test_update_batch_progress(self):
        """Test updating batch progress"""
        tracker = ProgressTracker("test-batch", operation_type="upload")
        
        await tracker.update_batch_progress(
            current_batch=3,
            total_batches=5,
            batch_size=100,
            message="Processing batch 3 of 5"
        )
        
        assert tracker.state["status"] == "processing_batch"
        assert tracker.state["progress"] == 60  # 3/5 = 60%
        assert tracker.state["current_batch"] == 3
        assert tracker.state["total_batches"] == 5
        assert tracker.state["batch_size"] == 100
        
    def test_multiple_trackers(self):
        """Test multiple progress trackers don't interfere"""
        tracker1 = ProgressTracker("tracker-1", operation_type="crawl")
        tracker2 = ProgressTracker("tracker-2", operation_type="upload")
        
        # Both should exist independently
        assert ProgressTracker.get_progress("tracker-1") is not None
        assert ProgressTracker.get_progress("tracker-2") is not None
        
        # They should have different types
        assert ProgressTracker.get_progress("tracker-1")["type"] == "crawl"
        assert ProgressTracker.get_progress("tracker-2")["type"] == "upload"
        
        # Clearing one shouldn't affect the other
        ProgressTracker.clear_progress("tracker-1")
        assert ProgressTracker.get_progress("tracker-1") is None
        assert ProgressTracker.get_progress("tracker-2") is not None