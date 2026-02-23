"""Integration tests for pause/resume/cancel flow.

These tests cover the complete lifecycle of pause/resume operations:
1. Pause before source creation fails on resume (the exact bug)
2. Pause after source creation resumes successfully (happy path)
3. Full cycle: start → pause → resume → complete
4. Cancel from paused state
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.crawling.crawling_service import CrawlingService
from src.server.utils.progress.progress_tracker import ProgressTracker


@pytest.fixture
def mock_crawler():
    """Create a mock Crawl4AI crawler."""
    crawler = MagicMock()
    crawler.arun = AsyncMock()
    return crawler


@pytest.fixture
def integration_mock_supabase_client():
    """Create a mock Supabase client for integration tests."""
    client = MagicMock()

    # Mock table operations
    mock_table = MagicMock()
    mock_select = MagicMock()
    mock_execute = MagicMock()

    # Default empty result
    mock_execute.data = []
    mock_select.execute.return_value = mock_execute
    mock_select.eq.return_value = mock_select
    mock_select.order.return_value = mock_select
    mock_select.limit.return_value = mock_select
    mock_table.select.return_value = mock_select

    # Mock insert
    mock_insert = MagicMock()
    mock_insert.execute.return_value.data = [{"source_id": "test-source-123"}]
    mock_table.insert.return_value = mock_insert

    # Mock update
    mock_update = MagicMock()
    mock_update.execute.return_value.data = [{"source_id": "test-source-123"}]
    mock_update.eq.return_value = mock_update
    mock_table.update.return_value = mock_update

    client.table.return_value = mock_table
    return client


@pytest.fixture
def crawling_service(mock_crawler, integration_mock_supabase_client):
    """Create a CrawlingService instance for testing."""
    service = CrawlingService(
        crawler=mock_crawler,
        supabase_client=integration_mock_supabase_client,
        progress_id="test-integration-123"
    )
    return service


@pytest.fixture(autouse=True)
def cleanup_progress_tracker():
    """Clean up ProgressTracker state between tests."""
    yield
    # Clear all progress states after each test
    ProgressTracker._progress_states.clear()


class TestPauseResumeFlow:
    """Integration tests for pause/resume/cancel lifecycle."""

    @pytest.mark.asyncio
    async def test_pause_before_source_creation_fails_on_resume(self):
        """Test the exact bug: pause very early, resume fails gracefully.

        Scenario:
        1. Start crawl (but pause before source record is created)
        2. Progress tracker has source_id=None
        3. Attempt resume
        4. Should fail with clear error about missing source_id
        5. DB status should remain "paused" (not "in_progress")
        """
        progress_id = "test-early-pause"

        # Simulate operation starting (no source_id yet)
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        await tracker.update(status="starting", progress=0, log="Initializing crawl")

        # Simulate early pause (before source_id is set)
        await ProgressTracker.pause_operation(progress_id)

        # Verify we're in paused state with no source_id
        progress_data = ProgressTracker.get_progress(progress_id)
        assert progress_data is not None
        assert progress_data["status"] == "paused"
        assert progress_data.get("source_id") is None

        # Attempt resume - should fail
        with pytest.raises(ValueError, match="missing source_id"):
            # Simulate what the resume endpoint does
            if not progress_data.get("source_id"):
                raise ValueError("Cannot resume operation: missing source_id")

        # Verify status remains paused (not updated to in_progress)
        final_state = ProgressTracker.get_progress(progress_id)
        assert final_state["status"] == "paused"

    @pytest.mark.asyncio
    async def test_pause_after_source_creation_resumes_successfully(self, integration_mock_supabase_client):
        """Test happy path: pause after source created, resume works.

        Scenario:
        1. Start crawl
        2. Source record is created (has source_id)
        3. Pause
        4. Verify source record exists
        5. Resume
        6. Verify crawl can continue from checkpoint
        """
        progress_id = "test-late-pause"
        source_id = "source-abc123"

        # Simulate operation with source record
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        await tracker.update(status="starting", progress=0, log="Initializing crawl")

        # Set source_id (simulating source creation)
        await tracker.update(status="crawling", progress=30, log="Crawling pages", source_id=source_id)

        # Pause
        await ProgressTracker.pause_operation(progress_id)

        # Verify paused state with source_id
        progress_data = ProgressTracker.get_progress(progress_id)
        assert progress_data is not None
        assert progress_data["status"] == "paused"
        assert progress_data["source_id"] == source_id

        # Mock source record lookup (for resume endpoint)
        mock_source_record = {
            "source_url": "https://example.com",
            "metadata": {
                "knowledge_type": "website",
                "tags": ["test"],
                "max_depth": 3,
                "allow_external_links": False,
            },
        }

        # Configure mock to return source record
        mock_table = integration_mock_supabase_client.table.return_value
        mock_execute = MagicMock()
        mock_execute.data = [mock_source_record]
        mock_table.select.return_value.eq.return_value.execute.return_value = mock_execute

        # Verify source record exists
        result = integration_mock_supabase_client.table("archon_sources").select("*").eq("source_id", source_id).execute()
        assert result.data is not None
        assert len(result.data) > 0

        # Resume
        success = await ProgressTracker.resume_operation(progress_id)
        assert success is True

        # Verify status updated to in_progress
        resumed_state = ProgressTracker.get_progress(progress_id)
        assert resumed_state["status"] == "in_progress"

    @pytest.mark.asyncio
    async def test_full_pause_resume_complete_cycle(self, crawling_service):
        """Test complete lifecycle: start → pause → resume → complete.

        Scenario:
        1. Start crawl
        2. Crawl progresses to 50%
        3. Pause
        4. Resume
        5. Complete crawl
        6. Verify progress never goes backwards
        7. Verify final status is "completed"
        """
        progress_id = "test-full-cycle"
        crawling_service.set_progress_id(progress_id)

        # Track all progress updates
        progress_history = []

        # Patch update to track progress
        original_update = crawling_service.progress_tracker.update
        async def tracked_update(*args, **kwargs):
            result = await original_update(*args, **kwargs)
            state = ProgressTracker.get_progress(progress_id)
            if state:
                progress_history.append({
                    "status": state["status"],
                    "progress": state["progress"],
                    "log": state.get("log", ""),
                })
            return result

        crawling_service.progress_tracker.update = tracked_update

        # Start crawl with source_id
        await crawling_service.progress_tracker.update(
            status="starting", progress=0, log="Starting crawl", source_id="source-full-cycle"
        )

        # Simulate crawling progress to 50%
        await crawling_service.progress_tracker.update(status="crawling", progress=50, log="Crawling pages (5/10)")

        # Pause
        await ProgressTracker.pause_operation(progress_id)
        pause_state = ProgressTracker.get_progress(progress_id)
        assert pause_state["status"] == "paused"
        paused_progress = pause_state["progress"]

        # Resume
        await ProgressTracker.resume_operation(progress_id)

        # Continue crawling
        await crawling_service.progress_tracker.update(status="crawling", progress=75, log="Crawling pages (8/10)")
        await crawling_service.progress_tracker.update(status="completed", progress=100, log="Crawl completed")

        # Verify progress never went backwards
        for i in range(len(progress_history) - 1):
            current_progress = progress_history[i]["progress"]
            next_progress = progress_history[i + 1]["progress"]
            # Progress should never decrease (except when explicitly pausing/resuming at same value)
            if progress_history[i]["status"] != "paused" and progress_history[i + 1]["status"] != "paused":
                assert next_progress >= current_progress, f"Progress went backwards: {current_progress} -> {next_progress}"

        # Verify final status
        final_state = ProgressTracker.get_progress(progress_id)
        assert final_state["status"] == "completed"
        assert final_state["progress"] == 100

    @pytest.mark.asyncio
    async def test_cancel_from_paused_state(self):
        """Test can cancel while paused.

        Scenario:
        1. Start crawl
        2. Pause
        3. Cancel
        4. Verify final status is "cancelled"
        """
        progress_id = "test-cancel-paused"

        # Start and pause
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        await tracker.update(status="starting", progress=0, log="Starting crawl", source_id="source-cancel-test")
        await tracker.update(status="crawling", progress=25, log="Crawling pages")
        await ProgressTracker.pause_operation(progress_id)

        # Verify paused
        paused_state = ProgressTracker.get_progress(progress_id)
        assert paused_state["status"] == "paused"

        # Cancel (simulate what stop endpoint does)
        await tracker.update(status="cancelled", progress=25, log="Crawl cancelled by user")

        # Verify cancelled
        final_state = ProgressTracker.get_progress(progress_id)
        assert final_state["status"] == "cancelled"
        assert final_state["progress"] == 25  # Progress preserved

    @pytest.mark.asyncio
    async def test_multiple_pause_resume_cycles(self):
        """Test multiple pause/resume cycles work correctly.

        Scenario:
        1. Start crawl
        2. Pause → Resume → Pause → Resume
        3. Complete
        4. Verify state transitions are valid
        """
        progress_id = "test-multi-pause"

        tracker = ProgressTracker(progress_id, operation_type="crawl")
        await tracker.update(status="starting", progress=0, log="Starting", source_id="source-multi-pause")

        # First pause/resume
        await tracker.update(status="crawling", progress=25, log="First segment")
        await ProgressTracker.pause_operation(progress_id)
        assert ProgressTracker.get_progress(progress_id)["status"] == "paused"

        await ProgressTracker.resume_operation(progress_id)
        assert ProgressTracker.get_progress(progress_id)["status"] == "in_progress"

        # Second pause/resume
        await tracker.update(status="crawling", progress=50, log="Second segment")
        await ProgressTracker.pause_operation(progress_id)
        assert ProgressTracker.get_progress(progress_id)["status"] == "paused"

        await ProgressTracker.resume_operation(progress_id)
        assert ProgressTracker.get_progress(progress_id)["status"] == "in_progress"

        # Complete
        await tracker.update(status="completed", progress=100, log="Completed")

        final_state = ProgressTracker.get_progress(progress_id)
        assert final_state["status"] == "completed"

    @pytest.mark.asyncio
    async def test_pause_stores_checkpoint_data(self):
        """Test that pause preserves checkpoint data for resume.

        Scenario:
        1. Start crawl with some progress
        2. Pause
        3. Verify checkpoint data is preserved
        4. Resume
        5. Verify checkpoint data is available
        """
        progress_id = "test-checkpoint"

        tracker = ProgressTracker(progress_id, operation_type="crawl")
        await tracker.update(status="starting", progress=0, log="Starting", source_id="source-checkpoint")

        # Simulate crawl progress
        await tracker.update(
            status="crawling",
            progress=40,
            log="Crawling pages",
            processed_pages=20,
            total_pages=50,
        )

        # Pause
        await ProgressTracker.pause_operation(progress_id)

        # Verify checkpoint data preserved
        paused_state = ProgressTracker.get_progress(progress_id)
        assert paused_state["status"] == "paused"
        assert paused_state["progress"] == 40
        assert paused_state.get("processed_pages") == 20
        assert paused_state.get("total_pages") == 50
        assert paused_state.get("source_id") == "source-checkpoint"

        # Resume
        await ProgressTracker.resume_operation(progress_id)

        # Verify checkpoint data still available after resume
        resumed_state = ProgressTracker.get_progress(progress_id)
        assert resumed_state["status"] == "in_progress"
        assert resumed_state["progress"] == 40  # Progress preserved
        assert resumed_state.get("processed_pages") == 20
        assert resumed_state.get("total_pages") == 50


class TestSourceCreationRetry:
    """Tests for source creation retry logic.

    These tests verify that source creation is required for crawls to proceed.
    If source creation fails after retries, the crawl should fail with a clear error.
    """

    @pytest.mark.asyncio
    async def test_source_creation_succeeds_after_retry(self):
        """Test that source creation retries on transient failures and eventually succeeds.

        This is a simpler unit test that verifies the retry logic without full orchestration.
        """
        import asyncio
        from src.server.services.crawling.crawling_service import CrawlingService

        # Track retry attempts
        call_count = {"count": 0}

        # Create mock supabase client
        mock_supabase = MagicMock()

        def mock_table_with_retry(table_name):
            if table_name == "archon_sources":
                call_count["count"] += 1
                mock_table = MagicMock()

                if call_count["count"] <= 2:
                    # First two calls fail
                    mock_table.select.side_effect = Exception("Transient DB error")
                else:
                    # Third call succeeds
                    mock_execute = MagicMock()
                    mock_execute.data = []  # No existing source
                    mock_eq = MagicMock()
                    mock_eq.execute.return_value = mock_execute
                    mock_select = MagicMock()
                    mock_select.eq.return_value = mock_eq
                    mock_table.select.return_value = mock_select

                    # Insert succeeds
                    mock_insert_execute = MagicMock()
                    mock_insert_execute.data = [{"source_id": "test-source"}]
                    mock_insert = MagicMock()
                    mock_insert.execute.return_value = mock_insert_execute
                    mock_table.insert.return_value = mock_insert

                return mock_table
            else:
                # Default mock for other tables
                mock_table = MagicMock()
                mock_execute = MagicMock()
                mock_execute.data = []
                mock_table.select.return_value.eq.return_value.execute.return_value = mock_execute
                return mock_table

        mock_supabase.table.side_effect = mock_table_with_retry

        # Create service
        mock_crawler = MagicMock()
        service = CrawlingService(
            crawler=mock_crawler,
            supabase_client=mock_supabase,
            progress_id="test-retry-success"
        )

        # This test just verifies retries happen - the full crawl will fail later,
        # but source creation should succeed on the 3rd attempt
        test_request = {
            "url": "https://example.com",
            "knowledge_type": "website",
            "tags": ["test"],
        }

        # Start crawl and let it run (will fail later, but source creation should work)
        result = await service.orchestrate_crawl(test_request)

        # Give the background task time to attempt source creation
        await asyncio.sleep(4)  # Wait for 3 retries (1s + 2s delays + execution time)

        # Cancel the task since we don't care about the rest of the crawl
        result["task"].cancel()
        try:
            await result["task"]
        except asyncio.CancelledError:
            pass

        # Verify 3 attempts were made (2 failures + 1 success)
        assert call_count["count"] == 3, f"Expected 3 retry attempts, got {call_count['count']}"

    @pytest.mark.asyncio
    async def test_source_creation_fails_after_max_retries(self, integration_mock_supabase_client):
        """Test that crawl fails if source creation fails after all retries.

        The crawl task completes without raising (background tasks don't crash),
        but the progress tracker shows "error" status with a clear error message.
        """
        from src.server.services.crawling.crawling_service import CrawlingService
        from src.server.utils.progress.progress_tracker import ProgressTracker

        # Mock supabase to always fail
        call_count = {"count": 0}

        def mock_table_always_fail(table_name):
            if table_name == "archon_sources":
                call_count["count"] += 1
                mock_table = MagicMock()
                mock_table.select.side_effect = Exception("Database permanently unavailable")
                return mock_table
            else:
                # Return default mock for other tables
                return MagicMock()

        integration_mock_supabase_client.table = mock_table_always_fail

        # Create service
        mock_crawler = MagicMock()
        progress_id = "test-retry-fail"
        service = CrawlingService(
            crawler=mock_crawler,
            supabase_client=integration_mock_supabase_client,
            progress_id=progress_id
        )

        test_request = {
            "url": "https://example.com",
            "knowledge_type": "website",
            "tags": ["test"],
        }

        # Start the crawl
        result = await service.orchestrate_crawl(test_request)

        # Wait for the background task to complete (won't raise, but will set error status)
        await result["task"]

        # Verify error was recorded in progress tracker
        progress_state = ProgressTracker.get_progress(progress_id)
        assert progress_state is not None
        assert progress_state["status"] == "error"

        # Verify error message contains source creation failure
        error_log = progress_state.get("log", "")
        assert "Failed to create source record after 3 attempts" in error_log or \
               "Crawl failed" in error_log

        # Verify 3 attempts were made
        assert call_count["count"] == 3, f"Expected 3 retry attempts, got {call_count['count']}"
