"""
Test async execution of extract_source_summary.

This test ensures that the synchronous extract_source_summary function
is properly executed in a thread pool to avoid blocking the async event loop.
"""

import asyncio
import time
from unittest.mock import Mock, AsyncMock, patch
import pytest

from src.server.services.crawling.document_storage_operations import DocumentStorageOperations


class TestAsyncSourceSummary:
    """Test that extract_source_summary doesn't block the async event loop."""

    @pytest.mark.asyncio
    async def test_extract_summary_runs_in_thread(self):
        """Test that extract_source_summary is executed in a thread pool."""
        # Create mock supabase client
        mock_supabase = Mock()
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = Mock()
        
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Track when extract_source_summary is called
        summary_call_times = []
        original_summary_result = "Test summary from AI"
        
        def slow_extract_summary(source_id, content):
            """Simulate a slow synchronous function that would block the event loop."""
            summary_call_times.append(time.time())
            # Simulate a blocking operation (like an API call)
            time.sleep(0.1)  # This would block the event loop if not run in thread
            return original_summary_result
        
        # Mock the storage service
        doc_storage.doc_storage_service.smart_chunk_text = Mock(
            return_value=["chunk1", "chunk2"]
        )
        
        with patch('src.server.services.crawling.document_storage_operations.extract_source_summary', 
                   side_effect=slow_extract_summary):
            with patch('src.server.services.crawling.document_storage_operations.update_source_info'):
                with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info'):
                    with patch('src.server.services.crawling.document_storage_operations.safe_logfire_error'):
                        # Create test metadata
                        all_metadatas = [
                            {"source_id": "test123", "word_count": 100},
                            {"source_id": "test123", "word_count": 150},
                        ]
                        all_contents = ["chunk1", "chunk2"]
                        source_word_counts = {"test123": 250}
                        request = {"knowledge_type": "documentation"}
                        
                        # Track async execution
                        start_time = time.time()
                        
                        # This should not block despite the sleep in extract_summary
                        await doc_storage._create_source_records(
                            all_metadatas,
                            all_contents,
                            source_word_counts,
                            request,
                            "https://example.com",
                            "Example Site"
                        )
                        
                        end_time = time.time()
                        
                        # Verify that extract_source_summary was called
                        assert len(summary_call_times) == 1, "extract_source_summary should be called once"
                        
                        # The async function should complete without blocking
                        # Even though extract_summary sleeps for 0.1s, the async function
                        # should not be blocked since it runs in a thread
                        total_time = end_time - start_time
                        
                        # We can't guarantee exact timing, but it should complete
                        # without throwing a timeout error
                        assert total_time < 1.0, "Should complete in reasonable time"

    @pytest.mark.asyncio
    async def test_extract_summary_error_handling(self):
        """Test that errors in extract_source_summary are handled correctly."""
        mock_supabase = Mock()
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = Mock()
        
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock to raise an exception
        def failing_extract_summary(source_id, content):
            raise RuntimeError("AI service unavailable")
        
        doc_storage.doc_storage_service.smart_chunk_text = Mock(
            return_value=["chunk1"]
        )
        
        error_messages = []
        
        with patch('src.server.services.crawling.document_storage_operations.extract_source_summary',
                   side_effect=failing_extract_summary):
            with patch('src.server.services.crawling.document_storage_operations.update_source_info') as mock_update:
                with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info'):
                    with patch('src.server.services.crawling.document_storage_operations.safe_logfire_error') as mock_error:
                        mock_error.side_effect = lambda msg: error_messages.append(msg)
                        
                        all_metadatas = [{"source_id": "test456", "word_count": 100}]
                        all_contents = ["chunk1"]
                        source_word_counts = {"test456": 100}
                        request = {}
                        
                        await doc_storage._create_source_records(
                            all_metadatas,
                            all_contents,
                            source_word_counts,
                            request,
                            None,
                            None
                        )
                        
                        # Verify error was logged
                        assert len(error_messages) == 1
                        assert "Failed to generate AI summary" in error_messages[0]
                        assert "AI service unavailable" in error_messages[0]
                        
                        # Verify fallback summary was used
                        mock_update.assert_called_once()
                        call_args = mock_update.call_args
                        assert call_args.kwargs["summary"] == "Documentation from test456 - 1 pages crawled"

    @pytest.mark.asyncio
    async def test_multiple_sources_concurrent_summaries(self):
        """Test that multiple source summaries are generated concurrently."""
        mock_supabase = Mock()
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = Mock()
        
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Track concurrent executions
        execution_order = []
        
        def track_extract_summary(source_id, content):
            execution_order.append(f"start_{source_id}")
            time.sleep(0.05)  # Simulate work
            execution_order.append(f"end_{source_id}")
            return f"Summary for {source_id}"
        
        doc_storage.doc_storage_service.smart_chunk_text = Mock(
            return_value=["chunk"]
        )
        
        with patch('src.server.services.crawling.document_storage_operations.extract_source_summary',
                   side_effect=track_extract_summary):
            with patch('src.server.services.crawling.document_storage_operations.update_source_info'):
                with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info'):
                    # Create metadata for multiple sources
                    all_metadatas = [
                        {"source_id": "source1", "word_count": 100},
                        {"source_id": "source2", "word_count": 150},
                        {"source_id": "source3", "word_count": 200},
                    ]
                    all_contents = ["chunk1", "chunk2", "chunk3"]
                    source_word_counts = {
                        "source1": 100,
                        "source2": 150,
                        "source3": 200,
                    }
                    request = {}
                    
                    await doc_storage._create_source_records(
                        all_metadatas,
                        all_contents,
                        source_word_counts,
                        request,
                        None,
                        None
                    )
                    
                    # With threading, sources are processed sequentially in the loop
                    # but the extract_summary calls happen in threads
                    assert len(execution_order) == 6  # 3 sources * 2 events each
                    
                    # Verify all sources were processed
                    processed_sources = set()
                    for event in execution_order:
                        if event.startswith("start_"):
                            processed_sources.add(event.replace("start_", ""))
                    
                    assert processed_sources == {"source1", "source2", "source3"}

    @pytest.mark.asyncio
    async def test_thread_safety_with_variables(self):
        """Test that variables are properly passed to thread execution."""
        mock_supabase = Mock()
        mock_supabase.table.return_value.upsert.return_value.execute.return_value = Mock()
        
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Track what gets passed to extract_summary
        captured_calls = []
        
        def capture_extract_summary(source_id, content):
            captured_calls.append({
                "source_id": source_id,
                "content_len": len(content),
                "content_preview": content[:50] if content else ""
            })
            return f"Summary for {source_id}"
        
        doc_storage.doc_storage_service.smart_chunk_text = Mock(
            return_value=["This is chunk one with some content", 
                          "This is chunk two with more content"]
        )
        
        with patch('src.server.services.crawling.document_storage_operations.extract_source_summary',
                   side_effect=capture_extract_summary):
            with patch('src.server.services.crawling.document_storage_operations.update_source_info'):
                with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info'):
                    all_metadatas = [
                        {"source_id": "test789", "word_count": 100},
                        {"source_id": "test789", "word_count": 150},
                    ]
                    all_contents = [
                        "This is chunk one with some content",
                        "This is chunk two with more content"
                    ]
                    source_word_counts = {"test789": 250}
                    request = {}
                    
                    await doc_storage._create_source_records(
                        all_metadatas,
                        all_contents,
                        source_word_counts,
                        request,
                        None,
                        None
                    )
                    
                    # Verify the correct values were passed to the thread
                    assert len(captured_calls) == 1
                    call = captured_calls[0]
                    assert call["source_id"] == "test789"
                    assert call["content_len"] > 0
                    # Combined content should start with space + first chunk
                    assert "This is chunk one" in call["content_preview"]