"""
Integration test to verify PostgreSQL backend works with the container.
"""
import asyncio
import os
from archon.container import configure, get_repository
from archon.domain.models.site_page import SitePage, SitePageMetadata


async def test_postgres_integration():
    """Test that PostgreSQL repository works through the container."""
    print("=" * 60)
    print("PostgreSQL Backend Integration Test")
    print("=" * 60)

    # Configure environment for PostgreSQL
    os.environ["POSTGRES_HOST"] = "localhost"
    os.environ["POSTGRES_PORT"] = "5432"
    os.environ["POSTGRES_DB"] = "mydb"
    os.environ["POSTGRES_USER"] = "postgres"
    os.environ["POSTGRES_PASSWORD"] = "postgres"

    # Configure container to use PostgreSQL
    configure(repository_type="postgres")

    # Get repository instance (async version for PostgreSQL)
    print("\n1. Getting repository instance...")
    from archon.container import get_repository_async
    repo = await get_repository_async()
    print(f"   Repository type: {type(repo).__name__}")

    # Clean up any existing test data
    print("\n2. Cleaning up test data...")
    deleted = await repo.delete_by_source("integration_test")
    print(f"   Deleted {deleted} existing test pages")

    # Test insert
    print("\n3. Testing insert...")
    page = SitePage(
        url="https://test.com/integration",
        chunk_number=0,
        title="Integration Test Page",
        summary="Testing PostgreSQL backend",
        content="This is a test page for PostgreSQL integration",
        metadata=SitePageMetadata(source="integration_test"),
        embedding=[0.1] * 1536,
    )
    inserted = await repo.insert(page)
    print(f"   Inserted page with id: {inserted.id}")

    # Test get_by_id
    print("\n4. Testing get_by_id...")
    retrieved = await repo.get_by_id(inserted.id)
    print(f"   Retrieved: {retrieved.title}")
    assert retrieved.title == page.title

    # Test find_by_url
    print("\n5. Testing find_by_url...")
    chunks = await repo.find_by_url(page.url)
    print(f"   Found {len(chunks)} chunks")
    assert len(chunks) == 1

    # Test search_similar
    print("\n6. Testing search_similar...")
    results = await repo.search_similar([0.1] * 1536, limit=5)
    print(f"   Found {len(results)} similar pages")
    if results:
        print(f"   Best match: {results[0].page.title} (similarity: {results[0].similarity:.4f})")
    assert len(results) >= 1

    # Test batch insert
    print("\n7. Testing insert_batch...")
    batch_pages = [
        SitePage(
            url=f"https://test.com/batch{i}",
            chunk_number=0,
            title=f"Batch Page {i}",
            content=f"Batch content {i}",
            metadata=SitePageMetadata(source="integration_test"),
        )
        for i in range(3)
    ]
    inserted_batch = await repo.insert_batch(batch_pages)
    print(f"   Inserted {len(inserted_batch)} pages")
    assert len(inserted_batch) == 3

    # Test count
    print("\n8. Testing count...")
    total = await repo.count()
    print(f"   Total pages: {total}")
    count_filtered = await repo.count(filter={"metadata.source": "integration_test"})
    print(f"   Integration test pages: {count_filtered}")
    assert count_filtered == 4  # 1 + 3 batch

    # Test list_unique_urls
    print("\n9. Testing list_unique_urls...")
    urls = await repo.list_unique_urls(source="integration_test")
    print(f"   Unique URLs: {len(urls)}")
    assert len(urls) == 4

    # Test delete_by_source
    print("\n10. Testing delete_by_source...")
    deleted = await repo.delete_by_source("integration_test")
    print(f"   Deleted {deleted} pages")
    assert deleted == 4

    # Verify deletion
    remaining = await repo.count(filter={"metadata.source": "integration_test"})
    print(f"   Remaining: {remaining}")
    assert remaining == 0

    print("\n" + "=" * 60)
    print("[SUCCESS] ALL TESTS PASSED!")
    print("=" * 60)

    # Close the repository
    await repo.close()


if __name__ == "__main__":
    asyncio.run(test_postgres_integration())
