"""
Enhanced test fixtures with comprehensive setup and teardown management.

This module provides advanced test fixtures for:
- Database connection management with automatic cleanup
- Repository mocking with realistic behavior
- Test data generation and cleanup
- Environment isolation and restoration
- Performance monitoring and resource tracking
"""

import asyncio
import pytest
import pytest_asyncio
import logging
import tempfile
import shutil
from typing import Dict, Any, List, Optional, Generator, AsyncGenerator
from unittest.mock import MagicMock, AsyncMock, patch
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from uuid import uuid4
from pathlib import Path

from src.server.repositories.implementations.supabase_database import SupabaseDatabase
from src.server.repositories.interfaces.unit_of_work import IUnitOfWork
from src.server.repositories.exceptions import RepositoryError, ValidationError
from src.server.models.entities import Source, Document, Project, Task, CodeExample
from src.server.config.database_factory import get_database


class TestDatabaseManager:
    """Manages test database connections and cleanup."""
    
    def __init__(self):
        self.connections: List[SupabaseDatabase] = []
        self.temp_resources: List[str] = []
    
    async def create_test_connection(self) -> SupabaseDatabase:
        """Create isolated test database connection."""
        mock_client = MagicMock()
        mock_client.table.return_value = MagicMock()
        
        db = SupabaseDatabase(client=mock_client)
        self.connections.append(db)
        return db
    
    async def cleanup_connections(self):
        """Clean up all test database connections."""
        for db in self.connections:
            try:
                if hasattr(db, 'close'):
                    await db.close()
            except Exception as e:
                logging.warning(f"Error closing database connection: {e}")
        self.connections.clear()
    
    def cleanup_temp_resources(self):
        """Clean up temporary resources."""
        for resource in self.temp_resources:
            try:
                if Path(resource).exists():
                    if Path(resource).is_dir():
                        shutil.rmtree(resource)
                    else:
                        Path(resource).unlink()
            except Exception as e:
                logging.warning(f"Error cleaning up temp resource {resource}: {e}")
        self.temp_resources.clear()


@pytest.fixture(scope="session")
def test_db_manager():
    """Session-scoped database manager for efficient resource management."""
    manager = TestDatabaseManager()
    yield manager
    # Session cleanup
    asyncio.run(manager.cleanup_connections())
    manager.cleanup_temp_resources()


@pytest.fixture
async def isolated_database(test_db_manager):
    """Create isolated database instance for each test."""
    db = await test_db_manager.create_test_connection()
    yield db
    # Test-level cleanup happens via session manager


@pytest_asyncio.fixture
async def transaction_database(isolated_database):
    """Database instance within transaction context."""
    async with isolated_database.transaction() as tx_db:
        yield tx_db


@pytest.fixture
def mock_supabase_client():
    """Create comprehensive mock Supabase client."""
    mock_client = MagicMock()
    
    # Mock table operations
    mock_table = MagicMock()
    mock_client.table.return_value = mock_table
    
    # Mock query operations
    mock_table.select.return_value = mock_table
    mock_table.insert.return_value = mock_table
    mock_table.update.return_value = mock_table
    mock_table.delete.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.neq.return_value = mock_table
    mock_table.gt.return_value = mock_table
    mock_table.gte.return_value = mock_table
    mock_table.lt.return_value = mock_table
    mock_table.lte.return_value = mock_table
    mock_table.like.return_value = mock_table
    mock_table.ilike.return_value = mock_table
    mock_table.in_.return_value = mock_table
    mock_table.limit.return_value = mock_table
    mock_table.offset.return_value = mock_table
    mock_table.order.return_value = mock_table
    
    # Mock execution methods
    mock_table.execute = AsyncMock()
    mock_client.rpc = AsyncMock()
    
    return mock_client


