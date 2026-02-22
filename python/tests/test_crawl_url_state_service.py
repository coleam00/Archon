"""
Unit tests for CrawlUrlStateService.

Tests the checkpoint/resume URL state tracking service.
"""

from unittest.mock import MagicMock, patch

import pytest


def create_mock_client():
    """Create a mock Supabase client with proper chaining."""
    mock_client = MagicMock()

    mock_table = MagicMock()
    mock_select = MagicMock()
    mock_upsert = MagicMock()
    mock_update = MagicMock()
    mock_delete = MagicMock()

    mock_select.execute.return_value = MagicMock(data=[])
    mock_select.eq.return_value = mock_select
    mock_select.match.return_value = mock_select

    mock_upsert.execute.return_value = MagicMock(data=[])
    mock_upsert.on_conflict.return_value = mock_upsert

    mock_update.execute.return_value = MagicMock(data=[])
    mock_update.match.return_value = mock_update

    mock_delete.execute.return_value = MagicMock(data=[])
    mock_delete.match.return_value = mock_delete

    mock_table.select.return_value = mock_select
    mock_table.upsert.return_value = mock_upsert
    mock_table.update.return_value = mock_update
    mock_table.delete.return_value = mock_delete

    mock_client.table.return_value = mock_table

    return mock_client


@pytest.fixture
def mock_client():
    """Create a fresh mock client for each test."""
    return create_mock_client()


@pytest.fixture
def url_state_service(mock_client):
    """Create CrawlUrlStateService with mock client."""
    from src.server.services.crawling.crawl_url_state_service import CrawlUrlStateService

    service = CrawlUrlStateService(supabase_client=mock_client)
    return service


class TestInitializeUrls:
    """Tests for initialize_urls method."""

    def test_initializes_empty_list_returns_zero(self, url_state_service, mock_client):
        """Empty URL list returns zero counts."""
        result = url_state_service.initialize_urls("source-1", [])

        assert result == {"inserted": 0, "skipped": 0}
        mock_client.table.assert_not_called()

    def test_initializes_urls_as_pending(self, url_state_service, mock_client):
        """URLs are initialized with pending status."""
        urls = ["https://example.com/page1", "https://example.com/page2"]

        mock_result = MagicMock()
        mock_result.data = [{"url": urls[0]}, {"url": urls[1]}]
        mock_client.table.return_value.upsert.return_value.execute.return_value = mock_result

        result = url_state_service.initialize_urls("source-1", urls)

        assert result["inserted"] == 2
        assert result["skipped"] == 0

        call_args = mock_client.table.return_value.upsert.call_args
        records = call_args[0][0]

        assert len(records) == 2
        assert all(r["status"] == "pending" for r in records)
        assert all(r["source_id"] == "source-1" for r in records)

    def test_skips_existing_urls(self, url_state_service, mock_client):
        """Existing URLs are skipped (not duplicated)."""
        urls = ["https://example.com/page1", "https://example.com/page2"]

        mock_result = MagicMock()
        mock_result.data = [{"url": urls[0]}]  # Only one inserted
        mock_client.table.return_value.upsert.return_value.execute.return_value = mock_result

        result = url_state_service.initialize_urls("source-1", urls)

        assert result["inserted"] == 1
        assert result["skipped"] == 1


class TestMarkFetched:
    """Tests for mark_fetched method."""

    def test_marks_url_as_fetched(self, url_state_service, mock_client):
        """URL status is updated to fetched."""
        result = url_state_service.mark_fetched("source-1", "https://example.com/page1")

        assert result is True

        mock_client.table.return_value.update.assert_called()
        call_args = mock_client.table.return_value.update.call_args
        assert call_args[0][0]["status"] == "fetched"

    def test_mark_fetched_returns_false_on_error(self, url_state_service, mock_client):
        """Returns False when update fails."""
        mock_client.table.return_value.update.return_value.match.return_value.execute.side_effect = Exception(
            "DB error"
        )

        result = url_state_service.mark_fetched("source-1", "https://example.com/page1")

        assert result is False


class TestMarkEmbedded:
    """Tests for mark_embedded method."""

    def test_marks_url_as_embedded(self, url_state_service, mock_client):
        """URL status is updated to embedded."""
        result = url_state_service.mark_embedded("source-1", "https://example.com/page1")

        assert result is True

        mock_client.table.return_value.update.assert_called()
        call_args = mock_client.table.return_value.update.call_args
        assert call_args[0][0]["status"] == "embedded"


class TestMarkFailed:
    """Tests for mark_failed method."""

    def test_marks_url_as_failed_after_max_retries(self, url_state_service, mock_client):
        """URL marked as failed after exceeding max retries."""
        mock_select_result = MagicMock()
        mock_select_result.data = [{"retry_count": 3, "max_retries": 3}]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_select_result

        result = url_state_service.mark_failed("source-1", "https://example.com/page1", "Connection timeout")

        assert result is True

        update_call = mock_client.table.return_value.update.return_value.match.return_value
        update_call.execute.assert_called()

    def test_increments_retry_count_below_max(self, url_state_service, mock_client):
        """Retry count incremented when under max retries."""
        mock_select_result = MagicMock()
        mock_select_result.data = [{"retry_count": 1, "max_retries": 3}]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_select_result

        result = url_state_service.mark_failed("source-1", "https://example.com/page1", "Connection timeout")

        assert result is True

        update_call = mock_client.table.return_value.update.return_value.match.return_value
        update_call.execute.assert_called()

    def test_returns_false_when_url_not_found(self, url_state_service, mock_client):
        """Returns False when URL doesn't exist in state."""
        mock_select_result = MagicMock()
        mock_select_result.data = []
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_select_result

        result = url_state_service.mark_failed("source-1", "https://example.com/nonexistent", "Error")

        assert result is False


