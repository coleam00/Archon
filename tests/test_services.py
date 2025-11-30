"""
Tests for the Services Layer.

This module tests the DocumentationService which encapsulates business logic
for documentation operations.
"""

import pytest
from typing import List

from archon.services import DocumentationService
from archon.domain import SitePage, SearchResult, SitePageMetadata
from archon.infrastructure.memory import InMemorySitePagesRepository, MockEmbeddingService


@pytest.fixture
def mock_repository():
    """Create an in-memory repository with sample data."""
    repo = InMemorySitePagesRepository()
    return repo


@pytest.fixture
def mock_embedding_service():
    """Create a mock embedding service."""
    return MockEmbeddingService()


@pytest.fixture
def documentation_service(mock_repository, mock_embedding_service):
    """Create a DocumentationService with mock dependencies."""
    return DocumentationService(
        repository=mock_repository,
        embedding_service=mock_embedding_service
    )


@pytest.fixture
async def populated_repository():
    """Create a repository populated with sample pages."""
    repo = InMemorySitePagesRepository()

    # Add some sample pages
    pages = [
        SitePage(
            url="https://ai.pydantic.dev/agents/",
            chunk_number=0,
            title="Agents - Pydantic AI",
            summary="Introduction to building agents",
            content="Pydantic AI is a Python framework for building production-grade applications with Generative AI.",
            metadata=SitePageMetadata(source="pydantic_ai_docs", chunk_size=1500),
            embedding=[0.1] * 1536,
        ),
        SitePage(
            url="https://ai.pydantic.dev/agents/",
            chunk_number=1,
            title="Agents - Pydantic AI",
            summary="Agent configuration",
            content="You can configure agents with custom tools, models, and dependencies.",
            metadata=SitePageMetadata(source="pydantic_ai_docs", chunk_size=1500),
            embedding=[0.2] * 1536,
        ),
        SitePage(
            url="https://ai.pydantic.dev/tools/",
            chunk_number=0,
            title="Tools - Pydantic AI",
            summary="Working with tools",
            content="Tools allow agents to interact with external systems and perform actions.",
            metadata=SitePageMetadata(source="pydantic_ai_docs", chunk_size=1500),
            embedding=[0.3] * 1536,
        ),
        SitePage(
            url="https://example.com/other/",
            chunk_number=0,
            title="Other Documentation",
            summary="Some other docs",
            content="This is from a different source.",
            metadata=SitePageMetadata(source="other_docs", chunk_size=1000),
            embedding=[0.4] * 1536,
        ),
    ]

    await repo.insert_batch(pages)
    return repo


