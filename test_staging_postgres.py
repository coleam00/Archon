#!/usr/bin/env python3
"""Quick test script to verify PostgreSQL connection in staging environment."""

import asyncio
import sys
from archon.infrastructure.postgres import PostgresSitePagesRepository

async def main():
    """Test PostgreSQL connection."""
    try:
        print("🔄 Connecting to PostgreSQL...")

        repo = await PostgresSitePagesRepository.create(
            host='host.docker.internal',
            port=5432,
            database='mydb',
            user='postgres',
            password='postgres'
        )

        print("✅ PostgreSQL connection established!")

        # Test count
        count = await repo.count()
        print(f"📊 Total pages in database: {count}")

        # Test insert
        from archon.domain.models.site_page import SitePage, SitePageMetadata

        test_page = SitePage(
            url="https://test.staging/validation",
            chunk_number=0,
            title="Staging Validation Test",
            content="This is a test page to validate staging environment.",
            metadata=SitePageMetadata(source="staging_validation")
        )

        inserted = await repo.insert(test_page)
        print(f"✅ Test page inserted with ID: {inserted.id}")

        # Cleanup
        deleted = await repo.delete_by_source("staging_validation")
        print(f"🧹 Cleaned up {deleted} test pages")

        await repo.close()
        print("\n✅ ALL TESTS PASSED - PostgreSQL backend is operational!")
        return 0

    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
