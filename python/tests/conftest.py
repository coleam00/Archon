"""Simple test configuration for Archon - Essential tests only."""

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Set test environment - always override to ensure test isolation
os.environ["TEST_MODE"] = "true"
os.environ["TESTING"] = "true"
# Set fake database credentials to prevent connection attempts
os.environ["SUPABASE_URL"] = "https://test.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "test-key"
# Set required port environment variables for ServiceDiscovery
os.environ["ARCHON_SERVER_PORT"] = "8181"
os.environ["ARCHON_MCP_PORT"] = "8051"
os.environ["ARCHON_AGENTS_PORT"] = "8052"

# Global patches that need to be active during module imports and app initialization
# This ensures that any code that runs during FastAPI app startup is mocked
mock_client = MagicMock()
mock_table = MagicMock()
mock_select = MagicMock()
mock_execute = MagicMock()
mock_execute.data = []
mock_select.execute.return_value = mock_execute
mock_select.eq.return_value = mock_select
mock_select.order.return_value = mock_select
mock_table.select.return_value = mock_select
mock_client.table.return_value = mock_table

# Apply global patches immediately
from unittest.mock import patch
_global_patches = [
    patch("supabase.create_client", return_value=mock_client),
    patch("src.server.services.client_manager.get_supabase_client", return_value=mock_client),
    patch("src.server.utils.get_supabase_client", return_value=mock_client),
]

for p in _global_patches:
    p.start()


@pytest.fixture(autouse=True)
def ensure_test_environment():
    """Ensure test environment is properly set for each test."""
    # Force test environment settings - this runs before each test
    os.environ["TEST_MODE"] = "true"
    os.environ["TESTING"] = "true"
    os.environ["SUPABASE_URL"] = "https://test.supabase.co"
    os.environ["SUPABASE_SERVICE_KEY"] = "test-key"
    os.environ["ARCHON_SERVER_PORT"] = "8181"
    os.environ["ARCHON_MCP_PORT"] = "8051"
    os.environ["ARCHON_AGENTS_PORT"] = "8052"
    yield
    

@pytest.fixture(autouse=True)
def prevent_real_db_calls():
    """Automatically prevent any real database calls in all tests."""
    # Create a mock client to use everywhere
    mock_client = MagicMock()
    
    # Mock table operations with chaining support
    mock_table = MagicMock()
    mock_select = MagicMock()
    mock_or = MagicMock()
    mock_execute = MagicMock()
    
    # Setup basic chaining
    mock_execute.data = []
    mock_or.execute.return_value = mock_execute
    mock_select.or_.return_value = mock_or
    mock_select.execute.return_value = mock_execute
    mock_select.eq.return_value = mock_select
    mock_select.order.return_value = mock_select
    mock_table.select.return_value = mock_select
    mock_table.insert.return_value.execute.return_value.data = [{"id": "test-id"}]
    mock_client.table.return_value = mock_table
    
    # Patch all the common ways to get a Supabase client
    with patch("supabase.create_client", return_value=mock_client):
        with patch("src.server.services.client_manager.get_supabase_client", return_value=mock_client):
            with patch("src.server.utils.get_supabase_client", return_value=mock_client):
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


@pytest.fixture
def client(mock_supabase_client):
    """FastAPI test client with mocked database."""
    # Patch all the ways Supabase client can be created
    with patch(
        "src.server.services.client_manager.get_supabase_client",
        return_value=mock_supabase_client,
    ):
        with patch(
            "src.server.utils.get_supabase_client",
            return_value=mock_supabase_client,
        ):
            with patch(
                "src.server.services.credential_service.create_client",
                return_value=mock_supabase_client,
            ):
                with patch("supabase.create_client", return_value=mock_supabase_client):
                    # Import app after patching to ensure mocks are used
                    from src.server.main import app

                    return TestClient(app)


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
