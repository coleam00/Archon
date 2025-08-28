"""
Tests for Repository Pattern interface contracts and base functionality.

This module tests the abstract repository interfaces, ensuring that:
- Interface contracts are properly defined
- Mock implementations follow the interface contracts
- Unit of Work pattern behaves correctly
- Error handling works as expected
"""

import pytest
import pytest_asyncio
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, AsyncMock, patch
from typing import Dict, Any, List, Optional
from uuid import UUID, uuid4

from src.server.repositories.interfaces.base_repository import IBaseRepository
from src.server.repositories.interfaces.unit_of_work import (
    IUnitOfWork, 
    ITransactionContext, 
    TransactionError, 
    SavepointError,
    NestedTransactionError
)
from src.server.repositories.implementations.mock_repositories import (
    MockSourceRepository,
    MockDocumentRepository,
    MockProjectRepository,
    MockTaskRepository,
    MockSettingsRepository,
    MockVersionRepository,
    MockCodeExampleRepository,
    MockPromptRepository
)


class TestBaseRepositoryInterface:
    """Test the base repository interface contract."""
    
    @pytest.fixture
    def mock_repository(self):
        """Create a mock source repository for testing."""
        return MockSourceRepository()
    
    @pytest.mark.asyncio
    async def test_create_operation(self, mock_repository):
        """Test create operation creates entity with ID and timestamps."""
        entity_data = {
            'source_id': 'test-source',
            'source_type': 'website',
            'base_url': 'https://example.com',
            'title': 'Test Source'
        }
        
        result = await mock_repository.create(entity_data)
        
        assert result['id'] is not None
        assert result['created_at'] is not None
        assert result['updated_at'] is not None
        assert result['source_id'] == 'test-source'
        assert result['title'] == 'Test Source'
    
    @pytest.mark.asyncio
    async def test_get_by_id_existing(self, mock_repository):
        """Test retrieving existing entity by ID."""
        # Create entity first
        entity_data = {'source_id': 'test-source', 'title': 'Test Source'}
        created = await mock_repository.create(entity_data)
        entity_id = created['id']
        
        # Retrieve by ID
        result = await mock_repository.get_by_id(entity_id)
        
        assert result is not None
        assert result['id'] == entity_id
        assert result['source_id'] == 'test-source'
    
    @pytest.mark.asyncio
    async def test_get_by_id_nonexistent(self, mock_repository):
        """Test retrieving non-existent entity returns None."""
        result = await mock_repository.get_by_id('nonexistent-id')
        assert result is None
    
    @pytest.mark.asyncio
    async def test_update_operation(self, mock_repository):
        """Test updating existing entity."""
        # Create entity first
        entity_data = {'source_id': 'test-source', 'title': 'Original Title'}
        created = await mock_repository.create(entity_data)
        entity_id = created['id']
        
        # Update entity
        update_data = {'title': 'Updated Title', 'summary': 'New summary'}
        result = await mock_repository.update(entity_id, update_data)
        
        assert result is not None
        assert result['id'] == entity_id
        assert result['title'] == 'Updated Title'
        assert result['summary'] == 'New summary'
        assert result['source_id'] == 'test-source'  # Unchanged field
        assert result['updated_at'] != created['updated_at']
    
    @pytest.mark.asyncio
    async def test_update_nonexistent(self, mock_repository):
        """Test updating non-existent entity returns None."""
        result = await mock_repository.update('nonexistent-id', {'title': 'New Title'})
        assert result is None
    
    @pytest.mark.asyncio
    async def test_delete_operation(self, mock_repository):
        """Test deleting existing entity."""
        # Create entity first
        entity_data = {'source_id': 'test-source', 'title': 'Test Source'}
        created = await mock_repository.create(entity_data)
        entity_id = created['id']
        
        # Delete entity
        result = await mock_repository.delete(entity_id)
        assert result is True
        
        # Verify deletion
        retrieved = await mock_repository.get_by_id(entity_id)
        assert retrieved is None
    
    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, mock_repository):
        """Test deleting non-existent entity returns False."""
        result = await mock_repository.delete('nonexistent-id')
        assert result is False
    
    @pytest.mark.asyncio
    async def test_list_operation_basic(self, mock_repository):
        """Test listing entities without filters."""
        # Create test entities
        entities = [
            {'source_id': 'source-1', 'title': 'First Source'},
            {'source_id': 'source-2', 'title': 'Second Source'},
            {'source_id': 'source-3', 'title': 'Third Source'}
        ]
        
        created_entities = []
        for entity_data in entities:
            created = await mock_repository.create(entity_data)
            created_entities.append(created)
        
        # List all entities
        result = await mock_repository.list()
        
        assert len(result) == 3
        source_ids = [entity['source_id'] for entity in result]
        assert 'source-1' in source_ids
        assert 'source-2' in source_ids
        assert 'source-3' in source_ids
    
    @pytest.mark.asyncio
    async def test_list_with_filters(self, mock_repository):
        """Test listing entities with filters."""
        # Create test entities
        entities = [
            {'source_id': 'source-1', 'source_type': 'website', 'title': 'Website 1'},
            {'source_id': 'source-2', 'source_type': 'upload', 'title': 'Upload 1'},
            {'source_id': 'source-3', 'source_type': 'website', 'title': 'Website 2'}
        ]
        
        for entity_data in entities:
            await mock_repository.create(entity_data)
        
        # Filter by source_type
        website_results = await mock_repository.list(filters={'source_type': 'website'})
        upload_results = await mock_repository.list(filters={'source_type': 'upload'})
        
        assert len(website_results) == 2
        assert len(upload_results) == 1
        assert all(entity['source_type'] == 'website' for entity in website_results)
        assert upload_results[0]['source_type'] == 'upload'
    
    @pytest.mark.asyncio
    async def test_list_with_pagination(self, mock_repository):
        """Test listing entities with pagination."""
        # Create 10 test entities
        for i in range(10):
            await mock_repository.create({
                'source_id': f'source-{i}',
                'title': f'Source {i}'
            })
        
        # Test limit
        limited_results = await mock_repository.list(limit=3)
        assert len(limited_results) == 3
        
        # Test offset
        offset_results = await mock_repository.list(limit=3, offset=3)
        assert len(offset_results) == 3
        
        # Ensure different entities
        limited_ids = {entity['source_id'] for entity in limited_results}
        offset_ids = {entity['source_id'] for entity in offset_results}
        assert limited_ids.isdisjoint(offset_ids)
    
    @pytest.mark.asyncio
    async def test_list_with_ordering(self, mock_repository):
        """Test listing entities with ordering."""
        # Create entities with different titles
        entities = [
            {'source_id': 'source-c', 'title': 'Charlie'},
            {'source_id': 'source-a', 'title': 'Alpha'},
            {'source_id': 'source-b', 'title': 'Beta'}
        ]
        
        for entity_data in entities:
            await mock_repository.create(entity_data)
        
        # Test ascending order
        asc_results = await mock_repository.list(order_by='title', order_direction='asc')
        titles_asc = [entity['title'] for entity in asc_results]
        assert titles_asc == ['Alpha', 'Beta', 'Charlie']
        
        # Test descending order
        desc_results = await mock_repository.list(order_by='title', order_direction='desc')
        titles_desc = [entity['title'] for entity in desc_results]
        assert titles_desc == ['Charlie', 'Beta', 'Alpha']
    
    @pytest.mark.asyncio
    async def test_count_operation(self, mock_repository):
        """Test counting entities."""
        # Initially empty
        count = await mock_repository.count()
        assert count == 0
        
        # Create test entities
        for i in range(5):
            await mock_repository.create({
                'source_id': f'source-{i}',
                'source_type': 'website' if i % 2 == 0 else 'upload'
            })
        
        # Count all entities
        total_count = await mock_repository.count()
        assert total_count == 5
        
        # Count with filter
        website_count = await mock_repository.count(filters={'source_type': 'website'})
        upload_count = await mock_repository.count(filters={'source_type': 'upload'})
        
        assert website_count == 3  # 0, 2, 4 are even
        assert upload_count == 2   # 1, 3 are odd
    
    @pytest.mark.asyncio
    async def test_exists_operation(self, mock_repository):
        """Test checking entity existence."""
        # Create entity
        entity_data = {'source_id': 'test-source', 'title': 'Test Source'}
        created = await mock_repository.create(entity_data)
        entity_id = created['id']
        
        # Check existence
        exists = await mock_repository.exists(entity_id)
        assert exists is True
        
        # Check non-existence
        not_exists = await mock_repository.exists('nonexistent-id')
        assert not_exists is False
    
    @pytest.mark.asyncio
    async def test_create_batch_operation(self, mock_repository):
        """Test batch entity creation."""
        entities = [
            {'source_id': 'batch-1', 'title': 'Batch Source 1'},
            {'source_id': 'batch-2', 'title': 'Batch Source 2'},
            {'source_id': 'batch-3', 'title': 'Batch Source 3'}
        ]
        
        results = await mock_repository.create_batch(entities)
        
        assert len(results) == 3
        for i, result in enumerate(results):
            assert result['id'] is not None
            assert result['created_at'] is not None
            assert result['source_id'] == f'batch-{i+1}'
            assert result['title'] == f'Batch Source {i+1}'
    
    @pytest.mark.asyncio
    async def test_update_batch_operation(self, mock_repository):
        """Test batch entity updates."""
        # Create entities first
        entities = [
            {'source_id': 'batch-1', 'title': 'Original 1'},
            {'source_id': 'batch-2', 'title': 'Original 2'}
        ]
        
        created_entities = []
        for entity_data in entities:
            created = await mock_repository.create(entity_data)
            created_entities.append(created)
        
        # Prepare batch updates
        updates = [
            {'id': created_entities[0]['id'], 'title': 'Updated 1'},
            {'id': created_entities[1]['id'], 'title': 'Updated 2'}
        ]
        
        results = await mock_repository.update_batch(updates)
        
        assert len(results) == 2
        assert results[0]['title'] == 'Updated 1'
        assert results[1]['title'] == 'Updated 2'
    
    @pytest.mark.asyncio
    async def test_delete_batch_operation(self, mock_repository):
        """Test batch entity deletion."""
        # Create entities first
        created_entities = []
        for i in range(3):
            entity_data = {'source_id': f'delete-{i}', 'title': f'Delete {i}'}
            created = await mock_repository.create(entity_data)
            created_entities.append(created)
        
        # Delete in batch
        ids_to_delete = [entity['id'] for entity in created_entities[:2]]
        deleted_count = await mock_repository.delete_batch(ids_to_delete)
        
        assert deleted_count == 2
        
        # Verify deletions
        for entity_id in ids_to_delete:
            exists = await mock_repository.exists(entity_id)
            assert exists is False
        
        # Verify remaining entity still exists
        remaining_exists = await mock_repository.exists(created_entities[2]['id'])
        assert remaining_exists is True


