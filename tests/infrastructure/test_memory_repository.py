"""
Tests for InMemorySitePagesRepository.

Tests the in-memory implementation of the repository interface.
"""

import pytest
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.infrastructure.memory import InMemorySitePagesRepository


@pytest.fixture
def repository():
    """Create a fresh in-memory repository for each test."""
    return InMemorySitePagesRepository()


@pytest.fixture
def sample_page():
    """Create a sample page for testing."""
    return SitePage(
        url="https://example.com/docs",
        chunk_number=0,
        title="Example Documentation",
        summary="A summary",
        content="Full content here",
        metadata=SitePageMetadata(source="example_docs", chunk_size=1500),
        embedding=[0.1, 0.2, 0.3],
    )


@pytest.mark.asyncio
async def test_insert_page(repository, sample_page):
    """Test inserting a page."""
    result = await repository.insert(sample_page)

    assert result.id == 1
    assert result.url == sample_page.url
    assert result.title == sample_page.title
    assert result.created_at is not None


@pytest.mark.asyncio
async def test_insert_page_with_id_raises_error(repository, sample_page):
    """Test that inserting a page with an id raises an error."""
    sample_page.id = 42

    with pytest.raises(ValueError, match="Cannot insert a page with an existing id"):
        await repository.insert(sample_page)


@pytest.mark.asyncio
async def test_get_by_id(repository, sample_page):
    """Test retrieving a page by id."""
    inserted = await repository.insert(sample_page)
    retrieved = await repository.get_by_id(inserted.id)

    assert retrieved is not None
    assert retrieved.id == inserted.id
    assert retrieved.url == sample_page.url


@pytest.mark.asyncio
async def test_get_by_id_not_found(repository):
    """Test retrieving a non-existent page."""
    result = await repository.get_by_id(999)
    assert result is None


@pytest.mark.asyncio
async def test_find_by_url(repository):
    """Test finding pages by URL."""
    url = "https://example.com/docs"

    # Insert multiple chunks for the same URL
    for i in range(3):
        page = SitePage(
            url=url,
            chunk_number=i,
            title=f"Chunk {i}",
            content=f"Content {i}",
            metadata=SitePageMetadata(source="example_docs"),
        )
        await repository.insert(page)

    # Find all chunks
    results = await repository.find_by_url(url)

    assert len(results) == 3
    assert all(page.url == url for page in results)
    assert [page.chunk_number for page in results] == [0, 1, 2]


@pytest.mark.asyncio
async def test_list_unique_urls(repository):
    """Test listing unique URLs."""
    urls = [
        "https://example.com/docs/page1",
        "https://example.com/docs/page2",
        "https://example.com/docs/page1",  # Duplicate
    ]

    for url in urls:
        page = SitePage(
            url=url,
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="example_docs"),
        )
        await repository.insert(page)

    unique_urls = await repository.list_unique_urls()

    assert len(unique_urls) == 2
    assert "https://example.com/docs/page1" in unique_urls
    assert "https://example.com/docs/page2" in unique_urls


@pytest.mark.asyncio
async def test_list_unique_urls_with_source_filter(repository):
    """Test listing unique URLs filtered by source."""
    # Insert pages from different sources
    page1 = SitePage(
        url="https://example.com/docs/page1",
        chunk_number=0,
        content="Content",
        metadata=SitePageMetadata(source="source_a"),
    )
    page2 = SitePage(
        url="https://example.com/docs/page2",
        chunk_number=0,
        content="Content",
        metadata=SitePageMetadata(source="source_b"),
    )

    await repository.insert(page1)
    await repository.insert(page2)

    # Filter by source_a
    urls = await repository.list_unique_urls(source="source_a")

    assert len(urls) == 1
    assert urls[0] == "https://example.com/docs/page1"


