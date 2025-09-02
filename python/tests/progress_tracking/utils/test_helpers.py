"""Test helpers and fixtures for progress tracking tests."""

import asyncio
from unittest.mock import AsyncMock, MagicMock
from typing import Any, Dict, List, Optional, Callable

import pytest

from src.server.utils.progress.progress_tracker import ProgressTracker
from src.server.services.crawling.progress_mapper import ProgressMapper


@pytest.fixture
def mock_progress_tracker():
    """Create a mock progress tracker for testing."""
    tracker = MagicMock(spec=ProgressTracker)
    tracker.progress_id = "test-progress-id"
    tracker.state = {
        "progress_id": "test-progress-id",
        "type": "crawl",
        "start_time": "2024-01-01T00:00:00",
        "status": "initializing",
        "progress": 0,
        "logs": [],
    }
    
    # Mock async methods
    tracker.start = AsyncMock()
    tracker.update = AsyncMock()
    tracker.complete = AsyncMock()
    tracker.error = AsyncMock()
    tracker.update_batch_progress = AsyncMock()
    
    # Mock class methods
    tracker.get_progress = MagicMock(return_value=tracker.state)
    tracker.clear_progress = MagicMock()
    
    return tracker


@pytest.fixture
def progress_mapper():
    """Create a real progress mapper for testing."""
    return ProgressMapper()


@pytest.fixture  
def sample_progress_data():
    """Sample progress data for testing."""
    return {
        "progress_id": "test-123",
        "type": "crawl",
        "status": "document_storage",
        "progress": 50,
        "message": "Processing batch 3/6",
        "current_batch": 3,
        "total_batches": 6,
        "completed_batches": 2,
        "chunks_in_batch": 25,
        "max_workers": 4,
        "total_pages": 60,
        "processed_pages": 60,
        "logs": [
            "Starting crawl",
            "Analyzing URL", 
            "Crawling pages",
            "Processing batch 1/6",
            "Processing batch 2/6",
            "Processing batch 3/6"
        ]
    }


@pytest.fixture
def mock_progress_callback():
    """Create a mock progress callback for testing."""
    callback = AsyncMock()
    callback.call_history = []
    
    async def track_calls(*args, **kwargs):
        callback.call_history.append((args, kwargs))
        return await callback(*args, **kwargs)
    
    callback.side_effect = track_calls
    return callback


class ProgressTestHelper:
    """Helper class for testing progress tracking functionality."""
    
    @staticmethod
    def assert_progress_update(
        tracker_mock: MagicMock,
        expected_status: str,
        expected_progress: int,
        expected_message: str,
        expected_kwargs: Optional[Dict[str, Any]] = None
    ):
        """Assert that progress tracker was updated with expected values."""
        tracker_mock.update.assert_called()
        call_args = tracker_mock.update.call_args
        
        assert call_args[1]["status"] == expected_status
        assert call_args[1]["progress"] == expected_progress
        assert call_args[1]["log"] == expected_message
        
        if expected_kwargs:
            for key, value in expected_kwargs.items():
                assert call_args[1][key] == value
    
    @staticmethod
    def assert_batch_progress(
        callback_mock: AsyncMock,
        expected_current_batch: int,
        expected_total_batches: int,
        expected_completed_batches: int
    ):
        """Assert that batch progress was reported correctly."""
        found_batch_call = False
        for call_args, call_kwargs in callback_mock.call_history:
            if "current_batch" in call_kwargs:
                assert call_kwargs["current_batch"] == expected_current_batch
                assert call_kwargs["total_batches"] == expected_total_batches  
                assert call_kwargs["completed_batches"] == expected_completed_batches
                found_batch_call = True
                break
        
        assert found_batch_call, "No batch progress call found in callback history"
    
    @staticmethod
    def create_crawl_results(count: int = 5) -> List[Dict[str, Any]]:
        """Create sample crawl results for testing."""
        return [
            {
                "url": f"https://example.com/page{i}",
                "markdown": f"# Page {i}\n\nThis is content for page {i}.",
                "title": f"Page {i}",
                "description": f"Description for page {i}"
            }
            for i in range(1, count + 1)
        ]
    
    @staticmethod
    def simulate_progress_sequence() -> List[Dict[str, Any]]:
        """Create a realistic progress sequence for testing."""
        return [
            {"status": "starting", "progress": 0, "message": "Initializing crawl"},
            {"status": "analyzing", "progress": 1, "message": "Analyzing URL"},
            {"status": "crawling", "progress": 3, "message": "Crawling 60 pages"},
            {"status": "processing", "progress": 6, "message": "Processing content"},
            {"status": "source_creation", "progress": 9, "message": "Creating source"},
            {"status": "document_storage", "progress": 15, "message": "Processing batch 1/6"},
            {"status": "document_storage", "progress": 20, "message": "Processing batch 2/6"},
            {"status": "document_storage", "progress": 25, "message": "Processing batch 3/6"},
            {"status": "code_extraction", "progress": 60, "message": "Extracting code examples"},
            {"status": "finalization", "progress": 97, "message": "Finalizing results"},
            {"status": "completed", "progress": 100, "message": "Crawl completed"}
        ]


@pytest.fixture
def progress_test_helper():
    """Provide the ProgressTestHelper class as a fixture."""
    return ProgressTestHelper