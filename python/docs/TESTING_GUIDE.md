# Repository Pattern Testing Guide

## Overview

This comprehensive guide covers testing strategies, patterns, and best practices for the Archon repository pattern implementation. It includes unit testing, integration testing, performance testing, and advanced testing scenarios with mock implementations.

## Table of Contents

- [Testing Philosophy](#testing-philosophy)
- [Test Setup and Configuration](#test-setup-and-configuration)
- [Unit Testing Repositories](#unit-testing-repositories)
- [Integration Testing](#integration-testing)
- [Performance Testing](#performance-testing)
- [Transaction Testing](#transaction-testing)
- [Error Handling Testing](#error-handling-testing)
- [Mock Implementations](#mock-implementations)
- [Test Data Management](#test-data-management)
- [Advanced Testing Patterns](#advanced-testing-patterns)

## Testing Philosophy

### Core Testing Principles

1. **Test Behavior, Not Implementation**: Focus on what repositories do, not how they do it
2. **Fast Feedback**: Unit tests should run quickly for rapid development cycles
3. **Isolated Testing**: Each test should be independent and repeatable
4. **Realistic Integration**: Integration tests should use real database scenarios
5. **Performance Validation**: Ensure lazy loading and performance optimizations work as expected

### Testing Pyramid

```
    /\
   /  \
  /E2E \     End-to-End Tests (Few, Slow, High Confidence)
 /______\
 /      \
/Integration\   Integration Tests (Some, Medium Speed, Medium Confidence)
\____________/
\            /
 \   Unit   /    Unit Tests (Many, Fast, Low-Level Confidence)
  \________/
```

## Test Setup and Configuration

### Project Structure

```
tests/
├── conftest.py                    # Pytest configuration and fixtures
├── fixtures/                     # Test data and fixtures
│   ├── __init__.py
│   ├── entity_fixtures.py        # Sample entity data
│   ├── database_fixtures.py      # Database setup fixtures
│   └── mock_fixtures.py          # Mock service fixtures
├── unit/                         # Unit tests
│   ├── __init__.py
│   ├── repositories/             # Repository unit tests
│   │   ├── __init__.py
│   │   ├── test_base_repository.py
│   │   ├── test_source_repository.py
│   │   ├── test_document_repository.py
│   │   └── test_project_repository.py
│   ├── test_lazy_loading.py      # Lazy loading unit tests
│   └── test_dependency_injection.py # DI unit tests
├── integration/                  # Integration tests
│   ├── __init__.py
│   ├── test_database_integration.py
│   ├── test_transaction_integration.py
│   └── test_repository_integration.py
├── performance/                  # Performance tests
│   ├── __init__.py
│   ├── test_lazy_loading_performance.py
│   └── test_batch_operation_performance.py
└── end_to_end/                  # E2E tests
    ├── __init__.py
    └── test_complete_workflows.py
```

### Test Configuration (conftest.py)

```python
import pytest
import asyncio
from typing import AsyncGenerator, Generator
from unittest.mock import AsyncMock, MagicMock

from src.server.repositories import LazySupabaseDatabase
from src.server.repositories.implementations.mock_repositories import (
    MockSourceRepository,
    MockDocumentRepository,
    MockProjectRepository
)
from src.server.repositories.interfaces import IUnitOfWork
from tests.fixtures.database_fixtures import create_test_database
from tests.fixtures.entity_fixtures import create_sample_entities

# Pytest configuration
pytestmark = pytest.mark.asyncio

@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Create event loop for async tests."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        yield loop
    finally:
        loop.close()

@pytest.fixture(scope="session")
async def test_database() -> AsyncGenerator[IUnitOfWork, None]:
    """Create test database for integration tests."""
    db = await create_test_database()
    try:
        yield db
    finally:
        await db.close()

@pytest.fixture
async def mock_database() -> IUnitOfWork:
    """Create mock database for unit tests."""
    mock_client = MagicMock()
    db = LazySupabaseDatabase(mock_client)
    
    # Replace repositories with mocks
    db._repository_cache = {
        'sources': MockSourceRepository(),
        'documents': MockDocumentRepository(), 
        'projects': MockProjectRepository()
    }
    
    return db

@pytest.fixture
def sample_entities():
    """Provide sample entities for testing."""
    return create_sample_entities()

@pytest.fixture(autouse=True)
async def cleanup_after_test():
    """Cleanup after each test."""
    yield
    # Perform cleanup operations
    await cleanup_test_data()

# Test database utilities
async def cleanup_test_data():
    """Clean up test data after each test."""
    # Implementation depends on your cleanup strategy
    pass

@pytest.fixture
def mock_embedding_service():
    """Mock embedding service for testing."""
    service = AsyncMock()
    service.embed.return_value = [0.1] * 1536  # Mock embedding vector
    return service
```

### Environment Configuration

```python
# tests/test_config.py
import os
from dataclasses import dataclass
from typing import Optional

@dataclass
class TestConfig:
    """Test environment configuration."""
    
    # Database configuration
    test_db_url: str = "postgresql://test:test@localhost:5432/archon_test"
    use_in_memory_db: bool = True
    cleanup_after_tests: bool = True
    
    # Performance testing
    performance_test_iterations: int = 100
    batch_size_for_testing: int = 50
    timeout_seconds: int = 30
    
    # Mock configuration
    use_mock_repositories: bool = True
    mock_data_size: int = 1000
    
    @classmethod
    def from_environment(cls) -> 'TestConfig':
        """Create configuration from environment variables."""
        return cls(
            test_db_url=os.getenv('TEST_DATABASE_URL', cls.test_db_url),
            use_in_memory_db=os.getenv('USE_IN_MEMORY_DB', 'true').lower() == 'true',
            performance_test_iterations=int(os.getenv('PERF_TEST_ITERATIONS', '100')),
            use_mock_repositories=os.getenv('USE_MOCK_REPOS', 'true').lower() == 'true'
        )

# Global test configuration
TEST_CONFIG = TestConfig.from_environment()
```

## Unit Testing Repositories

### Base Repository Testing

```python
# tests/unit/repositories/test_base_repository.py
import pytest
from typing import List, Optional
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from src.server.repositories.interfaces.base_repository import (
    IBaseRepository, PaginationParams, OrderingField, SortDirection
)
from src.server.repositories.exceptions import (
    ValidationError, EntityNotFoundError, DuplicateEntityError
)
from tests.fixtures.entity_fixtures import create_sample_source

class TestBaseRepository:
    """Test cases for base repository functionality."""
    
    @pytest.fixture
    def mock_repository(self) -> IBaseRepository:
        """Create mock repository for testing."""
        repo = AsyncMock(spec=IBaseRepository)
        return repo
    
    @pytest.fixture
    def sample_entity(self):
        """Sample entity for testing."""
        return create_sample_source()
    
    async def test_create_success(self, mock_repository, sample_entity):
        """Test successful entity creation."""
        # Setup
        expected_entity = sample_entity.copy()
        expected_entity.id = str(uuid4())
        mock_repository.create.return_value = expected_entity
        
        # Execute
        result = await mock_repository.create(sample_entity)
        
        # Verify
        assert result.id is not None
        assert result.url == sample_entity.url
        mock_repository.create.assert_called_once_with(sample_entity)
    
    async def test_create_validation_error(self, mock_repository):
        """Test creation with validation errors."""
        # Setup
        invalid_entity = create_sample_source()
        invalid_entity.url = "invalid-url"  # Invalid URL format
        
        mock_repository.create.side_effect = ValidationError(
            "Invalid URL format",
            validation_errors=["URL must be a valid HTTP/HTTPS URL"]
        )
        
        # Execute & Verify
        with pytest.raises(ValidationError) as exc_info:
            await mock_repository.create(invalid_entity)
        
        assert "Invalid URL format" in str(exc_info.value)
        assert len(exc_info.value.validation_errors) == 1
    
    async def test_get_by_id_found(self, mock_repository, sample_entity):
        """Test successful entity retrieval by ID."""
        # Setup
        entity_id = str(uuid4())
        expected_entity = sample_entity.copy()
        expected_entity.id = entity_id
        mock_repository.get_by_id.return_value = expected_entity
        
        # Execute
        result = await mock_repository.get_by_id(entity_id)
        
        # Verify
        assert result is not None
        assert result.id == entity_id
        mock_repository.get_by_id.assert_called_once_with(entity_id)
    
    async def test_get_by_id_not_found(self, mock_repository):
        """Test entity retrieval when not found."""
        # Setup
        entity_id = str(uuid4())
        mock_repository.get_by_id.return_value = None
        
        # Execute
        result = await mock_repository.get_by_id(entity_id)
        
        # Verify
        assert result is None
        mock_repository.get_by_id.assert_called_once_with(entity_id)
    
    async def test_update_success(self, mock_repository, sample_entity):
        """Test successful entity update."""
        # Setup
        entity_id = str(uuid4())
        update_data = {"title": "Updated Title", "description": "New description"}
        updated_entity = sample_entity.copy()
        updated_entity.id = entity_id
        updated_entity.title = update_data["title"]
        updated_entity.description = update_data["description"]
        
        mock_repository.update.return_value = updated_entity
        
        # Execute
        result = await mock_repository.update(entity_id, update_data)
        
        # Verify
        assert result.title == "Updated Title"
        assert result.description == "New description"
        mock_repository.update.assert_called_once_with(entity_id, update_data)
    
    async def test_update_not_found(self, mock_repository):
        """Test update when entity not found."""
        # Setup
        entity_id = str(uuid4())
        update_data = {"title": "Updated Title"}
        mock_repository.update.side_effect = EntityNotFoundError("Source", entity_id)
        
        # Execute & Verify
        with pytest.raises(EntityNotFoundError) as exc_info:
            await mock_repository.update(entity_id, update_data)
        
        assert entity_id in str(exc_info.value)
    
    async def test_delete_success(self, mock_repository):
        """Test successful entity deletion."""
        # Setup
        entity_id = str(uuid4())
        mock_repository.delete.return_value = True
        
        # Execute
        result = await mock_repository.delete(entity_id)
        
        # Verify
        assert result is True
        mock_repository.delete.assert_called_once_with(entity_id)
    
    async def test_delete_not_found(self, mock_repository):
        """Test deletion when entity not found."""
        # Setup
        entity_id = str(uuid4())
        mock_repository.delete.return_value = False
        
        # Execute
        result = await mock_repository.delete(entity_id)
        
        # Verify
        assert result is False
    
    async def test_soft_delete(self, mock_repository):
        """Test soft deletion functionality."""
        # Setup
        entity_id = str(uuid4())
        mock_repository.delete.return_value = True
        
        # Execute
        result = await mock_repository.delete(entity_id, soft_delete=True)
        
        # Verify
        assert result is True
        mock_repository.delete.assert_called_once_with(entity_id, soft_delete=True)
    
    async def test_list_with_pagination(self, mock_repository, sample_entities):
        """Test list operation with pagination."""
        # Setup
        pagination = PaginationParams(limit=10, offset=20)
        mock_repository.list.return_value = sample_entities[:10]
        
        # Execute
        result = await mock_repository.list(pagination=pagination)
        
        # Verify
        assert len(result) == 10
        mock_repository.list.assert_called_once_with(pagination=pagination)
    
    async def test_list_with_ordering(self, mock_repository, sample_entities):
        """Test list operation with ordering."""
        # Setup
        ordering = [
            OrderingField(field="created_at", direction=SortDirection.DESC),
            OrderingField(field="title", direction=SortDirection.ASC)
        ]
        mock_repository.list.return_value = sample_entities
        
        # Execute
        result = await mock_repository.list(ordering=ordering)
        
        # Verify
        assert len(result) > 0
        mock_repository.list.assert_called_once_with(ordering=ordering)
    
    async def test_list_with_filters(self, mock_repository, sample_entities):
        """Test list operation with filters."""
        # Setup
        filters = {"status": "active", "source_type": "website"}
        filtered_entities = [e for e in sample_entities if e.status == "active"]
        mock_repository.list.return_value = filtered_entities
        
        # Execute
        result = await mock_repository.list(filters=filters)
        
        # Verify
        assert all(e.status == "active" for e in result)
        mock_repository.list.assert_called_once_with(filters=filters)
    
    async def test_count_with_filters(self, mock_repository):
        """Test count operation with filters."""
        # Setup
        filters = {"status": "active"}
        expected_count = 42
        mock_repository.count.return_value = expected_count
        
        # Execute
        result = await mock_repository.count(filters=filters)
        
        # Verify
        assert result == expected_count
        mock_repository.count.assert_called_once_with(filters=filters)
    
    async def test_exists_found(self, mock_repository):
        """Test existence check when entity exists."""
        # Setup
        entity_id = str(uuid4())
        mock_repository.exists.return_value = True
        
        # Execute
        result = await mock_repository.exists(entity_id)
        
        # Verify
        assert result is True
        mock_repository.exists.assert_called_once_with(entity_id)
    
    async def test_exists_not_found(self, mock_repository):
        """Test existence check when entity doesn't exist."""
        # Setup
        entity_id = str(uuid4())
        mock_repository.exists.return_value = False
        
        # Execute
        result = await mock_repository.exists(entity_id)
        
        # Verify
        assert result is False
    
    async def test_create_batch_success(self, mock_repository, sample_entities):
        """Test successful batch creation."""
        # Setup
        from src.server.repositories.interfaces.base_repository import OperationResult
        
        expected_result = OperationResult[type(sample_entities[0])](
            success=True,
            entities=sample_entities,
            affected_count=len(sample_entities)
        )
        mock_repository.create_batch.return_value = expected_result
        
        # Execute
        result = await mock_repository.create_batch(sample_entities)
        
        # Verify
        assert result.success is True
        assert result.affected_count == len(sample_entities)
        assert len(result.entities) == len(sample_entities)
    
    async def test_create_batch_partial_failure(self, mock_repository, sample_entities):
        """Test batch creation with partial failures."""
        # Setup
        from src.server.repositories.interfaces.base_repository import OperationResult
        
        successful_entities = sample_entities[:3]
        expected_result = OperationResult[type(sample_entities[0])](
            success=False,
            entities=successful_entities,
            affected_count=len(successful_entities),
            error="2 entities failed validation",
            metadata={
                'failed_items': [
                    {'index': 3, 'error': 'Invalid URL'},
                    {'index': 4, 'error': 'Missing required field'}
                ]
            }
        )
        mock_repository.create_batch.return_value = expected_result
        
        # Execute
        result = await mock_repository.create_batch(sample_entities)
        
        # Verify
        assert result.success is False
        assert result.affected_count == 3
        assert len(result.metadata['failed_items']) == 2
```

### Domain-Specific Repository Testing

```python
# tests/unit/repositories/test_source_repository.py
import pytest
from unittest.mock import AsyncMock
from uuid import uuid4

from src.server.repositories.interfaces.knowledge_repository import ISourceRepository
from src.server.models.entities import Source, SourceType, CrawlStatus
from tests.fixtures.entity_fixtures import create_sample_source

class TestSourceRepository:
    """Test cases for source repository functionality."""
    
    @pytest.fixture
    def mock_source_repository(self) -> ISourceRepository:
        """Create mock source repository."""
        return AsyncMock(spec=ISourceRepository)
    
    async def test_get_by_url(self, mock_source_repository):
        """Test retrieving source by URL."""
        # Setup
        url = "https://example.com/docs"
        expected_source = create_sample_source()
        expected_source.url = url
        expected_source.id = str(uuid4())
        
        mock_source_repository.get_by_url.return_value = expected_source
        
        # Execute
        result = await mock_source_repository.get_by_url(url)
        
        # Verify
        assert result is not None
        assert result.url == url
        mock_source_repository.get_by_url.assert_called_once_with(url)
    
    async def test_get_by_url_not_found(self, mock_source_repository):
        """Test retrieving non-existent source by URL."""
        # Setup
        url = "https://nonexistent.com"
        mock_source_repository.get_by_url.return_value = None
        
        # Execute
        result = await mock_source_repository.get_by_url(url)
        
        # Verify
        assert result is None
    
    async def test_get_sources_by_type(self, mock_source_repository):
        """Test retrieving sources by type."""
        # Setup
        source_type = SourceType.WEBSITE
        expected_sources = [
            create_sample_source(source_type=source_type) 
            for _ in range(3)
        ]
        
        mock_source_repository.get_sources_by_type.return_value = expected_sources
        
        # Execute
        result = await mock_source_repository.get_sources_by_type(source_type)
        
        # Verify
        assert len(result) == 3
        assert all(s.source_type == source_type for s in result)
        mock_source_repository.get_sources_by_type.assert_called_once_with(source_type)
    
    async def test_update_crawl_status(self, mock_source_repository):
        """Test updating crawl status."""
        # Setup
        source_id = str(uuid4())
        new_status = CrawlStatus.COMPLETED
        pages_crawled = 100
        
        updated_source = create_sample_source()
        updated_source.id = source_id
        updated_source.crawl_status = new_status
        updated_source.pages_crawled = pages_crawled
        
        mock_source_repository.update_crawl_status.return_value = updated_source
        
        # Execute
        result = await mock_source_repository.update_crawl_status(
            source_id, 
            new_status,
            pages_crawled=pages_crawled
        )
        
        # Verify
        assert result.crawl_status == new_status
        assert result.pages_crawled == pages_crawled
        mock_source_repository.update_crawl_status.assert_called_once_with(
            source_id, new_status, pages_crawled=pages_crawled
        )
    
    async def test_get_sources_for_crawling(self, mock_source_repository):
        """Test getting sources that need crawling."""
        # Setup
        statuses = [CrawlStatus.PENDING, CrawlStatus.FAILED]
        limit = 10
        
        expected_sources = [
            create_sample_source(crawl_status=CrawlStatus.PENDING),
            create_sample_source(crawl_status=CrawlStatus.FAILED)
        ]
        
        mock_source_repository.get_sources_for_crawling.return_value = expected_sources
        
        # Execute
        result = await mock_source_repository.get_sources_for_crawling(statuses, limit)
        
        # Verify
        assert len(result) == 2
        assert all(s.crawl_status in statuses for s in result)
        mock_source_repository.get_sources_for_crawling.assert_called_once_with(
            statuses, limit
        )
```

## Integration Testing

### Database Integration Tests

```python
# tests/integration/test_database_integration.py
import pytest
from uuid import uuid4

from src.server.repositories import LazySupabaseDatabase
from src.server.models.entities import Source, SourceType, CrawlStatus
from tests.fixtures.entity_fixtures import create_sample_source

class TestDatabaseIntegration:
    """Integration tests with real database."""
    
    async def test_source_crud_operations(self, test_database):
        """Test complete CRUD cycle for sources."""
        db = test_database
        
        # Create
        source = create_sample_source()
        created_source = await db.sources.create(source)
        
        assert created_source.id is not None
        assert created_source.url == source.url
        assert created_source.created_at is not None
        
        # Read
        retrieved_source = await db.sources.get_by_id(created_source.id)
        assert retrieved_source is not None
        assert retrieved_source.id == created_source.id
        assert retrieved_source.url == source.url
        
        # Update
        update_data = {"title": "Updated Title", "description": "New description"}
        updated_source = await db.sources.update(created_source.id, update_data)
        
        assert updated_source.title == "Updated Title"
        assert updated_source.description == "New description"
        assert updated_source.updated_at > updated_source.created_at
        
        # Delete
        deleted = await db.sources.delete(created_source.id)
        assert deleted is True
        
        # Verify deletion
        deleted_source = await db.sources.get_by_id(created_source.id)
        assert deleted_source is None
    
    async def test_source_domain_specific_operations(self, test_database):
        """Test domain-specific source operations."""
        db = test_database
        
        # Create test sources
        sources = [
            create_sample_source(
                url=f"https://site{i}.com",
                source_type=SourceType.WEBSITE,
                crawl_status=CrawlStatus.PENDING if i % 2 == 0 else CrawlStatus.COMPLETED
            )
            for i in range(5)
        ]
        
        created_sources = []
        for source in sources:
            created = await db.sources.create(source)
            created_sources.append(created)
        
        # Test get_by_url
        found_source = await db.sources.get_by_url("https://site0.com")
        assert found_source is not None
        assert found_source.url == "https://site0.com"
        
        # Test get_sources_by_type
        website_sources = await db.sources.get_sources_by_type(SourceType.WEBSITE)
        assert len(website_sources) >= 5
        assert all(s.source_type == SourceType.WEBSITE for s in website_sources)
        
        # Test get_sources_for_crawling
        pending_sources = await db.sources.get_sources_for_crawling(
            [CrawlStatus.PENDING], 
            limit=10
        )
        assert len(pending_sources) >= 3  # At least 3 pending sources
        assert all(s.crawl_status == CrawlStatus.PENDING for s in pending_sources)
        
        # Test update_crawl_status
        source_to_update = created_sources[0]
        updated_source = await db.sources.update_crawl_status(
            source_to_update.id,
            CrawlStatus.IN_PROGRESS,
            pages_crawled=50
        )
        
        assert updated_source.crawl_status == CrawlStatus.IN_PROGRESS
        assert updated_source.pages_crawled == 50
        
        # Cleanup
        for source in created_sources:
            await db.sources.delete(source.id)
    
    async def test_batch_operations(self, test_database):
        """Test batch operations with real database."""
        db = test_database
        
        # Create batch data
        sources = [
            create_sample_source(url=f"https://batch-test-{i}.com")
            for i in range(10)
        ]
        
        # Test batch creation
        result = await db.sources.create_batch(sources)
        
        assert result.success is True
        assert result.affected_count == 10
        assert len(result.entities) == 10
        assert all(e.id is not None for e in result.entities)
        
        created_ids = [e.id for e in result.entities]
        
        # Test batch updates
        updates = [
            {"id": entity_id, "title": f"Updated Title {i}"}
            for i, entity_id in enumerate(created_ids[:5])
        ]
        
        update_result = await db.sources.update_batch(updates)
        assert update_result.success is True
        assert update_result.affected_count == 5
        
        # Verify updates
        for i, entity in enumerate(update_result.entities):
            assert entity.title == f"Updated Title {i}"
        
        # Test batch deletion
        ids_to_delete = created_ids[5:]
        deleted_count = await db.sources.delete_batch(ids_to_delete)
        assert deleted_count == 5
        
        # Cleanup remaining
        remaining_ids = created_ids[:5]
        cleanup_count = await db.sources.delete_batch(remaining_ids)
        assert cleanup_count == 5
    
    async def test_pagination_and_ordering(self, test_database):
        """Test pagination and ordering functionality."""
        db = test_database
        
        # Create test data with specific ordering
        sources = []
        for i in range(20):
            source = create_sample_source(
                url=f"https://order-test-{i:02d}.com",
                title=f"Title {i:02d}"
            )
            created = await db.sources.create(source)
            sources.append(created)
        
        try:
            # Test pagination
            from src.server.repositories.interfaces.base_repository import PaginationParams
            
            page1 = await db.sources.list(
                pagination=PaginationParams(limit=5, offset=0)
            )
            page2 = await db.sources.list(
                pagination=PaginationParams(limit=5, offset=5)
            )
            
            assert len(page1) == 5
            assert len(page2) == 5
            
            # Ensure no overlap
            page1_ids = {s.id for s in page1}
            page2_ids = {s.id for s in page2}
            assert page1_ids.isdisjoint(page2_ids)
            
            # Test ordering
            from src.server.repositories.interfaces.base_repository import (
                OrderingField, SortDirection
            )
            
            ordered_sources = await db.sources.list(
                ordering=[
                    OrderingField(field="title", direction=SortDirection.ASC)
                ]
            )
            
            # Verify ordering (at least our test sources should be in order)
            test_sources_ordered = [s for s in ordered_sources if "order-test" in s.url]
            assert len(test_sources_ordered) == 20
            
            for i in range(len(test_sources_ordered) - 1):
                assert test_sources_ordered[i].title <= test_sources_ordered[i + 1].title
        
        finally:
            # Cleanup
            for source in sources:
                await db.sources.delete(source.id)
    
    async def test_filtering_and_counting(self, test_database):
        """Test filtering and counting operations."""
        db = test_database
        
        # Create test data with different attributes
        website_sources = [
            create_sample_source(
                url=f"https://website-{i}.com",
                source_type=SourceType.WEBSITE,
                crawl_status=CrawlStatus.COMPLETED if i % 2 == 0 else CrawlStatus.PENDING
            )
            for i in range(10)
        ]
        
        document_sources = [
            create_sample_source(
                url=f"file:///doc-{i}.pdf",
                source_type=SourceType.DOCUMENT,
                crawl_status=CrawlStatus.COMPLETED
            )
            for i in range(5)
        ]
        
        all_sources = website_sources + document_sources
        created_sources = []
        
        for source in all_sources:
            created = await db.sources.create(source)
            created_sources.append(created)
        
        try:
            # Test filtering by type
            websites = await db.sources.list(
                filters={"source_type": SourceType.WEBSITE}
            )
            website_urls = {s.url for s in websites}
            expected_urls = {s.url for s in website_sources}
            assert expected_urls.issubset(website_urls)
            
            # Test compound filters
            completed_websites = await db.sources.list(
                filters={
                    "source_type": SourceType.WEBSITE,
                    "crawl_status": CrawlStatus.COMPLETED
                }
            )
            assert len(completed_websites) >= 5
            assert all(
                s.source_type == SourceType.WEBSITE and 
                s.crawl_status == CrawlStatus.COMPLETED 
                for s in completed_websites
            )
            
            # Test counting
            total_count = await db.sources.count()
            assert total_count >= 15  # At least our test data
            
            website_count = await db.sources.count(
                filters={"source_type": SourceType.WEBSITE}
            )
            assert website_count >= 10
            
            # Test distinct counting
            unique_types = await db.sources.count(distinct_field="source_type")
            assert unique_types >= 2  # At least WEBSITE and DOCUMENT
        
        finally:
            # Cleanup
            for source in created_sources:
                await db.sources.delete(source.id)
```

### Transaction Integration Tests

```python
# tests/integration/test_transaction_integration.py
import pytest
from uuid import uuid4

from src.server.repositories.exceptions import ValidationError
from tests.fixtures.entity_fixtures import create_sample_source, create_sample_project

class TestTransactionIntegration:
    """Integration tests for transaction functionality."""
    
    async def test_successful_transaction(self, test_database):
        """Test successful transaction with multiple operations."""
        db = test_database
        
        async with db.transaction() as uow:
            # Create a project
            project = create_sample_project()
            created_project = await uow.projects.create(project)
            
            # Create related sources
            sources = [
                create_sample_source(url=f"https://project-{i}.com")
                for i in range(3)
            ]
            
            source_result = await uow.sources.create_batch(sources)
            assert source_result.success is True
            
            # All operations should be committed together
        
        # Verify all data was committed
        retrieved_project = await db.projects.get_by_id(created_project.id)
        assert retrieved_project is not None
        
        for source in source_result.entities:
            retrieved_source = await db.sources.get_by_id(source.id)
            assert retrieved_source is not None
        
        # Cleanup
        await db.projects.delete(created_project.id)
        for source in source_result.entities:
            await db.sources.delete(source.id)
    
    async def test_transaction_rollback(self, test_database):
        """Test transaction rollback on error."""
        db = test_database
        
        created_project = None
        created_sources = []
        
        try:
            async with db.transaction() as uow:
                # Create a project (should succeed)
                project = create_sample_project()
                created_project = await uow.projects.create(project)
                
                # Create some sources (should succeed)
                sources = [
                    create_sample_source(url=f"https://rollback-test-{i}.com")
                    for i in range(2)
                ]
                
                for source in sources:
                    created_source = await uow.sources.create(source)
                    created_sources.append(created_source)
                
                # Force an error (invalid data)
                invalid_source = create_sample_source()
                invalid_source.url = None  # This should cause an error
                await uow.sources.create(invalid_source)
                
        except Exception:
            # Transaction should rollback
            pass
        
        # Verify rollback - no data should exist
        if created_project:
            retrieved_project = await db.projects.get_by_id(created_project.id)
            assert retrieved_project is None
        
        for source in created_sources:
            retrieved_source = await db.sources.get_by_id(source.id)
            assert retrieved_source is None
    
    async def test_savepoint_functionality(self, test_database):
        """Test savepoint creation and rollback."""
        db = test_database
        
        async with db.transaction() as uow:
            # Create initial data
            project = create_sample_project()
            created_project = await uow.projects.create(project)
            
            # Create savepoint before risky operations
            savepoint_id = await uow.savepoint("before_sources")
            
            try:
                # Risky operations
                sources = [
                    create_sample_source(url="https://valid-source.com"),
                    create_sample_source(url=None)  # Invalid - will cause error
                ]
                
                # First source should succeed
                created_source1 = await uow.sources.create(sources[0])
                
                # Second source should fail
                await uow.sources.create(sources[1])
                
            except Exception:
                # Rollback to savepoint - keep project, discard sources
                await uow.rollback_to_savepoint(savepoint_id)
            
            # Continue with transaction - add different source
            valid_source = create_sample_source(url="https://recovery-source.com")
            created_source = await uow.sources.create(valid_source)
        
        # Verify results
        retrieved_project = await db.projects.get_by_id(created_project.id)
        assert retrieved_project is not None
        
        retrieved_source = await db.sources.get_by_id(created_source.id)
        assert retrieved_source is not None
        assert retrieved_source.url == "https://recovery-source.com"
        
        # First source should not exist (rolled back)
        invalid_sources = await db.sources.list(
            filters={"url": "https://valid-source.com"}
        )
        assert len(invalid_sources) == 0
        
        # Cleanup
        await db.projects.delete(created_project.id)
        await db.sources.delete(created_source.id)
    
    async def test_nested_transactions(self, test_database):
        """Test nested transaction behavior."""
        db = test_database
        
        async with db.transaction() as outer_uow:
            # Outer transaction operations
            project = create_sample_project(title="Outer Transaction Project")
            created_project = await outer_uow.projects.create(project)
            
            # Inner "transaction" (actually a savepoint)
            inner_savepoint = await outer_uow.savepoint("inner_transaction")
            
            try:
                # Inner operations
                source = create_sample_source(url="https://inner-transaction.com")
                created_source = await outer_uow.sources.create(source)
                
                # Simulate inner transaction success
                await outer_uow.release_savepoint(inner_savepoint)
                
            except Exception:
                # Inner transaction rollback
                await outer_uow.rollback_to_savepoint(inner_savepoint)
            
            # Continue outer transaction
            final_source = create_sample_source(url="https://outer-final.com")
            created_final_source = await outer_uow.sources.create(final_source)
        
        # Verify all committed data
        retrieved_project = await db.projects.get_by_id(created_project.id)
        assert retrieved_project is not None
        
        retrieved_source = await db.sources.get_by_id(created_source.id)
        assert retrieved_source is not None
        
        retrieved_final = await db.sources.get_by_id(created_final_source.id)
        assert retrieved_final is not None
        
        # Cleanup
        await db.projects.delete(created_project.id)
        await db.sources.delete(created_source.id)
        await db.sources.delete(created_final_source.id)
```

## Performance Testing

### Lazy Loading Performance Tests

```python
# tests/performance/test_lazy_loading_performance.py
import pytest
import time
from typing import Dict, Any

from src.server.repositories import LazySupabaseDatabase
from src.server.repositories.lazy_imports import get_repository_class, clear_cache
from tests.test_config import TEST_CONFIG

class TestLazyLoadingPerformance:
    """Performance tests for lazy loading functionality."""
    
    @pytest.fixture(autouse=True)
    async def setup_and_cleanup(self):
        """Setup and cleanup for each test."""
        # Clear cache before each test
        clear_cache()
        yield
        # Cleanup after test if needed
    
    async def test_lazy_loading_startup_time(self, mock_client):
        """Test startup time with lazy loading."""
        iterations = TEST_CONFIG.performance_test_iterations
        startup_times = []
        
        for _ in range(iterations):
            clear_cache()  # Ensure clean state
            
            start_time = time.perf_counter()
            db = LazySupabaseDatabase(mock_client)
            end_time = time.perf_counter()
            
            startup_times.append(end_time - start_time)
        
        avg_startup_time = sum(startup_times) / len(startup_times)
        max_startup_time = max(startup_times)
        
        # Startup should be very fast (< 10ms on average)
        assert avg_startup_time < 0.01, f"Average startup time too slow: {avg_startup_time:.4f}s"
        assert max_startup_time < 0.05, f"Max startup time too slow: {max_startup_time:.4f}s"
        
        print(f"Lazy loading startup - Avg: {avg_startup_time*1000:.2f}ms, Max: {max_startup_time*1000:.2f}ms")
    
    async def test_repository_loading_performance(self, mock_client):
        """Test individual repository loading performance."""
        db = LazySupabaseDatabase(mock_client)
        
        repositories = [
            ('sources', 'ISourceRepository'),
            ('documents', 'IDocumentRepository'),
            ('projects', 'IProjectRepository'),
            ('tasks', 'ITaskRepository')
        ]
        
        loading_times = {}
        
        for repo_name, interface_name in repositories:
            # Test first access (loading time)
            start_time = time.perf_counter()
            repo = getattr(db, repo_name)
            end_time = time.perf_counter()
            
            loading_times[repo_name] = end_time - start_time
            
            # Test subsequent access (cache hit)
            start_time = time.perf_counter()
            repo_cached = getattr(db, repo_name)
            end_time = time.perf_counter()
            
            cache_time = end_time - start_time
            
            # Verify same instance (cached)
            assert repo is repo_cached
            
            # Cache access should be extremely fast
            assert cache_time < 0.001, f"Cache access too slow for {repo_name}: {cache_time:.6f}s"
        
        # All repository loading should be fast
        for repo_name, load_time in loading_times.items():
            assert load_time < 0.05, f"Repository {repo_name} loading too slow: {load_time:.4f}s"
        
        avg_load_time = sum(loading_times.values()) / len(loading_times)
        print(f"Repository loading - Avg: {avg_load_time*1000:.2f}ms per repository")
    
    async def test_preloading_performance(self, mock_client):
        """Test preloading all repositories performance."""
        iterations = 10
        preload_times = []
        
        for _ in range(iterations):
            clear_cache()
            db = LazySupabaseDatabase(mock_client)
            
            start_time = time.perf_counter()
            
            # Access all repositories (triggers loading)
            repositories = [
                db.sources,
                db.documents,
                db.projects,
                db.tasks,
                db.versions,
                db.settings,
                db.prompts
            ]
            
            end_time = time.perf_counter()
            preload_times.append(end_time - start_time)
        
        avg_preload_time = sum(preload_times) / len(preload_times)
        max_preload_time = max(preload_times)
        
        # Preloading all repositories should be reasonable
        assert avg_preload_time < 0.1, f"Preloading too slow: {avg_preload_time:.4f}s"
        assert max_preload_time < 0.2, f"Max preloading too slow: {max_preload_time:.4f}s"
        
        print(f"Preloading all repositories - Avg: {avg_preload_time*1000:.2f}ms")
    
    async def test_memory_usage_efficiency(self, mock_client):
        """Test memory efficiency of lazy loading."""
        import psutil
        import os
        
        process = psutil.Process(os.getpid())
        
        # Measure memory before
        memory_before = process.memory_info().rss
        
        # Create database with lazy loading
        db = LazySupabaseDatabase(mock_client)
        
        # Measure memory after creation (should be minimal)
        memory_after_creation = process.memory_info().rss
        creation_memory = memory_after_creation - memory_before
        
        # Access half of the repositories
        _ = db.sources
        _ = db.documents
        _ = db.projects
        
        # Measure memory after partial loading
        memory_after_partial = process.memory_info().rss
        partial_memory = memory_after_partial - memory_after_creation
        
        # Access remaining repositories
        _ = db.tasks
        _ = db.versions
        _ = db.settings
        _ = db.prompts
        
        # Measure memory after full loading
        memory_after_full = process.memory_info().rss
        full_memory = memory_after_full - memory_after_partial
        
        # Memory usage should be incremental
        assert creation_memory < 1024 * 1024, "Database creation uses too much memory"  # < 1MB
        assert partial_memory > 0, "Partial loading should increase memory"
        assert full_memory > 0, "Full loading should increase memory"
        
        print(f"Memory usage - Creation: {creation_memory/1024:.1f}KB, "
              f"Partial: {partial_memory/1024:.1f}KB, Full: {full_memory/1024:.1f}KB")
    
    async def test_concurrent_repository_access(self, mock_client):
        """Test concurrent access to repositories."""
        import asyncio
        
        db = LazySupabaseDatabase(mock_client)
        
        async def access_repository(repo_name: str) -> float:
            """Access a repository and return timing."""
            start_time = time.perf_counter()
            repo = getattr(db, repo_name)
            end_time = time.perf_counter()
            return end_time - start_time
        
        # Concurrent access to different repositories
        tasks = [
            access_repository('sources'),
            access_repository('documents'),  
            access_repository('projects'),
            access_repository('tasks')
        ]
        
        start_time = time.perf_counter()
        access_times = await asyncio.gather(*tasks)
        total_time = time.perf_counter() - start_time
        
        # Concurrent access should be fast
        assert total_time < 0.1, f"Concurrent access too slow: {total_time:.4f}s"
        
        # Individual access times should be reasonable
        for i, access_time in enumerate(access_times):
            assert access_time < 0.05, f"Repository {i} access too slow: {access_time:.4f}s"
        
        print(f"Concurrent access - Total: {total_time*1000:.2f}ms, "
              f"Individual avg: {sum(access_times)/len(access_times)*1000:.2f}ms")
```

### Batch Operation Performance Tests

```python
# tests/performance/test_batch_operation_performance.py
import pytest
import time
from typing import List

from tests.fixtures.entity_fixtures import create_sample_source
from tests.test_config import TEST_CONFIG

class TestBatchOperationPerformance:
    """Performance tests for batch operations."""
    
    async def test_batch_creation_performance(self, test_database):
        """Test performance of batch creation operations."""
        db = test_database
        
        batch_sizes = [10, 50, 100, 500]
        performance_results = {}
        
        for batch_size in batch_sizes:
            # Create test data
            sources = [
                create_sample_source(url=f"https://batch-perf-{batch_size}-{i}.com")
                for i in range(batch_size)
            ]
            
            # Measure batch creation time
            start_time = time.perf_counter()
            result = await db.sources.create_batch(sources)
            end_time = time.perf_counter()
            
            batch_time = end_time - start_time
            per_item_time = batch_time / batch_size
            
            performance_results[batch_size] = {
                'total_time': batch_time,
                'per_item_time': per_item_time,
                'items_per_second': batch_size / batch_time
            }
            
            # Verify success
            assert result.success is True
            assert result.affected_count == batch_size
            
            # Performance assertions
            assert per_item_time < 0.1, f"Per-item creation too slow for batch size {batch_size}"
            
            print(f"Batch size {batch_size}: {batch_time:.3f}s total, "
                  f"{per_item_time*1000:.2f}ms per item, "
                  f"{batch_size/batch_time:.1f} items/sec")
            
            # Cleanup
            created_ids = [entity.id for entity in result.entities]
            cleanup_count = await db.sources.delete_batch(created_ids)
            assert cleanup_count == batch_size
        
        # Verify scaling characteristics
        # Larger batches should be more efficient per item
        assert (performance_results[500]['per_item_time'] < 
                performance_results[10]['per_item_time'] * 0.5)
    
    async def test_batch_update_performance(self, test_database):
        """Test performance of batch update operations."""
        db = test_database
        
        batch_size = TEST_CONFIG.batch_size_for_testing
        
        # Create test data
        sources = [
            create_sample_source(url=f"https://update-perf-{i}.com")
            for i in range(batch_size)
        ]
        
        create_result = await db.sources.create_batch(sources)
        assert create_result.success is True
        
        try:
            # Prepare updates
            updates = [
                {
                    "id": entity.id,
                    "title": f"Updated Title {i}",
                    "description": f"Updated Description {i}"
                }
                for i, entity in enumerate(create_result.entities)
            ]
            
            # Measure batch update time
            start_time = time.perf_counter()
            update_result = await db.sources.update_batch(updates)
            end_time = time.perf_counter()
            
            update_time = end_time - start_time
            per_item_time = update_time / batch_size
            
            # Verify success
            assert update_result.success is True
            assert update_result.affected_count == batch_size
            
            # Performance assertions
            assert update_time < 5.0, f"Batch update too slow: {update_time:.3f}s"
            assert per_item_time < 0.1, f"Per-item update too slow: {per_item_time:.4f}s"
            
            print(f"Batch update ({batch_size} items): {update_time:.3f}s total, "
                  f"{per_item_time*1000:.2f}ms per item")
            
        finally:
            # Cleanup
            created_ids = [entity.id for entity in create_result.entities]
            await db.sources.delete_batch(created_ids)
    
    async def test_batch_deletion_performance(self, test_database):
        """Test performance of batch deletion operations."""
        db = test_database
        
        batch_size = TEST_CONFIG.batch_size_for_testing
        
        # Create test data
        sources = [
            create_sample_source(url=f"https://delete-perf-{i}.com")
            for i in range(batch_size)
        ]
        
        create_result = await db.sources.create_batch(sources)
        assert create_result.success is True
        
        created_ids = [entity.id for entity in create_result.entities]
        
        # Measure batch deletion time
        start_time = time.perf_counter()
        deleted_count = await db.sources.delete_batch(created_ids)
        end_time = time.perf_counter()
        
        delete_time = end_time - start_time
        per_item_time = delete_time / batch_size
        
        # Verify success
        assert deleted_count == batch_size
        
        # Performance assertions
        assert delete_time < 3.0, f"Batch deletion too slow: {delete_time:.3f}s"
        assert per_item_time < 0.05, f"Per-item deletion too slow: {per_item_time:.4f}s"
        
        print(f"Batch deletion ({batch_size} items): {delete_time:.3f}s total, "
              f"{per_item_time*1000:.2f}ms per item")
    
    async def test_large_dataset_query_performance(self, test_database):
        """Test query performance with larger datasets."""
        db = test_database
        
        # Create substantial test dataset
        large_batch_size = 1000
        sources = [
            create_sample_source(
                url=f"https://large-dataset-{i}.com",
                title=f"Source {i:04d}",
                source_type=SourceType.WEBSITE if i % 2 == 0 else SourceType.DOCUMENT
            )
            for i in range(large_batch_size)
        ]
        
        # Create in smaller batches for better performance
        batch_size = 100
        created_entities = []
        
        for i in range(0, large_batch_size, batch_size):
            batch = sources[i:i + batch_size]
            result = await db.sources.create_batch(batch)
            assert result.success is True
            created_entities.extend(result.entities)
        
        try:
            # Test various query operations
            query_tests = [
                ("list_all", lambda: db.sources.list()),
                ("list_paginated", lambda: db.sources.list(
                    pagination=PaginationParams(limit=50, offset=100)
                )),
                ("list_filtered", lambda: db.sources.list(
                    filters={"source_type": SourceType.WEBSITE}
                )),
                ("count_all", lambda: db.sources.count()),
                ("count_filtered", lambda: db.sources.count(
                    filters={"source_type": SourceType.WEBSITE}
                )),
                ("count_distinct", lambda: db.sources.count(
                    distinct_field="source_type"
                ))
            ]
            
            for test_name, query_func in query_tests:
                start_time = time.perf_counter()
                result = await query_func()
                end_time = time.perf_counter()
                
                query_time = end_time - start_time
                
                # Performance assertions (adjust based on your requirements)
                assert query_time < 2.0, f"{test_name} query too slow: {query_time:.3f}s"
                
                print(f"{test_name}: {query_time:.3f}s")
        
        finally:
            # Cleanup in batches
            created_ids = [entity.id for entity in created_entities]
            for i in range(0, len(created_ids), batch_size):
                batch_ids = created_ids[i:i + batch_size]
                await db.sources.delete_batch(batch_ids)
```

## Mock Implementations

### Mock Repository Implementation

```python
# src/server/repositories/implementations/mock_repositories.py
from typing import Dict, List, Optional, Any, Union
from uuid import uuid4, UUID
from datetime import datetime, timezone
from copy import deepcopy

from ..interfaces.base_repository import (
    IBaseRepository, PaginationParams, OrderingField, SortDirection,
    OperationResult, PaginatedResult
)
from ..interfaces.knowledge_repository import ISourceRepository
from ..exceptions import EntityNotFoundError, ValidationError
from ...models.entities import Source, SourceType, CrawlStatus

class MockBaseRepository(IBaseRepository[Any]):
    """Mock implementation of base repository for testing."""
    
    def __init__(self):
        self._data: Dict[str, Any] = {}
        self._next_id = 1
    
    def _generate_id(self) -> str:
        """Generate a unique ID for testing."""
        return str(uuid4())
    
    def _add_timestamps(self, entity: Any) -> Any:
        """Add timestamps to entity."""
        now = datetime.now(timezone.utc)
        entity.created_at = getattr(entity, 'created_at', now)
        entity.updated_at = now
        return entity
    
    async def create(self, entity: Any) -> Any:
        """Create entity in mock storage."""
        if hasattr(entity, 'validate') and not entity.validate():
            errors = entity.get_validation_errors()
            raise ValidationError("Validation failed", validation_errors=errors)
        
        entity_copy = deepcopy(entity)
        entity_copy.id = self._generate_id()
        entity_copy = self._add_timestamps(entity_copy)
        
        self._data[entity_copy.id] = entity_copy
        return entity_copy
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[Any]:
        """Retrieve entity by ID from mock storage."""
        return self._data.get(str(id))
    
    async def update(
        self, 
        id: Union[str, UUID, int], 
        data: Dict[str, Any],
        *,
        validate: bool = True,
        ignore_missing: bool = False
    ) -> Optional[Any]:
        """Update entity in mock storage."""
        entity_id = str(id)
        entity = self._data.get(entity_id)
        
        if not entity:
            if ignore_missing:
                return None
            raise EntityNotFoundError("Entity", entity_id)
        
        # Apply updates
        updated_entity = deepcopy(entity)
        for key, value in data.items():
            setattr(updated_entity, key, value)
        
        updated_entity = self._add_timestamps(updated_entity)
        
        if validate and hasattr(updated_entity, 'validate'):
            if not updated_entity.validate():
                errors = updated_entity.get_validation_errors()
                raise ValidationError("Validation failed", validation_errors=errors)
        
        self._data[entity_id] = updated_entity
        return updated_entity
    
    async def delete(self, id: Union[str, UUID, int], *, soft_delete: bool = False) -> bool:
        """Delete entity from mock storage."""
        entity_id = str(id)
        
        if entity_id not in self._data:
            return False
        
        if soft_delete:
            # Soft delete - mark as deleted
            entity = self._data[entity_id]
            entity.deleted_at = datetime.now(timezone.utc)
            entity.is_deleted = True
        else:
            # Hard delete - remove from storage
            del self._data[entity_id]
        
        return True
    
    async def list(
        self, 
        *,
        filters: Optional[Dict[str, Any]] = None,
        pagination: Optional[PaginationParams] = None,
        ordering: Optional[List[OrderingField]] = None,
        return_total_count: bool = False
    ) -> Union[List[Any], PaginatedResult[Any]]:
        """List entities from mock storage."""
        # Get all entities
        entities = list(self._data.values())
        
        # Apply filters
        if filters:
            filtered_entities = []
            for entity in entities:
                matches = True
                for field, value in filters.items():
                    if not hasattr(entity, field) or getattr(entity, field) != value:
                        matches = False
                        break
                if matches:
                    filtered_entities.append(entity)
            entities = filtered_entities
        
        # Apply ordering
        if ordering:
            for order_field in reversed(ordering):  # Apply in reverse order
                field_name = order_field['field']
                reverse = order_field['direction'] in [SortDirection.DESC, SortDirection.DESCENDING]
                entities.sort(
                    key=lambda x: getattr(x, field_name, None) or '',
                    reverse=reverse
                )
        
        total_count = len(entities)
        
        # Apply pagination
        if pagination:
            offset = pagination.get('offset', 0)
            limit = pagination.get('limit')
            
            if limit:
                entities = entities[offset:offset + limit]
            else:
                entities = entities[offset:]
        
        if return_total_count:
            return PaginatedResult[Any](
                entities=entities,
                total_count=total_count,
                page_size=pagination.get('limit', len(entities)) if pagination else len(entities),
                current_offset=pagination.get('offset', 0) if pagination else 0,
                has_more=len(entities) + (pagination.get('offset', 0) if pagination else 0) < total_count
            )
        else:
            return entities
    
    async def count(
        self, 
        filters: Optional[Dict[str, Any]] = None,
        *,
        distinct_field: Optional[str] = None
    ) -> int:
        """Count entities in mock storage."""
        entities = list(self._data.values())
        
        # Apply filters
        if filters:
            filtered_entities = []
            for entity in entities:
                matches = True
                for field, value in filters.items():
                    if not hasattr(entity, field) or getattr(entity, field) != value:
                        matches = False
                        break
                if matches:
                    filtered_entities.append(entity)
            entities = filtered_entities
        
        if distinct_field:
            # Count distinct values
            values = set()
            for entity in entities:
                if hasattr(entity, distinct_field):
                    values.add(getattr(entity, distinct_field))
            return len(values)
        else:
            return len(entities)
    
    async def exists(
        self, 
        id: Union[str, UUID, int],
        *,
        additional_filters: Optional[Dict[str, Any]] = None
    ) -> bool:
        """Check if entity exists in mock storage."""
        entity = self._data.get(str(id))
        if not entity:
            return False
        
        if additional_filters:
            for field, value in additional_filters.items():
                if not hasattr(entity, field) or getattr(entity, field) != value:
                    return False
        
        return True
    
    async def create_batch(
        self, 
        entities: List[Any],
        *,
        batch_size: int = 100,
        validate_all: bool = True,
        stop_on_first_error: bool = False
    ) -> OperationResult[Any]:
        """Create multiple entities in mock storage."""
        if validate_all:
            # Validate all first
            for i, entity in enumerate(entities):
                if hasattr(entity, 'validate') and not entity.validate():
                    errors = entity.get_validation_errors()
                    return OperationResult[Any](
                        success=False,
                        error=f"Validation failed for entity {i}",
                        metadata={'validation_errors': errors}
                    )
        
        created_entities = []
        failed_items = []
        
        for i, entity in enumerate(entities):
            try:
                created = await self.create(entity)
                created_entities.append(created)
            except Exception as e:
                failed_items.append({
                    'index': i,
                    'error': str(e),
                    'entity': entity
                })
                
                if stop_on_first_error:
                    break
        
        return OperationResult[Any](
            success=len(failed_items) == 0,
            entities=created_entities,
            affected_count=len(created_entities),
            error=f"{len(failed_items)} entities failed" if failed_items else None,
            metadata={'failed_items': failed_items}
        )
    
    async def update_batch(
        self, 
        updates: List[Dict[str, Any]],
        *,
        batch_size: int = 100,
        validate_updates: bool = True
    ) -> OperationResult[Any]:
        """Update multiple entities in mock storage."""
        updated_entities = []
        failed_items = []
        
        for i, update_data in enumerate(updates):
            try:
                if 'id' not in update_data:
                    raise ValidationError("Update data must contain 'id' field")
                
                entity_id = update_data['id']
                data_without_id = {k: v for k, v in update_data.items() if k != 'id'}
                
                updated = await self.update(
                    entity_id, 
                    data_without_id,
                    validate=validate_updates
                )
                
                if updated:
                    updated_entities.append(updated)
                    
            except Exception as e:
                failed_items.append({
                    'index': i,
                    'error': str(e),
                    'update_data': update_data
                })
        
        return OperationResult[Any](
            success=len(failed_items) == 0,
            entities=updated_entities,
            affected_count=len(updated_entities),
            error=f"{len(failed_items)} updates failed" if failed_items else None,
            metadata={'failed_items': failed_items}
        )
    
    async def delete_batch(
        self, 
        ids: List[Union[str, UUID, int]],
        *,
        batch_size: int = 100,
        soft_delete: bool = False
    ) -> int:
        """Delete multiple entities from mock storage."""
        deleted_count = 0
        
        for entity_id in ids:
            if await self.delete(entity_id, soft_delete=soft_delete):
                deleted_count += 1
        
        return deleted_count

class MockSourceRepository(MockBaseRepository, ISourceRepository):
    """Mock implementation of source repository."""
    
    async def get_by_url(self, url: str) -> Optional[Source]:
        """Get source by URL."""
        for source in self._data.values():
            if source.url == url:
                return source
        return None
    
    async def get_sources_by_type(self, source_type: SourceType) -> List[Source]:
        """Get sources by type."""
        return [
            source for source in self._data.values()
            if source.source_type == source_type
        ]
    
    async def update_crawl_status(
        self, 
        source_id: str, 
        status: CrawlStatus,
        *,
        error_message: Optional[str] = None,
        pages_crawled: Optional[int] = None,
        last_crawled: Optional[datetime] = None
    ) -> Source:
        """Update crawl status."""
        update_data = {'crawl_status': status}
        
        if error_message is not None:
            update_data['error_message'] = error_message
        if pages_crawled is not None:
            update_data['pages_crawled'] = pages_crawled
        if last_crawled is not None:
            update_data['last_crawled'] = last_crawled
        
        updated = await self.update(source_id, update_data)
        if not updated:
            raise EntityNotFoundError("Source", source_id)
        
        return updated
    
    async def get_sources_for_crawling(
        self, 
        statuses: List[CrawlStatus],
        limit: Optional[int] = None
    ) -> List[Source]:
        """Get sources that need crawling."""
        sources = [
            source for source in self._data.values()
            if source.crawl_status in statuses
        ]
        
        if limit:
            sources = sources[:limit]
        
        return sources
```

### Advanced Testing Utilities

```python
# tests/fixtures/entity_fixtures.py
from typing import List, Optional
from datetime import datetime, timezone
from uuid import uuid4

from src.server.models.entities import (
    Source, SourceType, CrawlStatus,
    Project, ProjectStatus,
    Task, TaskStatus, TaskPriority
)

def create_sample_source(
    url: Optional[str] = None,
    title: Optional[str] = None,
    source_type: SourceType = SourceType.WEBSITE,
    crawl_status: CrawlStatus = CrawlStatus.PENDING
) -> Source:
    """Create a sample source for testing."""
    return Source(
        id=None,  # Will be assigned by repository
        url=url or f"https://example-{uuid4().hex[:8]}.com",
        title=title or "Sample Source",
        description="A sample source for testing",
        source_type=source_type,
        crawl_status=crawl_status,
        pages_crawled=0,
        created_at=None,  # Will be assigned by repository
        updated_at=None,
        last_crawled=None,
        error_message=None,
        metadata={}
    )

def create_sample_project(
    title: Optional[str] = None,
    github_repo: Optional[str] = None,
    status: ProjectStatus = ProjectStatus.ACTIVE
) -> Project:
    """Create a sample project for testing."""
    return Project(
        id=None,
        title=title or f"Test Project {uuid4().hex[:8]}",
        description="A sample project for testing",
        github_repo=github_repo or f"https://github.com/test/project-{uuid4().hex[:8]}",
        status=status,
        created_at=None,
        updated_at=None,
        settings={},
        metadata={}
    )

def create_sample_task(
    project_id: str,
    title: Optional[str] = None,
    status: TaskStatus = TaskStatus.TODO,
    priority: TaskPriority = TaskPriority.MEDIUM
) -> Task:
    """Create a sample task for testing."""
    return Task(
        id=None,
        project_id=project_id,
        title=title or f"Test Task {uuid4().hex[:8]}",
        description="A sample task for testing",
        status=status,
        priority=priority,
        assignee=None,
        created_at=None,
        updated_at=None,
        due_date=None,
        completed_at=None,
        metadata={}
    )

def create_sample_entities():
    """Create a collection of sample entities for testing."""
    return {
        'sources': [create_sample_source() for _ in range(5)],
        'projects': [create_sample_project() for _ in range(3)],
        'tasks': [create_sample_task('test-project-id') for _ in range(10)]
    }

# Fixture helpers for specific test scenarios
def create_large_dataset(entity_type: str, count: int) -> List[Any]:
    """Create large dataset for performance testing."""
    if entity_type == 'sources':
        return [
            create_sample_source(
                url=f"https://perf-test-{i}.com",
                title=f"Performance Test Source {i}"
            )
            for i in range(count)
        ]
    elif entity_type == 'projects':
        return [
            create_sample_project(
                title=f"Performance Test Project {i}",
                github_repo=f"https://github.com/test/perf-{i}"
            )
            for i in range(count)
        ]
    else:
        raise ValueError(f"Unknown entity type: {entity_type}")

def create_invalid_entities():
    """Create entities with validation errors for testing."""
    return {
        'source_no_url': Source(
            id=None,
            url=None,  # Invalid - required field
            title="Invalid Source",
            source_type=SourceType.WEBSITE,
            crawl_status=CrawlStatus.PENDING
        ),
        'source_bad_url': Source(
            id=None,
            url="not-a-valid-url",  # Invalid URL format
            title="Bad URL Source",
            source_type=SourceType.WEBSITE,
            crawl_status=CrawlStatus.PENDING
        ),
        'project_empty_title': Project(
            id=None,
            title="",  # Invalid - empty title
            description="Project with empty title",
            status=ProjectStatus.ACTIVE
        )
    }
```

This comprehensive testing guide provides a complete framework for testing the repository pattern implementation, covering unit tests, integration tests, performance tests, and mock implementations. The tests ensure code quality, performance, and reliability while providing clear patterns for ongoing development.