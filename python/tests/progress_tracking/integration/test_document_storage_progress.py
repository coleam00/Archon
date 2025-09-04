"""Integration tests for document storage progress tracking."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from src.server.services.storage.document_storage_service import add_documents_to_supabase
from src.server.services.embeddings.embedding_service import EmbeddingBatchResult
from src.server.utils.progress.progress_tracker import ProgressTracker
from tests.progress_tracking.utils.test_helpers import ProgressTestHelper


def create_mock_embedding_result(embedding_count: int) -> EmbeddingBatchResult:
    """Create a mock EmbeddingBatchResult for testing."""
    result = EmbeddingBatchResult()
    for i in range(embedding_count):
        result.add_success([0.1 + i * 0.1] * 1536, f"text_{i}")
    return result


@pytest.fixture
def progress_mock_supabase_client():
    """Create a mock Supabase client for progress tracking tests."""
    client = MagicMock()
    
    # Mock table operations
    mock_table = MagicMock()
    mock_table.delete.return_value = mock_table
    mock_table.in_.return_value = mock_table
    mock_table.execute.return_value = MagicMock()
    
    client.table.return_value = mock_table
    return client


@pytest.fixture
def mock_progress_callback():
    """Create a mock progress callback for testing."""
    callback = AsyncMock()
    callback.call_history = []
    
    async def side_effect(*args, **kwargs):
        callback.call_history.append((args, kwargs))
    
    callback.side_effect = side_effect
    return callback


@pytest.fixture  
def sample_document_data():
    """Sample document data for testing."""
    return {
        "urls": ["https://example.com/page1", "https://example.com/page2", "https://example.com/page3"],
        "chunk_numbers": [0, 1, 0, 1, 2, 0],  # 2 chunks for page1, 3 for page2, 1 for page3
        "contents": [
            "First chunk of page 1",
            "Second chunk of page 1", 
            "First chunk of page 2",
            "Second chunk of page 2",
            "Third chunk of page 2",
            "First chunk of page 3"
        ],
        "metadatas": [
            {"url": "https://example.com/page1", "title": "Page 1", "chunk_index": 0},
            {"url": "https://example.com/page1", "title": "Page 1", "chunk_index": 1},
            {"url": "https://example.com/page2", "title": "Page 2", "chunk_index": 0},
            {"url": "https://example.com/page2", "title": "Page 2", "chunk_index": 1},
            {"url": "https://example.com/page2", "title": "Page 2", "chunk_index": 2},
            {"url": "https://example.com/page3", "title": "Page 3", "chunk_index": 0}
        ],
        "url_to_full_document": {
            "https://example.com/page1": "Full content of page 1",
            "https://example.com/page2": "Full content of page 2", 
            "https://example.com/page3": "Full content of page 3"
        }
    }


class TestDocumentStorageProgressIntegration:
    """Integration tests for document storage progress tracking."""

    @pytest.mark.asyncio
    @patch('src.server.services.storage.document_storage_service.create_embeddings_batch')
    @patch('src.server.services.credential_service.credential_service')
    async def test_batch_progress_reporting(self, mock_credentials, mock_create_embeddings, 
                                          mock_supabase_client, sample_document_data, 
                                          mock_progress_callback):
        """Test that batch progress is reported correctly during document storage."""
        
        # Setup mock credentials
        mock_credentials.get_credentials_by_category.return_value = {
            "DOCUMENT_STORAGE_BATCH_SIZE": "3",  # Small batch size for testing
            "USE_CONTEXTUAL_EMBEDDINGS": "false"
        }
        
        # Mock embedding creation
        mock_create_embeddings.return_value = create_mock_embedding_result(3)
        
        # Call the function
        result = await add_documents_to_supabase(
            client=mock_supabase_client,
            urls=sample_document_data["urls"],
            chunk_numbers=sample_document_data["chunk_numbers"],
            contents=sample_document_data["contents"],
            metadatas=sample_document_data["metadatas"],
            url_to_full_document=sample_document_data["url_to_full_document"],
            batch_size=3,
            progress_callback=mock_progress_callback
        )
        
        # Verify batch progress was reported
        assert mock_progress_callback.call_count >= 2  # At least start and end
        
        # Check that batch information was passed correctly
        batch_calls = [call for call in mock_progress_callback.call_history 
                      if len(call[1]) > 0 and "current_batch" in call[1]]
        
        assert len(batch_calls) >= 2  # Should have multiple batch progress updates
        
        # Verify batch structure
        for call_args, call_kwargs in batch_calls:
            assert "current_batch" in call_kwargs
            assert "total_batches" in call_kwargs  
            assert "completed_batches" in call_kwargs
            assert call_kwargs["current_batch"] >= 1
            assert call_kwargs["total_batches"] >= 1
            assert call_kwargs["completed_batches"] >= 0

    @pytest.mark.asyncio
    @patch('src.server.services.storage.document_storage_service.create_embeddings_batch')
    @patch('src.server.services.credential_service.credential_service')
    async def test_progress_callback_signature(self, mock_credentials, mock_create_embeddings,
                                             mock_supabase_client, sample_document_data):
        """Test that progress callback is called with correct signature."""
        
        # Setup
        mock_credentials.get_credentials_by_category.return_value = {
            "DOCUMENT_STORAGE_BATCH_SIZE": "6",  # Process all in one batch
            "USE_CONTEXTUAL_EMBEDDINGS": "false"
        }
        
        mock_create_embeddings.return_value = create_mock_embedding_result(6)
        
        # Create callback that validates signature
        callback_calls = []
        
        async def validate_callback(status: str, progress: int, message: str, **kwargs):
            callback_calls.append({
                'status': status,
                'progress': progress, 
                'message': message,
                'kwargs': kwargs
            })
        
        # Call function
        await add_documents_to_supabase(
            client=mock_supabase_client,
            urls=sample_document_data["urls"],
            chunk_numbers=sample_document_data["chunk_numbers"], 
            contents=sample_document_data["contents"],
            metadatas=sample_document_data["metadatas"],
            url_to_full_document=sample_document_data["url_to_full_document"],
            progress_callback=validate_callback
        )
        
        # Verify callback signature
        assert len(callback_calls) >= 2
        
        for call in callback_calls:
            assert isinstance(call['status'], str)
            assert isinstance(call['progress'], int)
            assert isinstance(call['message'], str)
            assert isinstance(call['kwargs'], dict)
            
            # Check that batch info is in kwargs when present
            if 'current_batch' in call['kwargs']:
                assert isinstance(call['kwargs']['current_batch'], int)
                assert isinstance(call['kwargs']['total_batches'], int)
                assert call['kwargs']['current_batch'] >= 1
                assert call['kwargs']['total_batches'] >= 1

    @pytest.mark.asyncio
    @patch('src.server.services.storage.document_storage_service.create_embeddings_batch')
    @patch('src.server.services.credential_service.credential_service')
    async def test_cancellation_support(self, mock_credentials, mock_create_embeddings,
                                       mock_supabase_client, sample_document_data):
        """Test that cancellation is handled correctly during document storage."""
        
        mock_credentials.get_credentials_by_category.return_value = {
            "DOCUMENT_STORAGE_BATCH_SIZE": "2",
            "USE_CONTEXTUAL_EMBEDDINGS": "false"
        }
        
        mock_create_embeddings.return_value = create_mock_embedding_result(2)
        
        # Create cancellation check that triggers after first batch
        call_count = 0
        def cancellation_check():
            nonlocal call_count
            call_count += 1
            if call_count > 1:  # Cancel after first batch
                raise asyncio.CancelledError("Operation cancelled")
        
        # Should raise CancelledError
        with pytest.raises(asyncio.CancelledError):
            await add_documents_to_supabase(
                client=mock_supabase_client,
                urls=sample_document_data["urls"],
                chunk_numbers=sample_document_data["chunk_numbers"],
                contents=sample_document_data["contents"], 
                metadatas=sample_document_data["metadatas"],
                url_to_full_document=sample_document_data["url_to_full_document"],
                cancellation_check=cancellation_check
            )

    @pytest.mark.asyncio
    @patch('src.server.services.storage.document_storage_service.create_embeddings_batch')
    @patch('src.server.services.credential_service.credential_service')
    async def test_error_handling_in_progress_reporting(self, mock_credentials, mock_create_embeddings,
                                                      mock_supabase_client, sample_document_data):
        """Test that errors in progress reporting don't crash the storage process."""
        
        mock_credentials.get_credentials_by_category.return_value = {
            "DOCUMENT_STORAGE_BATCH_SIZE": "3",
            "USE_CONTEXTUAL_EMBEDDINGS": "false"
        }
        
        mock_create_embeddings.return_value = create_mock_embedding_result(3)
        
        # Create callback that throws an error
        async def failing_callback(status: str, progress: int, message: str, **kwargs):
            if progress > 0:  # Fail on progress updates but not initial call
                raise Exception("Progress callback failed")
        
        # Should not raise exception - storage should continue despite callback failure  
        result = await add_documents_to_supabase(
            client=mock_supabase_client,
            urls=sample_document_data["urls"][:3],  # Limit to 3 for simplicity
            chunk_numbers=sample_document_data["chunk_numbers"][:3],
            contents=sample_document_data["contents"][:3],
            metadatas=sample_document_data["metadatas"][:3],
            url_to_full_document={k: v for k, v in list(sample_document_data["url_to_full_document"].items())[:2]},
            progress_callback=failing_callback
        )
        
        # Should still return valid result
        assert "chunks_stored" in result
        assert result["chunks_stored"] >= 0


