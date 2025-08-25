"""
Tests for Supabase repository implementations and database abstraction.

This module tests the SupabaseDatabase class and its repository implementations:
- SupabaseDatabase initialization and property access
- Repository property lazy initialization
- Health check functionality
- Mock client injection and isolation
- Error handling for database operations
"""

import logging
import pytest
import pytest_asyncio
from unittest.mock import MagicMock, AsyncMock, patch, Mock
from typing import Dict, Any, List, Optional

from src.server.repositories.implementations.supabase_database import SupabaseDatabase
from src.server.repositories.interfaces.unit_of_work import IUnitOfWork, TransactionError
from src.server.repositories.implementations.supabase_repositories import (
    SupabaseSourceRepository,
    SupabaseDocumentRepository,
    SupabaseProjectRepository,
    SupabaseTaskRepository,
    SupabaseSettingsRepository,
    SupabaseVersionRepository,
    SupabaseCodeExampleRepository,
    SupabasePromptRepository
)


class MockSupabaseDatabase(SupabaseDatabase):
    """Mock Supabase Database that implements missing abstract methods for testing."""
    
    def __init__(self, client=None):
        self._transaction_active = False
        self._savepoints = {}
        super().__init__(client)
    
    async def begin(self):
        """Begin transaction."""
        await super().begin()
        self._transaction_active = self._active
    
    async def is_active(self) -> bool:
        """Check if transaction is active."""
        return await super().is_active()
    
    async def savepoint(self, name: str) -> str:
        """Create savepoint."""
        if not self._transaction_active:
            raise TransactionError("No active transaction for savepoint")
        savepoint_id = f"sp_{name}_{len(self._savepoints)}"
        self._savepoints[savepoint_id] = name
        return savepoint_id
    
    async def rollback_to_savepoint(self, savepoint_id: str):
        """Rollback to savepoint."""
        if savepoint_id not in self._savepoints:
            raise TransactionError(f"Savepoint {savepoint_id} not found")
    
    async def release_savepoint(self, savepoint_id: str):
        """Release savepoint."""
        if savepoint_id not in self._savepoints:
            raise TransactionError(f"Savepoint {savepoint_id} not found")
        del self._savepoints[savepoint_id]
    
    async def commit(self):
        """Override to set transaction inactive."""
        await super().commit()
        self._transaction_active = self._active
    
    async def rollback(self):
        """Override to set transaction inactive."""
        await super().rollback()
        self._transaction_active = self._active


