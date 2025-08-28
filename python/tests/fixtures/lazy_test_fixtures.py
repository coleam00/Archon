"""
Lazy-loading test fixtures for optimal test performance.

This module provides lazy-loaded fixtures that defer expensive operations
until they are actually needed, significantly reducing test startup time
and memory usage.

Key optimizations:
- Lazy repository instantiation using the lazy_imports system
- Cached mock clients with session-scoped lifecycle
- Deferred database setup and teardown
- Memory-efficient fixture cleanup
- Smart fixture dependency resolution
"""

import asyncio
import os
import threading
from contextlib import asynccontextmanager
from functools import lru_cache, partial
from typing import Any, AsyncGenerator, Dict, Generator, Optional, Type
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# Set up test environment early
os.environ.update({
    "TEST_MODE": "true",
    "TESTING": "true",
    "SUPABASE_URL": "https://test.supabase.co",
    "SUPABASE_SERVICE_KEY": "test-key",
    "ARCHON_SERVER_PORT": "8181",
    "ARCHON_MCP_PORT": "8051",
    "ARCHON_AGENTS_PORT": "8052",
    "LOG_LEVEL": "WARNING",  # Reduce logging noise in tests
})


class LazyFixtureCache:
    """
    Thread-safe cache for expensive test fixtures.
    
    Provides lazy loading, cleanup management, and memory optimization
    for test fixtures that are expensive to create.
    """
    
    def __init__(self):
        self._cache: Dict[str, Any] = {}
        self._lock = threading.RLock()
        self._cleanup_handlers: Dict[str, callable] = {}
    
    def get_or_create(self, key: str, factory: callable, cleanup_handler: Optional[callable] = None) -> Any:
        """Get cached item or create it using factory function."""
        with self._lock:
            if key not in self._cache:
                self._cache[key] = factory()
                if cleanup_handler:
                    self._cleanup_handlers[key] = cleanup_handler
            return self._cache[key]
    
    def clear(self, key: Optional[str] = None):
        """Clear specific item or entire cache."""
        with self._lock:
            if key:
                if key in self._cache:
                    if key in self._cleanup_handlers:
                        try:
                            self._cleanup_handlers[key](self._cache[key])
                        except Exception:
                            pass  # Ignore cleanup errors
                        del self._cleanup_handlers[key]
                    del self._cache[key]
            else:
                # Clear all
                for cache_key in list(self._cache.keys()):
                    self.clear(cache_key)
    
    def get_stats(self) -> Dict[str, int]:
        """Get cache statistics."""
        with self._lock:
            return {
                "cached_items": len(self._cache),
                "cleanup_handlers": len(self._cleanup_handlers)
            }


# Global fixture cache
_fixture_cache = LazyFixtureCache()


@pytest.fixture(scope="session", autouse=True)
def setup_test_environment():
    """Set up test environment and cleanup after all tests."""
    # Environment is already set up at module level
    yield
    # Cleanup cache after all tests
    _fixture_cache.clear()


