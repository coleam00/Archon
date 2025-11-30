"""
Tests for Supabase mappers.

Tests the conversion between Supabase dicts and domain models.
"""

import pytest
from datetime import datetime, timezone
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.domain.models.search_result import SearchResult
from archon.infrastructure.supabase.mappers import (
    dict_to_site_page,
    site_page_to_dict,
    dict_to_search_result,
)


def test_dict_to_site_page_basic():
    """Test basic conversion from dict to SitePage."""
    data = {
        "id": 1,
        "url": "https://example.com/docs",
        "chunk_number": 0,
        "title": "Example Documentation",
        "summary": "A summary",
        "content": "Full content here",
        "metadata": {"source": "example_docs", "chunk_size": 1500},
        "embedding": [0.1, 0.2, 0.3],
        "created_at": "2025-11-29T12:00:00+00:00",
    }

    page = dict_to_site_page(data)

    assert page.id == 1
    assert page.url == "https://example.com/docs"
    assert page.chunk_number == 0
    assert page.title == "Example Documentation"
    assert page.summary == "A summary"
    assert page.content == "Full content here"
    assert page.metadata.source == "example_docs"
    assert page.metadata.chunk_size == 1500
    assert page.embedding == [0.1, 0.2, 0.3]
    assert isinstance(page.created_at, datetime)


def test_dict_to_site_page_minimal():
    """Test conversion with minimal required fields."""
    data = {
        "url": "https://example.com/docs",
        "metadata": {"source": "example_docs"},
    }

    page = dict_to_site_page(data)

    assert page.id is None
    assert page.url == "https://example.com/docs"
    assert page.chunk_number == 0
    assert page.title is None
    assert page.metadata.source == "example_docs"


def test_site_page_to_dict_basic():
    """Test basic conversion from SitePage to dict."""
    page = SitePage(
        id=1,
        url="https://example.com/docs",
        chunk_number=0,
        title="Example Documentation",
        summary="A summary",
        content="Full content here",
        metadata=SitePageMetadata(source="example_docs", chunk_size=1500),
        embedding=[0.1, 0.2, 0.3],
        created_at=datetime(2025, 11, 29, 12, 0, 0, tzinfo=timezone.utc),
    )

    data = site_page_to_dict(page)

    assert data["id"] == 1
    assert data["url"] == "https://example.com/docs"
    assert data["chunk_number"] == 0
    assert data["title"] == "Example Documentation"
    assert data["summary"] == "A summary"
    assert data["content"] == "Full content here"
    assert data["metadata"]["source"] == "example_docs"
    assert data["metadata"]["chunk_size"] == 1500
    assert data["embedding"] == [0.1, 0.2, 0.3]
    assert "created_at" in data


def test_site_page_to_dict_minimal():
    """Test conversion with minimal required fields."""
    page = SitePage(
        url="https://example.com/docs",
        metadata=SitePageMetadata(source="example_docs"),
    )

    data = site_page_to_dict(page)

    assert "id" not in data  # id is None, should not be included
    assert data["url"] == "https://example.com/docs"
    assert data["chunk_number"] == 0
    assert data["metadata"]["source"] == "example_docs"


def test_dict_to_search_result():
    """Test conversion from dict to SearchResult."""
    data = {
        "id": 1,
        "url": "https://example.com/docs",
        "chunk_number": 0,
        "title": "Example Documentation",
        "content": "Full content here",
        "metadata": {"source": "example_docs"},
        "similarity": 0.87,
    }

    result = dict_to_search_result(data)

    assert isinstance(result, SearchResult)
    assert result.similarity == 0.87
    assert result.page.id == 1
    assert result.page.url == "https://example.com/docs"
    assert result.page.title == "Example Documentation"


def test_roundtrip_conversion():
    """Test that converting dict -> SitePage -> dict preserves data."""
    original_dict = {
        "id": 42,
        "url": "https://example.com/docs",
        "chunk_number": 2,
        "title": "Example",
        "summary": "Summary",
        "content": "Content",
        "metadata": {"source": "example_docs", "chunk_size": 1000},
        "embedding": [0.1, 0.2],
        "created_at": "2025-11-29T12:00:00+00:00",
    }

    # Convert dict -> SitePage -> dict
    page = dict_to_site_page(original_dict)
    result_dict = site_page_to_dict(page)

    # Compare key fields (note: created_at format might differ)
    assert result_dict["id"] == original_dict["id"]
    assert result_dict["url"] == original_dict["url"]
    assert result_dict["chunk_number"] == original_dict["chunk_number"]
    assert result_dict["title"] == original_dict["title"]
    assert result_dict["metadata"]["source"] == original_dict["metadata"]["source"]
    assert result_dict["embedding"] == original_dict["embedding"]
