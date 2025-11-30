#!/usr/bin/env python
"""
Test d'intégration manuel pour valider le repository in-memory.
Exécuter: python scripts/test_integration_manual.py
"""

import asyncio
import sys
import os

# S'assurer qu'on est dans le bon répertoire
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
os.chdir(project_root)
sys.path.insert(0, project_root)

from datetime import datetime
from archon.domain import SitePage, SitePageMetadata, SearchResult
from archon.infrastructure.memory import InMemorySitePagesRepository


async def main():
    print("="*60)
    print("TEST D'INTÉGRATION - InMemoryRepository")
    print("="*60)

    errors = []
    repo = InMemorySitePagesRepository()

    # 1. Test insert
    print("\n1. Test INSERT...")
    try:
        page = SitePage(
            url="https://test.com/page1",
            chunk_number=0,
            title="Test Page",
            summary="A test page",
            content="This is test content for validation.",
            metadata=SitePageMetadata(
                source="test_validation",
                chunk_size=100,
                crawled_at=datetime.now(),
                url_path="/page1"
            ),
            embedding=[0.1] * 1536
        )

        inserted = await repo.insert(page)
        assert inserted.id is not None, "Insert should return page with ID"
        print(f"   [OK] Inserted page with ID: {inserted.id}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("INSERT", str(e)))

    # 2. Test get_by_id
    print("\n2. Test GET_BY_ID...")
    try:
        fetched = await repo.get_by_id(inserted.id)
        assert fetched is not None, "Should find inserted page"
        assert fetched.url == page.url, "URL should match"
        print(f"   [OK] Retrieved page: {fetched.title}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("GET_BY_ID", str(e)))

    # 3. Test find_by_url
    print("\n3. Test FIND_BY_URL...")
    try:
        pages = await repo.find_by_url("https://test.com/page1")
        assert len(pages) == 1, f"Should find 1 page, got {len(pages)}"
        print(f"   [OK] Found {len(pages)} page(s) for URL")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("FIND_BY_URL", str(e)))

    # 4. Test count
    print("\n4. Test COUNT...")
    try:
        count = await repo.count()
        assert count == 1, f"Should have 1 page, got {count}"
        print(f"   [OK] Count: {count}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("COUNT", str(e)))

    # 5. Test search_similar
    print("\n5. Test SEARCH_SIMILAR...")
    try:
        results = await repo.search_similar(
            embedding=[0.1] * 1536,
            limit=5
        )
        assert len(results) > 0, "Should find similar pages"
        assert isinstance(results[0], SearchResult), "Should return SearchResult"
        print(f"   [OK] Found {len(results)} similar pages")
        print(f"   [OK] Top result similarity: {results[0].similarity:.4f}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("SEARCH_SIMILAR", str(e)))

    # 6. Test list_unique_urls
    print("\n6. Test LIST_UNIQUE_URLS...")
    try:
        urls = await repo.list_unique_urls()
        assert len(urls) == 1, f"Should have 1 URL, got {len(urls)}"
        print(f"   [OK] URLs: {urls}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("LIST_UNIQUE_URLS", str(e)))

    # 7. Test insert_batch
    print("\n7. Test INSERT_BATCH...")
    try:
        batch_pages = [
            SitePage(
                url=f"https://test.com/batch{i}",
                chunk_number=0,
                title=f"Batch Page {i}",
                summary=f"Batch page {i}",
                content=f"Content {i}",
                metadata=SitePageMetadata(source="test_validation"),
                embedding=[0.1 * i] * 1536
            )
            for i in range(3)
        ]
        inserted_batch = await repo.insert_batch(batch_pages)
        assert len(inserted_batch) == 3, f"Should insert 3 pages, got {len(inserted_batch)}"
        print(f"   [OK] Inserted {len(inserted_batch)} pages in batch")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("INSERT_BATCH", str(e)))

    # 8. Test count after batch
    print("\n8. Test COUNT after batch...")
    try:
        count = await repo.count()
        assert count == 4, f"Should have 4 pages, got {count}"
        print(f"   [OK] Total count: {count}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("COUNT_AFTER_BATCH", str(e)))

    # 9. Test delete_by_source
    print("\n9. Test DELETE_BY_SOURCE...")
    try:
        deleted = await repo.delete_by_source("test_validation")
        assert deleted == 4, f"Should delete 4 pages, deleted {deleted}"
        print(f"   [OK] Deleted {deleted} pages")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("DELETE_BY_SOURCE", str(e)))

    # 10. Verify deletion
    print("\n10. Test VERIFY DELETION...")
    try:
        count_after = await repo.count()
        assert count_after == 0, f"Should have 0 pages, got {count_after}"
        print(f"   [OK] Count after deletion: {count_after}")
    except Exception as e:
        print(f"   [FAIL] {e}")
        errors.append(("VERIFY_DELETION", str(e)))

    # Résumé
    print("\n" + "="*60)
    if not errors:
        print("[SUCCESS] TOUS LES TESTS D'INTEGRATION PASSENT!")
        print("   Le repository in-memory fonctionne correctement.")
        print("="*60)
        return 0
    else:
        print(f"[FAIL] {len(errors)} TEST(S) EN ECHEC:")
        for name, err in errors:
            print(f"   - {name}: {err}")
        print("="*60)
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
