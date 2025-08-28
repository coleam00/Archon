"""Optimized test configuration for Archon with lazy loading and performance enhancements."""

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Import lazy fixtures for enhanced performance
from tests.fixtures.simple_lazy_fixtures import *  # noqa: F403, F401

# Set test environment with performance optimizations
os.environ.update({
    "TEST_MODE": "true",
    "TESTING": "true",
    "SUPABASE_URL": "https://test.supabase.co",
    "SUPABASE_SERVICE_KEY": "test-key",
    "ARCHON_SERVER_PORT": "8181",
    "ARCHON_MCP_PORT": "8051",
    "ARCHON_AGENTS_PORT": "8052",
    "LOG_LEVEL": "WARNING",  # Reduce logging noise
    "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",  # Speed up pytest startup
})


@pytest.fixture(autouse=True)
def prevent_real_db_calls():
    """Automatically prevent any real database calls in all tests."""
    with patch("supabase.create_client") as mock_create:
        # Make create_client raise an error if called without our mock
        mock_create.side_effect = Exception("Real database calls are not allowed in tests! Use lazy fixtures.")
        yield


@pytest.fixture
def mock_supabase_client():
    """Mock Supabase client for testing."""
    mock_client = MagicMock()

    # Mock table operations with chaining support
    mock_table = MagicMock()
    mock_select = MagicMock()
    mock_insert = MagicMock()
    mock_update = MagicMock()
    mock_delete = MagicMock()

    # Setup method chaining for select
    mock_select.execute.return_value.data = []
    mock_select.eq.return_value = mock_select
    mock_select.neq.return_value = mock_select
    mock_select.order.return_value = mock_select
    mock_select.limit.return_value = mock_select
    mock_table.select.return_value = mock_select

    # Setup method chaining for insert
    mock_insert.execute.return_value.data = [{"id": "test-id"}]
    mock_table.insert.return_value = mock_insert

    # Setup method chaining for update
    mock_update.execute.return_value.data = [{"id": "test-id"}]
    mock_update.eq.return_value = mock_update
    mock_table.update.return_value = mock_update

    # Setup method chaining for delete
    mock_delete.execute.return_value.data = []
    mock_delete.eq.return_value = mock_delete
    mock_table.delete.return_value = mock_delete

    # Make table() return the mock table
    mock_client.table.return_value = mock_table

    # Mock auth operations
    mock_client.auth = MagicMock()
    mock_client.auth.get_user.return_value = None

    # Mock storage operations
    mock_client.storage = MagicMock()

    return mock_client


# Legacy client fixture - use optimized_test_client from lazy_test_fixtures instead
@pytest.fixture
def client(optimized_test_client):
    """Legacy FastAPI test client - redirects to optimized version."""
    return optimized_test_client


@pytest.fixture
def test_project():
    """Simple test project data."""
    return {"title": "Test Project", "description": "A test project for essential tests"}


@pytest.fixture
def test_task():
    """Simple test task data."""
    return {
        "title": "Test Task",
        "description": "A test task for essential tests",
        "status": "todo",
        "assignee": "User",
    }


@pytest.fixture
def test_knowledge_item():
    """Simple test knowledge item data."""
    return {
        "url": "https://example.com/test",
        "title": "Test Knowledge Item",
        "content": "This is test content for knowledge base",
        "source_id": "test-source",
    }
