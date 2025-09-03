"""Unit tests for progress API endpoints."""

import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from fastapi import status
from datetime import datetime

from src.server.api_routes.progress_api import router
from src.server.utils.progress.progress_tracker import ProgressTracker


@pytest.fixture
def client():
    """Create a test client for the progress API."""
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def mock_progress_data():
    """Mock progress data for testing."""
    return {
        "progress_id": "test-123",
        "type": "crawl", 
        "status": "document_storage",
        "progress": 45,
        "log": "Processing batch 3/6",
        "start_time": "2024-01-01T10:00:00",
        "timestamp": "2024-01-01T10:05:00",
        "current_batch": 3,
        "total_batches": 6,
        "completed_batches": 2,
        "chunks_in_batch": 25,
        "total_pages": 60,
        "processed_pages": 60,
        "logs": [
            {"timestamp": "2024-01-01T10:00:00", "message": "Starting crawl", "status": "starting"},
            {"timestamp": "2024-01-01T10:01:00", "message": "Analyzing URL", "status": "analyzing"},
            {"timestamp": "2024-01-01T10:02:00", "message": "Crawling pages", "status": "crawling"},
            {"timestamp": "2024-01-01T10:05:00", "message": "Processing batch 3/6", "status": "document_storage"}
        ]
    }


