"""
Quick test to verify PostgreSQL works from within the Docker container.
"""
import asyncio
from archon.container import get_repository_async
from archon.domain.models.site_page import SitePage, SitePageMetadata


async def main():
    print("Testing PostgreSQL connection from container...")

    try:
        # Get repository
        repo = await get_repository_async()
        print(f"✓ Repository initialized: {type(repo).__name__}")

        # Test count
        count = await repo.count()
        print(f"✓ Database accessible: {count} total pages")

        # Test insert
        test_page = SitePage(
            url="https://test.com/container",
            chunk_number=0,
            title="Container Test",
            metadata=SitePageMetadata(source="container_test"),
        )
        inserted = await repo.insert(test_page)
        print(f"✓ Insert works: page id {inserted.id}")

        # Clean up
        await repo.delete_by_source("container_test")
        print(f"✓ Delete works: cleaned up test data")

        await repo.close()
        print("\n[SUCCESS] PostgreSQL backend fully functional in container!")

    except Exception as e:
        print(f"\n[ERROR] {type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())
