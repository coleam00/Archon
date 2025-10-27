"""
Test that code extraction uses the correct source_id.

This test ensures that the fix for using hash-based source_ids
instead of domain-based source_ids works correctly.
"""

import pytest
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from src.server.services.crawling.code_extraction_service import CodeExtractionService
from src.server.services.crawling.document_storage_operations import DocumentStorageOperations


class TestCodeExtractionSourceId:
    """Test that code extraction properly uses the provided source_id."""

    @pytest.mark.asyncio
    async def test_code_extraction_uses_provided_source_id(self):
        """Test that code extraction uses the hash-based source_id, not domain."""
        # Create mock supabase client
        mock_supabase = Mock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        
        # Create service instance
        code_service = CodeExtractionService(mock_supabase)
        
        # Track what gets passed to the internal extraction method
        extracted_blocks = []
        
        async def mock_extract_blocks(crawl_results, source_id, progress_callback=None, start=0, end=100, cancellation_check=None):
            # Simulate finding code blocks and verify source_id is passed correctly
            for doc in crawl_results:
                extracted_blocks.append({
                    "block": {"code": "print('hello')", "language": "python"},
                    "source_url": doc["url"],
                    "source_id": source_id  # This should be the provided source_id
                })
            return extracted_blocks
        
        code_service._extract_code_blocks_from_documents = mock_extract_blocks
        code_service._generate_code_summaries = AsyncMock(return_value=[{"summary": "Test code"}])
        code_service._prepare_code_examples_for_storage = Mock(return_value=[
            {"source_id": extracted_blocks[0]["source_id"] if extracted_blocks else None}
        ])
        code_service._store_code_examples = AsyncMock(return_value=1)
        
        # Test data
        crawl_results = [
            {
                "url": "https://docs.mem0.ai/example",
                "markdown": "```python\nprint('hello')\n```"
            }
        ]
        
        url_to_full_document = {
            "https://docs.mem0.ai/example": "Full content with code"
        }
        
        # The correct hash-based source_id
        correct_source_id = "393224e227ba92eb"
        
        # Call the method with the correct source_id
        result = await code_service.extract_and_store_code_examples(
            crawl_results,
            url_to_full_document,
            correct_source_id,
            None
        )
        
        # Verify that extracted blocks use the correct source_id
        assert len(extracted_blocks) > 0, "Should have extracted at least one code block"
        
        for block in extracted_blocks:
            # Check that it's using the hash-based source_id, not the domain
            assert block["source_id"] == correct_source_id, \
                f"Should use hash-based source_id '{correct_source_id}', not domain"
            assert block["source_id"] != "docs.mem0.ai", \
                "Should NOT use domain-based source_id"

    @pytest.mark.asyncio
    async def test_document_storage_passes_source_id(self):
        """Test that DocumentStorageOperations passes source_id to code extraction."""
        # Create mock supabase client
        mock_supabase = Mock()
        
        # Create DocumentStorageOperations instance
        doc_storage = DocumentStorageOperations(mock_supabase)
        
        # Mock the code extraction service
        mock_extract = AsyncMock(return_value=5)
        doc_storage.code_extraction_service.extract_and_store_code_examples = mock_extract
        
        # Test data
        crawl_results = [{"url": "https://example.com", "markdown": "test"}]
        url_to_full_document = {"https://example.com": "test content"}
        source_id = "abc123def456"
        
        # Call the wrapper method
        result = await doc_storage.extract_and_store_code_examples(
            crawl_results,
            url_to_full_document,
            source_id,
            None
        )
        
        # Verify the correct source_id was passed (now with cancellation_check parameter)
        mock_extract.assert_called_once()
        args, kwargs = mock_extract.call_args
        assert args[0] == crawl_results
        assert args[1] == url_to_full_document
        assert args[2] == source_id
        assert args[3] is None
        assert args[4] is None
        assert args[5] is None
        assert args[6] is None
        assert result == 5

    @pytest.mark.asyncio
    async def test_no_domain_extraction_from_url(self):
        """Test that we're NOT extracting domain from URL anymore."""
        mock_supabase = Mock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        
        code_service = CodeExtractionService(mock_supabase)
        
        # Patch internal methods
        code_service._get_setting = AsyncMock(return_value=True)
        
        # Create a mock that will track what source_id is used
        source_ids_seen = []
        
        original_extract = code_service._extract_code_blocks_from_documents
        async def track_source_id(crawl_results, source_id, progress_callback=None, cancellation_check=None):
            source_ids_seen.append(source_id)
            return []  # Return empty list to skip further processing
        
        code_service._extract_code_blocks_from_documents = track_source_id
        
        # Test with various URLs that would produce different domains
        test_cases = [
            ("https://github.com/example/repo", "github123abc"),
            ("https://docs.python.org/guide", "python456def"),
            ("https://api.openai.com/v1", "openai789ghi"),
        ]
        
        for url, expected_source_id in test_cases:
            source_ids_seen.clear()
            
            crawl_results = [{"url": url, "markdown": "# Test"}]
            url_to_full_document = {url: "Full content"}
            
            await code_service.extract_and_store_code_examples(
                crawl_results,
                url_to_full_document,
                expected_source_id,
                None
            )
            
            # Verify the provided source_id was used
            assert len(source_ids_seen) == 1
            assert source_ids_seen[0] == expected_source_id
            # Verify it's NOT the domain
            assert "github.com" not in source_ids_seen[0]
            assert "python.org" not in source_ids_seen[0]
            assert "openai.com" not in source_ids_seen[0]

    def test_urlparse_not_imported(self):
        """Test that urlparse is not imported in code_extraction_service."""
        import src.server.services.crawling.code_extraction_service as module
        
        # Check that urlparse is not in the module's namespace
        assert not hasattr(module, 'urlparse'), \
            "urlparse should not be imported in code_extraction_service"
        
        # Check the module's actual imports
        import inspect
        source = inspect.getsource(module)
        assert "from urllib.parse import urlparse" not in source, \
            "Should not import urlparse since we don't extract domain from URL anymore"
