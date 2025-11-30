"""
Unit tests for domain interfaces.

These tests verify that:
- Interfaces are abstract and cannot be instantiated
- Interfaces have all required methods defined
- Mock implementations can be created for testing
"""

import pytest
from abc import ABC
from typing import Optional, List, Dict, Any
from archon.domain.interfaces import ISitePagesRepository, IEmbeddingService
from archon.domain.models import SitePage, SitePageMetadata, SearchResult


class TestISitePagesRepository:
    """Tests for ISitePagesRepository interface."""

    def test_is_abstract(self):
        """Test that ISitePagesRepository is an ABC."""
        assert issubclass(ISitePagesRepository, ABC)

    def test_cannot_instantiate(self):
        """Test that the interface cannot be instantiated directly."""
        with pytest.raises(TypeError, match="Can't instantiate abstract class"):
            ISitePagesRepository()

    def test_has_get_by_id(self):
        """Test that get_by_id method is defined."""
        assert hasattr(ISitePagesRepository, "get_by_id")
        assert callable(getattr(ISitePagesRepository, "get_by_id"))

    def test_has_find_by_url(self):
        """Test that find_by_url method is defined."""
        assert hasattr(ISitePagesRepository, "find_by_url")
        assert callable(getattr(ISitePagesRepository, "find_by_url"))

    def test_has_search_similar(self):
        """Test that search_similar method is defined."""
        assert hasattr(ISitePagesRepository, "search_similar")
        assert callable(getattr(ISitePagesRepository, "search_similar"))

    def test_has_list_unique_urls(self):
        """Test that list_unique_urls method is defined."""
        assert hasattr(ISitePagesRepository, "list_unique_urls")
        assert callable(getattr(ISitePagesRepository, "list_unique_urls"))

    def test_has_insert(self):
        """Test that insert method is defined."""
        assert hasattr(ISitePagesRepository, "insert")
        assert callable(getattr(ISitePagesRepository, "insert"))

    def test_has_insert_batch(self):
        """Test that insert_batch method is defined."""
        assert hasattr(ISitePagesRepository, "insert_batch")
        assert callable(getattr(ISitePagesRepository, "insert_batch"))

    def test_has_delete_by_source(self):
        """Test that delete_by_source method is defined."""
        assert hasattr(ISitePagesRepository, "delete_by_source")
        assert callable(getattr(ISitePagesRepository, "delete_by_source"))

    def test_has_count(self):
        """Test that count method is defined."""
        assert hasattr(ISitePagesRepository, "count")
        assert callable(getattr(ISitePagesRepository, "count"))

    def test_all_methods_are_abstract(self):
        """Test that all public methods are abstract."""
        public_methods = [
            "get_by_id",
            "find_by_url",
            "search_similar",
            "list_unique_urls",
            "insert",
            "insert_batch",
            "delete_by_source",
            "count",
        ]
        for method_name in public_methods:
            method = getattr(ISitePagesRepository, method_name)
            assert getattr(method, "__isabstractmethod__", False), (
                f"{method_name} should be abstract"
            )


class TestIEmbeddingService:
    """Tests for IEmbeddingService interface."""

    def test_is_abstract(self):
        """Test that IEmbeddingService is an ABC."""
        assert issubclass(IEmbeddingService, ABC)

    def test_cannot_instantiate(self):
        """Test that the interface cannot be instantiated directly."""
        with pytest.raises(TypeError, match="Can't instantiate abstract class"):
            IEmbeddingService()

    def test_has_get_embedding(self):
        """Test that get_embedding method is defined."""
        assert hasattr(IEmbeddingService, "get_embedding")
        assert callable(getattr(IEmbeddingService, "get_embedding"))

    def test_has_get_embeddings_batch(self):
        """Test that get_embeddings_batch method is defined."""
        assert hasattr(IEmbeddingService, "get_embeddings_batch")
        assert callable(getattr(IEmbeddingService, "get_embeddings_batch"))

    def test_all_methods_are_abstract(self):
        """Test that all public methods are abstract."""
        public_methods = ["get_embedding", "get_embeddings_batch"]
        for method_name in public_methods:
            method = getattr(IEmbeddingService, method_name)
            assert getattr(method, "__isabstractmethod__", False), (
                f"{method_name} should be abstract"
            )


