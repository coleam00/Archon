"""
Unit tests for Sources Repository implementations.

Tests the InMemory implementation which validates the interface contract.
"""

import pytest

from src.server.domain.models.source import SourceCreate
from src.server.infrastructure.memory import InMemorySourcesRepository


@pytest.fixture
def repo():
    """Fresh InMemory repository for each test."""
    repository = InMemorySourcesRepository()
    yield repository
    repository.clear()


@pytest.fixture
def sample_source_create():
    """Sample source data for testing."""
    return SourceCreate(
        source_id="src_pydantic_ai",
        url="https://docs.pydantic.dev/ai",
        title="Pydantic AI Documentation",
        description="Official documentation for Pydantic AI framework",
        metadata={"version": "1.0", "language": "en"},
    )


class TestCreate:
    """Tests for create operations."""

    @pytest.mark.asyncio
    async def test_create_stores_source(self, repo, sample_source_create):
        """Create should store the source."""
        source = await repo.create(sample_source_create)

        assert source.source_id == sample_source_create.source_id
        assert source.url == sample_source_create.url
        assert source.title == sample_source_create.title

    @pytest.mark.asyncio
    async def test_create_sets_defaults(self, repo, sample_source_create):
        """Create should set default values."""
        source = await repo.create(sample_source_create)

        assert source.pages_count == 0
        assert source.chunks_count == 0
        assert source.status == "pending"
        assert source.created_at is not None
        assert source.updated_at is not None

    @pytest.mark.asyncio
    async def test_create_rejects_duplicate_id(self, repo, sample_source_create):
        """Create should reject duplicate source_id."""
        await repo.create(sample_source_create)

        with pytest.raises(ValueError, match="already exists"):
            await repo.create(sample_source_create)


class TestGetById:
    """Tests for get_by_id operations."""

    @pytest.mark.asyncio
    async def test_get_by_id_returns_source(self, repo, sample_source_create):
        """Get by ID should return the correct source."""
        created = await repo.create(sample_source_create)
        found = await repo.get_by_id(created.source_id)

        assert found is not None
        assert found.source_id == created.source_id

    @pytest.mark.asyncio
    async def test_get_by_id_returns_none_for_missing(self, repo):
        """Get by ID should return None for non-existent ID."""
        found = await repo.get_by_id("non-existent")

        assert found is None


class TestGetByUrl:
    """Tests for get_by_url operations."""

    @pytest.mark.asyncio
    async def test_get_by_url_returns_source(self, repo, sample_source_create):
        """Get by URL should return the correct source."""
        await repo.create(sample_source_create)
        found = await repo.get_by_url(sample_source_create.url)

        assert found is not None
        assert found.url == sample_source_create.url

    @pytest.mark.asyncio
    async def test_get_by_url_returns_none_for_missing(self, repo):
        """Get by URL should return None for non-existent URL."""
        found = await repo.get_by_url("https://non-existent.com")

        assert found is None


class TestListAll:
    """Tests for list_all operations."""

    @pytest.mark.asyncio
    async def test_list_all_returns_all_sources(self, repo):
        """List all should return all sources."""
        for i in range(5):
            await repo.create(SourceCreate(
                source_id=f"src_{i}",
                url=f"https://docs{i}.example.com",
                title=f"Source {i}",
            ))

        sources = await repo.list_all()

        assert len(sources) == 5

    @pytest.mark.asyncio
    async def test_list_all_orders_by_created_at_desc(self, repo):
        """List all should order by created_at descending."""
        import asyncio
        for i in range(3):
            await repo.create(SourceCreate(
                source_id=f"src_{i}",
                url=f"https://docs{i}.example.com",
                title=f"Source {i}",
            ))
            await asyncio.sleep(0.01)  # Ensure different timestamps

        sources = await repo.list_all()

        # Most recently created should be first
        assert sources[0].source_id == "src_2"
        assert sources[-1].source_id == "src_0"


class TestSearch:
    """Tests for search operations."""

    @pytest.mark.asyncio
    async def test_search_matches_title(self, repo):
        """Search should match by title."""
        await repo.create(SourceCreate(
            source_id="src_python",
            url="https://python.org",
            title="Python Documentation",
        ))
        await repo.create(SourceCreate(
            source_id="src_rust",
            url="https://rust-lang.org",
            title="Rust Documentation",
        ))

        results = await repo.search("Python")

        assert len(results) == 1
        assert results[0].source_id == "src_python"

    @pytest.mark.asyncio
    async def test_search_matches_description(self, repo):
        """Search should match by description."""
        await repo.create(SourceCreate(
            source_id="src_ai",
            url="https://ai.example.com",
            title="AI Framework",
            description="Machine learning and deep learning tools",
        ))

        results = await repo.search("machine learning")

        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_search_is_case_insensitive(self, repo):
        """Search should be case insensitive."""
        await repo.create(SourceCreate(
            source_id="src_test",
            url="https://test.com",
            title="UPPERCASE Title",
        ))

        results = await repo.search("uppercase")

        assert len(results) == 1


