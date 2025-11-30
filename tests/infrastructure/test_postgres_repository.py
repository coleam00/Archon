"""
Tests for PostgresSitePagesRepository.

Tests the PostgreSQL implementation of the repository interface using
the local PostgreSQL database (localhost:5432).
"""

import pytest
import os
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.infrastructure.postgres import PostgresSitePagesRepository


# Configuration for test database
TEST_CONFIG = {
    "host": os.environ.get("TEST_POSTGRES_HOST", "localhost"),
    "port": int(os.environ.get("TEST_POSTGRES_PORT", "5432")),
    "database": os.environ.get("TEST_POSTGRES_DB", "mydb"),
    "user": os.environ.get("TEST_POSTGRES_USER", "postgres"),
    "password": os.environ.get("TEST_POSTGRES_PASSWORD", "postgres"),
}


@pytest.fixture
async def repository():
    """Create a test repository with a fresh database."""
    repo = await PostgresSitePagesRepository.create(**TEST_CONFIG)

    # Clean up before tests
    async with repo.pool.acquire() as conn:
        await conn.execute("DELETE FROM site_pages")

    yield repo

    # Clean up after tests
    async with repo.pool.acquire() as conn:
        await conn.execute("DELETE FROM site_pages")

    await repo.close()


@pytest.fixture
def sample_page():
    """Create a sample page for testing."""
    return SitePage(
        url="https://example.com/test",
        chunk_number=0,
        title="Test Page",
        summary="A test summary",
        content="Test content",
        metadata=SitePageMetadata(source="test"),
    )


@pytest.mark.asyncio
async def test_insert_and_get_by_id(repository, sample_page):
    """Test inserting a page and retrieving it by id."""
    inserted = await repository.insert(sample_page)

    assert inserted.id is not None
    assert inserted.url == sample_page.url
    assert inserted.title == sample_page.title
    assert inserted.created_at is not None

    retrieved = await repository.get_by_id(inserted.id)
    assert retrieved is not None
    assert retrieved.id == inserted.id
    assert retrieved.url == sample_page.url
    assert retrieved.title == sample_page.title


@pytest.mark.asyncio
async def test_get_by_id_not_found(repository):
    """Test retrieving a non-existent page."""
    result = await repository.get_by_id(999999)
    assert result is None


@pytest.mark.asyncio
async def test_insert_page_with_id_raises_error(repository, sample_page):
    """Test that inserting a page with an id raises an error."""
    sample_page.id = 42

    with pytest.raises(ValueError, match="Cannot insert a page with an existing id"):
        await repository.insert(sample_page)


@pytest.mark.asyncio
async def test_find_by_url(repository):
    """Test finding pages by URL."""
    url = "https://example.com/multi"

    # Insert multiple chunks for same URL
    for i in range(3):
        page = SitePage(
            url=url,
            chunk_number=i,
            title=f"Chunk {i}",
            content=f"Content {i}",
            metadata=SitePageMetadata(source="test"),
        )
        await repository.insert(page)

    chunks = await repository.find_by_url(url)
    assert len(chunks) == 3
    assert chunks[0].chunk_number == 0
    assert chunks[1].chunk_number == 1
    assert chunks[2].chunk_number == 2
    assert all(chunk.url == url for chunk in chunks)


@pytest.mark.asyncio
async def test_find_by_url_not_found(repository):
    """Test finding pages for a URL that doesn't exist."""
    chunks = await repository.find_by_url("https://nonexistent.com")
    assert len(chunks) == 0


@pytest.mark.asyncio
async def test_search_similar(repository):
    """Test vector similarity search."""
    # Insert pages with embeddings
    # Note: Avoid zero vectors as they cause NaN in cosine distance
    embedding1 = [1.0] + [0.0] * 1535  # First dimension is 1.0
    embedding2 = [0.9] + [0.1] * 1535  # Close to embedding1
    embedding3 = [0.0] + [1.0] * 1535  # Very different (orthogonal)

    page1 = SitePage(
        url="https://example.com/page1",
        chunk_number=0,
        title="Page 1",
        content="Content 1",
        metadata=SitePageMetadata(source="test"),
        embedding=embedding1,
    )
    page2 = SitePage(
        url="https://example.com/page2",
        chunk_number=0,
        title="Page 2",
        content="Content 2",
        metadata=SitePageMetadata(source="test"),
        embedding=embedding2,
    )
    page3 = SitePage(
        url="https://example.com/page3",
        chunk_number=0,
        title="Page 3",
        content="Content 3",
        metadata=SitePageMetadata(source="test"),
        embedding=embedding3,
    )

    await repository.insert(page1)
    await repository.insert(page2)
    await repository.insert(page3)

    # Search with embedding similar to page1
    query_embedding = [1.0] + [0.0] * 1535
    results = await repository.search_similar(query_embedding, limit=3)

    # IVFFlat index may not return all results with few vectors
    # so we test that we get at least 1 result and it's the best match
    assert len(results) >= 1
    assert len(results) <= 3
    # Results should be ordered by similarity (highest first)
    assert results[0].page.title == "Page 1"
    assert results[0].similarity > 0.99  # Almost exact match
    # If we have multiple results, they should be ordered
    if len(results) > 1:
        assert results[1].similarity < results[0].similarity
    if len(results) > 2:
        assert results[2].similarity < results[1].similarity


@pytest.mark.asyncio
async def test_search_similar_with_filter(repository):
    """Test vector similarity search with source filter."""
    embedding = [1.0] + [0.0] * 1535

    # Insert pages from different sources
    page_a = SitePage(
        url="https://example.com/a",
        chunk_number=0,
        content="Content A",
        metadata=SitePageMetadata(source="source_a"),
        embedding=embedding,
    )
    page_b = SitePage(
        url="https://example.com/b",
        chunk_number=0,
        content="Content B",
        metadata=SitePageMetadata(source="source_b"),
        embedding=embedding,
    )

    await repository.insert(page_a)
    await repository.insert(page_b)

    # Search with source filter
    results = await repository.search_similar(
        embedding, limit=10, filter={"source": "source_a"}
    )

    assert len(results) == 1
    assert results[0].page.url == "https://example.com/a"


