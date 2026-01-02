"""
Unit tests for CrawledPages Repository implementations.

Tests the InMemory implementation which validates the interface contract.
"""

import pytest

from src.server.domain.models.crawled_page import CrawledPageCreate, CrawledPageMetadata
from src.server.infrastructure.memory import InMemoryCrawledPagesRepository


@pytest.fixture
def repo():
    """Fresh InMemory repository for each test."""
    repository = InMemoryCrawledPagesRepository()
    yield repository
    repository.clear()


@pytest.fixture
def sample_page_create():
    """Sample page data for testing."""
    return CrawledPageCreate(
        url="https://docs.example.com/getting-started",
        chunk_number=0,
        content="This is the getting started guide content.",
        metadata={"title": "Getting Started", "source": "example-docs"},
        source_id="src_example",
        page_id="page_001",
        embedding=[0.1] * 1536,  # 1536-dim embedding
        embedding_dimension=1536,
        embedding_model="text-embedding-ada-002",
        llm_chat_model="gpt-4",
    )


@pytest.fixture
def sample_embedding():
    """Sample embedding vector for search tests."""
    return [0.1] * 1536


class TestInsert:
    """Tests for insert operations."""

    @pytest.mark.asyncio
    async def test_insert_creates_page_with_id(self, repo, sample_page_create):
        """Insert should create a page with a generated ID."""
        page = await repo.insert(sample_page_create)

        assert page.id is not None
        assert page.url == sample_page_create.url
        assert page.content == sample_page_create.content
        assert page.chunk_number == 0

    @pytest.mark.asyncio
    async def test_insert_stores_embedding(self, repo, sample_page_create):
        """Insert should store the embedding in the correct column."""
        page = await repo.insert(sample_page_create)

        assert page.embedding_1536 is not None
        assert len(page.embedding_1536) == 1536
        assert page.embedding_dimension == 1536

    @pytest.mark.asyncio
    async def test_insert_sets_created_at(self, repo, sample_page_create):
        """Insert should set created_at timestamp."""
        page = await repo.insert(sample_page_create)

        assert page.created_at is not None

    @pytest.mark.asyncio
    async def test_insert_batch_creates_multiple(self, repo):
        """Insert batch should create multiple pages."""
        pages_data = [
            CrawledPageCreate(
                url=f"https://docs.example.com/page-{i}",
                chunk_number=i,
                content=f"Content for page {i}",
                source_id="src_batch",
            )
            for i in range(5)
        ]

        pages = await repo.insert_batch(pages_data)

        assert len(pages) == 5
        assert all(p.id is not None for p in pages)


class TestGetById:
    """Tests for get_by_id operations."""

    @pytest.mark.asyncio
    async def test_get_by_id_returns_page(self, repo, sample_page_create):
        """Get by ID should return the correct page."""
        created = await repo.insert(sample_page_create)
        found = await repo.get_by_id(created.id)

        assert found is not None
        assert found.id == created.id
        assert found.url == created.url

    @pytest.mark.asyncio
    async def test_get_by_id_returns_none_for_missing(self, repo):
        """Get by ID should return None for non-existent ID."""
        found = await repo.get_by_id("non-existent-id")

        assert found is None


class TestFindByUrl:
    """Tests for find_by_url operations."""

    @pytest.mark.asyncio
    async def test_find_by_url_returns_all_chunks(self, repo):
        """Find by URL should return all chunks for that URL."""
        url = "https://docs.example.com/multi-chunk"
        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=url,
                chunk_number=i,
                content=f"Chunk {i} content",
                source_id="src_test",
            ))

        pages = await repo.find_by_url(url)

        assert len(pages) == 3
        assert [p.chunk_number for p in pages] == [0, 1, 2]

    @pytest.mark.asyncio
    async def test_find_by_url_returns_empty_for_missing(self, repo):
        """Find by URL should return empty list for non-existent URL."""
        pages = await repo.find_by_url("https://non-existent.com")

        assert pages == []


class TestFindBySource:
    """Tests for find_by_source operations."""

    @pytest.mark.asyncio
    async def test_find_by_source_returns_all_pages(self, repo):
        """Find by source should return all pages for that source."""
        source_id = "src_test_source"
        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/page-{i}",
                chunk_number=0,
                content=f"Page {i} content",
                source_id=source_id,
            ))

        # Add a page from different source
        await repo.insert(CrawledPageCreate(
            url="https://other.com/page",
            chunk_number=0,
            content="Other source",
            source_id="other_source",
        ))

        pages = await repo.find_by_source(source_id)

        assert len(pages) == 3
        assert all(p.source_id == source_id for p in pages)


