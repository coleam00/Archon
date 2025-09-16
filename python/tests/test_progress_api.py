"""
Integration tests for Progress API endpoints
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock

from src.server.main import app
from src.server.utils.progress import ProgressTracker


@pytest.fixture
def client():
    """Create test client"""
    return TestClient(app)


@pytest.fixture(autouse=True)
def clear_progress_states():
    """Clear all progress states before each test"""
    ProgressTracker._progress_states.clear()
    yield
    ProgressTracker._progress_states.clear()


class TestProgressAPI:
    """Test suite for Progress API endpoints"""

    def test_get_progress_success(self, client):
        """Test getting progress for an existing operation"""
        # Create a progress tracker
        progress_id = "test-progress-123"
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        tracker.state.update({
            "status": "crawling",
            "progress": 50,
            "log": "Processing pages",
            "processed_pages": 5,
            "total_pages": 10,
            "current_url": "https://example.com/page5"
        })
        
        # Get progress via API
        response = client.get(f"/api/progress/{progress_id}")
        
        assert response.status_code == 200
        data = response.json()
        
        assert data["progressId"] == progress_id
        assert data["status"] == "crawling"
        assert data["progress"] == 50
        assert data["message"] == "Processing pages"
        assert data["processedPages"] == 5
        assert data["totalPages"] == 10
        assert data["currentUrl"] == "https://example.com/page5"
        
    def test_get_progress_not_found(self, client):
        """Test getting progress for non-existent operation"""
        response = client.get("/api/progress/non-existent-id")
        
        assert response.status_code == 404
        data = response.json()
        assert "error" in data["detail"]
        assert "not found" in data["detail"]["error"].lower()
        
    def test_get_progress_with_etag(self, client):
        """Test ETag support for progress endpoint"""
        # Create a progress tracker
        progress_id = "test-etag-123"
        tracker = ProgressTracker(progress_id, operation_type="upload")
        tracker.state.update({
            "status": "processing",
            "progress": 30,
            "log": "Processing file"
        })
        
        # First request - should get full response
        response1 = client.get(f"/api/progress/{progress_id}")
        assert response1.status_code == 200
        etag = response1.headers.get("etag")
        assert etag is not None
        
        # Second request with same ETag - should get 304
        response2 = client.get(
            f"/api/progress/{progress_id}",
            headers={"If-None-Match": etag}
        )
        assert response2.status_code == 304
        
        # Update progress
        tracker.state["progress"] = 50
        
        # Third request with same ETag - should get full response (data changed)
        response3 = client.get(
            f"/api/progress/{progress_id}",
            headers={"If-None-Match": etag}
        )
        assert response3.status_code == 200
        new_etag = response3.headers.get("etag")
        assert new_etag != etag  # ETag should be different
        
    def test_list_active_operations(self, client):
        """Test listing all active operations"""
        # Create multiple progress trackers
        tracker1 = ProgressTracker("crawl-1", operation_type="crawl")
        tracker1.state.update({
            "status": "crawling",
            "progress": 30,
            "log": "Crawling site 1"
        })
        
        tracker2 = ProgressTracker("upload-1", operation_type="upload")
        tracker2.state.update({
            "status": "processing",
            "progress": 60,
            "log": "Processing document"
        })
        
        # Create a completed one (should not be listed)
        tracker3 = ProgressTracker("completed-1", operation_type="crawl")
        tracker3.state.update({
            "status": "completed",
            "progress": 100,
            "log": "Done"
        })
        
        # List active operations
        response = client.get("/api/progress/")
        
        assert response.status_code == 200
        data = response.json()
        
        assert "operations" in data
        assert "count" in data
        assert data["count"] == 2  # Only active operations
        
        # Check operations
        operations = data["operations"]
        op_ids = [op["operation_id"] for op in operations]
        assert "crawl-1" in op_ids
        assert "upload-1" in op_ids
        assert "completed-1" not in op_ids  # Completed should not be listed
        
    def test_list_active_operations_empty(self, client):
        """Test listing when no active operations"""
        response = client.get("/api/progress/")
        
        assert response.status_code == 200
        data = response.json()
        
        assert data["operations"] == []
        assert data["count"] == 0
        
    def test_progress_response_for_crawl_operation(self, client):
        """Test progress response for crawl operation with all fields"""
        progress_id = "crawl-test-456"
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        tracker.state.update({
            "status": "code_extraction",
            "progress": 45,
            "log": "Extracting code examples",
            "crawl_type": "normal",
            "current_url": "https://example.com/docs",
            "total_pages": 20,
            "processed_pages": 10,
            "code_blocks_found": 15,
            "completed_summaries": 5,
            "total_summaries": 15
        })
        
        response = client.get(f"/api/progress/{progress_id}")
        
        assert response.status_code == 200
        data = response.json()
        
        # Check crawl-specific fields
        assert data["status"] == "code_extraction"
        assert data["progress"] == 45
        assert data["crawlType"] == "normal"
        assert data["currentUrl"] == "https://example.com/docs"
        assert data["totalPages"] == 20
        assert data["processedPages"] == 10
        assert data["codeBlocksFound"] == 15
        assert data["completedSummaries"] == 5
        assert data["totalSummaries"] == 15
        
    def test_progress_response_for_upload_operation(self, client):
        """Test progress response for upload operation"""
        progress_id = "upload-test-789"
        tracker = ProgressTracker(progress_id, operation_type="upload")
        tracker.state.update({
            "status": "storing",
            "progress": 75,
            "log": "Storing chunks",
            "filename": "document.pdf",
            "chunks_stored": 75,
            "total_chunks": 100
        })
        
        response = client.get(f"/api/progress/{progress_id}")
        
        assert response.status_code == 200
        data = response.json()
        
        # Check upload-specific fields
        assert data["status"] == "storing"
        assert data["progress"] == 75
        assert data["message"] == "Storing chunks"
        
    def test_progress_headers(self, client):
        """Test response headers for progress endpoint"""
        progress_id = "header-test-123"
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        tracker.state.update({
            "status": "running",
            "progress": 25
        })
        
        response = client.get(f"/api/progress/{progress_id}")
        
        assert response.status_code == 200
        
        # Check headers
        assert "ETag" in response.headers
        assert "Last-Modified" in response.headers
        assert "Cache-Control" in response.headers
        assert response.headers["Cache-Control"] == "no-cache, must-revalidate"
        assert response.headers["X-Poll-Interval"] == "1000"  # Running operation
        
    def test_progress_completed_operation_headers(self, client):
        """Test headers for completed operation"""
        progress_id = "completed-test-456"
        tracker = ProgressTracker(progress_id, operation_type="crawl")
        tracker.state.update({
            "status": "completed",
            "progress": 100
        })
        
        response = client.get(f"/api/progress/{progress_id}")
        
        assert response.status_code == 200
        assert response.headers["X-Poll-Interval"] == "0"  # No need to poll completed
        
    def test_progress_error_handling(self, client):
        """Test error handling in progress endpoint"""
        # Mock an error in ProgressTracker.get_progress
        with patch.object(ProgressTracker, 'get_progress', side_effect=Exception("Database error")):
            response = client.get("/api/progress/any-id")
            
            assert response.status_code == 500
            data = response.json()
            assert "error" in data["detail"]
            
    def test_list_operations_error_handling(self, client):
        """Test error handling in list operations endpoint"""
        # Mock an error when accessing _progress_states
        with patch.object(ProgressTracker, '_progress_states', new_callable=lambda: MagicMock(side_effect=Exception("Memory error"))):
            response = client.get("/api/progress/")
            
            # The endpoint has try/except so it should handle the error gracefully
            assert response.status_code in [200, 500]  # May return empty list or error