class TestSupabaseDatabase:
    """Test the main SupabaseDatabase class."""
    
    @pytest.fixture
    def mock_supabase_client(self):
        """Create a mock Supabase client for testing."""
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
        mock_select.offset.return_value = mock_select
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
        
        return mock_client
    
    def test_database_initialization_with_client(self, mock_supabase_client):
        """Test SupabaseDatabase initialization with provided client."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._client is mock_supabase_client
        assert database._sources is None  # Lazy initialization
        assert database._documents is None
        assert database._projects is None
    
    @patch('src.server.services.client_manager.get_supabase_client')
    def test_database_initialization_without_client(self, mock_get_client):
        """Test SupabaseDatabase initialization without client (uses default)."""
        mock_default_client = MagicMock()
        mock_get_client.return_value = mock_default_client
        
        database = MockSupabaseDatabase()
        
        assert database._client is mock_default_client
        mock_get_client.assert_called_once()
    
    @patch('src.server.services.client_manager.get_supabase_client')
    def test_database_initialization_import_error(self, mock_get_client):
        """Test handling of import error during client initialization."""
        mock_get_client.side_effect = ImportError("Module not found")
        
        with pytest.raises(ImportError, match="Failed to import client_manager"):
            MockSupabaseDatabase()
    
    def test_sources_property_lazy_initialization(self, mock_supabase_client):
        """Test that sources repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        # Initially None
        assert database._sources is None
        
        # First access creates instance
        sources_repo = database.sources
        assert isinstance(sources_repo, SupabaseSourceRepository)
        assert database._sources is sources_repo
        
        # Second access returns same instance
        sources_repo2 = database.sources
        assert sources_repo2 is sources_repo
    
    def test_documents_property_lazy_initialization(self, mock_supabase_client):
        """Test that documents repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._documents is None
        
        documents_repo = database.documents
        assert isinstance(documents_repo, SupabaseDocumentRepository)
        assert database._documents is documents_repo
        
        # Verify same instance returned
        documents_repo2 = database.documents
        assert documents_repo2 is documents_repo
    
    def test_code_examples_property_lazy_initialization(self, mock_supabase_client):
        """Test that code examples repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._code_examples is None
        
        code_repo = database.code_examples
        assert isinstance(code_repo, SupabaseCodeExampleRepository)
        assert database._code_examples is code_repo
    
    def test_projects_property_lazy_initialization(self, mock_supabase_client):
        """Test that projects repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._projects is None
        
        projects_repo = database.projects
        assert isinstance(projects_repo, SupabaseProjectRepository)
        assert database._projects is projects_repo
    
    def test_tasks_property_lazy_initialization(self, mock_supabase_client):
        """Test that tasks repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._tasks is None
        
        tasks_repo = database.tasks
        assert isinstance(tasks_repo, SupabaseTaskRepository)
        assert database._tasks is tasks_repo
    
    def test_versions_property_lazy_initialization(self, mock_supabase_client):
        """Test that versions repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._versions is None
        
        versions_repo = database.versions
        assert isinstance(versions_repo, SupabaseVersionRepository)
        assert database._versions is versions_repo
    
    def test_settings_property_lazy_initialization(self, mock_supabase_client):
        """Test that settings repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._settings is None
        
        settings_repo = database.settings
        assert isinstance(settings_repo, SupabaseSettingsRepository)
        assert database._settings is settings_repo
    
    def test_prompts_property_lazy_initialization(self, mock_supabase_client):
        """Test that prompts repository is lazily initialized."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        assert database._prompts is None
        
        prompts_repo = database.prompts
        assert isinstance(prompts_repo, SupabasePromptRepository)
        assert database._prompts is prompts_repo
    
    @pytest.mark.asyncio
    async def test_transaction_context_manager_success(self, mock_supabase_client):
        """Test successful transaction context manager."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        async with database.transaction() as db:
            # Should return the same database instance
            assert db is database
            
            # Can access repositories within transaction
            sources_repo = db.sources
            assert isinstance(sources_repo, SupabaseSourceRepository)
    
    @pytest.mark.asyncio
    async def test_transaction_context_manager_with_exception(self, mock_supabase_client):
        """Test transaction context manager with exception handling."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        with pytest.raises(ValueError, match="Test exception"):
            async with database.transaction():
                raise ValueError("Test exception")
        
        # Database should still be usable after failed transaction
        sources_repo = database.sources
        assert isinstance(sources_repo, SupabaseSourceRepository)
    
    @pytest.mark.asyncio
    async def test_commit_operation(self, mock_supabase_client):
        """Test manual commit operation."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        # Start a transaction first
        await database.begin()
        
        # Should not raise exception (no-op for Supabase)
        await database.commit()
    
    @pytest.mark.asyncio
    async def test_rollback_operation(self, mock_supabase_client):
        """Test manual rollback operation."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        # Start a transaction first
        await database.begin()
        
        # Should not raise exception but log warning
        with patch.object(database._logger, 'warning') as mock_warning:
            await database.rollback()
            
            # Should log warning about rollback not implemented
            mock_warning.assert_called_once_with(
                "Rollback requested but not implemented for Supabase (no-op)"
            )
    
    @pytest.mark.asyncio
    async def test_health_check_success(self, mock_supabase_client):
        """Test successful health check."""
        # Mock successful query response
        mock_response = MagicMock()
        mock_response.data = [{"key": "test_setting"}]
        
        mock_supabase_client.table.return_value.select.return_value.limit.return_value.execute.return_value = mock_response
        
        database = MockSupabaseDatabase(client=mock_supabase_client)
        result = await database.health_check()
        
        assert result is True
        
        # Verify correct query was made
        mock_supabase_client.table.assert_called_with('archon_settings')
        mock_supabase_client.table.return_value.select.assert_called_with('key')
        mock_supabase_client.table.return_value.select.return_value.limit.assert_called_with(1)
    
    @pytest.mark.asyncio
    async def test_health_check_no_data(self, mock_supabase_client):
        """Test health check with no data returned."""
        # Mock response with None data
        mock_response = MagicMock()
        mock_response.data = None
        
        mock_supabase_client.table.return_value.select.return_value.limit.return_value.execute.return_value = mock_response
        
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        with patch.object(database._logger, 'warning') as mock_warning:
            result = await database.health_check()
            
            assert result is False
            
            # Should log warning
            mock_warning.assert_called_once_with(
                "Database health check failed: No data returned"
            )
    
    @pytest.mark.asyncio
    async def test_health_check_exception(self, mock_supabase_client):
        """Test health check with database exception."""
        # Mock exception during query
        mock_supabase_client.table.return_value.select.return_value.limit.return_value.execute.side_effect = \
            Exception("Database connection failed")
        
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        with patch.object(database._logger, 'error') as mock_error:
            result = await database.health_check()
            
            assert result is False
            
            # Should log error
            mock_error.assert_called_once_with(
                "Database health check failed: Database connection failed",
                exc_info=True
            )
    
    def test_get_client_method(self, mock_supabase_client):
        """Test get_client method returns underlying client."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        client = database.get_client()
        assert client is mock_supabase_client
    
    @pytest.mark.asyncio
    async def test_close_method(self, mock_supabase_client):
        """Test close method (no-op for Supabase)."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        with patch.object(database._logger, 'info') as mock_info:
            await database.close()
            
            # Should log info message
            mock_info.assert_called_once_with("Database connections closed")
    
    def test_repr_method(self, mock_supabase_client):
        """Test string representation of database instance."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        repr_str = repr(database)
        assert repr_str == f"SupabaseDatabase(client={type(mock_supabase_client).__name__})"


