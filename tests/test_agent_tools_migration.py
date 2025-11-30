"""
Unit tests for agent_tools.py Phase 3 migration.

These tests validate that agent_tools functions work correctly with the new
repository pattern while maintaining backward compatibility.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    get_page_content_tool,
    get_embedding
)
from archon.domain.models import SitePage, SitePageMetadata, SearchResult
from archon.infrastructure.memory import InMemorySitePagesRepository, MockEmbeddingService


class TestGetEmbeddingMigration:
    """Test get_embedding() with both legacy and new implementations."""

    @pytest.mark.asyncio
    async def test_with_embedding_service(self):
        """Test get_embedding with IEmbeddingService."""
        service = MockEmbeddingService()
        result = await get_embedding("test query", embedding_service=service)

        assert isinstance(result, list)
        assert len(result) == 1536
        assert all(isinstance(x, float) for x in result)

    @pytest.mark.asyncio
    async def test_with_legacy_client(self):
        """Test get_embedding with legacy AsyncOpenAI client."""
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1] * 1536)]
        mock_client.embeddings.create.return_value = mock_response

        result = await get_embedding("test query", embedding_client=mock_client)

        assert isinstance(result, list)
        assert len(result) == 1536
        mock_client.embeddings.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_prefers_embedding_service_over_client(self):
        """Test that embedding_service is preferred when both are provided."""
        service = MockEmbeddingService()
        mock_client = AsyncMock()

        result = await get_embedding(
            "test query",
            embedding_client=mock_client,
            embedding_service=service
        )

        # Should use service, not client
        assert isinstance(result, list)
        mock_client.embeddings.create.assert_not_called()

    @pytest.mark.asyncio
    async def test_returns_zero_vector_when_neither_provided(self):
        """Test that zero vector is returned when neither service nor client is provided (error handling)."""
        result = await get_embedding("test query")
        # Should return zero vector due to error handling
        assert result == [0] * 1536


class TestRetrieveRelevantDocumentationMigration:
    """Test retrieve_relevant_documentation_tool with repository pattern."""

    @pytest.mark.asyncio
    async def test_with_repository(self):
        """Test retrieve documentation with repository pattern."""
        # Setup
        repo = InMemorySitePagesRepository()
        embedding_service = MockEmbeddingService()

        # Generate embedding for our test query using the same service
        # This ensures we'll get a high similarity match
        query_text = "agents"
        test_embedding = await embedding_service.get_embedding(query_text)

        # Add test data WITH EMBEDDING (required for similarity search)
        # Use similar content so the embedding will be similar
        page1 = SitePage(
            url="https://ai.pydantic.dev/agents/",
            chunk_number=0,
            title="Agents - Pydantic AI",
            summary="Introduction to agents",
            content="This is about agents.",
            embedding=test_embedding,  # Same embedding = 100% similarity
            metadata=SitePageMetadata(source="pydantic_ai_docs")
        )
        await repo.insert(page1)

        # Execute
        result = await retrieve_relevant_documentation_tool(
            repository=repo,
            embedding_service=embedding_service,
            user_query=query_text
        )

        # Verify
        assert isinstance(result, str)
        assert "Agents - Pydantic AI" in result
        assert "This is about agents." in result

    @pytest.mark.asyncio
    async def test_with_legacy_supabase(self):
        """Test retrieve documentation with legacy Supabase client."""
        # Setup mock Supabase client
        mock_supabase = MagicMock()
        mock_rpc_result = MagicMock()
        mock_rpc_result.data = [
            {
                'title': 'Test Title',
                'content': 'Test content',
                'similarity': 0.95
            }
        ]
        mock_supabase.rpc.return_value.execute.return_value = mock_rpc_result

        # Mock embedding client
        mock_embedding_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1] * 1536)]
        mock_embedding_client.embeddings.create.return_value = mock_response

        # Execute
        result = await retrieve_relevant_documentation_tool(
            supabase=mock_supabase,
            embedding_client=mock_embedding_client,
            user_query="test query"
        )

        # Verify
        assert isinstance(result, str)
        assert "Test Title" in result
        assert "Test content" in result
        mock_supabase.rpc.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_results_returns_message(self):
        """Test that 'No relevant documentation found' is returned when no results."""
        repo = InMemorySitePagesRepository()
        embedding_service = MockEmbeddingService()

        result = await retrieve_relevant_documentation_tool(
            repository=repo,
            embedding_service=embedding_service,
            user_query="nonexistent topic"
        )

        assert result == "No relevant documentation found."


class TestListDocumentationPagesMigration:
    """Test list_documentation_pages_tool with repository pattern."""

    @pytest.mark.asyncio
    async def test_with_repository(self):
        """Test list pages with repository pattern."""
        # Setup
        repo = InMemorySitePagesRepository()

        # Add test data
        page1 = SitePage(
            url="https://ai.pydantic.dev/agents/",
            chunk_number=0,
            title="Agents",
            content="Content",
            metadata=SitePageMetadata(source="pydantic_ai_docs")
        )
        page2 = SitePage(
            url="https://ai.pydantic.dev/tools/",
            chunk_number=0,
            title="Tools",
            content="Content",
            metadata=SitePageMetadata(source="pydantic_ai_docs")
        )
        await repo.insert(page1)
        await repo.insert(page2)

        # Execute
        result = await list_documentation_pages_tool(repository=repo)

        # Verify
        assert isinstance(result, list)
        assert len(result) == 2
        assert all(isinstance(url, str) for url in result)
        assert "https://ai.pydantic.dev/agents/" in result
        assert "https://ai.pydantic.dev/tools/" in result

    @pytest.mark.asyncio
    async def test_with_legacy_supabase(self):
        """Test list pages with legacy Supabase client."""
        # Setup mock Supabase client
        mock_supabase = MagicMock()
        mock_result = MagicMock()
        mock_result.data = [
            {'url': 'https://example.com/page1'},
            {'url': 'https://example.com/page2'},
            {'url': 'https://example.com/page1'}  # Duplicate
        ]

        # Chain mocking for .from_().select().eq().execute()
        mock_supabase.from_.return_value.select.return_value.eq.return_value.execute.return_value = mock_result

        # Execute
        result = await list_documentation_pages_tool(supabase=mock_supabase)

        # Verify
        assert isinstance(result, list)
        assert len(result) == 2  # Duplicates removed
        assert sorted(result) == result  # Sorted

    @pytest.mark.asyncio
    async def test_empty_repository_returns_empty_list(self):
        """Test that empty repository returns empty list."""
        repo = InMemorySitePagesRepository()

        result = await list_documentation_pages_tool(repository=repo)

        assert result == []


class TestGetPageContentMigration:
    """Test get_page_content_tool with repository pattern."""

    @pytest.mark.asyncio
    async def test_with_repository(self):
        """Test get page content with repository pattern."""
        # Setup
        repo = InMemorySitePagesRepository()

        # Add test data with multiple chunks
        page1 = SitePage(
            url="https://ai.pydantic.dev/agents/",
            chunk_number=0,
            title="Agents - Introduction",
            content="First chunk content",
            metadata=SitePageMetadata(source="pydantic_ai_docs")
        )
        page2 = SitePage(
            url="https://ai.pydantic.dev/agents/",
            chunk_number=1,
            title="Agents - Details",
            content="Second chunk content",
            metadata=SitePageMetadata(source="pydantic_ai_docs")
        )
        await repo.insert(page1)
        await repo.insert(page2)

        # Execute
        result = await get_page_content_tool(
            repository=repo,
            url="https://ai.pydantic.dev/agents/"
        )

        # Verify
        assert isinstance(result, str)
        assert result.startswith("# Agents")
        assert "First chunk content" in result
        assert "Second chunk content" in result

    @pytest.mark.asyncio
    async def test_with_legacy_supabase(self):
        """Test get page content with legacy Supabase client."""
        # Setup mock Supabase client
        mock_supabase = MagicMock()
        mock_result = MagicMock()
        mock_result.data = [
            {
                'title': 'Test Page - Part 1',
                'content': 'Content 1',
                'chunk_number': 0
            },
            {
                'title': 'Test Page - Part 2',
                'content': 'Content 2',
                'chunk_number': 1
            }
        ]

        # Chain mocking
        mock_supabase.from_.return_value.select.return_value.eq.return_value.eq.return_value.order.return_value.execute.return_value = mock_result

        # Execute
        result = await get_page_content_tool(
            supabase=mock_supabase,
            url="https://example.com/page"
        )

        # Verify
        assert isinstance(result, str)
        assert "# Test Page" in result
        assert "Content 1" in result
        assert "Content 2" in result

    @pytest.mark.asyncio
    async def test_unknown_url_returns_message(self):
        """Test that unknown URL returns appropriate message."""
        repo = InMemorySitePagesRepository()

        result = await get_page_content_tool(
            repository=repo,
            url="https://nonexistent.com/page"
        )

        assert "No content found for URL" in result

    @pytest.mark.asyncio
    async def test_content_length_limit(self):
        """Test that content is limited to 20000 characters."""
        repo = InMemorySitePagesRepository()

        # Add page with very long content
        long_content = "x" * 25000
        page = SitePage(
            url="https://example.com/long",
            chunk_number=0,
            title="Long Page",
            content=long_content,
            metadata=SitePageMetadata(source="pydantic_ai_docs")
        )
        await repo.insert(page)

        # Execute
        result = await get_page_content_tool(
            repository=repo,
            url="https://example.com/long"
        )

        # Verify length limit
        assert len(result) <= 20000


class TestBackwardCompatibility:
    """Test that legacy code paths still work."""

    @pytest.mark.asyncio
    async def test_returns_error_message_when_neither_provided(self):
        """Test that functions return error messages when neither legacy nor new params provided."""
        # list_documentation_pages_tool returns empty list on error
        result1 = await list_documentation_pages_tool()
        assert result1 == []

        # get_page_content_tool returns error message
        result2 = await get_page_content_tool(url="https://example.com")
        assert "Error retrieving page content" in result2

        # retrieve_relevant_documentation_tool returns error message
        result3 = await retrieve_relevant_documentation_tool(user_query="test")
        assert "Error retrieving documentation" in result3