@pytest.fixture
def sample_entities():
    """Generate sample entity data for testing."""
    
    def create_source_data(**overrides):
        base_data = {
            "id": str(uuid4()),
            "source_id": "example.com",
            "source_type": "website",
            "base_url": "https://example.com",
            "title": "Example Website",
            "summary": "Test website for examples",
            "crawl_status": "completed",
            "total_pages": 10,
            "pages_crawled": 8,
            "total_word_count": 5000,
            "metadata": {"language": "en"},
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        base_data.update(overrides)
        return base_data
    
    def create_document_data(**overrides):
        base_data = {
            "id": str(uuid4()),
            "url": "https://example.com/page1",
            "chunk_number": 0,
            "content": "This is test document content",
            "source_id": "example.com",
            "embedding": [0.1, 0.2, 0.3, 0.4, 0.5],
            "metadata": {"page_title": "Test Page"},
            "similarity_score": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        base_data.update(overrides)
        return base_data
    
    def create_project_data(**overrides):
        base_data = {
            "id": str(uuid4()),
            "title": "Test Project",
            "description": "A test project for development",
            "github_repo": "https://github.com/test/project",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "docs": [],
            "features": {},
            "data": {}
        }
        base_data.update(overrides)
        return base_data
    
    def create_task_data(**overrides):
        base_data = {
            "id": str(uuid4()),
            "project_id": str(uuid4()),
            "title": "Test Task",
            "description": "A test task for development",
            "status": "todo",
            "assignee": "AI IDE Agent",
            "task_order": 1,
            "feature": "test-feature",
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "sources": [],
            "code_examples": []
        }
        base_data.update(overrides)
        return base_data
    
    def create_code_example_data(**overrides):
        base_data = {
            "id": str(uuid4()),
            "url": "https://example.com/code.py",
            "chunk_number": 0,
            "source_id": "example.com",
            "code_block": "print('Hello, World!')",
            "language": "python",
            "summary": "Hello world example",
            "embedding": [0.1, 0.2, 0.3, 0.4, 0.5],
            "metadata": {"function_name": "hello_world"},
            "similarity_score": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc)
        }
        base_data.update(overrides)
        return base_data
    
    return {
        "source": create_source_data,
        "document": create_document_data,
        "project": create_project_data,
        "task": create_task_data,
        "code_example": create_code_example_data
    }


@pytest.fixture
def test_data_cleanup():
    """Track and cleanup test data."""
    created_resources = {
        "temp_files": [],
        "temp_dirs": [],
        "database_records": [],
        "mock_objects": []
    }
    
    yield created_resources
    
    # Cleanup temporary files
    for temp_file in created_resources["temp_files"]:
        try:
            if Path(temp_file).exists():
                Path(temp_file).unlink()
        except Exception as e:
            logging.warning(f"Failed to cleanup temp file {temp_file}: {e}")
    
    # Cleanup temporary directories
    for temp_dir in created_resources["temp_dirs"]:
        try:
            if Path(temp_dir).exists():
                shutil.rmtree(temp_dir)
        except Exception as e:
            logging.warning(f"Failed to cleanup temp dir {temp_dir}: {e}")


@contextmanager
def temporary_file(suffix=".txt", content=None):
    """Create temporary file with automatic cleanup."""
    with tempfile.NamedTemporaryFile(mode='w', suffix=suffix, delete=False) as f:
        if content:
            f.write(content)
        temp_path = f.name
    
    try:
        yield temp_path
    finally:
        try:
            Path(temp_path).unlink()
        except Exception:
            pass


@contextmanager
def temporary_directory():
    """Create temporary directory with automatic cleanup."""
    temp_dir = tempfile.mkdtemp()
    try:
        yield temp_dir
    finally:
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass


@pytest.fixture
def performance_monitor():
    """Monitor test performance and resource usage."""
    import time
    import psutil
    import threading
    
    class PerformanceMonitor:
        def __init__(self):
            self.start_time = None
            self.end_time = None
            self.start_memory = None
            self.end_memory = None
            self.peak_memory = None
            self.monitoring = False
            self.monitor_thread = None
    
        def start_monitoring(self):
            self.start_time = time.time()
            self.start_memory = psutil.Process().memory_info().rss
            self.peak_memory = self.start_memory
            self.monitoring = True
            
            def memory_monitor():
                while self.monitoring:
                    current_memory = psutil.Process().memory_info().rss
                    self.peak_memory = max(self.peak_memory, current_memory)
                    time.sleep(0.1)
            
            self.monitor_thread = threading.Thread(target=memory_monitor, daemon=True)
            self.monitor_thread.start()
    
        def stop_monitoring(self):
            self.monitoring = False
            self.end_time = time.time()
            self.end_memory = psutil.Process().memory_info().rss
            
            if self.monitor_thread:
                self.monitor_thread.join(timeout=1.0)
    
        def get_metrics(self):
            return {
                "duration_seconds": (self.end_time - self.start_time) if self.start_time and self.end_time else None,
                "memory_start_mb": self.start_memory / (1024 * 1024) if self.start_memory else None,
                "memory_end_mb": self.end_memory / (1024 * 1024) if self.end_memory else None,
                "memory_peak_mb": self.peak_memory / (1024 * 1024) if self.peak_memory else None,
                "memory_delta_mb": (self.end_memory - self.start_memory) / (1024 * 1024) if self.start_memory and self.end_memory else None
            }
    
    monitor = PerformanceMonitor()
    yield monitor


@pytest.fixture
def environment_isolation():
    """Isolate environment variables for testing."""
    import os
    
    # Store original environment
    original_env = os.environ.copy()
    
    # Provide environment manipulation methods
    class EnvironmentManager:
        @staticmethod
        def set_env(**kwargs):
            for key, value in kwargs.items():
                os.environ[key] = str(value)
        
        @staticmethod
        def unset_env(*keys):
            for key in keys:
                os.environ.pop(key, None)
        
        @staticmethod
        def get_env(key, default=None):
            return os.environ.get(key, default)
    
    yield EnvironmentManager()
    
    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)