class TestProgressTrackerIntegration:
    """Integration tests for ProgressTracker with real progress mapping."""

    @pytest.mark.asyncio
    async def test_full_crawl_progress_sequence(self):
        """Test a complete crawl progress sequence with realistic data."""
        
        tracker = ProgressTracker("integration-test-123", "crawl")
        
        # Simulate realistic crawl sequence
        sequence = [
            ("starting", 0, "Initializing crawl operation"),
            ("analyzing", 1, "Analyzing sitemap URL"),
            ("crawling", 4, "Crawled 60/60 pages successfully"), 
            ("processing", 7, "Processing and chunking content"),
            ("source_creation", 9, "Creating source record"),
            ("document_storage", 15, "Processing batch 1/6 (25 chunks)"),
            ("document_storage", 20, "Processing batch 2/6 (25 chunks)"),
            ("document_storage", 25, "Processing batch 3/6 (25 chunks)"),
            ("document_storage", 30, "Document storage completed"),
            ("code_extraction", 50, "Extracting code examples (25/50 documents)"),
            ("code_extraction", 80, "Generating AI summaries (40/50 examples)"),
            ("code_extraction", 95, "Code extraction completed"),
            ("finalization", 98, "Finalizing crawl metadata"),
            ("completed", 100, "Crawl completed successfully")
        ]
        
        # Process sequence
        for status, progress, message in sequence:
            await tracker.update(
                status=status,
                progress=progress, 
                log=message,
                # Add some realistic kwargs
                total_pages=60 if status in ["crawling", "processing"] else None,
                processed_pages=60 if status in ["crawling", "processing"] else None,
                current_batch=3 if status == "document_storage" and progress == 25 else None,
                total_batches=6 if status == "document_storage" else None,
                code_blocks_found=150 if status == "code_extraction" else None
            )
        
        # Verify final state
        final_state = tracker.get_state()
        assert final_state["status"] == "completed"
        assert final_state["progress"] == 100
        assert len(final_state["logs"]) == len(sequence)
        
        # Verify log entries contain expected data
        log_messages = [log["message"] for log in final_state["logs"]]
        assert "Initializing crawl operation" in log_messages
        assert "Processing batch 3/6 (25 chunks)" in log_messages
        assert "Crawl completed successfully" in log_messages

    @pytest.mark.asyncio
    async def test_progress_tracker_with_batch_data(self):
        """Test ProgressTracker with realistic batch processing data."""
        
        tracker = ProgressTracker("batch-test-456", "crawl")
        
        # Simulate batch processing updates
        batches = [
            (1, 6, 0, "Starting batch 1/6 (25 chunks)"),
            (2, 6, 1, "Starting batch 2/6 (25 chunks)"), 
            (3, 6, 2, "Starting batch 3/6 (25 chunks)"),
            (4, 6, 3, "Starting batch 4/6 (25 chunks)"),
            (5, 6, 4, "Starting batch 5/6 (25 chunks)"),
            (6, 6, 5, "Starting batch 6/6 (15 chunks)")
        ]
        
        for current, total, completed, message in batches:
            progress = int((completed / total) * 100)
            
            await tracker.update(
                status="document_storage",
                progress=progress,
                log=message,
                current_batch=current,
                total_batches=total,
                completed_batches=completed,
                chunks_in_batch=25 if current < 6 else 15,
                active_workers=4
            )
        
        # Verify batch data is preserved
        final_state = tracker.get_state()
        assert final_state["current_batch"] == 6
        assert final_state["total_batches"] == 6
        assert final_state["completed_batches"] == 5
        assert final_state["active_workers"] == 4

    @pytest.mark.asyncio
    async def test_concurrent_progress_trackers(self):
        """Test that multiple concurrent progress trackers work independently."""
        
        tracker1 = ProgressTracker("concurrent-1", "crawl")
        tracker2 = ProgressTracker("concurrent-2", "upload")
        tracker3 = ProgressTracker("concurrent-3", "crawl")
        
        # Update all trackers concurrently
        async def update_tracker(tracker, prefix):
            for i in range(5):
                await tracker.update(
                    status="processing",
                    progress=i * 20,
                    log=f"{prefix} progress update {i}",
                    custom_field=f"{prefix}_data_{i}"
                )
                # Small delay to simulate real work
                await asyncio.sleep(0.01)
        
        # Run all updates concurrently
        await asyncio.gather(
            update_tracker(tracker1, "Crawl1"),
            update_tracker(tracker2, "Upload"), 
            update_tracker(tracker3, "Crawl3")
        )
        
        # Verify each tracker maintains independent state
        state1 = ProgressTracker.get_progress("concurrent-1")
        state2 = ProgressTracker.get_progress("concurrent-2")
        state3 = ProgressTracker.get_progress("concurrent-3")
        
        assert state1["type"] == "crawl"
        assert state2["type"] == "upload" 
        assert state3["type"] == "crawl"
        
        assert "Crawl1 progress update" in state1["log"]
        assert "Upload progress update" in state2["log"]
        assert "Crawl3 progress update" in state3["log"]
        
        # Verify logs are independent
        assert len(state1["logs"]) == 5
        assert len(state2["logs"]) == 5
        assert len(state3["logs"]) == 5
        
        # Clean up
        ProgressTracker.clear_progress("concurrent-1")
        ProgressTracker.clear_progress("concurrent-2")
        ProgressTracker.clear_progress("concurrent-3")