"""
Unit tests for domain models.

These tests verify that:
- Pydantic models have correct field definitions
- Validation rules work as expected
- Model serialization/deserialization works
"""

import pytest
from datetime import datetime
from archon.domain.models import SitePage, SitePageMetadata, SearchResult


class TestSitePageMetadata:
    """Tests for SitePageMetadata model."""

    def test_create_minimal(self):
        """Test creating metadata with only required fields."""
        metadata = SitePageMetadata(source="test_docs")
        assert metadata.source == "test_docs"
        assert metadata.chunk_size is None
        assert metadata.crawled_at is None
        assert metadata.url_path is None

    def test_create_full(self):
        """Test creating metadata with all fields."""
        now = datetime.now()
        metadata = SitePageMetadata(
            source="pydantic_ai_docs",
            chunk_size=1500,
            crawled_at=now,
            url_path="/agents/",
        )
        assert metadata.source == "pydantic_ai_docs"
        assert metadata.chunk_size == 1500
        assert metadata.crawled_at == now
        assert metadata.url_path == "/agents/"

    def test_extra_fields_allowed(self):
        """Test that extra fields are allowed (model_config extra='allow')."""
        metadata = SitePageMetadata(
            source="test_docs",
            custom_field="custom_value",
            another_field=123,
        )
        assert metadata.source == "test_docs"
        # Pydantic v2 stores extra fields in __pydantic_extra__
        assert hasattr(metadata, "__pydantic_extra__")

    def test_serialization(self):
        """Test model_dump (serialization)."""
        metadata = SitePageMetadata(
            source="test_docs",
            chunk_size=1000,
        )
        data = metadata.model_dump()
        assert data["source"] == "test_docs"
        assert data["chunk_size"] == 1000
        assert data["crawled_at"] is None


class TestSitePage:
    """Tests for SitePage model."""

    def test_create_minimal(self):
        """Test creating a page with minimal required fields."""
        metadata = SitePageMetadata(source="test_docs")
        page = SitePage(
            url="https://example.com/docs",
            metadata=metadata,
        )
        assert page.url == "https://example.com/docs"
        assert page.chunk_number == 0
        assert page.id is None
        assert page.title is None
        assert page.summary is None
        assert page.content is None
        assert page.embedding is None
        assert page.created_at is None

    def test_create_full(self):
        """Test creating a page with all fields."""
        now = datetime.now()
        metadata = SitePageMetadata(source="pydantic_ai_docs")
        embedding = [0.1, 0.2, 0.3] * 512  # Mock 1536-dim embedding

        page = SitePage(
            id=42,
            url="https://ai.pydantic.dev/agents/",
            chunk_number=2,
            title="Agents - Pydantic AI",
            summary="Building agents with Pydantic AI",
            content="Pydantic AI is a framework for...",
            metadata=metadata,
            embedding=embedding,
            created_at=now,
        )

        assert page.id == 42
        assert page.url == "https://ai.pydantic.dev/agents/"
        assert page.chunk_number == 2
        assert page.title == "Agents - Pydantic AI"
        assert page.summary == "Building agents with Pydantic AI"
        assert page.content == "Pydantic AI is a framework for..."
        assert len(page.embedding) == 1536
        assert page.created_at == now

    def test_from_dict(self):
        """Test creating from dict (from_attributes)."""
        data = {
            "id": 1,
            "url": "https://example.com",
            "chunk_number": 0,
            "title": "Example",
            "metadata": {"source": "example_docs"},
        }
        page = SitePage.model_validate(data)
        assert page.id == 1
        assert page.url == "https://example.com"
        assert page.metadata.source == "example_docs"

    def test_serialization(self):
        """Test model_dump (serialization)."""
        metadata = SitePageMetadata(source="test_docs")
        page = SitePage(
            url="https://example.com",
            chunk_number=1,
            metadata=metadata,
        )
        data = page.model_dump()
        assert data["url"] == "https://example.com"
        assert data["chunk_number"] == 1
        assert data["metadata"]["source"] == "test_docs"

    def test_json_serialization(self):
        """Test JSON serialization."""
        metadata = SitePageMetadata(source="test_docs")
        page = SitePage(
            url="https://example.com",
            metadata=metadata,
            created_at=datetime(2025, 11, 29, 12, 0, 0),
        )
        json_str = page.model_dump_json()
        assert "https://example.com" in json_str
        assert "test_docs" in json_str


class TestSearchResult:
    """Tests for SearchResult model."""

    def test_create(self):
        """Test creating a search result."""
        metadata = SitePageMetadata(source="test_docs")
        page = SitePage(
            url="https://example.com",
            metadata=metadata,
        )
        result = SearchResult(page=page, similarity=0.87)

        assert result.page.url == "https://example.com"
        assert result.similarity == 0.87

    def test_similarity_validation(self):
        """Test that similarity is validated to be between 0 and 1."""
        metadata = SitePageMetadata(source="test_docs")
        page = SitePage(url="https://example.com", metadata=metadata)

        # Valid values
        SearchResult(page=page, similarity=0.0)
        SearchResult(page=page, similarity=0.5)
        SearchResult(page=page, similarity=1.0)

        # Invalid values should raise validation error
        with pytest.raises(Exception):  # Pydantic ValidationError
            SearchResult(page=page, similarity=-0.1)

        with pytest.raises(Exception):  # Pydantic ValidationError
            SearchResult(page=page, similarity=1.5)

    def test_serialization(self):
        """Test model_dump (serialization)."""
        metadata = SitePageMetadata(source="test_docs")
        page = SitePage(
            id=1,
            url="https://example.com",
            metadata=metadata,
        )
        result = SearchResult(page=page, similarity=0.92)

        data = result.model_dump()
        assert data["similarity"] == 0.92
        assert data["page"]["id"] == 1
        assert data["page"]["url"] == "https://example.com"


class TestModelIntegration:
    """Integration tests for models working together."""

    def test_nested_model_creation(self):
        """Test creating nested models from raw data."""
        raw_data = {
            "page": {
                "id": 1,
                "url": "https://ai.pydantic.dev/agents/",
                "chunk_number": 0,
                "title": "Agents",
                "summary": "Introduction",
                "content": "Pydantic AI...",
                "metadata": {
                    "source": "pydantic_ai_docs",
                    "chunk_size": 1500,
                },
                "embedding": [0.1, 0.2, 0.3],
            },
            "similarity": 0.88,
        }

        result = SearchResult.model_validate(raw_data)
        assert result.similarity == 0.88
        assert result.page.id == 1
        assert result.page.title == "Agents"
        assert result.page.metadata.source == "pydantic_ai_docs"
        assert len(result.page.embedding) == 3

    def test_round_trip_serialization(self):
        """Test that serialization and deserialization preserve data."""
        metadata = SitePageMetadata(
            source="pydantic_ai_docs",
            chunk_size=1500,
        )
        original_page = SitePage(
            id=42,
            url="https://ai.pydantic.dev/agents/",
            chunk_number=1,
            title="Agents",
            metadata=metadata,
            embedding=[0.1, 0.2, 0.3],
        )

        # Serialize to dict
        page_dict = original_page.model_dump()

        # Deserialize back to model
        restored_page = SitePage.model_validate(page_dict)

        # Verify data is preserved
        assert restored_page.id == original_page.id
        assert restored_page.url == original_page.url
        assert restored_page.chunk_number == original_page.chunk_number
        assert restored_page.title == original_page.title
        assert restored_page.metadata.source == original_page.metadata.source
        assert restored_page.embedding == original_page.embedding