class TestProgressAPI:
    """Test cases for progress API endpoints."""

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    @patch('src.server.api_routes.progress_api.create_progress_response')
    def test_get_progress_success(self, mock_create_response, mock_get_progress, client, mock_progress_data):
        """Test successful progress retrieval."""
        # Setup mocks
        mock_get_progress.return_value = mock_progress_data
        
        mock_response = MagicMock()
        mock_response.model_dump.return_value = {
            "progressId": "test-123",
            "status": "document_storage", 
            "progress": 45,
            "message": "Processing batch 3/6",
            "currentBatch": 3,
            "totalBatches": 6,
            "completedBatches": 2,
            "totalPages": 60,
            "processedPages": 60
        }
        mock_create_response.return_value = mock_response
        
        # Make request
        response = client.get("/api/progress/test-123")
        
        # Assertions
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        
        assert data["progressId"] == "test-123"
        assert data["status"] == "document_storage"
        assert data["progress"] == 45
        assert data["currentBatch"] == 3
        assert data["totalBatches"] == 6
        
        # Verify mocks were called correctly
        mock_get_progress.assert_called_once_with("test-123")
        mock_create_response.assert_called_once_with("crawl", mock_progress_data)

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    def test_get_progress_not_found(self, mock_get_progress, client):
        """Test progress retrieval for non-existent operation."""
        mock_get_progress.return_value = None
        
        response = client.get("/api/progress/non-existent-id")
        
        assert response.status_code == status.HTTP_404_NOT_FOUND
        data = response.json()
        assert "Operation non-existent-id not found" in data["detail"]["error"]

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    @patch('src.server.api_routes.progress_api.create_progress_response')
    def test_get_progress_with_etag_cache(self, mock_create_response, mock_get_progress, client, mock_progress_data):
        """Test ETag caching functionality."""
        mock_get_progress.return_value = mock_progress_data
        
        mock_response = MagicMock()
        mock_response.model_dump.return_value = {
            "progressId": "test-123",
            "status": "document_storage",
            "progress": 45
        }
        mock_create_response.return_value = mock_response
        
        # First request - should return data with ETag
        response1 = client.get("/api/progress/test-123")
        assert response1.status_code == status.HTTP_200_OK
        etag = response1.headers.get("ETag")
        assert etag is not None
        
        # Second request with ETag - should return 304 Not Modified
        response2 = client.get("/api/progress/test-123", headers={"If-None-Match": etag})
        assert response2.status_code == status.HTTP_304_NOT_MODIFIED
        assert response2.headers.get("ETag") == etag

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    @patch('src.server.api_routes.progress_api.create_progress_response')
    def test_get_progress_poll_interval_headers(self, mock_create_response, mock_get_progress, client, mock_progress_data):
        """Test that appropriate polling interval headers are set."""
        # Test running operation
        mock_progress_data["status"] = "running"
        mock_get_progress.return_value = mock_progress_data
        
        mock_response = MagicMock()
        mock_response.model_dump.return_value = {"progressId": "test-123", "status": "running"}
        mock_create_response.return_value = mock_response
        
        response = client.get("/api/progress/test-123")
        assert response.headers.get("X-Poll-Interval") == "1000"  # 1 second for running
        
        # Test completed operation
        mock_progress_data["status"] = "completed"
        mock_get_progress.return_value = mock_progress_data
        mock_response.model_dump.return_value = {"progressId": "test-123", "status": "completed"}
        
        response = client.get("/api/progress/test-123")
        assert response.headers.get("X-Poll-Interval") == "0"  # No polling needed

    def test_list_active_operations_success(self, client):
        """Test listing active operations."""
        # Setup mock active operations by directly modifying the class attribute
        from src.server.utils.progress.progress_tracker import ProgressTracker
        
        # Store original states to restore later
        original_states = ProgressTracker._progress_states.copy()
        
        try:
            ProgressTracker._progress_states = {
                "op-1": {"type": "crawl", "status": "running", "progress": 25, "log": "Crawling pages", "start_time": datetime(2024, 1, 1, 10, 0, 0)},
                "op-2": {"type": "upload", "status": "starting", "progress": 0, "log": "Initializing", "start_time": datetime(2024, 1, 1, 10, 1, 0)},
                "op-3": {"type": "crawl", "status": "completed", "progress": 100, "log": "Completed"}
            }
        
            response = client.get("/api/progress/")
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert "operations" in data
            assert "count" in data
            assert data["count"] == 2  # Only running/starting operations
            
            # Should only include active operations (running, starting)
            operations = data["operations"]
            assert len(operations) == 2
            
            operation_ids = [op["operation_id"] for op in operations]
            assert "op-1" in operation_ids
            assert "op-2" in operation_ids
            assert "op-3" not in operation_ids  # Completed operations excluded
            
        finally:
            # Restore original states
            ProgressTracker._progress_states = original_states

    def test_list_active_operations_empty(self, client):
        """Test listing active operations when none exist."""
        from src.server.utils.progress.progress_tracker import ProgressTracker
        
        # Store original states to restore later
        original_states = ProgressTracker._progress_states.copy()
        
        try:
            ProgressTracker._progress_states = {}
            
            response = client.get("/api/progress/")
            
            assert response.status_code == status.HTTP_200_OK
            data = response.json()
            
            assert data["operations"] == []
            assert data["count"] == 0
            
        finally:
            # Restore original states
            ProgressTracker._progress_states = original_states

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    def test_get_progress_server_error(self, mock_get_progress, client):
        """Test handling of server errors during progress retrieval."""
        mock_get_progress.side_effect = Exception("Database connection failed")
        
        response = client.get("/api/progress/test-123")
        
        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
        data = response.json()
        assert "Database connection failed" in data["detail"]["error"]

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    @patch('src.server.api_routes.progress_api.create_progress_response')
    def test_progress_response_model_validation(self, mock_create_response, mock_get_progress, client, mock_progress_data):
        """Test that progress response model validation works correctly."""
        mock_get_progress.return_value = mock_progress_data
        
        # Simulate validation error in create_progress_response
        mock_create_response.side_effect = ValueError("Invalid progress data")
        
        response = client.get("/api/progress/test-123")
        
        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR

    @patch('src.server.api_routes.progress_api.ProgressTracker.get_progress')
    @patch('src.server.api_routes.progress_api.create_progress_response')
    def test_get_progress_different_operation_types(self, mock_create_response, mock_get_progress, client):
        """Test progress retrieval for different operation types."""
        test_cases = [
            {"type": "crawl", "status": "document_storage"},
            {"type": "upload", "status": "storing"},
            {"type": "project_creation", "status": "generating_prp"}
        ]
        
        for case in test_cases:
            mock_progress_data = {
                "progress_id": f"test-{case['type']}",
                "type": case["type"],
                "status": case["status"],
                "progress": 50,
                "log": f"Processing {case['type']}"
            }
            
            mock_get_progress.return_value = mock_progress_data
            
            mock_response = MagicMock()
            mock_response.model_dump.return_value = mock_progress_data
            mock_create_response.return_value = mock_response
            
            response = client.get(f"/api/progress/test-{case['type']}")
            
            assert response.status_code == status.HTTP_200_OK
            mock_create_response.assert_called_with(case["type"], mock_progress_data)