@pytest.mark.asyncio
async def test_list_unique_urls(repository):
    """Test listing unique URLs."""
    urls = ["https://a.com", "https://b.com", "https://a.com"]

    for url in urls:
        await repository.insert(
            SitePage(
                url=url,
                chunk_number=0,
                content="Content",
                metadata=SitePageMetadata(source="test"),
            )
        )

    unique = await repository.list_unique_urls()
    assert len(unique) == 2
    assert "https://a.com" in unique
    assert "https://b.com" in unique


@pytest.mark.asyncio
async def test_list_unique_urls_with_source_filter(repository):
    """Test listing unique URLs filtered by source."""
    # Insert pages from different sources
    page1 = SitePage(
        url="https://example.com/page1",
        chunk_number=0,
        content="Content",
        metadata=SitePageMetadata(source="source_a"),
    )
    page2 = SitePage(
        url="https://example.com/page2",
        chunk_number=0,
        content="Content",
        metadata=SitePageMetadata(source="source_b"),
    )

    await repository.insert(page1)
    await repository.insert(page2)

    # Filter by source_a
    urls = await repository.list_unique_urls(source="source_a")

    assert len(urls) == 1
    assert urls[0] == "https://example.com/page1"


@pytest.mark.asyncio
async def test_insert_batch(repository):
    """Test batch insertion."""
    pages = [
        SitePage(
            url=f"https://example.com/page{i}",
            chunk_number=0,
            content=f"Content {i}",
            metadata=SitePageMetadata(source="test"),
        )
        for i in range(5)
    ]

    results = await repository.insert_batch(pages)

    assert len(results) == 5
    assert all(page.id is not None for page in results)
    # IDs should be sequential
    ids = [page.id for page in results]
    assert ids == sorted(ids)


@pytest.mark.asyncio
async def test_insert_batch_empty(repository):
    """Test batch insertion with empty list."""
    results = await repository.insert_batch([])
    assert len(results) == 0


@pytest.mark.asyncio
async def test_insert_batch_with_id_raises_error(repository):
    """Test that batch insert fails if any page has an id."""
    pages = [
        SitePage(
            url="https://example.com/page1",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="test"),
        ),
        SitePage(
            id=42,  # This should cause an error
            url="https://example.com/page2",
            chunk_number=0,
            content="Content",
            metadata=SitePageMetadata(source="test"),
        ),
    ]

    with pytest.raises(ValueError, match="Cannot insert pages with existing ids"):
        await repository.insert_batch(pages)


@pytest.mark.asyncio
async def test_delete_by_source(repository):
    """Test deleting pages by source."""
    # Insert pages from different sources
    for i in range(3):
        await repository.insert(
            SitePage(
                url=f"https://a.com/{i}",
                chunk_number=0,
                content="Content",
                metadata=SitePageMetadata(source="source_a"),
            )
        )
        await repository.insert(
            SitePage(
                url=f"https://b.com/{i}",
                chunk_number=0,
                content="Content",
                metadata=SitePageMetadata(source="source_b"),
            )
        )

    deleted = await repository.delete_by_source("source_a")
    assert deleted == 3

    remaining = await repository.count()
    assert remaining == 3

    urls = await repository.list_unique_urls(source="source_b")
    assert len(urls) == 3


@pytest.mark.asyncio
async def test_count(repository):
    """Test counting pages."""
    # Insert some pages
    for i in range(5):
        await repository.insert(
            SitePage(
                url=f"https://example.com/page{i}",
                chunk_number=0,
                content="Content",
                metadata=SitePageMetadata(source="test"),
            )
        )

    total = await repository.count()
    assert total == 5


@pytest.mark.asyncio
async def test_count_with_filter(repository):
    """Test counting pages with filter."""
    # Insert pages from different sources
    for i in range(3):
        await repository.insert(
            SitePage(
                url=f"https://a.com/{i}",
                chunk_number=0,
                content="Content",
                metadata=SitePageMetadata(source="source_a"),
            )
        )
        await repository.insert(
            SitePage(
                url=f"https://b.com/{i}",
                chunk_number=0,
                content="Content",
                metadata=SitePageMetadata(source="source_b"),
            )
        )

    count_a = await repository.count(filter={"metadata.source": "source_a"})
    assert count_a == 3

    count_b = await repository.count(filter={"metadata.source": "source_b"})
    assert count_b == 3

    total = await repository.count()
    assert total == 6


@pytest.mark.asyncio
async def test_insert_with_full_embedding(repository):
    """Test inserting a page with a full 1536-dimension embedding."""
    # Create a realistic 1536-dimension embedding
    embedding = [float(i % 100) / 100.0 for i in range(1536)]

    page = SitePage(
        url="https://example.com/with-embedding",
        chunk_number=0,
        title="Page with Embedding",
        content="Content",
        metadata=SitePageMetadata(source="test"),
        embedding=embedding,
    )

    inserted = await repository.insert(page)
    assert inserted.id is not None

    # Retrieve and verify embedding
    retrieved = await repository.get_by_id(inserted.id)
    assert retrieved is not None
    assert retrieved.embedding is not None
    assert len(retrieved.embedding) == 1536
    # Check a few values (may have slight float precision differences)
    assert abs(retrieved.embedding[0] - embedding[0]) < 0.0001
    assert abs(retrieved.embedding[1535] - embedding[1535]) < 0.0001