class TestUpdate:
    """Tests for update operations."""

    @pytest.mark.asyncio
    async def test_update_modifies_fields(self, repo, sample_source_create):
        """Update should modify specified fields."""
        await repo.create(sample_source_create)

        updated = await repo.update(
            sample_source_create.source_id,
            {"title": "Updated Title", "description": "Updated description"}
        )

        assert updated is not None
        assert updated.title == "Updated Title"
        assert updated.description == "Updated description"

    @pytest.mark.asyncio
    async def test_update_sets_updated_at(self, repo, sample_source_create):
        """Update should set updated_at timestamp."""
        created = await repo.create(sample_source_create)
        original_updated_at = created.updated_at

        import asyncio
        await asyncio.sleep(0.01)

        updated = await repo.update(
            sample_source_create.source_id,
            {"title": "New Title"}
        )

        assert updated.updated_at > original_updated_at

    @pytest.mark.asyncio
    async def test_update_returns_none_for_missing(self, repo):
        """Update should return None for non-existent source."""
        result = await repo.update("non-existent", {"title": "New"})

        assert result is None


class TestUpdateCounts:
    """Tests for update_counts operations."""

    @pytest.mark.asyncio
    async def test_update_counts_modifies_values(self, repo, sample_source_create):
        """Update counts should modify page and chunk counts."""
        await repo.create(sample_source_create)

        await repo.update_counts(
            sample_source_create.source_id,
            pages_count=10,
            chunks_count=50
        )

        source = await repo.get_by_id(sample_source_create.source_id)
        assert source.pages_count == 10
        assert source.chunks_count == 50

    @pytest.mark.asyncio
    async def test_update_counts_partial_update(self, repo, sample_source_create):
        """Update counts should allow partial updates."""
        await repo.create(sample_source_create)

        await repo.update_counts(
            sample_source_create.source_id,
            pages_count=5
        )

        source = await repo.get_by_id(sample_source_create.source_id)
        assert source.pages_count == 5
        assert source.chunks_count == 0  # Unchanged


class TestUpdateStatus:
    """Tests for update_status operations."""

    @pytest.mark.asyncio
    async def test_update_status_changes_status(self, repo, sample_source_create):
        """Update status should change the status."""
        await repo.create(sample_source_create)

        await repo.update_status(sample_source_create.source_id, "crawling")

        source = await repo.get_by_id(sample_source_create.source_id)
        assert source.status == "crawling"

    @pytest.mark.asyncio
    async def test_update_status_workflow(self, repo, sample_source_create):
        """Update status should support full workflow."""
        await repo.create(sample_source_create)

        # Simulate crawl workflow
        for status in ["crawling", "completed"]:
            await repo.update_status(sample_source_create.source_id, status)
            source = await repo.get_by_id(sample_source_create.source_id)
            assert source.status == status


class TestDelete:
    """Tests for delete operations."""

    @pytest.mark.asyncio
    async def test_delete_removes_source(self, repo, sample_source_create):
        """Delete should remove the source."""
        await repo.create(sample_source_create)

        deleted = await repo.delete(sample_source_create.source_id)

        assert deleted is True
        assert await repo.get_by_id(sample_source_create.source_id) is None

    @pytest.mark.asyncio
    async def test_delete_returns_false_for_missing(self, repo):
        """Delete should return False for non-existent source."""
        deleted = await repo.delete("non-existent")

        assert deleted is False


class TestCount:
    """Tests for count operations."""

    @pytest.mark.asyncio
    async def test_count_returns_total(self, repo):
        """Count should return total number of sources."""
        for i in range(5):
            await repo.create(SourceCreate(
                source_id=f"src_{i}",
                url=f"https://docs{i}.example.com",
            ))

        count = await repo.count()

        assert count == 5

    @pytest.mark.asyncio
    async def test_count_returns_zero_for_empty(self, repo):
        """Count should return 0 for empty repository."""
        count = await repo.count()

        assert count == 0
