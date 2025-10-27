"""
Test that source_url parameter is not shadowed by document URLs.

This test ensures that the original crawl URL (e.g., sitemap URL)
is correctly passed to _create_source_records and not overwritten
by individual document URLs during processing.
"""

import pytest
from unittest.mock import Mock, AsyncMock, MagicMock, patch
from src.server.services.crawling.document_storage_operations import DocumentStorageOperations


class TestSourceUrlShadowing:
    """Test that source_url parameter is preserved correctly."""

    @pytest.mark.asyncio
    async def test_source_url_not_shadowed(self):
        """Test that the original source_url is passed to _create_source_records."""
        # Create mock supabase client
        mock_supabase = Mock()
        
        # Create DocumentStorageOperations instance
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock the storage service
        doc_storage.doc_storage_service.smart_chunk_text = Mock(return_value=["chunk1", "chunk2"])
        
        # Track what gets passed to _create_source_records
        captured_source_url = None
        async def mock_create_source_records(all_metadatas, all_contents, source_word_counts, 
                                            request, source_url, source_display_name):
            nonlocal captured_source_url
            captured_source_url = source_url
        
        doc_storage._create_source_records = mock_create_source_records
        
        # Mock add_documents_to_supabase
        with patch('src.server.services.crawling.document_storage_operations.add_documents_to_supabase') as mock_add:
            mock_add.return_value = {"chunks_stored": 3}
            
            # Test data - simulating a sitemap crawl
            original_source_url = "https://mem0.ai/sitemap.xml"
            crawl_results = [
                {
                    "url": "https://mem0.ai/page1",
                    "markdown": "Content of page 1",
                    "title": "Page 1"
                },
                {
                    "url": "https://mem0.ai/page2", 
                    "markdown": "Content of page 2",
                    "title": "Page 2"
                },
                {
                    "url": "https://mem0.ai/models/openai-o3",  # Last document URL
                    "markdown": "Content of models page",
                    "title": "Models"
                }
            ]
            
            request = {"knowledge_type": "documentation", "tags": []}
            
            # Call the method
            result = await doc_storage.process_and_store_documents(
                crawl_results=crawl_results,
                request=request,
                crawl_type="sitemap",
                original_source_id="test123",
                progress_callback=None,
                cancellation_check=None,
                source_url=original_source_url,  # This should NOT be overwritten
                source_display_name="Test Sitemap"
            )
            
            # Verify the original source_url was preserved
            assert captured_source_url == original_source_url, \
                f"source_url should be '{original_source_url}', not '{captured_source_url}'"
            
            # Verify it's NOT the last document's URL
            assert captured_source_url != "https://mem0.ai/models/openai-o3", \
                "source_url should NOT be overwritten with the last document's URL"
            
            # Verify url_to_full_document has correct URLs
            assert "https://mem0.ai/page1" in result["url_to_full_document"]
            assert "https://mem0.ai/page2" in result["url_to_full_document"]
            assert "https://mem0.ai/models/openai-o3" in result["url_to_full_document"]

    @pytest.mark.asyncio  
    async def test_metadata_uses_document_urls(self):
        """Test that metadata correctly uses individual document URLs."""
        mock_supabase = Mock()
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock the storage service
        doc_storage.doc_storage_service.smart_chunk_text = Mock(return_value=["chunk1"])
        
        # Capture metadata
        captured_metadatas = None
        async def mock_create_source_records(all_metadatas, all_contents, source_word_counts,
                                            request, source_url, source_display_name):
            nonlocal captured_metadatas
            captured_metadatas = all_metadatas
        
        doc_storage._create_source_records = mock_create_source_records
        
        with patch('src.server.services.crawling.document_storage_operations.add_documents_to_supabase') as mock_add:
            mock_add.return_value = {"chunks_stored": 2}
            crawl_results = [
                {"url": "https://example.com/doc1", "markdown": "Doc 1"},
                {"url": "https://example.com/doc2", "markdown": "Doc 2"}
            ]
            
            await doc_storage.process_and_store_documents(
                crawl_results=crawl_results,
                request={},
                crawl_type="normal",
                original_source_id="test456",
                source_url="https://example.com",
                source_display_name="Example"
            )
            
            # Each metadata should have the correct document URL
            assert captured_metadatas[0]["url"] == "https://example.com/doc1"
            assert captured_metadatas[1]["url"] == "https://example.com/doc2"