class TestTransactionErrorHandling:
    """Test transaction error handling and custom exceptions."""
    
    def test_transaction_error_creation(self):
        """Test TransactionError creation with and without original error."""
        # Without original error
        error1 = TransactionError("Transaction failed")
        assert str(error1) == "Transaction failed"
        assert error1.original_error is None
        
        # With original error
        original = ValueError("Database connection lost")
        error2 = TransactionError("Transaction rollback failed", original)
        assert str(error2) == "Transaction rollback failed"
        assert error2.original_error == original
    
    def test_savepoint_error_inheritance(self):
        """Test SavepointError inherits from TransactionError."""
        error = SavepointError("Savepoint creation failed")
        assert isinstance(error, TransactionError)
        assert str(error) == "Savepoint creation failed"
    
    def test_nested_transaction_error_inheritance(self):
        """Test NestedTransactionError inherits from TransactionError."""
        error = NestedTransactionError("Nested transaction not allowed")
        assert isinstance(error, TransactionError)
        assert str(error) == "Nested transaction not allowed"


class TestMockRepositoryImplementations:
    """Test that mock repository implementations correctly follow interface contracts."""
    
    @pytest.mark.parametrize("repository_class", [
        MockSourceRepository,
        MockDocumentRepository,
        MockProjectRepository,
        MockTaskRepository,
        MockSettingsRepository,
        MockVersionRepository,
        MockCodeExampleRepository,
        MockPromptRepository
    ])
    @pytest.mark.asyncio
    async def test_mock_repository_basic_operations(self, repository_class):
        """Test that all mock repositories implement basic CRUD operations."""
        repo = repository_class()
        
        # Test create
        test_entity = {'test_field': 'test_value'}
        if hasattr(repo, '_get_test_entity'):
            test_entity = repo._get_test_entity()
        
        created = await repo.create(test_entity)
        assert created['id'] is not None
        assert 'created_at' in created
        
        # Test get_by_id
        retrieved = await repo.get_by_id(created['id'])
        assert retrieved is not None
        assert retrieved['id'] == created['id']
        
        # Test exists
        exists = await repo.exists(created['id'])
        assert exists is True
        
        # Test update
        update_data = {'updated_field': 'updated_value'}
        updated = await repo.update(created['id'], update_data)
        assert updated is not None
        assert updated['updated_field'] == 'updated_value'
        
        # Test delete
        deleted = await repo.delete(created['id'])
        assert deleted is True
        
        # Verify deletion
        not_found = await repo.get_by_id(created['id'])
        assert not_found is None


