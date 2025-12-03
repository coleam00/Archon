"""
Unit Tests for Re-Embed Service

Tests the bulk re-embedding service including:
- Batch size configuration from settings
- Start/stop functionality
- Cancellation support
- Progress tracking
- Statistics retrieval
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.re_embed_service import (
    ReEmbedService,
    active_re_embed_tasks,
)


class TestReEmbedServiceBatchSize:
    """Test suite for batch size configuration."""

    @pytest.mark.asyncio
    async def test_get_embedding_batch_size_from_settings(self):
        """Test that batch size is loaded from settings."""
        service = ReEmbedService(supabase_client=MagicMock())

        with patch(
            "src.server.services.re_embed_service.credential_service"
        ) as mock_cred:
            mock_cred.get_credentials_by_category = AsyncMock(
                return_value={"EMBEDDING_BATCH_SIZE": "150"}
            )

            result = await service._get_embedding_batch_size()

            assert result == 150
            mock_cred.get_credentials_by_category.assert_called_once_with("rag_strategy")

    @pytest.mark.asyncio
    async def test_get_embedding_batch_size_default(self):
        """Test default batch size when setting not found."""
        service = ReEmbedService(supabase_client=MagicMock())

        with patch(
            "src.server.services.re_embed_service.credential_service"
        ) as mock_cred:
            mock_cred.get_credentials_by_category = AsyncMock(return_value={})

            result = await service._get_embedding_batch_size()

            assert result == 100  # Default value

    @pytest.mark.asyncio
    async def test_get_embedding_batch_size_clamp_min(self):
        """Test that batch size is clamped to minimum 20."""
        service = ReEmbedService(supabase_client=MagicMock())

        with patch(
            "src.server.services.re_embed_service.credential_service"
        ) as mock_cred:
            mock_cred.get_credentials_by_category = AsyncMock(
                return_value={"EMBEDDING_BATCH_SIZE": "5"}
            )

            result = await service._get_embedding_batch_size()

            assert result == 20  # Minimum clamped value

    @pytest.mark.asyncio
    async def test_get_embedding_batch_size_clamp_max(self):
        """Test that batch size is clamped to maximum 200."""
        service = ReEmbedService(supabase_client=MagicMock())

        with patch(
            "src.server.services.re_embed_service.credential_service"
        ) as mock_cred:
            mock_cred.get_credentials_by_category = AsyncMock(
                return_value={"EMBEDDING_BATCH_SIZE": "500"}
            )

            result = await service._get_embedding_batch_size()

            assert result == 200  # Maximum clamped value

    @pytest.mark.asyncio
    async def test_get_embedding_batch_size_error_handling(self):
        """Test fallback to default on error."""
        service = ReEmbedService(supabase_client=MagicMock())

        with patch(
            "src.server.services.re_embed_service.credential_service"
        ) as mock_cred:
            mock_cred.get_credentials_by_category = AsyncMock(
                side_effect=Exception("Database error")
            )

            result = await service._get_embedding_batch_size()

            assert result == 100  # Default on error


class TestReEmbedServiceCancellation:
    """Test suite for cancellation functionality."""

    def test_is_cancelled_false_when_active(self):
        """Test _is_cancelled returns False when task is active."""
        service = ReEmbedService(supabase_client=MagicMock())
        progress_id = "test-progress-123"

        # Simulate active task
        active_re_embed_tasks[progress_id] = MagicMock()

        try:
            assert service._is_cancelled(progress_id) is False
        finally:
            # Cleanup
            del active_re_embed_tasks[progress_id]

    def test_is_cancelled_true_when_not_active(self):
        """Test _is_cancelled returns True when task is not in active_re_embed_tasks."""
        service = ReEmbedService(supabase_client=MagicMock())
        progress_id = "test-progress-456"

        # Ensure task is not in the dict
        if progress_id in active_re_embed_tasks:
            del active_re_embed_tasks[progress_id]

        assert service._is_cancelled(progress_id) is True

    @pytest.mark.asyncio
    async def test_stop_re_embed_active_task(self):
        """Test stopping an active re-embed task."""
        service = ReEmbedService(supabase_client=MagicMock())
        progress_id = "test-progress-789"

        # Create a mock task
        mock_task = MagicMock()
        mock_task.done.return_value = False
        mock_task.cancel = MagicMock()

        # Add to active tasks
        active_re_embed_tasks[progress_id] = mock_task

        with patch("src.server.services.re_embed_service.safe_logfire_info"):
            with patch("asyncio.wait_for", new_callable=AsyncMock):
                result = await service.stop_re_embed(progress_id)

        assert result is True
        assert progress_id not in active_re_embed_tasks
        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_stop_re_embed_nonexistent_task(self):
        """Test stopping a task that doesn't exist."""
        service = ReEmbedService(supabase_client=MagicMock())
        progress_id = "nonexistent-task"

        result = await service.stop_re_embed(progress_id)

        assert result is False

    @pytest.mark.asyncio
    async def test_stop_re_embed_already_done_task(self):
        """Test stopping an already completed task."""
        service = ReEmbedService(supabase_client=MagicMock())
        progress_id = "completed-task"

        # Create a mock task that is already done
        mock_task = MagicMock()
        mock_task.done.return_value = True

        active_re_embed_tasks[progress_id] = mock_task

        with patch("src.server.services.re_embed_service.safe_logfire_info"):
            result = await service.stop_re_embed(progress_id)

        assert result is True
        assert progress_id not in active_re_embed_tasks
        # cancel should not be called on a done task
        mock_task.cancel.assert_not_called()


