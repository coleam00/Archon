"""
Unit tests for pages_api.py
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client(mock_supabase_client):
    """Create test client with mocked database."""
    with patch("src.server.utils.get_supabase_client", return_value=mock_supabase_client):
        return TestClient(app)


@pytest.fixture
def mock_page_data():
    """Mock page data for tests."""
    return {
        "id": "page-123",
        "source_id": "source-456",
        "url": "https://example.com/page1",
        "full_content": "This is the full page content.",
        "section_title": "Introduction",
        "section_order": 1,
        "word_count": 100,
        "char_count": 500,
        "chunk_count": 5,
        "metadata": {"author": "Test Author"},
        "created_at": "2025-01-01T00:00:00",
        "updated_at": "2025-01-01T00:00:00"
    }


def test_list_pages_success(client, mock_supabase_client, mock_page_data):
    """Test successful page listing."""
    # Mock database response
    mock_execute = MagicMock()
    mock_execute.data = [mock_page_data]
    mock_select = MagicMock()
    mock_select.eq.return_value.order.return_value.order.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages?source_id=source-456")

    assert response.status_code == 200
    data = response.json()
    assert "pages" in data
    assert "total" in data
    assert data["source_id"] == "source-456"
    assert len(data["pages"]) == 1


def test_list_pages_with_section_filter(client, mock_supabase_client, mock_page_data):
    """Test listing pages with section filter."""
    mock_execute = MagicMock()
    mock_execute.data = [mock_page_data]
    mock_select = MagicMock()
    mock_select.eq.return_value.eq.return_value.order.return_value.order.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages?source_id=source-456&section=Introduction")

    assert response.status_code == 200
    data = response.json()
    assert data["total"] >= 0


def test_list_pages_missing_source_id(client):
    """Test listing pages without source_id parameter."""
    response = client.get("/api/pages")

    assert response.status_code == 422  # Validation error


def test_list_pages_empty_result(client, mock_supabase_client):
    """Test listing pages when no pages exist."""
    mock_execute = MagicMock()
    mock_execute.data = []
    mock_select = MagicMock()
    mock_select.eq.return_value.order.return_value.order.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages?source_id=source-456")

    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 0
    assert len(data["pages"]) == 0


def test_get_page_by_url_success(client, mock_supabase_client, mock_page_data):
    """Test getting a page by URL."""
    mock_execute = MagicMock()
    mock_execute.data = mock_page_data
    mock_select = MagicMock()
    mock_select.eq.return_value.single.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages/by-url?url=https://example.com/page1")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "page-123"
    assert data["url"] == "https://example.com/page1"


def test_get_page_by_url_not_found(client, mock_supabase_client):
    """Test getting page by URL when not found."""
    mock_execute = MagicMock()
    mock_execute.data = None
    mock_select = MagicMock()
    mock_select.eq.return_value.single.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages/by-url?url=https://nonexistent.com")

    assert response.status_code == 404


def test_get_page_by_id_success(client, mock_supabase_client, mock_page_data):
    """Test getting a page by ID."""
    mock_execute = MagicMock()
    mock_execute.data = mock_page_data
    mock_select = MagicMock()
    mock_select.eq.return_value.single.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages/page-123")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "page-123"


def test_get_page_by_id_not_found(client, mock_supabase_client):
    """Test getting page by ID when not found."""
    mock_execute = MagicMock()
    mock_execute.data = None
    mock_select = MagicMock()
    mock_select.eq.return_value.single.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages/nonexistent-id")

    assert response.status_code == 404


def test_large_page_content_truncation(client, mock_supabase_client):
    """Test that large pages get their content replaced with a message."""
    large_page_data = {
        "id": "page-123",
        "source_id": "source-456",
        "url": "https://example.com/large",
        "full_content": "x" * 30000,  # Large content
        "section_title": "Large Section",
        "section_order": 1,
        "word_count": 5000,
        "char_count": 30000,  # Exceeds MAX_PAGE_CHARS (20,000)
        "chunk_count": 100,
        "metadata": {},
        "created_at": "2025-01-01T00:00:00",
        "updated_at": "2025-01-01T00:00:00"
    }

    mock_execute = MagicMock()
    mock_execute.data = large_page_data
    mock_select = MagicMock()
    mock_select.eq.return_value.single.return_value.execute.return_value = mock_execute
    mock_supabase_client.table.return_value.select.return_value = mock_select

    response = client.get("/api/pages/page-123")

    assert response.status_code == 200
    data = response.json()
    # Content should be replaced with helpful message
    assert "[Page too large for context" in data["full_content"]
    assert "30,000 characters" in data["full_content"]