class TestSupabaseRepositoryInstantiation:
    """Test instantiation and basic functionality of Supabase repositories."""
    
    @pytest.fixture
    def mock_client(self):
        """Create mock client for repository testing."""
        return MagicMock()
    
    def test_supabase_source_repository_creation(self, mock_client):
        """Test SupabaseSourceRepository can be instantiated."""
        repo = SupabaseSourceRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_sources'
    
    def test_supabase_document_repository_creation(self, mock_client):
        """Test SupabaseDocumentRepository can be instantiated."""
        repo = SupabaseDocumentRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_crawled_pages'
    
    def test_supabase_project_repository_creation(self, mock_client):
        """Test SupabaseProjectRepository can be instantiated."""
        repo = SupabaseProjectRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_projects'
    
    def test_supabase_task_repository_creation(self, mock_client):
        """Test SupabaseTaskRepository can be instantiated."""
        repo = SupabaseTaskRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_tasks'
    
    def test_supabase_settings_repository_creation(self, mock_client):
        """Test SupabaseSettingsRepository can be instantiated."""
        repo = SupabaseSettingsRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_settings'
    
    def test_supabase_version_repository_creation(self, mock_client):
        """Test SupabaseVersionRepository can be instantiated."""
        repo = SupabaseVersionRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_document_versions'
    
    def test_supabase_code_example_repository_creation(self, mock_client):
        """Test SupabaseCodeExampleRepository can be instantiated."""
        repo = SupabaseCodeExampleRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_code_examples'
    
    def test_supabase_prompt_repository_creation(self, mock_client):
        """Test SupabasePromptRepository can be instantiated."""
        repo = SupabasePromptRepository(mock_client)
        assert repo._client is mock_client
        assert repo._table == 'archon_prompts'
    
    @pytest.mark.asyncio
    async def test_code_example_vector_search(self, mock_client):
        """Test SupabaseCodeExampleRepository vector_search method."""
        repo = SupabaseCodeExampleRepository(mock_client)
        
        # Mock the RPC response
        mock_response = MagicMock()
        mock_response.data = [
            {
                'id': '123',
                'url': 'https://example.com/code',
                'chunk_number': 1,
                'content': 'def hello(): pass',
                'summary': 'A hello function',
                'metadata': {'language': 'python'},
                'source_id': 'src123',
                'similarity': 0.95
            }
        ]
        mock_client.rpc.return_value.execute.return_value = mock_response
        
        # Test vector search with valid embedding
        embedding = [0.1] * 1536
        results = await repo.vector_search(
            embedding=embedding,
            limit=10,
            source_filter='src123',
            metadata_filter={'language': 'python'}
        )
        
        # Verify results
        assert len(results) == 1
        assert results[0]['id'] == '123'
        assert results[0]['similarity_score'] == 0.95
        assert results[0]['metadata']['similarity_score'] == 0.95
        assert results[0]['metadata']['search_type'] == 'vector_search'
        
        # Verify RPC was called with correct parameters
        mock_client.rpc.assert_called_once_with('match_archon_code_examples', {
            'query_embedding': embedding,
            'match_count': 10,
            'filter': {'language': 'python'},
            'source_filter': 'src123'
        })
    
    @pytest.mark.asyncio
    async def test_code_example_vector_search_invalid_embedding(self, mock_client):
        """Test vector_search with invalid embedding."""
        repo = SupabaseCodeExampleRepository(mock_client)
        
        # Test with empty embedding
        results = await repo.vector_search(embedding=[], limit=10)
        assert results == []
        
        # Test with wrong dimension embedding
        results = await repo.vector_search(embedding=[0.1] * 100, limit=10)
        assert results == []
        
        # Test with invalid limit
        results = await repo.vector_search(embedding=[0.1] * 1536, limit=0)
        assert results == []
        
        results = await repo.vector_search(embedding=[0.1] * 1536, limit=1001)
        assert results == []
    
    def test_code_example_calculate_text_relevance(self, mock_client):
        """Test _calculate_text_relevance helper method."""
        repo = SupabaseCodeExampleRepository(mock_client)
        
        # Test exact phrase match
        score = repo._calculate_text_relevance("hello world", "This is hello world example")
        assert score > 0.9
        
        # Test word matching
        score = repo._calculate_text_relevance("python function", "A python script with function definitions")
        assert score > 0.5
        
        # Test no match
        score = repo._calculate_text_relevance("java class", "python function definitions")
        assert score == 0.0
        
        # Test empty inputs
        assert repo._calculate_text_relevance("", "text") == 0.0
        assert repo._calculate_text_relevance("query", "") == 0.0
        assert repo._calculate_text_relevance("", "") == 0.0
    
    def test_code_example_calculate_code_relevance(self, mock_client):
        """Test _calculate_code_relevance helper method."""
        repo = SupabaseCodeExampleRepository(mock_client)
        
        # Test exact match
        score = repo._calculate_code_relevance("hello", "def hello(): pass")
        assert score == 1.0
        
        # Test function pattern match
        score = repo._calculate_code_relevance("greet", "def greet(name): return f'Hello {name}'")
        assert score > 0.7
        
        # Test class pattern match
        score = repo._calculate_code_relevance("User", "class User: pass")
        assert score > 0.7
        
        # Test no match
        score = repo._calculate_code_relevance("java", "def python_function(): pass")
        assert score == 0.0
        
        # Test empty inputs
        assert repo._calculate_code_relevance("", "code") == 0.0
        assert repo._calculate_code_relevance("query", "") == 0.0