class TestDocumentationService:
    """Tests for DocumentationService."""

    @pytest.mark.asyncio
    async def test_search_documentation_basic(self, populated_repository, mock_embedding_service):
        """Test basic documentation search."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        results = await service.search_documentation("agents", limit=5)

        assert isinstance(results, list)
        assert len(results) > 0
        assert all(isinstance(r, SearchResult) for r in results)
        # Results should be ordered by similarity
        similarities = [r.similarity for r in results]
        assert similarities == sorted(similarities, reverse=True)

    @pytest.mark.asyncio
    async def test_search_documentation_with_source_filter(self, populated_repository, mock_embedding_service):
        """Test documentation search with source filter."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        # Search with source filter
        results = await service.search_documentation(
            "documentation",
            limit=10,
            source="pydantic_ai_docs"
        )

        # All results should be from the specified source
        assert all(
            r.page.metadata.source == "pydantic_ai_docs"
            for r in results
        )

    @pytest.mark.asyncio
    async def test_search_documentation_limit(self, populated_repository, mock_embedding_service):
        """Test that search respects the limit parameter."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        results = await service.search_documentation("docs", limit=2)

        assert len(results) <= 2

    @pytest.mark.asyncio
    async def test_get_page_content_single_chunk(self, populated_repository, mock_embedding_service):
        """Test retrieving content for a page with a single chunk."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        content = await service.get_page_content("https://ai.pydantic.dev/tools/")

        assert isinstance(content, str)
        assert "Tools allow agents to interact with external systems" in content

    @pytest.mark.asyncio
    async def test_get_page_content_multiple_chunks(self, populated_repository, mock_embedding_service):
        """Test retrieving content for a page with multiple chunks."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        content = await service.get_page_content("https://ai.pydantic.dev/agents/")

        assert isinstance(content, str)
        # Should contain content from both chunks
        assert "Pydantic AI is a Python framework" in content
        assert "You can configure agents" in content
        # Chunks should be separated by double newline
        assert "\n\n" in content

    @pytest.mark.asyncio
    async def test_get_page_content_not_found(self, populated_repository, mock_embedding_service):
        """Test get_page_content raises ValueError for non-existent URL."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        with pytest.raises(ValueError, match="No content found for URL"):
            await service.get_page_content("https://nonexistent.com/page/")

    @pytest.mark.asyncio
    async def test_list_available_pages_all(self, populated_repository, mock_embedding_service):
        """Test listing all available pages."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        urls = await service.list_available_pages()

        assert isinstance(urls, list)
        assert len(urls) == 3  # 3 unique URLs in test data
        assert "https://ai.pydantic.dev/agents/" in urls
        assert "https://ai.pydantic.dev/tools/" in urls
        assert "https://example.com/other/" in urls

    @pytest.mark.asyncio
    async def test_list_available_pages_with_source(self, populated_repository, mock_embedding_service):
        """Test listing pages filtered by source."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        urls = await service.list_available_pages(source="pydantic_ai_docs")

        assert isinstance(urls, list)
        assert len(urls) == 2  # 2 URLs from pydantic_ai_docs
        assert "https://ai.pydantic.dev/agents/" in urls
        assert "https://ai.pydantic.dev/tools/" in urls
        assert "https://example.com/other/" not in urls

    @pytest.mark.asyncio
    async def test_get_page_metadata(self, populated_repository, mock_embedding_service):
        """Test retrieving page metadata."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        metadata = await service.get_page_metadata("https://ai.pydantic.dev/agents/")

        assert isinstance(metadata, dict)
        assert metadata["source"] == "pydantic_ai_docs"
        assert metadata["chunk_size"] == 1500

    @pytest.mark.asyncio
    async def test_get_page_metadata_not_found(self, populated_repository, mock_embedding_service):
        """Test get_page_metadata returns None for non-existent URL."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        metadata = await service.get_page_metadata("https://nonexistent.com/page/")

        assert metadata is None

    @pytest.mark.asyncio
    async def test_count_pages_total(self, populated_repository, mock_embedding_service):
        """Test counting total pages."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        count = await service.count_pages()

        assert count == 4  # 4 chunks total in test data

    @pytest.mark.asyncio
    async def test_count_pages_by_source(self, populated_repository, mock_embedding_service):
        """Test counting pages filtered by source."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        count = await service.count_pages(source="pydantic_ai_docs")

        assert count == 3  # 3 chunks from pydantic_ai_docs

    @pytest.mark.asyncio
    async def test_empty_repository(self, mock_repository, mock_embedding_service):
        """Test service operations on empty repository."""
        service = DocumentationService(
            repository=mock_repository,
            embedding_service=mock_embedding_service
        )

        # Search should return empty list
        results = await service.search_documentation("query")
        assert results == []

        # List should return empty list
        urls = await service.list_available_pages()
        assert urls == []

        # Count should return 0
        count = await service.count_pages()
        assert count == 0

        # Get content should raise ValueError
        with pytest.raises(ValueError):
            await service.get_page_content("https://example.com/")


class TestDocumentationServiceIntegration:
    """Integration tests for DocumentationService."""

    @pytest.mark.asyncio
    async def test_service_workflow(self, populated_repository, mock_embedding_service):
        """Test complete workflow: list, search, retrieve content."""
        service = DocumentationService(
            repository=populated_repository,
            embedding_service=mock_embedding_service
        )

        # 1. List available pages
        urls = await service.list_available_pages(source="pydantic_ai_docs")
        assert len(urls) > 0

        # 2. Search for relevant content
        results = await service.search_documentation("agents", limit=3)
        assert len(results) > 0

        # 3. Retrieve full content for top result
        top_url = results[0].page.url
        content = await service.get_page_content(top_url)
        assert len(content) > 0

        # 4. Get metadata
        metadata = await service.get_page_metadata(top_url)
        assert metadata is not None
        assert "source" in metadata
