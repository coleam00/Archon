"""
Unit tests for CodeExamples Repository implementations.

Tests the InMemory implementation which validates the interface contract.
"""

import pytest

from src.server.domain.models.code_example import CodeExampleCreate
from src.server.infrastructure.memory import InMemoryCodeExamplesRepository


@pytest.fixture
def repo():
    """Fresh InMemory repository for each test."""
    repository = InMemoryCodeExamplesRepository()
    yield repository
    repository.clear()


@pytest.fixture
def sample_example_create():
    """Sample code example data for testing."""
    return CodeExampleCreate(
        source_id="src_pydantic",
        page_url="https://docs.pydantic.dev/ai/agents",
        code='''
from pydantic_ai import Agent

agent = Agent("openai:gpt-4")

@agent.tool
def get_weather(city: str) -> str:
    return f"Weather in {city}: Sunny"
''',
        language="python",
        summary="Creating a simple Pydantic AI agent with a tool",
        context="This example shows how to create an agent with tools",
        metadata={"framework": "pydantic_ai"},
        embedding=[0.1] * 1536,
        embedding_dimension=1536,
        embedding_model="text-embedding-ada-002",
    )


@pytest.fixture
def sample_embedding():
    """Sample embedding vector for search tests."""
    return [0.1] * 1536


class TestInsert:
    """Tests for insert operations."""

    @pytest.mark.asyncio
    async def test_insert_creates_example_with_id(self, repo, sample_example_create):
        """Insert should create an example with a generated ID."""
        example = await repo.insert(sample_example_create)

        assert example.id is not None
        assert example.code == sample_example_create.code
        assert example.language == "python"

    @pytest.mark.asyncio
    async def test_insert_stores_embedding(self, repo, sample_example_create):
        """Insert should store the embedding in the correct column."""
        example = await repo.insert(sample_example_create)

        assert example.embedding_1536 is not None
        assert len(example.embedding_1536) == 1536

    @pytest.mark.asyncio
    async def test_insert_sets_created_at(self, repo, sample_example_create):
        """Insert should set created_at timestamp."""
        example = await repo.insert(sample_example_create)

        assert example.created_at is not None

    @pytest.mark.asyncio
    async def test_insert_batch_creates_multiple(self, repo):
        """Insert batch should create multiple examples."""
        examples_data = [
            CodeExampleCreate(
                source_id="src_batch",
                page_url=f"https://docs.example.com/page-{i}",
                code=f"print('Example {i}')",
                language="python",
            )
            for i in range(5)
        ]

        examples = await repo.insert_batch(examples_data)

        assert len(examples) == 5
        assert all(e.id is not None for e in examples)


class TestGetById:
    """Tests for get_by_id operations."""

    @pytest.mark.asyncio
    async def test_get_by_id_returns_example(self, repo, sample_example_create):
        """Get by ID should return the correct example."""
        created = await repo.insert(sample_example_create)
        found = await repo.get_by_id(created.id)

        assert found is not None
        assert found.id == created.id
        assert found.code == created.code

    @pytest.mark.asyncio
    async def test_get_by_id_returns_none_for_missing(self, repo):
        """Get by ID should return None for non-existent ID."""
        found = await repo.get_by_id("non-existent-id")

        assert found is None


class TestFindBySource:
    """Tests for find_by_source operations."""

    @pytest.mark.asyncio
    async def test_find_by_source_returns_all(self, repo):
        """Find by source should return all examples for that source."""
        source_id = "src_test"
        for i in range(3):
            await repo.insert(CodeExampleCreate(
                source_id=source_id,
                page_url=f"https://docs.example.com/page-{i}",
                code=f"example_{i}()",
                language="python",
            ))

        # Add example from different source
        await repo.insert(CodeExampleCreate(
            source_id="other_source",
            page_url="https://other.com/page",
            code="other()",
            language="python",
        ))

        examples = await repo.find_by_source(source_id)

        assert len(examples) == 3
        assert all(e.source_id == source_id for e in examples)


class TestFindByPageUrl:
    """Tests for find_by_page_url operations."""

    @pytest.mark.asyncio
    async def test_find_by_page_url_returns_all(self, repo):
        """Find by page URL should return all examples from that page."""
        page_url = "https://docs.example.com/multi-example"
        for i in range(3):
            await repo.insert(CodeExampleCreate(
                source_id="src_test",
                page_url=page_url,
                code=f"example_{i}()",
                language="python",
            ))

        examples = await repo.find_by_page_url(page_url)

        assert len(examples) == 3


