"""
Contract tests for Repository implementations.

These tests verify that all repository implementations correctly
implement the interface contract. Uses InMemory for fast testing,
but the same tests can be run against other implementations.
"""

import pytest
from abc import ABC, abstractmethod

from src.server.domain.interfaces.crawled_pages_repository import ICrawledPagesRepository
from src.server.domain.interfaces.sources_repository import ISourcesRepository
from src.server.domain.interfaces.code_examples_repository import ICodeExamplesRepository
from src.server.domain.models.crawled_page import CrawledPageCreate
from src.server.domain.models.source import SourceCreate
from src.server.domain.models.code_example import CodeExampleCreate
from src.server.infrastructure.memory import (
    InMemoryCrawledPagesRepository,
    InMemorySourcesRepository,
    InMemoryCodeExamplesRepository,
)


class CrawledPagesRepositoryContract:
    """
    Contract tests for ICrawledPagesRepository implementations.

    Any implementation that passes these tests correctly implements
    the interface contract.
    """

    @pytest.fixture
    @abstractmethod
    def repo(self) -> ICrawledPagesRepository:
        """Subclasses must provide a repository implementation."""
        pass

    @pytest.mark.asyncio
    async def test_insert_and_get_by_id(self, repo):
        """Insert should return a page that can be retrieved by ID."""
        page_data = CrawledPageCreate(
            url="https://test.com/page",
            chunk_number=0,
            content="Test content",
            source_id="test_source",
        )

        created = await repo.insert(page_data)
        found = await repo.get_by_id(created.id)

        assert found is not None
        assert found.id == created.id
        assert found.content == page_data.content

    @pytest.mark.asyncio
    async def test_find_by_url_returns_correct_pages(self, repo):
        """find_by_url should return all pages with that URL."""
        url = "https://test.com/multi"
        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=url,
                chunk_number=i,
                content=f"Chunk {i}",
                source_id="test",
            ))

        pages = await repo.find_by_url(url)

        assert len(pages) == 3

    @pytest.mark.asyncio
    async def test_delete_by_url_removes_all_chunks(self, repo):
        """delete_by_url should remove all pages with that URL."""
        url = "https://test.com/delete"
        for i in range(2):
            await repo.insert(CrawledPageCreate(
                url=url,
                chunk_number=i,
                content=f"Chunk {i}",
                source_id="test",
            ))

        deleted = await repo.delete_by_url(url)
        remaining = await repo.find_by_url(url)

        assert deleted == 2
        assert remaining == []

    @pytest.mark.asyncio
    async def test_count_reflects_insertions(self, repo):
        """count should reflect the number of inserted pages."""
        initial = await repo.count()

        for i in range(3):
            await repo.insert(CrawledPageCreate(
                url=f"https://test.com/page-{i}",
                chunk_number=0,
                content=f"Page {i}",
                source_id="test",
            ))

        final = await repo.count()

        assert final == initial + 3


class SourcesRepositoryContract:
    """
    Contract tests for ISourcesRepository implementations.
    """

    @pytest.fixture
    @abstractmethod
    def repo(self) -> ISourcesRepository:
        """Subclasses must provide a repository implementation."""
        pass

    @pytest.mark.asyncio
    async def test_create_and_get_by_id(self, repo):
        """Create should return a source that can be retrieved by ID."""
        source_data = SourceCreate(
            source_id="test_src",
            url="https://test.com",
            title="Test Source",
        )

        created = await repo.create(source_data)
        found = await repo.get_by_id(created.source_id)

        assert found is not None
        assert found.source_id == source_data.source_id

    @pytest.mark.asyncio
    async def test_update_modifies_source(self, repo):
        """Update should modify the source."""
        await repo.create(SourceCreate(
            source_id="update_test",
            url="https://test.com",
            title="Original",
        ))

        updated = await repo.update("update_test", {"title": "Updated"})

        assert updated is not None
        assert updated.title == "Updated"

    @pytest.mark.asyncio
    async def test_delete_removes_source(self, repo):
        """Delete should remove the source."""
        await repo.create(SourceCreate(
            source_id="delete_test",
            url="https://test.com",
        ))

        deleted = await repo.delete("delete_test")
        found = await repo.get_by_id("delete_test")

        assert deleted is True
        assert found is None


class CodeExamplesRepositoryContract:
    """
    Contract tests for ICodeExamplesRepository implementations.
    """

    @pytest.fixture
    @abstractmethod
    def repo(self) -> ICodeExamplesRepository:
        """Subclasses must provide a repository implementation."""
        pass

    @pytest.mark.asyncio
    async def test_insert_and_get_by_id(self, repo):
        """Insert should return an example that can be retrieved by ID."""
        example_data = CodeExampleCreate(
            source_id="test_source",
            page_url="https://test.com/page",
            code="print('hello')",
            language="python",
        )

        created = await repo.insert(example_data)
        found = await repo.get_by_id(created.id)

        assert found is not None
        assert found.code == example_data.code

    @pytest.mark.asyncio
    async def test_find_by_source_returns_correct_examples(self, repo):
        """find_by_source should return all examples for that source."""
        source_id = "find_source_test"
        for i in range(3):
            await repo.insert(CodeExampleCreate(
                source_id=source_id,
                page_url=f"https://test.com/page-{i}",
                code=f"code_{i}()",
                language="python",
            ))

        examples = await repo.find_by_source(source_id)

        assert len(examples) == 3

    @pytest.mark.asyncio
    async def test_delete_by_source_removes_all(self, repo):
        """delete_by_source should remove all examples for that source."""
        source_id = "delete_source_test"
        for i in range(2):
            await repo.insert(CodeExampleCreate(
                source_id=source_id,
                page_url=f"https://test.com/page-{i}",
                code=f"code_{i}()",
                language="python",
            ))

        deleted = await repo.delete_by_source(source_id)
        remaining = await repo.count(source_id)

        assert deleted == 2
        assert remaining == 0


# =============================================================================
# InMemory Implementation Tests
# =============================================================================

class TestInMemoryCrawledPagesContract(CrawledPagesRepositoryContract):
    """Run contract tests against InMemory implementation."""

    @pytest.fixture
    def repo(self):
        repository = InMemoryCrawledPagesRepository()
        yield repository
        repository.clear()


class TestInMemorySourcesContract(SourcesRepositoryContract):
    """Run contract tests against InMemory implementation."""

    @pytest.fixture
    def repo(self):
        repository = InMemorySourcesRepository()
        yield repository
        repository.clear()


class TestInMemoryCodeExamplesContract(CodeExamplesRepositoryContract):
    """Run contract tests against InMemory implementation."""

    @pytest.fixture
    def repo(self):
        repository = InMemoryCodeExamplesRepository()
        yield repository
        repository.clear()


# =============================================================================
# Note: Add Supabase and PostgreSQL contract tests when running integration tests
#
# class TestSupabaseCrawledPagesContract(CrawledPagesRepositoryContract):
#     @pytest.fixture
#     def repo(self, supabase_client):
#         return SupabaseCrawledPagesRepository(supabase_client)
#
# class TestPostgresCrawledPagesContract(CrawledPagesRepositoryContract):
#     @pytest.fixture
#     def repo(self, postgres_pool):
#         return PostgresCrawledPagesRepository(postgres_pool)
# =============================================================================