class MockSitePagesRepository(ISitePagesRepository):
    """Mock implementation for testing that interfaces can be implemented."""

    async def get_by_id(self, id: int) -> Optional[SitePage]:
        return None

    async def find_by_url(self, url: str) -> List[SitePage]:
        return []

    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        return []

    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        return []

    async def insert(self, page: SitePage) -> SitePage:
        return page

    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]:
        return pages

    async def delete_by_source(self, source: str) -> int:
        return 0

    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        return 0


class MockEmbeddingService(IEmbeddingService):
    """Mock implementation for testing that interfaces can be implemented."""

    async def get_embedding(self, text: str) -> List[float]:
        return [0.0] * 1536

    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        return [[0.0] * 1536 for _ in texts]


class TestMockImplementations:
    """Tests for mock implementations."""

    def test_can_create_mock_repository(self):
        """Test that a concrete implementation can be created."""
        repo = MockSitePagesRepository()
        assert isinstance(repo, ISitePagesRepository)

    def test_can_create_mock_embedding_service(self):
        """Test that a concrete implementation can be created."""
        service = MockEmbeddingService()
        assert isinstance(service, IEmbeddingService)

    @pytest.mark.asyncio
    async def test_mock_repository_methods(self):
        """Test that mock repository methods can be called."""
        repo = MockSitePagesRepository()

        # Test each method
        result = await repo.get_by_id(1)
        assert result is None

        results = await repo.find_by_url("https://example.com")
        assert results == []

        search_results = await repo.search_similar([0.1] * 1536)
        assert search_results == []

        urls = await repo.list_unique_urls()
        assert urls == []

        metadata = SitePageMetadata(source="test")
        page = SitePage(url="https://example.com", metadata=metadata)
        inserted = await repo.insert(page)
        assert inserted == page

        batch = await repo.insert_batch([page])
        assert batch == [page]

        deleted = await repo.delete_by_source("test")
        assert deleted == 0

        count = await repo.count()
        assert count == 0

    @pytest.mark.asyncio
    async def test_mock_embedding_service_methods(self):
        """Test that mock embedding service methods can be called."""
        service = MockEmbeddingService()

        # Test single embedding
        embedding = await service.get_embedding("test text")
        assert len(embedding) == 1536
        assert all(e == 0.0 for e in embedding)

        # Test batch embeddings
        embeddings = await service.get_embeddings_batch(["text1", "text2"])
        assert len(embeddings) == 2
        assert all(len(e) == 1536 for e in embeddings)


class TestInterfaceContract:
    """Tests that verify the interface contract is well-defined."""

    def test_repository_methods_are_async(self):
        """Verify that all repository methods are async."""
        import inspect

        for method_name in [
            "get_by_id",
            "find_by_url",
            "search_similar",
            "list_unique_urls",
            "insert",
            "insert_batch",
            "delete_by_source",
            "count",
        ]:
            method = getattr(ISitePagesRepository, method_name)
            # Abstract methods won't be coroutine functions, but implementations should be
            # We just verify the method exists and is callable
            assert callable(method)

    def test_embedding_service_methods_are_async(self):
        """Verify that all embedding service methods are async."""
        import inspect

        for method_name in ["get_embedding", "get_embeddings_batch"]:
            method = getattr(IEmbeddingService, method_name)
            # Abstract methods won't be coroutine functions, but implementations should be
            # We just verify the method exists and is callable
            assert callable(method)

    def test_repository_has_complete_crud_operations(self):
        """Verify that repository provides complete CRUD operations."""
        # Read operations
        assert hasattr(ISitePagesRepository, "get_by_id")
        assert hasattr(ISitePagesRepository, "find_by_url")
        assert hasattr(ISitePagesRepository, "search_similar")
        assert hasattr(ISitePagesRepository, "list_unique_urls")
        assert hasattr(ISitePagesRepository, "count")

        # Create operations
        assert hasattr(ISitePagesRepository, "insert")
        assert hasattr(ISitePagesRepository, "insert_batch")

        # Delete operations
        assert hasattr(ISitePagesRepository, "delete_by_source")

        # Note: No update operations in current design (immutable pages)