class TestReEmbedServiceStart:
    """Test suite for start_re_embed functionality."""

    @pytest.mark.asyncio
    async def test_start_re_embed_returns_progress_id(self):
        """Test that start_re_embed returns a progress_id."""
        mock_client = MagicMock()
        service = ReEmbedService(supabase_client=mock_client)

        with patch(
            "src.server.services.re_embed_service.ProgressTracker"
        ) as mock_tracker_class:
            mock_tracker = MagicMock()
            mock_tracker.start = AsyncMock()
            mock_tracker_class.return_value = mock_tracker

            with patch.object(service, "_perform_re_embed", new_callable=AsyncMock):
                result = await service.start_re_embed()

        assert "progress_id" in result
        assert "message" in result
        assert result["message"] == "Re-embedding started"

        # Cleanup any active tasks
        progress_id = result["progress_id"]
        if progress_id in active_re_embed_tasks:
            del active_re_embed_tasks[progress_id]

    @pytest.mark.asyncio
    async def test_start_re_embed_creates_background_task(self):
        """Test that start_re_embed creates a background task."""
        mock_client = MagicMock()
        service = ReEmbedService(supabase_client=mock_client)

        with patch(
            "src.server.services.re_embed_service.ProgressTracker"
        ) as mock_tracker_class:
            mock_tracker = MagicMock()
            mock_tracker.start = AsyncMock()
            mock_tracker_class.return_value = mock_tracker

            with patch.object(service, "_perform_re_embed", new_callable=AsyncMock):
                result = await service.start_re_embed()
                progress_id = result["progress_id"]

                # Give the task a moment to be scheduled
                await asyncio.sleep(0.01)

                assert progress_id in active_re_embed_tasks

                # Cleanup
                if progress_id in active_re_embed_tasks:
                    del active_re_embed_tasks[progress_id]


class TestReEmbedServiceStats:
    """Test suite for get_re_embed_stats functionality."""

    @pytest.mark.asyncio
    async def test_get_re_embed_stats_success(self):
        """Test successful stats retrieval."""
        mock_client = MagicMock()

        # Mock count result
        mock_count_result = MagicMock()
        mock_count_result.count = 100

        # Mock models result
        mock_models_result = MagicMock()
        mock_models_result.data = [
            {"embedding_model": "text-embedding-3-small"},
            {"embedding_model": "text-embedding-3-small"},
            {"embedding_model": "nomic-embed-text"},
        ]

        # Setup chaining
        mock_table = MagicMock()
        mock_select = MagicMock()
        mock_select.execute.return_value = mock_models_result
        mock_select.order.return_value = mock_select

        # First call returns count, second returns models
        def table_side_effect(name):
            return mock_table

        mock_client.table.side_effect = table_side_effect

        # Setup the select chain for count
        mock_count_select = MagicMock()
        mock_count_select.execute.return_value = mock_count_result

        call_count = [0]
        def select_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_count_select
            return mock_select

        mock_table.select.side_effect = select_side_effect

        service = ReEmbedService(supabase_client=mock_client)

        result = await service.get_re_embed_stats()

        assert result["total_chunks"] == 100
        assert "text-embedding-3-small" in result["embedding_models_in_use"]
        assert "nomic-embed-text" in result["embedding_models_in_use"]

    @pytest.mark.asyncio
    async def test_get_re_embed_stats_empty_database(self):
        """Test stats with empty database."""
        mock_client = MagicMock()

        # Mock empty count result
        mock_count_result = MagicMock()
        mock_count_result.count = 0

        # Mock empty models result
        mock_models_result = MagicMock()
        mock_models_result.data = []

        # Setup chaining
        mock_table = MagicMock()
        mock_select = MagicMock()

        call_count = [0]
        def select_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                mock_select.execute.return_value = mock_count_result
            else:
                mock_select.execute.return_value = mock_models_result
            return mock_select

        mock_table.select.side_effect = select_side_effect
        mock_client.table.return_value = mock_table

        service = ReEmbedService(supabase_client=mock_client)

        result = await service.get_re_embed_stats()

        assert result["total_chunks"] == 0
        assert result["embedding_models_in_use"] == []

    @pytest.mark.asyncio
    async def test_get_re_embed_stats_error_handling(self):
        """Test stats with database error."""
        mock_client = MagicMock()
        mock_client.table.side_effect = Exception("Database connection failed")

        service = ReEmbedService(supabase_client=mock_client)

        with patch("src.server.services.re_embed_service.safe_logfire_error"):
            result = await service.get_re_embed_stats()

        assert result["total_chunks"] == 0
        assert result["embedding_models_in_use"] == []
        assert "error" in result