class TestSearchSimilar:
    """Tests for vector similarity search."""

    @pytest.mark.asyncio
    async def test_search_similar_returns_matches(self, repo, sample_embedding):
        """Search similar should return matching examples."""
        for i in range(5):
            embedding = [0.1 + (i * 0.01)] * 1536
            await repo.insert(CodeExampleCreate(
                source_id="src_search",
                page_url=f"https://docs.example.com/page-{i}",
                code=f"example_{i}()",
                language="python",
                embedding=embedding,
                embedding_dimension=1536,
            ))

        results = await repo.search_similar(sample_embedding, match_count=3)

        assert len(results) <= 3
        assert all(r.similarity > 0 for r in results)

    @pytest.mark.asyncio
    async def test_search_similar_filters_by_source(self, repo, sample_embedding):
        """Search similar should filter by source_id."""
        await repo.insert(CodeExampleCreate(
            source_id="target_source",
            page_url="https://target.com/page",
            code="target()",
            language="python",
            embedding=sample_embedding,
            embedding_dimension=1536,
        ))
        await repo.insert(CodeExampleCreate(
            source_id="other_source",
            page_url="https://other.com/page",
            code="other()",
            language="python",
            embedding=sample_embedding,
            embedding_dimension=1536,
        ))

        results = await repo.search_similar(
            sample_embedding,
            match_count=10,
            source_id="target_source"
        )

        assert len(results) == 1
        assert results[0].item.source_id == "target_source"

    @pytest.mark.asyncio
    async def test_search_similar_filters_by_language(self, repo, sample_embedding):
        """Search similar should filter by language."""
        await repo.insert(CodeExampleCreate(
            source_id="src_test",
            page_url="https://docs.example.com/python",
            code="def hello(): pass",
            language="python",
            embedding=sample_embedding,
            embedding_dimension=1536,
        ))
        await repo.insert(CodeExampleCreate(
            source_id="src_test",
            page_url="https://docs.example.com/rust",
            code="fn hello() {}",
            language="rust",
            embedding=sample_embedding,
            embedding_dimension=1536,
        ))

        results = await repo.search_similar(
            sample_embedding,
            match_count=10,
            language="python"
        )

        assert len(results) == 1
        assert results[0].item.language == "python"


class TestDelete:
    """Tests for delete operations."""

    @pytest.mark.asyncio
    async def test_delete_by_source_removes_all(self, repo):
        """Delete by source should remove all examples for that source."""
        source_id = "src_to_delete"
        for i in range(5):
            await repo.insert(CodeExampleCreate(
                source_id=source_id,
                page_url=f"https://docs.example.com/page-{i}",
                code=f"example_{i}()",
                language="python",
            ))

        deleted = await repo.delete_by_source(source_id)

        assert deleted == 5
        assert await repo.count(source_id) == 0

    @pytest.mark.asyncio
    async def test_delete_by_page_url_removes_all(self, repo):
        """Delete by page URL should remove all examples from that page."""
        page_url = "https://docs.example.com/to-delete"
        for i in range(3):
            await repo.insert(CodeExampleCreate(
                source_id="src_test",
                page_url=page_url,
                code=f"example_{i}()",
                language="python",
            ))

        deleted = await repo.delete_by_page_url(page_url)

        assert deleted == 3


class TestCount:
    """Tests for count operations."""

    @pytest.mark.asyncio
    async def test_count_returns_total(self, repo):
        """Count should return total number of examples."""
        for i in range(5):
            await repo.insert(CodeExampleCreate(
                source_id="src_count",
                page_url=f"https://docs.example.com/page-{i}",
                code=f"example_{i}()",
                language="python",
            ))

        count = await repo.count()

        assert count == 5

    @pytest.mark.asyncio
    async def test_count_filters_by_source(self, repo):
        """Count should filter by source_id."""
        for i in range(3):
            await repo.insert(CodeExampleCreate(
                source_id="source_a",
                page_url=f"https://a.com/page-{i}",
                code=f"a_{i}()",
                language="python",
            ))
        for i in range(2):
            await repo.insert(CodeExampleCreate(
                source_id="source_b",
                page_url=f"https://b.com/page-{i}",
                code=f"b_{i}()",
                language="python",
            ))

        assert await repo.count("source_a") == 3
        assert await repo.count("source_b") == 2


class TestListLanguages:
    """Tests for list_languages operations."""

    @pytest.mark.asyncio
    async def test_list_languages_returns_unique(self, repo):
        """List languages should return unique languages."""
        languages = ["python", "rust", "javascript", "python"]  # Duplicate python
        for i, lang in enumerate(languages):
            await repo.insert(CodeExampleCreate(
                source_id="src_test",
                page_url=f"https://docs.example.com/page-{i}",
                code=f"code_{i}",
                language=lang,
            ))

        result = await repo.list_languages()

        assert len(result) == 3
        assert set(result) == {"javascript", "python", "rust"}

    @pytest.mark.asyncio
    async def test_list_languages_sorted(self, repo):
        """List languages should return sorted list."""
        for lang in ["rust", "python", "go"]:
            await repo.insert(CodeExampleCreate(
                source_id="src_test",
                page_url=f"https://docs.example.com/{lang}",
                code="code",
                language=lang,
            ))

        result = await repo.list_languages()

        assert result == ["go", "python", "rust"]

    @pytest.mark.asyncio
    async def test_list_languages_filters_by_source(self, repo):
        """List languages should filter by source_id."""
        await repo.insert(CodeExampleCreate(
            source_id="source_a",
            page_url="https://a.com/page",
            code="code",
            language="python",
        ))
        await repo.insert(CodeExampleCreate(
            source_id="source_b",
            page_url="https://b.com/page",
            code="code",
            language="rust",
        ))

        result = await repo.list_languages("source_a")

        assert result == ["python"]
