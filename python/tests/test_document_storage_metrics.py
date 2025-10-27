"""
Test document storage metrics calculation.

This test ensures that avg_chunks_per_doc is calculated correctly
and handles edge cases like empty documents.
"""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from src.server.services.crawling.document_storage_operations import DocumentStorageOperations


class TestDocumentStorageMetrics:
    """Test metrics calculation in document storage operations."""

    @pytest.mark.asyncio
    async def test_avg_chunks_calculation_with_empty_docs(self):
        """Test that avg_chunks_per_doc handles empty documents correctly."""
        # Create mock supabase client
        mock_supabase = Mock()
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock the storage service
        doc_storage.doc_storage_service.smart_chunk_text = Mock(
            side_effect=lambda text, chunk_size: ["chunk1", "chunk2"] if text else []
        )
        
        # Mock internal methods
        doc_storage._create_source_records = AsyncMock()
        
        # Track what gets logged
        logged_messages = []
        
        with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info') as mock_log:
            mock_log.side_effect = lambda msg: logged_messages.append(msg)
            
            with patch('src.server.services.crawling.document_storage_operations.add_documents_to_supabase'):
                # Test data with mix of empty and non-empty documents
                crawl_results = [
                    {"url": "https://example.com/page1", "markdown": "Content 1"},
                    {"url": "https://example.com/page2", "markdown": ""},  # Empty
                    {"url": "https://example.com/page3", "markdown": "Content 3"},
                    {"url": "https://example.com/page4", "markdown": ""},  # Empty
                    {"url": "https://example.com/page5", "markdown": "Content 5"},
                ]
                
                result = await doc_storage.process_and_store_documents(
                    crawl_results=crawl_results,
                    request={},
                    crawl_type="test",
                    original_source_id="test123",
                    source_url="https://example.com",
                    source_display_name="Example"
                )
                
                # Find the metrics log message
                metrics_log = None
                for msg in logged_messages:
                    if "Document storage | processed=" in msg:
                        metrics_log = msg
                        break
                
                assert metrics_log is not None, "Should log metrics"
                
                # Verify metrics are correct
                # 3 documents processed (non-empty), 5 total, 6 chunks (2 per doc), avg = 2.0
                assert "processed=3/5" in metrics_log, "Should show 3 processed out of 5 total"
                assert "chunks=6" in metrics_log, "Should have 6 chunks total"
                assert "avg_chunks_per_doc=2.0" in metrics_log, "Average should be 2.0 (6/3)"

    @pytest.mark.asyncio
    async def test_avg_chunks_all_empty_docs(self):
        """Test that avg_chunks_per_doc handles all empty documents without division by zero."""
        mock_supabase = Mock()
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock the storage service
        doc_storage.doc_storage_service.smart_chunk_text = Mock(return_value=[])
        doc_storage._create_source_records = AsyncMock()
        
        logged_messages = []
        
        with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info') as mock_log:
            mock_log.side_effect = lambda msg: logged_messages.append(msg)
            
            with patch('src.server.services.crawling.document_storage_operations.add_documents_to_supabase'):
                # All documents are empty
                crawl_results = [
                    {"url": "https://example.com/page1", "markdown": ""},
                    {"url": "https://example.com/page2", "markdown": ""},
                    {"url": "https://example.com/page3", "markdown": ""},
                ]
                
                result = await doc_storage.process_and_store_documents(
                    crawl_results=crawl_results,
                    request={},
                    crawl_type="test",
                    original_source_id="test456",
                    source_url="https://example.com",
                    source_display_name="Example"
                )
                
                # Find the metrics log
                metrics_log = None
                for msg in logged_messages:
                    if "Document storage | processed=" in msg:
                        metrics_log = msg
                        break
                
                assert metrics_log is not None, "Should log metrics even with no processed docs"
                
                # Should show 0 processed, 0 chunks, 0.0 average (no division by zero)
                assert "processed=0/3" in metrics_log, "Should show 0 processed out of 3 total"
                assert "chunks=0" in metrics_log, "Should have 0 chunks"
                assert "avg_chunks_per_doc=0.0" in metrics_log, "Average should be 0.0 (no division by zero)"

    @pytest.mark.asyncio
    async def test_avg_chunks_single_doc(self):
        """Test avg_chunks_per_doc with a single document."""
        mock_supabase = Mock()
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock to return 5 chunks for content
        doc_storage.doc_storage_service.smart_chunk_text = Mock(
            return_value=["chunk1", "chunk2", "chunk3", "chunk4", "chunk5"]
        )
        doc_storage._create_source_records = AsyncMock()
        
        logged_messages = []
        
        with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info') as mock_log:
            mock_log.side_effect = lambda msg: logged_messages.append(msg)
            
            with patch('src.server.services.crawling.document_storage_operations.add_documents_to_supabase'):
                crawl_results = [
                    {"url": "https://example.com/page", "markdown": "Long content here..."},
                ]
                
                result = await doc_storage.process_and_store_documents(
                    crawl_results=crawl_results,
                    request={},
                    crawl_type="test",
                    original_source_id="test789",
                    source_url="https://example.com",
                    source_display_name="Example"
                )
                
                # Find metrics log
                metrics_log = None
                for msg in logged_messages:
                    if "Document storage | processed=" in msg:
                        metrics_log = msg
                        break
                
                assert metrics_log is not None
                assert "processed=1/1" in metrics_log, "Should show 1 processed out of 1 total"
                assert "chunks=5" in metrics_log, "Should have 5 chunks"
                assert "avg_chunks_per_doc=5.0" in metrics_log, "Average should be 5.0"

    @pytest.mark.asyncio
    async def test_processed_count_accuracy(self):
        """Test that processed_docs count is accurate."""
        mock_supabase = Mock()
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Track which documents are chunked
        chunked_urls = []
        
        def mock_chunk(text, chunk_size):
            if text:
                return ["chunk"]
            return []
        
        doc_storage.doc_storage_service.smart_chunk_text = Mock(side_effect=mock_chunk)
        doc_storage._create_source_records = AsyncMock()
        
        with patch('src.server.services.crawling.document_storage_operations.safe_logfire_info'):
            with patch('src.server.services.crawling.document_storage_operations.add_documents_to_supabase'):
                # Mix of documents with various content states
                crawl_results = [
                    {"url": "https://example.com/1", "markdown": "Content"},
                    {"url": "https://example.com/2", "markdown": ""},  # Empty markdown - skipped
                    {"url": "https://example.com/3", "markdown": None},  # None markdown - skipped
                    {"url": "https://example.com/4", "markdown": "More content"},
                    {"url": "https://example.com/5"},  # Missing markdown key - skipped
                    {"url": "https://example.com/6", "markdown": "   "},  # Whitespace only - skipped
                ]
                
                result = await doc_storage.process_and_store_documents(
                    crawl_results=crawl_results,
                    request={},
                    crawl_type="test",
                    original_source_id="test999",
                    source_url="https://example.com",
                    source_display_name="Example"
                )
                
                # Should process only documents 1 and 4 (documents with actual content)
                # Documents 2, 3, 5, 6 are skipped (empty, None, missing, or whitespace-only)
                assert result["chunk_count"] == 2, "Should have 2 chunks (one per processed doc with content)"
                
                # Check url_to_full_document only has processed docs
                assert len(result["url_to_full_document"]) == 2
                assert "https://example.com/1" in result["url_to_full_document"]
                assert "https://example.com/4" in result["url_to_full_document"]
                # Documents with no content should not be in the result
                assert "https://example.com/6" not in result["url_to_full_document"]