class TestSpecificRepositoryFeatures:
    """Test repository-specific features and methods."""
    
    @pytest.mark.asyncio
    async def test_source_repository_specific_methods(self):
        """Test source repository specific methods."""
        repo = MockSourceRepository()
        
        # Create test source
        source_data = {
            'source_id': 'test-source',
            'source_type': 'website',
            'base_url': 'https://example.com',
            'crawl_status': 'in_progress',
            'pages_crawled': 5,
            'total_pages': 10
        }
        created = await repo.create(source_data)
        
        # Test get_by_source_id
        by_source_id = await repo.get_by_source_id('test-source')
        assert by_source_id is not None
        assert by_source_id['source_id'] == 'test-source'
        
        # Test update_crawl_status
        updated = await repo.update_crawl_status(
            'test-source', 'completed', pages_crawled=10, total_pages=10
        )
        assert updated is not None
        assert updated['crawl_status'] == 'completed'
        assert updated['pages_crawled'] == 10
        
        # Test get_by_status
        completed_sources = await repo.get_by_status('completed')
        assert len(completed_sources) == 1
        assert completed_sources[0]['source_id'] == 'test-source'
        
        # Test get_by_type
        website_sources = await repo.get_by_type('website')
        assert len(website_sources) == 1
        assert website_sources[0]['source_type'] == 'website'
        
        # Test get_crawl_statistics
        stats = await repo.get_crawl_statistics()
        assert stats['total_sources'] == 1
        assert stats['by_status']['completed'] == 1
        assert stats['by_type']['website'] == 1
        assert stats['total_pages'] == 10
    
    @pytest.mark.asyncio
    async def test_document_repository_vector_search(self):
        """Test document repository vector search functionality."""
        repo = MockDocumentRepository()
        
        # Create test documents
        documents = [
            {
                'url': 'https://example.com/page1',
                'chunk_number': 0,
                'content': 'Python programming tutorial',
                'source_id': 'example-source',
                'embedding': [0.1, 0.2, 0.3]
            },
            {
                'url': 'https://example.com/page2',
                'chunk_number': 0,
                'content': 'JavaScript development guide',
                'source_id': 'example-source',
                'embedding': [0.4, 0.5, 0.6]
            }
        ]
        
        for doc_data in documents:
            await repo.create(doc_data)
        
        # Test vector search
        query_embedding = [0.1, 0.2, 0.3]
        results = await repo.vector_search(query_embedding, limit=5)
        
        assert len(results) <= 5
        # Check that similarity scores are added
        for result in results:
            assert 'similarity' in result
            assert 0.0 <= result['similarity'] <= 1.0
        
        # Test with source filter
        filtered_results = await repo.vector_search(
            query_embedding, limit=5, source_filter='example-source'
        )
        
        for result in filtered_results:
            assert result['source_id'] == 'example-source'
    
    @pytest.mark.asyncio
    async def test_project_repository_jsonb_operations(self):
        """Test project repository JSONB field operations."""
        repo = MockProjectRepository()
        
        # Create test project
        project_data = {
            'title': 'Test Project',
            'description': 'A test project'
        }
        created = await repo.create(project_data)
        project_id = created['id']
        
        # Test update_jsonb_field
        docs_data = [{'title': 'Doc 1', 'content': 'Content 1'}]
        updated = await repo.update_jsonb_field(project_id, 'docs', docs_data)
        assert updated is not None
        assert updated['docs'] == docs_data
        
        # Test merge_jsonb_field
        data_merge = {'setting1': 'value1', 'setting2': 'value2'}
        merged = await repo.merge_jsonb_field(project_id, 'data', data_merge)
        assert merged is not None
        assert merged['data'] == data_merge
        
        # Test append_to_jsonb_array
        new_doc = {'title': 'Doc 2', 'content': 'Content 2'}
        appended = await repo.append_to_jsonb_array(project_id, 'docs', new_doc)
        assert appended is not None
        assert len(appended['docs']) == 2
        
        # Test search_by_title
        search_results = await repo.search_by_title('Test', limit=10)
        assert len(search_results) == 1
        assert search_results[0]['title'] == 'Test Project'
    
    @pytest.mark.asyncio
    async def test_settings_repository_upsert_operation(self):
        """Test settings repository upsert functionality."""
        repo = MockSettingsRepository()
        
        # Test creating new setting
        result1 = await repo.upsert(
            key='test_setting',
            value='initial_value',
            category='test',
            description='A test setting'
        )
        
        assert result1['key'] == 'test_setting'
        assert result1['value'] == 'initial_value'
        assert result1['category'] == 'test'
        
        # Test updating existing setting
        result2 = await repo.upsert(
            key='test_setting',
            value='updated_value',
            category='test',
            description='Updated description'
        )
        
        assert result2['key'] == 'test_setting'
        assert result2['value'] == 'updated_value'
        assert result2['description'] == 'Updated description'
        
        # Verify only one setting exists
        all_settings = await repo.list()
        test_settings = [s for s in all_settings if s['key'] == 'test_setting']
        assert len(test_settings) == 1


