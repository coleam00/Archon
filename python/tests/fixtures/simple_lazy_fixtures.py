"""
Simple lazy-loading test fixtures for optimal test performance.
"""

import os
import threading
from functools import lru_cache
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Set up test environment
os.environ.update({
    "TEST_MODE": "true",
    "TESTING": "true",
    "SUPABASE_URL": "https://test.supabase.co",
    "SUPABASE_SERVICE_KEY": "test-key",
    "ARCHON_SERVER_PORT": "8181",
    "ARCHON_MCP_PORT": "8051",
    "ARCHON_AGENTS_PORT": "8052",
    "LOG_LEVEL": "WARNING",
})


@lru_cache(maxsize=1)
def _create_mock_supabase_client() -> MagicMock:
    """Create a cached mock Supabase client."""
    mock_client = MagicMock()
    
    # Mock table operations
    mock_table = MagicMock()
    mock_select = MagicMock()
    mock_select.execute.return_value.data = []
    mock_select.eq.return_value = mock_select
    mock_select.order.return_value = mock_select
    mock_select.limit.return_value = mock_select
    mock_table.select.return_value = mock_select
    
    mock_insert = MagicMock()
    mock_insert.execute.return_value.data = [{"id": "test-id"}]
    mock_table.insert.return_value = mock_insert
    
    mock_update = MagicMock()
    mock_update.execute.return_value.data = [{"id": "test-id"}]
    mock_update.eq.return_value = mock_update
    mock_table.update.return_value = mock_update
    
    mock_delete = MagicMock()
    mock_delete.execute.return_value.data = []
    mock_delete.eq.return_value = mock_delete
    mock_table.delete.return_value = mock_delete
    
    mock_client.table.return_value = mock_table
    mock_client.auth = MagicMock()
    mock_client.auth.get_user.return_value = None
    mock_client.storage = MagicMock()
    
    return mock_client


@pytest.fixture(scope="session")
def mock_supabase_client() -> MagicMock:
    """Session-scoped mock Supabase client for maximum reuse."""
    return _create_mock_supabase_client()


@pytest.fixture(scope="function")
def isolated_mock_supabase_client(mock_supabase_client) -> MagicMock:
    """Function-scoped mock that resets state between tests."""
    mock_supabase_client.reset_mock()
    return mock_supabase_client


@pytest.fixture(scope="function")
def optimized_test_client(isolated_mock_supabase_client):
    """Optimized FastAPI test client with comprehensive mocking."""
    with patch("src.server.services.client_manager.create_client", return_value=isolated_mock_supabase_client):
        with patch("src.server.services.credential_service.create_client", return_value=isolated_mock_supabase_client):
            with patch("src.server.services.client_manager.get_supabase_client", return_value=isolated_mock_supabase_client):
                with patch("supabase.create_client", return_value=isolated_mock_supabase_client):
                    from src.server.main import app
                    yield TestClient(app)


class LazyMockDataFactory:
    """Factory for creating mock data with lazy loading."""
    
    @lru_cache(maxsize=32)
    def create_test_project(self, project_id: str = "test-project-id") -> Dict[str, Any]:
        """Create test project data."""
        return {
            "id": project_id,
            "title": "Test Project",
            "description": "A test project for lazy fixture testing",
            "github_repo": "https://github.com/test/repo",
            "created_at": "2024-01-01T00:00:00Z"
        }
    
    @lru_cache(maxsize=32)
    def create_test_task(self, task_id: str = "test-task-id", project_id: str = "test-project-id") -> Dict[str, Any]:
        """Create test task data."""
        return {
            "id": task_id,
            "project_id": project_id,
            "title": "Test Task",
            "description": "A test task for lazy fixture testing",
            "status": "todo",
            "assignee": "User",
            "created_at": "2024-01-01T00:00:00Z"
        }
    
    @lru_cache(maxsize=32)
    def create_test_knowledge_item(self, source_id: str = "test-source-id") -> Dict[str, Any]:
        """Create test knowledge item data."""
        return {
            "id": source_id,
            "url": "https://example.com/test",
            "title": "Test Knowledge Item",
            "content": "This is test content for knowledge base testing",
            "source_type": "webpage",
            "status": "completed",
            "created_at": "2024-01-01T00:00:00Z"
        }


@pytest.fixture(scope="function")
def mock_data_factory() -> LazyMockDataFactory:
    """Factory for creating mock test data with caching."""
    return LazyMockDataFactory()


@pytest.fixture
def test_project(mock_data_factory):
    """Lazy-loaded test project data."""
    return mock_data_factory.create_test_project()


@pytest.fixture
def test_task(mock_data_factory):
    """Lazy-loaded test task data."""
    return mock_data_factory.create_test_task()


@pytest.fixture
def test_knowledge_item(mock_data_factory):
    """Lazy-loaded test knowledge item data."""
    return mock_data_factory.create_test_knowledge_item()