@pytest.mark.asyncio
async def test_search_similar(repository):
    """Test vector similarity search."""
    # Insert pages with embeddings
    pages = [
        SitePage(
            url="https://example.com/page1",
            chunk_number=0,
            title="Page 1",
            content="Content 1",
            metadata=SitePageMetadata(source="example_docs"),
            embedding=[1.0, 0.0, 0.0],  # Orthogonal to query
        ),
        SitePage(
            url="https://example.com/page2",
            chunk_number=0,
            title="Page 2",
            content="Content 2",
            metadata=SitePageMetadata(source="example_docs"),
            embedding=[0.9, 0.1, 0.0],  # Very similar to query
        ),
        SitePage(
            url="https://example.com/page3",
            chunk_number=0,
            title="Page 3",
            content="Content 3",
            metadata=SitePageMetadata(source="example_docs"),
            embedding=[0.5, 0.5, 0.0],  # Moderately similar
        ),
    ]

    for page in pages:
        await repository.insert(page)

    # Search with a query vector identical to page1
    query_embedding = [1.0, 0.0, 0.0]
    results = await repository.search_similar(query_embedding, limit=3)

    assert len(results) == 3
    # Results should be ordered by similarity (highest first)
    assert results[0].page.title == "Page 1"  # Exact match with [1.0, 0.0, 0.0]
    assert results[0].similarity > results[1].similarity
    assert results[1].similarity > results[2].similarity


@pytest.mark.asyncio
async def test_search_similar_with_filter(repository):
    """Test vector similarity search with metadata filter."""
    # Insert pages from different sources
    page1 = SitePage(
        url="https://example.com/page1",
        chunk_number=0,
        content="Content 1",
        metadata=SitePageMetadata(source="source_a"),
        embedding=[1.0, 0.0, 0.0],
    )
    page2 = SitePage(
        url="https://example.com/page2",
        chunk_number=0,
        content="Content 2",
        metadata=SitePageMetadata(source="source_b"),
        embedding=[0.9, 0.1, 0.0],
    )

    await repository.insert(page1)
    await repository.insert(page2)

    # Search with source filter
    query_embedding = [1.0, 0.0, 0.0]
    results = await repository.search_similar(
        query_embedding, limit=10, filter={"source": "source_a"}
    )

    assert len(results) == 1
    assert results[0].page.url == "https://example.com/page1"


@pytest.mark.asyncio
async def test_insert_batch(repository):
    """Test batch insertion."""
    pages = [
        SitePage(
            url=f"https://example.com/page{i}",
            chunk_number=0,
            content=f"Content {i}",
            metadata=SitePageMetadata(source="example_docs"),
        )
        for i in range(5)
    ]

    results = await repository.insert_batch(pages)

    assert len(results) == 5
    assert all(page.id is not None for page in results)
    assert [page.id for page in results] == [1, 2, 3, 4, 5]


@pytest.mark.asyncio
async def test_delete_by_source(repository):
    """Test deleting pages by source."""
    # Insert pages from different sources
    for i in range(3):
        page_a = SitePage(
            url=f"https://example.com/a{i}",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="source_a"),
        )
        page_b = SitePage(
            url=f"https://example.com/b{i}",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="source_b"),
        )
        await repository.insert(page_a)
        await repository.insert(page_b)

    # Delete source_a
    deleted_count = await repository.delete_by_source("source_a")

    assert deleted_count == 3

    # Verify only source_b remains
    remaining = await repository.count()
    assert remaining == 3

    urls = await repository.list_unique_urls(source="source_b")
    assert len(urls) == 3


@pytest.mark.asyncio
async def test_count(repository):
    """Test counting pages."""
    # Insert some pages
    for i in range(5):
        page = SitePage(
            url=f"https://example.com/page{i}",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="example_docs"),
        )
        await repository.insert(page)

    total = await repository.count()
    assert total == 5


@pytest.mark.asyncio
async def test_count_with_filter(repository):
    """Test counting pages with filter."""
    # Insert pages from different sources
    for i in range(3):
        page_a = SitePage(
            url=f"https://example.com/a{i}",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="source_a"),
        )
        page_b = SitePage(
            url=f"https://example.com/b{i}",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="source_b"),
        )
        await repository.insert(page_a)
        await repository.insert(page_b)

    count_a = await repository.count(filter={"metadata.source": "source_a"})
    assert count_a == 3

    count_b = await repository.count(filter={"metadata.source": "source_b"})
    assert count_b == 3


@pytest.mark.asyncio
async def test_clear(repository, sample_page):
    """Test clearing the repository."""
    await repository.insert(sample_page)
    assert await repository.count() == 1

    repository.clear()

    assert await repository.count() == 0