class MockUnitOfWork(IUnitOfWork):
    """Mock Unit of Work implementation for testing."""
    
    def __init__(self):
        self._transaction_active = False
        self._savepoints = {}
        
    @asynccontextmanager
    async def transaction(self):
        if self._transaction_active:
            raise NestedTransactionError("Nested transactions not supported")
        
        self._transaction_active = True
        try:
            yield self
            await self.commit()
        except Exception as e:
            await self.rollback()
            raise
        finally:
            self._transaction_active = False
    
    async def commit(self):
        if not self._transaction_active:
            raise TransactionError("No active transaction to commit")
        # Mock commit operation
        self._transaction_active = False
        pass
    
    async def rollback(self):
        if not self._transaction_active:
            raise TransactionError("No active transaction to rollback")
        # Mock rollback operation
        self._transaction_active = False
        pass
    
    async def begin(self):
        if self._transaction_active:
            raise TransactionError("Transaction already active")
        self._transaction_active = True
    
    async def is_active(self) -> bool:
        return self._transaction_active
    
    async def savepoint(self, name: str) -> str:
        if not self._transaction_active:
            raise TransactionError("No active transaction for savepoint")
        
        savepoint_id = f"sp_{name}_{len(self._savepoints)}"
        self._savepoints[savepoint_id] = name
        return savepoint_id
    
    async def rollback_to_savepoint(self, savepoint_id: str):
        if savepoint_id not in self._savepoints:
            raise SavepointError(f"Savepoint {savepoint_id} not found")
        # Mock rollback to savepoint
        pass
    
    async def release_savepoint(self, savepoint_id: str):
        if savepoint_id not in self._savepoints:
            raise SavepointError(f"Savepoint {savepoint_id} not found")
        del self._savepoints[savepoint_id]
    
    async def close(self):
        """Mock close operation - clean up resources."""
        self._transaction_active = False
        self._savepoints.clear()
    
    async def health_check(self) -> bool:
        """Mock health check - always returns True."""
        return True