@pytest.fixture
def mock_repository_responses():
    """Pre-configured mock responses for repository operations."""
    
    def create_success_response(data=None, count=None):
        return {
            "data": data or [],
            "count": count or (len(data) if data else 0),
            "error": None,
            "status": 200,
            "status_text": "OK"
        }
    
    def create_error_response(error_code="400", error_message="Bad Request"):
        return {
            "data": None,
            "count": 0,
            "error": {
                "code": error_code,
                "message": error_message
            },
            "status": int(error_code),
            "status_text": error_message
        }
    
    def create_empty_response():
        return create_success_response(data=[], count=0)
    
    return {
        "success": create_success_response,
        "error": create_error_response,
        "empty": create_empty_response,
    }


@pytest_asyncio.fixture
async def repository_test_suite():
    """Comprehensive repository testing suite."""
    
    class RepositoryTestSuite:
        def __init__(self):
            self.mock_client = MagicMock()
            self.database = SupabaseDatabase(client=self.mock_client)
            self.test_data = []
    
        async def setup_test_data(self, entity_type: str, count: int = 5):
            """Generate and setup test data for entity type."""
            if entity_type == "sources":
                for i in range(count):
                    data = {
                        "id": str(uuid4()),
                        "source_id": f"example{i}.com",
                        "source_type": "website",
                        "title": f"Example Site {i}",
                        "crawl_status": "completed"
                    }
                    self.test_data.append(data)
            
            # Configure mock to return test data
            self.mock_client.table().select().execute = AsyncMock(
                return_value={"data": self.test_data, "error": None}
            )
        
        async def cleanup_test_data(self):
            """Clean up generated test data."""
            self.test_data.clear()
        
        def assert_repository_methods_exist(self, repository):
            """Assert that repository has required methods."""
            required_methods = [
                'create', 'get_by_id', 'update', 'delete', 'list',
                'exists', 'count'
            ]
            for method in required_methods:
                assert hasattr(repository, method), f"Repository missing method: {method}"
                assert callable(getattr(repository, method)), f"Repository method not callable: {method}"
        
        def assert_entity_structure(self, entity_data: Dict[str, Any], required_fields: List[str]):
            """Assert that entity data has required structure."""
            for field in required_fields:
                assert field in entity_data, f"Entity missing required field: {field}"
                assert entity_data[field] is not None, f"Entity field is None: {field}"
    
    suite = RepositoryTestSuite()
    yield suite
    await suite.cleanup_test_data()


