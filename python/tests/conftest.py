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

# Apply global patches immediately (patch already imported at line 4)
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
                    from unittest.mock import AsyncMock
                    import src.server.main as server_main

                    # Mark initialization as complete for testing (before accessing app)
                    server_main._initialization_complete = True
                    app = server_main.app

                    # Mock the schema check to always return valid
                    mock_schema_check = AsyncMock(return_value={"valid": True, "message": "Schema is up to date"})
                    with patch("src.server.main._check_database_schema", new=mock_schema_check):
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


# =============================================================================
# Repository Fixtures (InMemory for fast unit testing)
# =============================================================================

@pytest.fixture
def memory_crawled_pages_repository():
    """InMemory crawled pages repository for testing."""
    from src.server.infrastructure.memory import InMemoryCrawledPagesRepository
    repo = InMemoryCrawledPagesRepository()
    yield repo
    repo.clear()


@pytest.fixture
def memory_sources_repository():
    """InMemory sources repository for testing."""
    from src.server.infrastructure.memory import InMemorySourcesRepository
    repo = InMemorySourcesRepository()
    yield repo
    repo.clear()


@pytest.fixture
def memory_code_examples_repository():
    """InMemory code examples repository for testing."""
    from src.server.infrastructure.memory import InMemoryCodeExamplesRepository
    repo = InMemoryCodeExamplesRepository()
    yield repo
    repo.clear()


@pytest.fixture
def use_memory_repositories():
    """
    Fixture to use InMemory repositories via the container.

    Sets REPOSITORY_TYPE=memory and resets the factory singletons.
    """
    from src.server.infrastructure.repository_factory import reset_repositories_sync

    # Store original value
    original_type = os.environ.get("REPOSITORY_TYPE")

    # Set to memory
    os.environ["REPOSITORY_TYPE"] = "memory"
    reset_repositories_sync()

    yield

    # Restore original value
    if original_type is not None:
        os.environ["REPOSITORY_TYPE"] = original_type
    else:
        os.environ.pop("REPOSITORY_TYPE", None)
    reset_repositories_sync()


@pytest.fixture
def container_with_memory():
    """
    Container fixture configured with InMemory repositories.

    Useful for integration tests that need the full container.
    """
    from src.server.container import Container
    from src.server.infrastructure.repository_factory import reset_repositories_sync

    # Store original value
    original_type = os.environ.get("REPOSITORY_TYPE")

    # Set to memory and reset container
    os.environ["REPOSITORY_TYPE"] = "memory"
    Container.reset()
    reset_repositories_sync()

    from src.server.container import container

    yield container

    # Restore and cleanup
    if original_type is not None:
        os.environ["REPOSITORY_TYPE"] = original_type
    else:
        os.environ.pop("REPOSITORY_TYPE", None)
    Container.reset()
    reset_repositories_sync()
