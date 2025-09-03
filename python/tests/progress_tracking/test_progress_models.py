"""Unit tests for progress response models."""

import pytest
from pydantic import ValidationError

from src.server.models.progress_models import (
    ProgressDetails,
    BaseProgressResponse,
    CrawlProgressResponse,
    UploadProgressResponse,
    ProjectCreationProgressResponse,
    create_progress_response
)


class TestProgressDetails:
    """Test cases for ProgressDetails model."""

    def test_create_with_snake_case_fields(self):
        """Test creating ProgressDetails with snake_case field names."""
        details = ProgressDetails(
            current_chunk=25,
            total_chunks=100,
            current_batch=3,
            total_batches=6,
            chunks_per_second=5.5
        )
        
        assert details.current_chunk == 25
        assert details.total_chunks == 100
        assert details.current_batch == 3
        assert details.total_batches == 6
        assert details.chunks_per_second == 5.5

    def test_create_with_camel_case_fields(self):
        """Test creating ProgressDetails with camelCase field names."""
        details = ProgressDetails(
            currentChunk=25,
            totalChunks=100,
            currentBatch=3,
            totalBatches=6,
            chunksPerSecond=5.5
        )
        
        assert details.current_chunk == 25
        assert details.total_chunks == 100
        assert details.current_batch == 3
        assert details.total_batches == 6
        assert details.chunks_per_second == 5.5

    def test_model_dump_uses_aliases(self):
        """Test that model_dump uses camelCase aliases."""
        details = ProgressDetails(
            current_chunk=25,
            total_chunks=100,
            chunks_per_second=2.5
        )
        
        data = details.model_dump(by_alias=True)
        
        assert "currentChunk" in data
        assert "totalChunks" in data
        assert "chunksPerSecond" in data
        assert "current_chunk" not in data
        assert "total_chunks" not in data


class TestBaseProgressResponse:
    """Test cases for BaseProgressResponse model."""

    def test_create_minimal_response(self):
        """Test creating minimal progress response."""
        response = BaseProgressResponse(
            progress_id="test-123",
            status="running",
            progress=50.0,
            message="Processing..."
        )
        
        assert response.progress_id == "test-123"
        assert response.status == "running" 
        assert response.progress == 50.0
        assert response.message == "Processing..."

    def test_progress_validation(self):
        """Test that progress is validated to be between 0-100."""
        # Valid progress
        response = BaseProgressResponse(
            progress_id="test-123",
            status="running",
            progress=50.0
        )
        assert response.progress == 50.0
        
        # Invalid progress - too high
        with pytest.raises(ValidationError):
            BaseProgressResponse(
                progress_id="test-123",
                status="running", 
                progress=150.0
            )
        
        # Invalid progress - too low
        with pytest.raises(ValidationError):
            BaseProgressResponse(
                progress_id="test-123",
                status="running",
                progress=-10.0
            )

    def test_logs_validation_and_conversion(self):
        """Test logs field validation and conversion."""
        # Test with list of strings
        response = BaseProgressResponse(
            progress_id="test-123",
            status="running",
            progress=50.0,
            logs=["Starting", "Processing", "Almost done"]
        )
        assert response.logs == ["Starting", "Processing", "Almost done"]
        
        # Test with single string
        response = BaseProgressResponse(
            progress_id="test-123",
            status="running",
            progress=50.0,
            logs="Single log message"
        )
        assert response.logs == ["Single log message"]
        
        # Test with list of dicts (log entries)
        response = BaseProgressResponse(
            progress_id="test-123",
            status="running",
            progress=50.0,
            logs=[
                {"message": "Starting", "timestamp": "2024-01-01T10:00:00"},
                {"message": "Processing", "timestamp": "2024-01-01T10:01:00"}
            ]
        )
        assert response.logs == ["Starting", "Processing"]

    def test_camel_case_aliases(self):
        """Test that camelCase aliases work correctly."""
        response = BaseProgressResponse(
            progressId="test-123",  # camelCase
            status="running",
            progress=50.0,
            currentStep="processing",  # camelCase
            stepMessage="Working on it"  # camelCase
        )
        
        assert response.progress_id == "test-123"
        assert response.current_step == "processing"
        assert response.step_message == "Working on it"