@pytest.fixture
def async_test_utilities():
    """Utilities for async test operations."""
    
    class AsyncTestUtils:
        @staticmethod
        async def wait_for_condition(condition_func, timeout=5.0, interval=0.1):
            """Wait for a condition to become true with timeout."""
            import time
            start_time = time.time()
            
            while time.time() - start_time < timeout:
                if await condition_func() if asyncio.iscoroutinefunction(condition_func) else condition_func():
                    return True
                await asyncio.sleep(interval)
            
            return False
        
        @staticmethod
        async def run_with_timeout(coro, timeout=5.0):
            """Run coroutine with timeout."""
            return await asyncio.wait_for(coro, timeout=timeout)
        
        @staticmethod
        def create_async_mock(**kwargs):
            """Create AsyncMock with predefined behavior."""
            mock = AsyncMock(**kwargs)
            return mock
    
    return AsyncTestUtils()


@pytest.fixture
def logging_capture():
    """Capture and analyze log output during tests."""
    import logging
    from io import StringIO
    
    class LogCapture:
        def __init__(self):
            self.log_capture = StringIO()
            self.handler = logging.StreamHandler(self.log_capture)
            self.handler.setLevel(logging.DEBUG)
            
            # Add handler to root logger
            self.root_logger = logging.getLogger()
            self.original_handlers = self.root_logger.handlers[:]
            self.root_logger.addHandler(self.handler)
        
        def get_logs(self):
            return self.log_capture.getvalue()
        
        def get_log_lines(self):
            return [line.strip() for line in self.get_logs().split('\n') if line.strip()]
        
        def has_log_containing(self, text):
            return text in self.get_logs()
        
        def count_log_level(self, level):
            logs = self.get_logs()
            return logs.upper().count(level.upper())
        
        def cleanup(self):
            self.root_logger.removeHandler(self.handler)
            self.handler.close()
    
    capture = LogCapture()
    yield capture
    capture.cleanup()


@pytest.fixture(scope="function", autouse=True)
def test_isolation():
    """Automatic test isolation for each test function."""
    # Setup: Clear any global state, reset singletons, etc.
    yield
    # Teardown: Clean up any state changes


class MockNetworkManager:
    """Manage network-related mocks for testing."""
    
    def __init__(self):
        self.request_history = []
        self.response_queue = []
    
    def add_response(self, status_code=200, json_data=None, text_data=None, headers=None):
        """Add a mock response to the queue."""
        response = MagicMock()
        response.status_code = status_code
        response.json.return_value = json_data or {}
        response.text = text_data or ""
        response.headers = headers or {}
        self.response_queue.append(response)
    
    def get_request_history(self):
        """Get history of requests made."""
        return self.request_history.copy()
    
    def clear_history(self):
        """Clear request history."""
        self.request_history.clear()


@pytest.fixture
def mock_network():
    """Mock network requests and responses."""
    manager = MockNetworkManager()
    
    with patch('requests.get') as mock_get, \
         patch('requests.post') as mock_post, \
         patch('requests.put') as mock_put, \
         patch('requests.delete') as mock_delete:
        
        def make_request_mock(method):
            def request_mock(*args, **kwargs):
                manager.request_history.append({
                    'method': method,
                    'args': args,
                    'kwargs': kwargs
                })
                if manager.response_queue:
                    return manager.response_queue.pop(0)
                else:
                    # Default response
                    response = MagicMock()
                    response.status_code = 200
                    response.json.return_value = {}
                    return response
            return request_mock
        
        mock_get.side_effect = make_request_mock('GET')
        mock_post.side_effect = make_request_mock('POST')
        mock_put.side_effect = make_request_mock('PUT')
        mock_delete.side_effect = make_request_mock('DELETE')
        
        yield manager


# Utility functions for test setup and teardown
def setup_test_environment():
    """Setup test environment with necessary configurations."""
    import os
    
    test_env_vars = {
        'TESTING': 'true',
        'LOG_LEVEL': 'DEBUG',
        'DATABASE_URL': 'sqlite:///:memory:',
    }
    
    for key, value in test_env_vars.items():
        os.environ.setdefault(key, value)


def teardown_test_environment():
    """Clean up test environment."""
    import os
    
    test_env_vars = ['TESTING', 'LOG_LEVEL', 'DATABASE_URL']
    for var in test_env_vars:
        os.environ.pop(var, None)