class TestReEmbedServicePerformReEmbed:
    """Test suite for _perform_re_embed functionality."""

    @pytest.mark.asyncio
    async def test_perform_re_embed_no_chunks(self):
        """Test re-embed with no chunks to process."""
        mock_client = MagicMock()

        # Mock empty result
        mock_result = MagicMock()
        mock_result.data = []

        mock_select = MagicMock()
        mock_select.order.return_value = mock_select
        mock_select.range.return_value = mock_select
        mock_select.execute.return_value = mock_result

        mock_table = MagicMock()
        mock_table.select.return_value = mock_select
        mock_client.table.return_value = mock_table

        service = ReEmbedService(supabase_client=mock_client)

        mock_tracker = MagicMock()
        mock_tracker.start = AsyncMock()
        mock_tracker.update = AsyncMock()
        mock_tracker.complete = AsyncMock()

        progress_id = "test-progress"
        active_re_embed_tasks[progress_id] = MagicMock()

        with patch("src.server.services.re_embed_service.get_embedding_model", new_callable=AsyncMock, return_value="test-model"):
            with patch("src.server.services.re_embed_service.safe_logfire_info"):
                await service._perform_re_embed(progress_id, mock_tracker)

        # Verify complete was called with 0 chunks
        mock_tracker.complete.assert_called_once()
        call_args = mock_tracker.complete.call_args
        assert call_args[0][0]["chunks_processed"] == 0

    @pytest.mark.asyncio
    async def test_perform_re_embed_respects_cancellation(self):
        """Test that re-embed stops when cancelled."""
        mock_client = MagicMock()

        # Mock some chunks
        mock_result = MagicMock()
        mock_result.data = [
            {"id": "1", "content": "test content 1", "url": "http://test.com", "chunk_number": 0, "source_id": "s1", "metadata": {}},
            {"id": "2", "content": "test content 2", "url": "http://test.com", "chunk_number": 1, "source_id": "s1", "metadata": {}},
        ]

        # First call returns data, subsequent calls return empty (end of pagination)
        call_count = [0]
        def mock_execute():
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_result
            empty_result = MagicMock()
            empty_result.data = []
            return empty_result

        mock_select = MagicMock()
        mock_select.order.return_value = mock_select
        mock_select.range.return_value = mock_select
        mock_select.execute.side_effect = mock_execute

        mock_table = MagicMock()
        mock_table.select.return_value = mock_select
        mock_client.table.return_value = mock_table

        service = ReEmbedService(supabase_client=mock_client)

        mock_tracker = MagicMock()
        mock_tracker.start = AsyncMock()
        mock_tracker.update = AsyncMock()
        mock_tracker.complete = AsyncMock()

        progress_id = "test-cancel-progress"
        # Don't add to active_re_embed_tasks - this simulates cancelled state

        with patch("src.server.services.re_embed_service.get_embedding_model", new_callable=AsyncMock, return_value="test-model"):
            with patch("src.server.services.re_embed_service.safe_logfire_info"):
                with patch.object(service, "_get_embedding_batch_size", new_callable=AsyncMock, return_value=100):
                    await service._perform_re_embed(progress_id, mock_tracker)

        # Verify cancellation status was set
        last_update_call = mock_tracker.update.call_args_list[-1]
        assert last_update_call.kwargs.get("status") == "cancelled"