class TestSupabaseRepositoryErrorHandling:
    """Test error handling in Supabase repository operations."""
    
    @pytest.fixture
    def mock_client_with_errors(self):
        """Create mock client that raises errors."""
        mock_client = MagicMock()
        
        # Mock table operations to raise exceptions
        mock_table = MagicMock()
        mock_client.table.return_value = mock_table
        
        # Make execute methods raise exceptions
        # For health_check which calls select(...).limit(1).execute()
        mock_table.select.return_value.limit.return_value.execute.side_effect = Exception("Database error")
        mock_table.insert.return_value.execute.side_effect = Exception("Insert error")
        mock_table.update.return_value.eq.return_value.execute.side_effect = Exception("Update error")
        mock_table.delete.return_value.eq.return_value.execute.side_effect = Exception("Delete error")
        
        return mock_client
    
    @pytest.mark.asyncio
    async def test_repository_handles_query_errors(self, mock_client_with_errors, caplog):
        """Test that repositories handle query errors gracefully."""
        database = MockSupabaseDatabase(client=mock_client_with_errors)
        
        # Health check should handle errors and return False
        with caplog.at_level(logging.ERROR):
            result = await database.health_check()
        
        # Assert the health check returns False when database error occurs
        assert result is False
        
        # Verify that an error was logged
        assert len(caplog.records) > 0
        error_records = [r for r in caplog.records if r.levelname == 'ERROR']
        assert len(error_records) > 0
        assert 'Database health check failed' in error_records[0].message
    
    @pytest.mark.asyncio
    async def test_multiple_repository_access(self, mock_supabase_client):
        """Test accessing multiple repositories from same database instance."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        # Access multiple repositories
        sources = database.sources
        documents = database.documents
        projects = database.projects
        tasks = database.tasks
        settings = database.settings
        versions = database.versions
        code_examples = database.code_examples
        prompts = database.prompts
        
        # Verify all are different instances
        assert sources is not documents
        assert documents is not projects
        assert projects is not tasks
        assert tasks is not settings
        assert settings is not versions
        assert versions is not code_examples
        assert code_examples is not prompts
        
        # Verify all are correct types
        assert isinstance(sources, SupabaseSourceRepository)
        assert isinstance(documents, SupabaseDocumentRepository)
        assert isinstance(projects, SupabaseProjectRepository)
        assert isinstance(tasks, SupabaseTaskRepository)
        assert isinstance(settings, SupabaseSettingsRepository)
        assert isinstance(versions, SupabaseVersionRepository)
        assert isinstance(code_examples, SupabaseCodeExampleRepository)
        assert isinstance(prompts, SupabasePromptRepository)
    
    def test_repository_client_sharing(self, mock_supabase_client):
        """Test that all repositories share the same client instance."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        # Access all repositories
        repositories = [
            database.sources,
            database.documents,
            database.projects,
            database.tasks,
            database.settings,
            database.versions,
            database.code_examples,
            database.prompts
        ]
        
        # Verify all repositories use the same client
        for repo in repositories:
            assert repo._client is mock_supabase_client