class TestCrawlProgressResponse:
    """Test cases for CrawlProgressResponse model."""

    def test_create_crawl_response_with_batch_info(self):
        """Test creating crawl response with batch processing information."""
        response = CrawlProgressResponse(
            progress_id="crawl-123",
            status="document_storage", 
            progress=45.0,
            message="Processing batch 3/6",
            total_pages=60,
            processed_pages=60,
            current_batch=3,
            total_batches=6,
            completed_batches=2,
            chunks_in_batch=25,
            active_workers=4
        )
        
        assert response.progress_id == "crawl-123"
        assert response.status == "document_storage"
        assert response.current_batch == 3
        assert response.total_batches == 6
        assert response.completed_batches == 2
        assert response.chunks_in_batch == 25
        assert response.active_workers == 4

    def test_create_with_code_extraction_fields(self):
        """Test creating crawl response with code extraction fields."""
        response = CrawlProgressResponse(
            progress_id="crawl-123",
            status="code_extraction",
            progress=75.0,
            code_blocks_found=150,
            code_examples_stored=120,
            completed_documents=45,
            total_documents=50,
            completed_summaries=30,
            total_summaries=40
        )
        
        assert response.code_blocks_found == 150
        assert response.code_examples_stored == 120
        assert response.completed_documents == 45
        assert response.total_documents == 50
        assert response.completed_summaries == 30
        assert response.total_summaries == 40

    def test_status_validation(self):
        """Test that only valid crawl statuses are accepted."""
        valid_statuses = [
            "starting", "analyzing", "crawling", "processing",
            "source_creation", "document_storage", "code_extraction", 
            "finalization", "completed", "failed", "cancelled"
        ]
        
        for status in valid_statuses:
            response = CrawlProgressResponse(
                progress_id="test-123",
                status=status,
                progress=50.0
            )
            assert response.status == status
        
        # Invalid status should raise validation error
        with pytest.raises(ValidationError):
            CrawlProgressResponse(
                progress_id="test-123",
                status="invalid_status",
                progress=50.0
            )

    def test_camel_case_field_aliases(self):
        """Test that crawl-specific fields use camelCase aliases."""
        response = CrawlProgressResponse(
            progress_id="test-123",
            status="code_extraction",
            progress=50.0,
            currentUrl="https://example.com/page1",  # camelCase
            totalPages=100,  # camelCase
            processedPages=50,  # camelCase
            codeBlocksFound=75,  # camelCase
            totalBatches=6,  # camelCase
            currentBatch=3  # camelCase
        )
        
        assert response.current_url == "https://example.com/page1"
        assert response.total_pages == 100
        assert response.processed_pages == 50
        assert response.code_blocks_found == 75
        assert response.total_batches == 6
        assert response.current_batch == 3

    def test_duration_conversion(self):
        """Test that duration is converted to string."""
        # Test with float
        response = CrawlProgressResponse(
            progress_id="test-123",
            status="completed",
            progress=100.0,
            duration=123.45
        )
        assert response.duration == "123.45"
        
        # Test with int
        response = CrawlProgressResponse(
            progress_id="test-123",
            status="completed", 
            progress=100.0,
            duration=120
        )
        assert response.duration == "120"
        
        # Test with None
        response = CrawlProgressResponse(
            progress_id="test-123",
            status="processing",  # Use valid crawl status
            progress=50.0,
            duration=None
        )
        assert response.duration is None