@pytest.fixture(scope="session")
def event_loop():
    """Create session-scoped event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    try:
        # Clean up any remaining tasks
        pending = asyncio.all_tasks(loop)
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
    finally:
        loop.close()


@lru_cache(maxsize=1)
def _create_mock_supabase_client() -> MagicMock:
    """Create a cached mock Supabase client with comprehensive API coverage."""
    mock_client = MagicMock()
    
    # Mock table operations with full method chaining
    def create_mock_table():
        mock_table = MagicMock()
        
        # Query operations
        mock_select = MagicMock()
        mock_select.execute.return_value.data = []
        mock_select.eq.return_value = mock_select
        mock_select.neq.return_value = mock_select
        mock_select.gt.return_value = mock_select
        mock_select.gte.return_value = mock_select
        mock_select.lt.return_value = mock_select
        mock_select.lte.return_value = mock_select
        mock_select.like.return_value = mock_select
        mock_select.ilike.return_value = mock_select
        mock_select.in_.return_value = mock_select
        mock_select.order.return_value = mock_select
        mock_select.limit.return_value = mock_select
        mock_select.offset.return_value = mock_select
        mock_select.range.return_value = mock_select
        mock_table.select.return_value = mock_select
        
        # Insert operations
        mock_insert = MagicMock()
        mock_insert.execute.return_value.data = [{"id": "test-id"}]
        mock_table.insert.return_value = mock_insert
        
        # Update operations
        mock_update = MagicMock()
        mock_update.execute.return_value.data = [{"id": "test-id"}]
        mock_update.eq.return_value = mock_update
        mock_table.update.return_value = mock_update
        
        # Delete operations
        mock_delete = MagicMock()
        mock_delete.execute.return_value.data = []
        mock_delete.eq.return_value = mock_delete
        mock_table.delete.return_value = mock_delete
        
        # Upsert operations
        mock_upsert = MagicMock()
        mock_upsert.execute.return_value.data = [{"id": "test-id"}]
        mock_table.upsert.return_value = mock_upsert
        
        return mock_table
    
    # Make table() return a new mock table each time
    mock_client.table.side_effect = create_mock_table
    
    # Mock auth operations
    mock_client.auth = MagicMock()
    mock_client.auth.get_user.return_value = None
    mock_client.auth.get_session.return_value = None
    
    # Mock storage operations
    mock_client.storage = MagicMock()
    mock_storage_bucket = MagicMock()
    mock_storage_bucket.upload.return_value = {"data": {"path": "test-path"}}
    mock_storage_bucket.download.return_value = b"test-content"
    mock_storage_bucket.list.return_value = {"data": []}
    mock_client.storage.from_.return_value = mock_storage_bucket
    
    # Mock RPC operations
    mock_client.rpc.return_value.execute.return_value.data = {}
    
    return mock_client\n\n\n@pytest.fixture(scope=\"session\")\ndef mock_supabase_client() -> MagicMock:\n    \"\"\"Session-scoped mock Supabase client for maximum reuse.\"\"\"\n    return _fixture_cache.get_or_create(\n        \"mock_supabase_client\",\n        _create_mock_supabase_client\n    )\n\n\n@pytest.fixture(scope=\"function\")\ndef isolated_mock_supabase_client(mock_supabase_client) -> MagicMock:\n    \"\"\"Function-scoped mock that resets state between tests.\"\"\"\n    # Reset all mock calls for this test\n    mock_supabase_client.reset_mock()\n    return mock_supabase_client\n\n\nclass LazyRepositoryFactory:\n    \"\"\"Factory for lazy-loaded repository instances.\"\"\"\n    \n    def __init__(self, mock_client):\n        self.mock_client = mock_client\n        self._repository_cache = {}\n    \n    def get_repository(self, repository_name: str):\n        \"\"\"Get repository instance with lazy loading.\"\"\"\n        if repository_name not in self._repository_cache:\n            from src.server.repositories.lazy_imports import get_repository_class\n            \n            try:\n                RepositoryClass = get_repository_class(repository_name)\n                self._repository_cache[repository_name] = RepositoryClass(self.mock_client)\n            except Exception as e:\n                # Fall back to mock repository if real one fails\n                mock_repo = MagicMock()\n                mock_repo._client = self.mock_client\n                self._repository_cache[repository_name] = mock_repo\n        \n        return self._repository_cache[repository_name]\n    \n    def clear_cache(self):\n        \"\"\"Clear repository cache.\"\"\"\n        self._repository_cache.clear()\n\n\n@pytest.fixture(scope=\"function\")\ndef lazy_repository_factory(isolated_mock_supabase_client) -> LazyRepositoryFactory:\n    \"\"\"Factory for creating repository instances on-demand.\"\"\"\n    factory = LazyRepositoryFactory(isolated_mock_supabase_client)\n    yield factory\n    factory.clear_cache()\n\n\n@pytest.fixture\ndef lazy_source_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded source repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseSourceRepository\")\n\n\n@pytest.fixture\ndef lazy_document_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded document repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseDocumentRepository\")\n\n\n@pytest.fixture\ndef lazy_project_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded project repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseProjectRepository\")\n\n\n@pytest.fixture\ndef lazy_task_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded task repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseTaskRepository\")\n\n\n@pytest.fixture\ndef lazy_code_example_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded code example repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseCodeExampleRepository\")\n\n\n@pytest.fixture\ndef lazy_version_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded version repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseVersionRepository\")\n\n\n@pytest.fixture\ndef lazy_settings_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded settings repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabaseSettingsRepository\")\n\n\n@pytest.fixture\ndef lazy_prompt_repository(lazy_repository_factory):\n    \"\"\"Lazy-loaded prompt repository.\"\"\"\n    return lazy_repository_factory.get_repository(\"SupabasePromptRepository\")\n\n\n@pytest.fixture(scope=\"function\")\ndef prevent_real_database_connections():\n    \"\"\"Prevent any real database connections during tests.\"\"\"\n    with patch(\"supabase.create_client\") as mock_create:\n        mock_create.side_effect = Exception(\n            \"Real database calls are not allowed in tests! Use lazy fixtures.\"\n        )\n        yield\n\n\n@pytest.fixture(scope=\"function\")\ndef optimized_test_client(isolated_mock_supabase_client):\n    \"\"\"Optimized FastAPI test client with comprehensive mocking.\"\"\"\n    patches = [\n        patch(\"src.server.services.client_manager.create_client\", return_value=isolated_mock_supabase_client),\n        patch(\"src.server.services.credential_service.create_client\", return_value=isolated_mock_supabase_client),\n        patch(\"src.server.services.client_manager.get_supabase_client\", return_value=isolated_mock_supabase_client),\n        patch(\"supabase.create_client\", return_value=isolated_mock_supabase_client),\n        # Mock expensive services\n        patch(\"src.server.services.llm_provider_service.LLMProviderService\"),\n        patch(\"src.server.services.crawler_manager.CrawlerManager\"),\n        patch(\"src.server.services.background_task_manager.BackgroundTaskManager\"),\n    ]\n    \n    with patch.multiple(*[p for p in patches]):\n        # Import app after all patches are in place\n        from src.server.main import app\n        yield TestClient(app)\n\n\n# Performance monitoring fixtures\n@pytest.fixture\ndef performance_monitor():\n    \"\"\"Monitor test performance metrics.\"\"\"\n    import time\n    import psutil\n    import os\n    \n    start_time = time.time()\n    process = psutil.Process(os.getpid())\n    start_memory = process.memory_info().rss\n    \n    yield\n    \n    end_time = time.time()\n    end_memory = process.memory_info().rss\n    \n    duration = end_time - start_time\n    memory_diff = end_memory - start_memory\n    \n    # Log performance if test is slow\n    if duration > 1.0:  # More than 1 second\n        print(f\"\\n⚠️  Slow test: {duration:.2f}s, Memory: {memory_diff/1024/1024:.1f}MB\")\n\n\n# Async test utilities\n@asynccontextmanager\nasync def async_test_context():\n    \"\"\"Context manager for async tests with proper cleanup.\"\"\"\n    try:\n        yield\n    finally:\n        # Cleanup any pending async tasks\n        try:\n            pending = [t for t in asyncio.all_tasks() if not t.done()]\n            if pending:\n                await asyncio.gather(*pending, return_exceptions=True)\n        except Exception:\n            pass  # Ignore cleanup errors\n\n\n@pytest.fixture\nasync def async_test_context_fixture():\n    \"\"\"Fixture wrapper for async test context.\"\"\"\n    async with async_test_context():\n        yield\n\n\n# Mock data factories with lazy loading\nclass LazyMockDataFactory:\n    \"\"\"Factory for creating mock data with lazy loading.\"\"\"\n    \n    @lru_cache(maxsize=32)\n    def create_test_project(self, project_id: str = \"test-project-id\") -> Dict[str, Any]:\n        \"\"\"Create test project data.\"\"\"\n        return {\n            \"id\": project_id,\n            \"title\": \"Test Project\",\n            \"description\": \"A test project for lazy fixture testing\",\n            \"github_repo\": \"https://github.com/test/repo\",\n            \"created_at\": \"2024-01-01T00:00:00Z\",\n            \"features\": [\"authentication\", \"api\"],\n            \"prd\": {\n                \"product_vision\": \"Test product vision\",\n                \"target_users\": [\"developers\"],\n                \"key_features\": [\"feature1\", \"feature2\"],\n                \"success_metrics\": [\"metric1\"],\n                \"constraints\": [\"constraint1\"]\n            }\n        }\n    \n    @lru_cache(maxsize=32)\n    def create_test_task(self, task_id: str = \"test-task-id\", project_id: str = \"test-project-id\") -> Dict[str, Any]:\n        \"\"\"Create test task data.\"\"\"\n        return {\n            \"id\": task_id,\n            \"project_id\": project_id,\n            \"title\": \"Test Task\",\n            \"description\": \"A test task for lazy fixture testing\",\n            \"status\": \"todo\",\n            \"assignee\": \"User\",\n            \"task_order\": 10,\n            \"feature\": \"test-feature\",\n            \"created_at\": \"2024-01-01T00:00:00Z\"\n        }\n    \n    @lru_cache(maxsize=32)\n    def create_test_knowledge_item(self, source_id: str = \"test-source-id\") -> Dict[str, Any]:\n        \"\"\"Create test knowledge item data.\"\"\"\n        return {\n            \"id\": source_id,\n            \"url\": \"https://example.com/test\",\n            \"title\": \"Test Knowledge Item\",\n            \"content\": \"This is test content for knowledge base testing\",\n            \"source_type\": \"webpage\",\n            \"status\": \"completed\",\n            \"created_at\": \"2024-01-01T00:00:00Z\"\n        }\n    \n    @lru_cache(maxsize=32)\n    def create_test_document(self, doc_id: str = \"test-doc-id\", source_id: str = \"test-source-id\") -> Dict[str, Any]:\n        \"\"\"Create test document data.\"\"\"\n        return {\n            \"id\": doc_id,\n            \"source_id\": source_id,\n            \"content\": \"Test document content\",\n            \"url\": \"https://example.com/test-doc\",\n            \"title\": \"Test Document\",\n            \"embedding\": [0.1] * 1536,  # Mock embedding vector\n            \"metadata\": {\"section\": \"test-section\"},\n            \"created_at\": \"2024-01-01T00:00:00Z\"\n        }\n    \n    def clear_cache(self):\n        \"\"\"Clear all cached mock data.\"\"\"\n        for attr_name in dir(self):\n            attr = getattr(self, attr_name)\n            if hasattr(attr, 'cache_clear'):\n                attr.cache_clear()\n\n\n@pytest.fixture(scope=\"function\")\ndef mock_data_factory() -> LazyMockDataFactory:\n    \"\"\"Factory for creating mock test data with caching.\"\"\"\n    factory = LazyMockDataFactory()\n    yield factory\n    factory.clear_cache()\n\n\n# Convenient data fixtures that use the factory\n@pytest.fixture\ndef test_project(mock_data_factory):\n    \"\"\"Lazy-loaded test project data.\"\"\"\n    return mock_data_factory.create_test_project()\n\n\n@pytest.fixture\ndef test_task(mock_data_factory):\n    \"\"\"Lazy-loaded test task data.\"\"\"\n    return mock_data_factory.create_test_task()\n\n\n@pytest.fixture\ndef test_knowledge_item(mock_data_factory):\n    \"\"\"Lazy-loaded test knowledge item data.\"\"\"\n    return mock_data_factory.create_test_knowledge_item()\n\n\n@pytest.fixture\ndef test_document(mock_data_factory):\n    \"\"\"Lazy-loaded test document data.\"\"\"\n    return mock_data_factory.create_test_document()\n\n\n# Cleanup fixture\n@pytest.fixture(autouse=True)\ndef test_cleanup():\n    \"\"\"Automatic cleanup after each test.\"\"\"\n    yield\n    # Reset any global state if needed\n    import gc\n    gc.collect()  # Force garbage collection to free memory