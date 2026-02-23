"""Tests for pause/resume/cancel API endpoints.

These tests cover critical bugs discovered during development:
1. Resume fails when source record doesn't exist (source created too late in pipeline)
2. Resume endpoint updates DB status BEFORE validating source exists
3. Cancel works for active operations but pause/resume are broken

Critical test cases:
- Pause endpoint: valid operations, non-existent operations, completed operations
- Resume endpoint: missing source_id, missing source record, valid resume
- Cancel endpoint: active operations, paused operations
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import status
from fastapi.testclient import TestClient

# Patch paths for imports done inside endpoint functions
PROGRESS_TRACKER_PATH = "src.server.utils.progress.progress_tracker.ProgressTracker"
GET_ACTIVE_ORCHESTRATION_PATH = "src.server.services.crawling.get_active_orchestration"
UNREGISTER_ORCHESTRATION_PATH = "src.server.services.crawling.unregister_orchestration"
GET_SUPABASE_PATH = "src.server.api_routes.knowledge_api.get_supabase_client"
GET_CRAWLER_PATH = "src.server.api_routes.knowledge_api.get_crawler"
CRAWLING_SERVICE_PATH = "src.server.api_routes.knowledge_api.CrawlingService"


@pytest.fixture
def client():
    """Create a test client for knowledge API."""
    from fastapi import FastAPI
    from src.server.api_routes.knowledge_api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def mock_active_crawl_operation():
    """Mock progress data for an active crawl operation."""
    return {
        "progress_id": "test-active-crawl",
        "type": "crawl",
        "status": "crawling",
        "progress": 35,
        "log": "Crawling pages (20/50)",
        "source_id": "source-abc123",
        "start_time": "2024-01-01T10:00:00",
    }


@pytest.fixture
def mock_paused_operation_no_source():
    """Mock operation paused too early, missing source_id.

    This represents the bug scenario where pause happens before source record is created.
    """
    return {
        "progress_id": "test-early-pause",
        "type": "crawl",
        "status": "paused",
        "progress": 5,
        "log": "Paused during initialization",
        "source_id": None,  # BUG SCENARIO: no source_id yet
        "start_time": "2024-01-01T10:00:00",
    }


@pytest.fixture
def mock_paused_operation_with_source():
    """Mock operation paused after source created (happy path)."""
    return {
        "progress_id": "test-late-pause",
        "type": "crawl",
        "status": "paused",
        "progress": 30,
        "log": "Paused at checkpoint",
        "source_id": "source-abc123",
        "start_time": "2024-01-01T10:00:00",
    }


@pytest.fixture
def mock_completed_operation():
    """Mock completed operation (cannot be paused)."""
    return {
        "progress_id": "test-completed",
        "type": "crawl",
        "status": "completed",
        "progress": 100,
        "log": "Crawl completed successfully",
        "source_id": "source-xyz789",
        "start_time": "2024-01-01T10:00:00",
    }


class TestPauseEndpoint:
    """Test cases for POST /knowledge-items/pause/{progress_id}."""

    @patch(GET_ACTIVE_ORCHESTRATION_PATH)
    @patch(PROGRESS_TRACKER_PATH)
    def test_pause_active_operation_success(
        self, mock_progress_tracker, mock_get_orchestration, client, mock_active_crawl_operation
    ):
        """Test pausing an active operation returns 200."""
        # Mock progress tracker to return active operation
        mock_progress_tracker.get_progress.return_value = mock_active_crawl_operation
        mock_progress_tracker.pause_operation = AsyncMock(return_value=True)

        # Mock orchestration
        mock_orchestration = MagicMock()
        mock_orchestration.pause = MagicMock()
        mock_get_orchestration.return_value = AsyncMock(return_value=mock_orchestration)

        # Make request
        response = client.post("/api/knowledge-items/pause/test-active-crawl")

        # Assertions
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["success"] is True
        assert "paused successfully" in data["message"].lower()
        assert data["progressId"] == "test-active-crawl"

    @patch(PROGRESS_TRACKER_PATH)
    def test_pause_nonexistent_operation_returns_404(self, mock_progress_tracker, client):
        """Test pausing non-existent operation returns 404."""
        # Mock progress tracker to return None (operation not found)
        mock_progress_tracker.get_progress.return_value = None

        # Make request
        response = client.post("/api/knowledge-items/pause/non-existent-id")

        # Assertions
        assert response.status_code == status.HTTP_404_NOT_FOUND
        data = response.json()
        assert "error" in data["detail"]
        assert "non-existent-id" in data["detail"]["error"]

    @patch(PROGRESS_TRACKER_PATH)
    def test_pause_completed_operation_returns_400(self, mock_progress_tracker, client, mock_completed_operation):
        """Test pausing completed operation returns 400."""
        # Mock progress tracker to return completed operation
        mock_progress_tracker.get_progress.return_value = mock_completed_operation

        # Make request
        response = client.post("/api/knowledge-items/pause/test-completed")

        # Assertions
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        data = response.json()
        assert "error" in data["detail"]
        assert "cannot pause" in data["detail"]["error"].lower()
        assert "completed" in data["detail"]["error"].lower()


class TestResumeEndpoint:
    """Test cases for POST /knowledge-items/resume/{progress_id}.

    These tests cover the critical bugs:
    - Resume with missing source_id (paused too early)
    - Resume with missing source record (DB inconsistency)
    - Proper validation BEFORE updating DB status
    """

    @patch(PROGRESS_TRACKER_PATH)
    def test_resume_missing_source_id_returns_400(self, mock_progress_tracker, client, mock_paused_operation_no_source):
        """Test resume fails gracefully when source_id is NULL.

        Critical bug test: Operation was paused before source record was created.
        Must fail with 400 and NOT update DB status to in_progress.
        """
        # Mock progress tracker to return operation without source_id
        mock_progress_tracker.get_progress.return_value = mock_paused_operation_no_source

        # Make request
        response = client.post("/api/knowledge-items/resume/test-early-pause")

        # Assertions
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        data = response.json()
        assert "error" in data["detail"]
        assert "missing source_id" in data["detail"]["error"].lower()
        assert "interrupted too early" in data["detail"]["error"].lower()

        # CRITICAL: Verify status was NOT updated (resume_operation should not have been called)
        mock_progress_tracker.resume_operation.assert_not_called()

    @patch(GET_SUPABASE_PATH)
    @patch(PROGRESS_TRACKER_PATH)
    def test_resume_missing_source_record_returns_404(
        self, mock_progress_tracker, mock_get_supabase, client, mock_paused_operation_with_source
    ):
        """Test resume fails when source record doesn't exist in DB.

        Critical bug test: source_id exists but source record was deleted or never created.
        Must fail with 404 and NOT update DB status to in_progress.
        """
        # Mock progress tracker to return operation with source_id
        mock_progress_tracker.get_progress.return_value = mock_paused_operation_with_source

        # Mock supabase query to return empty result (source not found)
        mock_supabase = MagicMock()
        mock_table = MagicMock()
        mock_select = MagicMock()
        mock_eq = MagicMock()
        mock_execute_result = MagicMock()
        mock_execute_result.data = []  # Empty data = source not found

        mock_eq.execute.return_value = mock_execute_result
        mock_select.eq.return_value = mock_eq
        mock_table.select.return_value = mock_select
        mock_supabase.table.return_value = mock_table
        mock_get_supabase.return_value = mock_supabase

        # Make request
        response = client.post("/api/knowledge-items/resume/test-late-pause")

        # Assertions
        assert response.status_code == status.HTTP_404_NOT_FOUND
        data = response.json()
        assert "error" in data["detail"]
        assert "source record not found" in data["detail"]["error"].lower()
        assert "source-abc123" in data["detail"]["error"]

        # CRITICAL: Verify status was NOT updated (resume_operation should not have been called)
        mock_progress_tracker.resume_operation.assert_not_called()

    @patch("asyncio.create_task")
    @patch(CRAWLING_SERVICE_PATH)
    @patch(GET_CRAWLER_PATH)
    @patch(GET_SUPABASE_PATH)
    @patch(PROGRESS_TRACKER_PATH)
    def test_resume_paused_operation_success(
        self,
        mock_progress_tracker,
        mock_get_supabase,
        mock_get_crawler,
        mock_crawling_service,
        mock_create_task,
        client,
        mock_paused_operation_with_source,
    ):
        """Test resuming paused operation with valid source.

        Happy path: operation paused after source created, all validations pass.
        """
        # Mock progress tracker
        mock_progress_tracker.get_progress.return_value = mock_paused_operation_with_source
        mock_progress_tracker.resume_operation = AsyncMock(return_value=True)

        # Mock supabase query to return valid source
        mock_supabase = MagicMock()
        mock_table = MagicMock()
        mock_select = MagicMock()
        mock_eq = MagicMock()
        mock_execute_result = MagicMock()
        mock_execute_result.data = [
            {
                "source_url": "https://example.com",
                "metadata": {
                    "knowledge_type": "website",
                    "tags": ["test"],
                    "max_depth": 3,
                    "allow_external_links": False,
                },
            }
        ]

        mock_eq.execute.return_value = mock_execute_result
        mock_select.eq.return_value = mock_eq
        mock_table.select.return_value = mock_select
        mock_supabase.table.return_value = mock_table
        mock_get_supabase.return_value = mock_supabase

        # Mock crawler
        mock_crawler = MagicMock()
        mock_get_crawler.return_value = AsyncMock(return_value=mock_crawler)

        # Mock crawl service
        mock_service_instance = MagicMock()
        mock_service_instance.orchestrate_crawl = AsyncMock(return_value={"task": MagicMock()})
        mock_crawling_service.return_value = mock_service_instance

        # Mock create_task
        mock_task = MagicMock()
        mock_create_task.return_value = mock_task

        # Make request
        response = client.post("/api/knowledge-items/resume/test-late-pause")

        # Assertions
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["success"] is True
        assert "resumed successfully" in data["message"].lower()
        assert data["progressId"] == "test-late-pause"
        assert data["sourceId"] == "source-abc123"

    @patch(PROGRESS_TRACKER_PATH)
    def test_resume_nonexistent_operation_returns_404(self, mock_progress_tracker, client):
        """Test resuming non-existent operation returns 404."""
        # Mock progress tracker to return None
        mock_progress_tracker.get_progress.return_value = None

        # Make request
        response = client.post("/api/knowledge-items/resume/non-existent-id")

        # Assertions
        assert response.status_code == status.HTTP_404_NOT_FOUND
        data = response.json()
        assert "error" in data["detail"]
        assert "non-existent-id" in data["detail"]["error"]


class TestStopEndpoint:
    """Test cases for POST /knowledge-items/stop/{progress_id}."""

    @patch(PROGRESS_TRACKER_PATH)
    @patch(UNREGISTER_ORCHESTRATION_PATH)
    @patch(GET_ACTIVE_ORCHESTRATION_PATH)
    def test_stop_active_operation_success(
        self, mock_get_orchestration, mock_unregister, mock_progress_tracker, client, mock_active_crawl_operation
    ):
        """Test stopping active operation returns 200."""
        # Mock orchestration
        mock_orchestration = MagicMock()
        mock_orchestration.cancel = MagicMock()
        mock_get_orchestration.return_value = AsyncMock(return_value=mock_orchestration)

        # Mock unregister
        mock_unregister.return_value = AsyncMock(return_value=None)

        # Mock progress tracker
        mock_progress_tracker.get_progress.return_value = mock_active_crawl_operation
        mock_tracker_instance = MagicMock()
        mock_tracker_instance.update = AsyncMock()
        mock_progress_tracker.return_value = mock_tracker_instance

        # Make request
        response = client.post("/api/knowledge-items/stop/test-active-crawl")

        # Assertions
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["success"] is True
        assert "stopped successfully" in data["message"].lower()
        assert data["progressId"] == "test-active-crawl"

    @patch("src.server.api_routes.knowledge_api.active_crawl_tasks", {})
    @patch(UNREGISTER_ORCHESTRATION_PATH)
    @patch(GET_ACTIVE_ORCHESTRATION_PATH)
    def test_stop_nonexistent_operation_returns_404(self, mock_get_orchestration, mock_unregister, client):
        """Test stopping non-existent operation returns 404."""
        # Mock no orchestration found
        mock_get_orchestration.return_value = AsyncMock(return_value=None)
        mock_unregister.return_value = AsyncMock(return_value=None)

        # Make request (with no tasks in active_crawl_tasks dict)
        response = client.post("/api/knowledge-items/stop/non-existent-id")

        # Assertions
        assert response.status_code == status.HTTP_404_NOT_FOUND
        data = response.json()
        assert "error" in data["detail"]
        assert "no active task" in data["detail"]["error"].lower()