class TestGetUrlsByStatus:
    """Tests for get_*_urls methods."""

    def test_get_pending_urls(self, url_state_service, mock_client):
        """Returns list of pending URLs."""
        mock_result = MagicMock()
        mock_result.data = [
            {"url": "https://example.com/page1"},
            {"url": "https://example.com/page2"},
        ]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        urls = url_state_service.get_pending_urls("source-1")

        assert urls == ["https://example.com/page1", "https://example.com/page2"]

    def test_get_fetched_urls(self, url_state_service, mock_client):
        """Returns list of fetched URLs."""
        mock_result = MagicMock()
        mock_result.data = [{"url": "https://example.com/page1"}]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        urls = url_state_service.get_fetched_urls("source-1")

        assert urls == ["https://example.com/page1"]

    def test_get_embedded_urls(self, url_state_service, mock_client):
        """Returns list of embedded URLs."""
        mock_result = MagicMock()
        mock_result.data = [
            {"url": "https://example.com/page1"},
            {"url": "https://example.com/page2"},
            {"url": "https://example.com/page3"},
        ]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        urls = url_state_service.get_embedded_urls("source-1")

        assert urls == [
            "https://example.com/page1",
            "https://example.com/page2",
            "https://example.com/page3",
        ]

    def test_get_failed_urls(self, url_state_service, mock_client):
        """Returns list of failed URLs."""
        mock_result = MagicMock()
        mock_result.data = [{"url": "https://example.com/broken"}]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        urls = url_state_service.get_failed_urls("source-1")

        assert urls == ["https://example.com/broken"]

    def test_returns_empty_list_on_error(self, url_state_service, mock_client):
        """Returns empty list when query fails."""
        mock_client.table.return_value.select.return_value.match.return_value.execute.side_effect = Exception(
            "DB error"
        )

        urls = url_state_service.get_pending_urls("source-1")

        assert urls == []


class TestGetCrawlState:
    """Tests for get_crawl_state method."""

    def test_returns_state_counts(self, url_state_service, mock_client):
        """Returns counts for each status."""
        mock_result = MagicMock()
        mock_result.data = [
            {"status": "pending"},
            {"status": "pending"},
            {"status": "fetched"},
            {"status": "embedded"},
            {"status": "embedded"},
            {"status": "embedded"},
            {"status": "failed"},
        ]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        state = url_state_service.get_crawl_state("source-1")

        assert state["pending"] == 2
        assert state["fetched"] == 1
        assert state["embedded"] == 3
        assert state["failed"] == 1
        assert state["total"] == 7

    def test_returns_zero_counts_when_no_data(self, url_state_service, mock_client):
        """Returns zero counts when no URLs tracked."""
        mock_result = MagicMock()
        mock_result.data = []
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        state = url_state_service.get_crawl_state("source-1")

        assert state["pending"] == 0
        assert state["fetched"] == 0
        assert state["embedded"] == 0
        assert state["failed"] == 0
        assert state["total"] == 0


class TestHasExistingState:
    """Tests for has_existing_state method."""

    def test_returns_true_when_state_exists(self, url_state_service, mock_client):
        """Returns True when URLs exist for source."""
        mock_result = MagicMock()
        mock_result.count = 5
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        assert url_state_service.has_existing_state("source-1") is True

    def test_returns_false_when_no_state(self, url_state_service, mock_client):
        """Returns False when no URLs exist for source."""
        mock_result = MagicMock()
        mock_result.count = 0
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_result

        assert url_state_service.has_existing_state("source-1") is False


class TestClearState:
    """Tests for clear_state method."""

    def test_clears_all_urls_for_source(self, url_state_service, mock_client):
        """Deletes all URL state for a source."""
        result = url_state_service.clear_state("source-1")

        assert result is True
        mock_client.table.return_value.delete.return_value.match.return_value.execute.assert_called()

    def test_returns_false_on_delete_error(self, url_state_service, mock_client):
        """Returns False when delete fails."""
        mock_client.table.return_value.delete.return_value.match.return_value.execute.side_effect = Exception(
            "DB error"
        )

        result = url_state_service.clear_state("source-1")

        assert result is False


class TestStateTransitionLogic:
    """Tests for URL state transition logic."""

    def test_pending_to_fetched_transition(self, url_state_service):
        """Verify mark_fetched updates status correctly."""
        source_id = "source-1"
        url = "https://example.com/page1"

        result = url_state_service.mark_fetched(source_id, url)

        assert result is True

    def test_fetched_to_embedded_transition(self, url_state_service):
        """Verify mark_embedded updates status correctly."""
        source_id = "source-1"
        url = "https://example.com/page1"

        result = url_state_service.mark_embedded(source_id, url)

        assert result is True

    def test_pending_to_failed_with_retry(self, url_state_service, mock_client):
        """Verify mark_failed handles retry logic correctly."""
        source_id = "source-1"
        url = "https://example.com/page1"

        mock_select_result = MagicMock()
        mock_select_result.data = [{"retry_count": 2, "max_retries": 3}]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_select_result

        result = url_state_service.mark_failed(source_id, url, "Connection error")

        assert result is True

    def test_pending_to_failed_permanent(self, url_state_service, mock_client):
        """Verify mark_failed permanently fails after max retries."""
        source_id = "source-1"
        url = "https://example.com/page1"

        mock_select_result = MagicMock()
        mock_select_result.data = [{"retry_count": 3, "max_retries": 3}]
        mock_client.table.return_value.select.return_value.match.return_value.execute.return_value = mock_select_result

        result = url_state_service.mark_failed(source_id, url, "Connection error")

        assert result is True
