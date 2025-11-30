"""
Tests for crawl_pydantic_ai_docs.py migration to repository pattern.

These tests verify that:
1. Functions accept repository and embedding_service parameters
2. Functions work with injected dependencies
3. Backward compatibility is maintained with global clients
"""
import pytest
import asyncio
from unittest.mock import Mock, AsyncMock, patch
from uuid import uuid4

from archon.domain import SitePage, ISitePagesRepository, IEmbeddingService
from archon.infrastructure.memory import InMemorySitePagesRepository, MockEmbeddingService


# Import functions from crawl module
# Note: This will fail if html2text is not installed, but syntax is correct
try:
    from archon.crawl_pydantic_ai_docs import (
        get_embedding,
        insert_chunk,
        process_chunk,
        clear_existing_records,
        ProcessedChunk
    )
    CRAWL_MODULE_AVAILABLE = True
except ImportError as e:
    CRAWL_MODULE_AVAILABLE = False
    IMPORT_ERROR = str(e)


@pytest.mark.skipif(not CRAWL_MODULE_AVAILABLE, reason=f"Crawl module not available: {IMPORT_ERROR if not CRAWL_MODULE_AVAILABLE else ''}")
class TestCrawlMigration:
    """Tests for crawl_pydantic_ai_docs.py migration."""

    @pytest.mark.asyncio
    async def test_get_embedding_with_injected_service(self):
        """Test get_embedding() accepts embedding_service parameter."""
        mock_service = MockEmbeddingService()

        embedding = await get_embedding("test text", embedding_service=mock_service)

        assert isinstance(embedding, list)
        assert len(embedding) == 1536
        assert all(isinstance(x, float) for x in embedding)

    @pytest.mark.asyncio
    async def test_insert_chunk_with_injected_repository(self):
        """Test insert_chunk() accepts repository parameter."""
        repo = InMemorySitePagesRepository()

        chunk = ProcessedChunk(
            url="https://example.com/test",
            chunk_number=0,
            title="Test Title",
            summary="Test Summary",
            content="Test Content",
            metadata={"source": "pydantic_ai_docs"},
            embedding=[0.1] * 1536
        )

        result = await insert_chunk(chunk, repository=repo)

        assert result is not None
        assert isinstance(result, SitePage)
        assert result.url == "https://example.com/test"
        assert result.title == "Test Title"

    @pytest.mark.asyncio
    async def test_process_chunk_with_injected_service(self):
        """Test process_chunk() accepts embedding_service parameter."""
        mock_service = MockEmbeddingService()

        # Mock get_title_and_summary to avoid LLM calls
        with patch('archon.crawl_pydantic_ai_docs.get_title_and_summary') as mock_title:
            mock_title.return_value = {
                "title": "Test Title",
                "summary": "Test Summary"
            }

            chunk = await process_chunk(
                chunk="Test content",
                chunk_number=0,
                url="https://example.com/test",
                embedding_service=mock_service
            )

        assert isinstance(chunk, ProcessedChunk)
        assert chunk.url == "https://example.com/test"
        assert chunk.title == "Test Title"
        assert len(chunk.embedding) == 1536

    @pytest.mark.asyncio
    async def test_clear_existing_records_with_injected_repository(self):
        """Test clear_existing_records() accepts repository parameter."""
        repo = InMemorySitePagesRepository()

        # Add some test pages
        page1 = SitePage(
            id=None,  # Will be assigned by repository
            url="https://example.com/1",
            chunk_number=0,
            title="Test 1",
            summary="Summary 1",
            content="Content 1",
            metadata={"source": "pydantic_ai_docs"},
            embedding=[0.1] * 1536
        )
        page2 = SitePage(
            id=None,  # Will be assigned by repository
            url="https://example.com/2",
            chunk_number=0,
            title="Test 2",
            summary="Summary 2",
            content="Content 2",
            metadata={"source": "other_source"},
            embedding=[0.2] * 1536
        )

        await repo.insert(page1)
        await repo.insert(page2)

        # Clear pydantic_ai_docs records
        count = await clear_existing_records(repository=repo)

        assert count == 1  # Only pydantic_ai_docs should be deleted

        # Verify remaining records
        total_count = await repo.count()
        other_source_count = await repo.count({"metadata.source": "other_source"})

        assert total_count == 1  # Other record should remain
        assert other_source_count == 1

    @pytest.mark.asyncio
    async def test_backward_compatibility_without_params(self):
        """Test that functions still work without injected params (backward compatibility)."""
        # This test verifies signature compatibility
        # We can't test execution without global clients, but we can verify the signature

        import inspect

        # Check get_embedding signature
        sig = inspect.signature(get_embedding)
        assert 'text' in sig.parameters
        assert 'embedding_service' in sig.parameters
        assert sig.parameters['embedding_service'].default is None

        # Check insert_chunk signature
        sig = inspect.signature(insert_chunk)
        assert 'chunk' in sig.parameters
        assert 'repository' in sig.parameters
        assert sig.parameters['repository'].default is None

        # Check clear_existing_records signature
        sig = inspect.signature(clear_existing_records)
        assert 'repository' in sig.parameters
        assert sig.parameters['repository'].default is None

    def test_all_modified_functions_have_optional_params(self):
        """Verify that all modified functions have optional repository/embedding_service params."""
        import inspect

        # List of functions that should have optional params
        functions_to_check = [
            (get_embedding, 'embedding_service'),
            (insert_chunk, 'repository'),
            (clear_existing_records, 'repository'),
            (process_chunk, 'embedding_service'),
        ]

        for func, param_name in functions_to_check:
            sig = inspect.signature(func)
            assert param_name in sig.parameters, f"{func.__name__} should have {param_name} parameter"
            assert sig.parameters[param_name].default is None, \
                f"{func.__name__}.{param_name} should be optional (default=None)"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