class TestUploadProgressResponse:
    """Test cases for UploadProgressResponse model."""

    def test_create_upload_response(self):
        """Test creating upload progress response."""
        response = UploadProgressResponse(
            progress_id="upload-123",
            status="storing",
            progress=80.0,
            upload_type="document",
            file_name="document.pdf",
            file_type="application/pdf",
            chunks_stored=400,
            word_count=5000
        )
        
        assert response.progress_id == "upload-123"
        assert response.status == "storing"
        assert response.upload_type == "document"
        assert response.file_name == "document.pdf"
        assert response.file_type == "application/pdf"
        assert response.chunks_stored == 400
        assert response.word_count == 5000

    def test_upload_status_validation(self):
        """Test upload status validation."""
        valid_statuses = [
            "starting", "reading", "extracting", "chunking",
            "creating_source", "summarizing", "storing",
            "completed", "failed", "cancelled"
        ]
        
        for status in valid_statuses:
            response = UploadProgressResponse(
                progress_id="test-123",
                status=status,
                progress=50.0
            )
            assert response.status == status


class TestProgressResponseFactory:
    """Test cases for create_progress_response factory function."""

    def test_create_crawl_response(self):
        """Test creating crawl progress response via factory."""
        progress_data = {
            "progress_id": "crawl-123",
            "status": "document_storage",
            "progress": 50,
            "log": "Processing batch 3/6",
            "current_batch": 3,
            "total_batches": 6,
            "total_pages": 60,
            "processed_pages": 60
        }
        
        response = create_progress_response("crawl", progress_data)
        
        assert isinstance(response, CrawlProgressResponse)
        assert response.progress_id == "crawl-123"
        assert response.status == "document_storage"
        assert response.current_batch == 3
        assert response.total_batches == 6

    def test_create_upload_response(self):
        """Test creating upload progress response via factory."""
        progress_data = {
            "progress_id": "upload-123",
            "status": "storing",
            "progress": 75,
            "log": "Storing document chunks",
            "file_name": "document.pdf",
            "chunks_stored": 300
        }
        
        response = create_progress_response("upload", progress_data)
        
        assert isinstance(response, UploadProgressResponse)
        assert response.progress_id == "upload-123"
        assert response.status == "storing"
        assert response.file_name == "document.pdf"
        assert response.chunks_stored == 300

    def test_create_response_with_details(self):
        """Test that factory creates details object from progress data."""
        progress_data = {
            "progress_id": "test-123",
            "status": "processing",
            "progress": 50,
            "current_batch": 3,
            "total_batches": 6,
            "current_chunk": 150,
            "total_chunks": 300,
            "chunks_per_second": 5.5
        }
        
        response = create_progress_response("crawl", progress_data)
        
        assert response.details is not None
        assert response.details.current_batch == 3
        assert response.details.total_batches == 6
        assert response.details.current_chunk == 150
        assert response.details.total_chunks == 300
        assert response.details.chunks_per_second == 5.5

    def test_factory_handles_missing_fields(self):
        """Test that factory handles missing required fields gracefully."""
        # Missing status
        progress_data = {
            "progress_id": "test-123",
            "progress": 50
        }
        
        response = create_progress_response("crawl", progress_data)
        assert response.status == "running"  # Default
        
        # Missing progress
        progress_data = {
            "progress_id": "test-123",
            "status": "processing"
        }
        
        response = create_progress_response("crawl", progress_data)
        assert response.progress == 0  # Default

    def test_factory_unknown_operation_type(self):
        """Test factory with unknown operation type falls back to base response."""
        progress_data = {
            "progress_id": "test-123",
            "status": "processing",
            "progress": 50
        }
        
        response = create_progress_response("unknown_type", progress_data)
        assert isinstance(response, BaseProgressResponse)
        assert not isinstance(response, CrawlProgressResponse)

    def test_factory_validation_error_fallback(self):
        """Test that factory falls back to base response on validation errors."""
        # Create invalid data that would fail CrawlProgressResponse validation
        progress_data = {
            "progress_id": "test-123", 
            "status": "invalid_crawl_status",  # Invalid status
            "progress": 50
        }
        
        response = create_progress_response("crawl", progress_data)
        
        # Should fall back to BaseProgressResponse
        assert isinstance(response, BaseProgressResponse)
        assert response.progress_id == "test-123"