class TestSearchSimilar:
    """Tests for vector similarity search."""

    @pytest.mark.asyncio
    async def test_search_similar_returns_matches(self, repo, sample_embedding):
        """Search similar should return matching pages."""
        # Insert pages with embeddings
        for i in range(5):
            embedding = [0.1 + (i * 0.01)] * 1536  # Slightly different embeddings
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/page-{i}",
                chunk_number=0,
                content=f"Page {i} content",
                source_id="src_search",
                embedding=embedding,
                embedding_dimension=1536,
            ))

        results = await repo.search_similar(sample_embedding, match_count=3)

        assert len(results) <= 3
        assert all(r.similarity > 0 for r in results)
        # Results should be sorted by similarity descending
        similarities = [r.similarity for r in results]
        assert similarities == sorted(similarities, reverse=True)

    @pytest.mark.asyncio
    async def test_search_similar_filters_by_source(self, repo, sample_embedding):
        """Search similar should filter by source_id."""
        # Insert pages from different sources
        await repo.insert(CrawledPageCreate(
            url="https://docs.example.com/target",
            chunk_number=0,
            content="Target source",
            source_id="target_source",
            embedding=sample_embedding,
            embedding_dimension=1536,
        ))
        await repo.insert(CrawledPageCreate(
            url="https://docs.example.com/other",
            chunk_number=0,
            content="Other source",
            source_id="other_source",
            embedding=sample_embedding,
            embedding_dimension=1536,
        ))

        results = await repo.search_similar(
            sample_embedding,
            match_count=10,
            source_id="target_source"
        )

        assert len(results) == 1
        assert results[0].item.source_id == "target_source"

    @pytest.mark.asyncio
    async def test_search_similar_respects_match_count(self, repo, sample_embedding):
        """Search similar should respect match_count limit."""
        # Insert more pages than match_count
        for i in range(10):
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/page-{i}",
                chunk_number=0,
                content=f"Page {i}",
                source_id="src_limit",
                embedding=sample_embedding,
                embedding_dimension=1536,
            ))

        results = await repo.search_similar(sample_embedding, match_count=3)

        assert len(results) == 3


class TestDelete:
    """Tests for delete operations."""

    @pytest.mark.asyncio
    async def test_delete_by_url_removes_all_chunks(self, repo):
        """Delete by URL should remove all chunks for that URL."""
        url = "https://docs.example.com/to-delete"
        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=url,
                chunk_number=i,
                content=f"Chunk {i}",
                source_id="src_delete",
            ))

        deleted = await repo.delete_by_url(url)

        assert deleted == 3
        assert await repo.find_by_url(url) == []

    @pytest.mark.asyncio
    async def test_delete_by_source_removes_all_pages(self, repo):
        """Delete by source should remove all pages for that source."""
        source_id = "src_to_delete"
        for i in range(5):
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/page-{i}",
                chunk_number=0,
                content=f"Page {i}",
                source_id=source_id,
            ))

        deleted = await repo.delete_by_source(source_id)

        assert deleted == 5
        assert await repo.count(source_id) == 0


class TestCount:
    """Tests for count operations."""

    @pytest.mark.asyncio
    async def test_count_returns_total(self, repo):
        """Count should return total number of pages."""
        for i in range(5):
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/page-{i}",
                chunk_number=0,
                content=f"Page {i}",
                source_id="src_count",
            ))

        count = await repo.count()

        assert count == 5

    @pytest.mark.asyncio
    async def test_count_filters_by_source(self, repo):
        """Count should filter by source_id."""
        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/a-{i}",
                chunk_number=0,
                content=f"Source A page {i}",
                source_id="source_a",
            ))
        for i in range(2):
            await repo.insert(CrawledPageCreate(
                url=f"https://docs.example.com/b-{i}",
                chunk_number=0,
                content=f"Source B page {i}",
                source_id="source_b",
            ))

        count_a = await repo.count("source_a")
        count_b = await repo.count("source_b")
        count_total = await repo.count()

        assert count_a == 3
        assert count_b == 2
        assert count_total == 5


class TestListUniqueUrls:
    """Tests for list_unique_urls operations."""

    @pytest.mark.asyncio
    async def test_list_unique_urls_returns_distinct(self, repo):
        """List unique URLs should return distinct URLs."""
        url = "https://docs.example.com/multi-chunk"
        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=url,
                chunk_number=i,
                content=f"Chunk {i}",
                source_id="src_unique",
            ))

        urls = await repo.list_unique_urls()

        assert len(urls) == 1
        assert urls[0] == url

    @pytest.mark.asyncio
    async def test_list_unique_urls_filters_by_source(self, repo):
        """List unique URLs should filter by source_id."""
        await repo.insert(CrawledPageCreate(
            url="https://a.com/page",
            chunk_number=0,
            content="A",
            source_id="source_a",
        ))
        await repo.insert(CrawledPageCreate(
            url="https://b.com/page",
            chunk_number=0,
            content="B",
            source_id="source_b",
        ))

        urls_a = await repo.list_unique_urls("source_a")

        assert len(urls_a) == 1
        assert "a.com" in urls_a[0]