class TestUnitOfWorkPattern:
    """Test the Unit of Work pattern implementation."""
    
    @pytest.fixture
    def unit_of_work(self):
        """Create mock unit of work for testing."""
        return MockUnitOfWork()
    
    @pytest.mark.asyncio
    async def test_transaction_context_manager_success(self, unit_of_work):
        """Test successful transaction context manager."""
        async with unit_of_work.transaction():
            # Simulate work within transaction
            assert await unit_of_work.is_active() is True
        
        # Transaction should be inactive after successful completion
        assert await unit_of_work.is_active() is False
    
    @pytest.mark.asyncio
    async def test_transaction_context_manager_failure(self, unit_of_work):
        """Test transaction context manager with exception."""
        with pytest.raises(ValueError):
            async with unit_of_work.transaction():
                assert await unit_of_work.is_active() is True
                raise ValueError("Simulated error")
        
        # Transaction should be inactive after rollback
        assert await unit_of_work.is_active() is False
    
    @pytest.mark.asyncio
    async def test_nested_transaction_prevention(self, unit_of_work):
        """Test that nested transactions are prevented."""
        async with unit_of_work.transaction():
            with pytest.raises(NestedTransactionError):
                async with unit_of_work.transaction():
                    pass
    
    @pytest.mark.asyncio
    async def test_manual_transaction_management(self, unit_of_work):
        """Test manual transaction begin/commit/rollback."""
        # Begin transaction
        await unit_of_work.begin()
        assert await unit_of_work.is_active() is True
        
        # Commit transaction
        await unit_of_work.commit()
        assert await unit_of_work.is_active() is False
    
    @pytest.mark.asyncio
    async def test_manual_rollback(self, unit_of_work):
        """Test manual transaction rollback."""
        await unit_of_work.begin()
        assert await unit_of_work.is_active() is True
        
        await unit_of_work.rollback()
        assert await unit_of_work.is_active() is False
    
    @pytest.mark.asyncio
    async def test_commit_without_transaction_raises_error(self, unit_of_work):
        """Test that commit without active transaction raises error."""
        with pytest.raises(TransactionError, match="No active transaction to commit"):
            await unit_of_work.commit()
    
    @pytest.mark.asyncio
    async def test_rollback_without_transaction_raises_error(self, unit_of_work):
        """Test that rollback without active transaction raises error."""
        with pytest.raises(TransactionError, match="No active transaction to rollback"):
            await unit_of_work.rollback()
    
    @pytest.mark.asyncio
    async def test_savepoint_operations(self, unit_of_work):
        """Test savepoint creation and management."""
        await unit_of_work.begin()
        
        # Create savepoint
        savepoint_id = await unit_of_work.savepoint("test_savepoint")
        assert savepoint_id.startswith("sp_test_savepoint")
        
        # Rollback to savepoint
        await unit_of_work.rollback_to_savepoint(savepoint_id)
        
        # Release savepoint
        await unit_of_work.release_savepoint(savepoint_id)
        
        # Try to use released savepoint should fail
        with pytest.raises(SavepointError):
            await unit_of_work.rollback_to_savepoint(savepoint_id)
        
        await unit_of_work.commit()
    
    @pytest.mark.asyncio
    async def test_savepoint_without_transaction_raises_error(self, unit_of_work):
        """Test that savepoint without active transaction raises error."""
        with pytest.raises(TransactionError, match="No active transaction for savepoint"):
            await unit_of_work.savepoint("test")
    
    @pytest.mark.asyncio
    async def test_rollback_to_nonexistent_savepoint_raises_error(self, unit_of_work):
        """Test rollback to non-existent savepoint raises error."""
        await unit_of_work.begin()
        
        with pytest.raises(SavepointError, match="Savepoint nonexistent not found"):
            await unit_of_work.rollback_to_savepoint("nonexistent")
        
        await unit_of_work.commit()