@pytest.mark.integration
class TestSupabaseDatabaseIntegration:
    """
    Integration tests for SupabaseDatabase.
    
    These tests require a real database connection and are marked with @pytest.mark.integration.
    Run with: pytest -m integration
    """
    
    def test_database_with_real_client_structure(self, mock_supabase_client):
        """Test database structure with realistic client mock."""
        # This test uses a more realistic mock that simulates actual Supabase responses
        mock_client = MagicMock()
        
        # Mock realistic response structure
        mock_response = MagicMock()
        mock_response.data = []
        mock_response.count = 0
        
        # Setup realistic table operation chain
        mock_table = MagicMock()
        mock_select = MagicMock()
        mock_select.execute.return_value = mock_response
        mock_select.eq.return_value = mock_select
        mock_select.limit.return_value = mock_select
        mock_table.select.return_value = mock_select
        mock_client.table.return_value = mock_table
        
        database = MockSupabaseDatabase(client=mock_client)
        
        # Test that database can perform operations
        assert database.get_client() is mock_client
        
        # Test repository access doesn't fail
        sources_repo = database.sources
        assert isinstance(sources_repo, SupabaseSourceRepository)
    
    @pytest.mark.asyncio
    async def test_transaction_workflow_simulation(self, mock_supabase_client):
        """Test complete transaction workflow simulation."""
        database = MockSupabaseDatabase(client=mock_supabase_client)
        
        # Mock successful operations
        mock_supabase_client.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "project-1", "title": "Test Project"}
        ]
        mock_supabase_client.table.return_value.select.return_value.execute.return_value.data = []
        
        # Simulate transaction workflow
        async with database.transaction() as db:
            # Access repositories within transaction
            projects_repo = db.projects
            tasks_repo = db.tasks
            
            assert isinstance(projects_repo, SupabaseProjectRepository)
            assert isinstance(tasks_repo, SupabaseTaskRepository)
            
            # Simulate operations (would normally call repository methods)
            # This tests that the transaction context works correctly