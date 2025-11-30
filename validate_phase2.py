#!/usr/bin/env python
"""
Validation script for Phase 2 - Infrastructure Layer.

This script validates that all infrastructure components are correctly implemented
and can be imported and instantiated.
"""

import sys
import asyncio
from typing import List


def test_imports():
    """Test that all infrastructure modules can be imported."""
    print("Testing imports...")

    try:
        # Domain imports
        from archon.domain.models.site_page import SitePage, SitePageMetadata
        from archon.domain.models.search_result import SearchResult
        from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
        from archon.domain.interfaces.embedding_service import IEmbeddingService

        # Infrastructure imports
        from archon.infrastructure.supabase import (
            SupabaseSitePagesRepository,
            dict_to_site_page,
            site_page_to_dict,
        )
        from archon.infrastructure.memory import InMemorySitePagesRepository
        from archon.infrastructure.openai import OpenAIEmbeddingService

        print("[PASS] All imports successful")
        return True
    except ImportError as e:
        print(f"[FAIL] Import failed: {e}")
        return False


def test_mappers():
    """Test mapper functions."""
    print("\nTesting mappers...")

    try:
        from archon.domain.models.site_page import SitePage, SitePageMetadata
        from archon.infrastructure.supabase.mappers import (
            dict_to_site_page,
            site_page_to_dict,
        )

        # Test dict -> SitePage
        data = {
            "id": 1,
            "url": "https://example.com",
            "chunk_number": 0,
            "title": "Test",
            "content": "Content",
            "metadata": {"source": "test_docs"},
        }

        page = dict_to_site_page(data)
        assert page.id == 1
        assert page.url == "https://example.com"
        assert page.metadata.source == "test_docs"

        # Test SitePage -> dict
        result = site_page_to_dict(page)
        assert result["url"] == "https://example.com"
        assert result["metadata"]["source"] == "test_docs"

        print("[PASS] Mapper tests passed")
        return True
    except Exception as e:
        print(f"[FAIL] Mapper tests failed: {e}")
        return False


async def test_memory_repository():
    """Test in-memory repository."""
    print("\nTesting in-memory repository...")

    try:
        from archon.domain.models.site_page import SitePage, SitePageMetadata
        from archon.infrastructure.memory import InMemorySitePagesRepository

        repo = InMemorySitePagesRepository()

        # Test insert
        page = SitePage(
            url="https://example.com",
            chunk_number=0,
            title="Test",
            content="Content",
            metadata=SitePageMetadata(source="test_docs"),
            embedding=[0.1, 0.2, 0.3],
        )

        inserted = await repo.insert(page)
        assert inserted.id == 1

        # Test get_by_id
        retrieved = await repo.get_by_id(1)
        assert retrieved is not None
        assert retrieved.url == "https://example.com"

        # Test search_similar
        results = await repo.search_similar([0.1, 0.2, 0.3], limit=5)
        assert len(results) == 1
        assert results[0].page.id == 1

        # Test count
        count = await repo.count()
        assert count == 1

        print("[PASS] In-memory repository tests passed")
        return True
    except Exception as e:
        print(f"[FAIL] In-memory repository tests failed: {e}")
        import traceback

        traceback.print_exc()
        return False


def test_interface_compliance():
    """Test that implementations comply with interfaces."""
    print("\nTesting interface compliance...")

    try:
        from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
        from archon.domain.interfaces.embedding_service import IEmbeddingService
        from archon.infrastructure.memory import InMemorySitePagesRepository

        # Check that InMemorySitePagesRepository implements ISitePagesRepository
        repo = InMemorySitePagesRepository()
        assert isinstance(repo, ISitePagesRepository)

        # Check that all abstract methods are implemented
        required_methods = [
            "get_by_id",
            "find_by_url",
            "search_similar",
            "list_unique_urls",
            "insert",
            "insert_batch",
            "delete_by_source",
            "count",
        ]

        for method_name in required_methods:
            assert hasattr(repo, method_name), f"Missing method: {method_name}"

        print("[PASS] Interface compliance tests passed")
        return True
    except Exception as e:
        print(f"[FAIL] Interface compliance tests failed: {e}")
        return False


async def main():
    """Run all validation tests."""
    print("=" * 60)
    print("Phase 2 - Infrastructure Layer Validation")
    print("=" * 60)

    results = []

    # Run tests
    results.append(test_imports())
    results.append(test_mappers())
    results.append(await test_memory_repository())
    results.append(test_interface_compliance())

    # Summary
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    passed = sum(results)
    total = len(results)
    print(f"Tests passed: {passed}/{total}")

    if all(results):
        print("\n[SUCCESS] All validation tests passed!")
        print("\nPhase 2 infrastructure layer is ready for Phase 3 migration.")
        return 0
    else:
        print("\n[ERROR] Some validation tests failed")
        print("\nPlease fix the issues before proceeding to Phase 3.")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
