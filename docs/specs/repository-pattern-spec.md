# Repository Pattern Implementation Specification
## Abstracting Supabase Dependency in Archon Server

**Version**: 1.0.0  
**Date**: 2025-08-19  
**Status**: Draft  
**Author**: System Architect

---

## Executive Summary

This specification defines the implementation of the Repository Pattern to abstract all Supabase database operations in the Archon Server project. The goal is to decouple business logic from the persistence layer, enabling easier testing, maintenance, and potential database migrations while maintaining the current functionality.

## Current State Analysis

### Architecture Overview
- **Database**: Supabase (PostgreSQL + pgvector)
- **Connection Management**: Centralized through `client_manager.py`
- **Service Pattern**: All services inherit from `BaseStorageService`
- **Direct Dependencies**: 27+ service files directly import Supabase client

### Key Challenges
1. **Tight Coupling**: Services directly depend on Supabase client implementation
2. **Testing Complexity**: Difficult to unit test without actual database
3. **Migration Risk**: Changing database provider requires extensive refactoring
4. **Code Duplication**: Similar database operations scattered across services

## Proposed Architecture

### Design Principles
1. **Single Responsibility**: Each repository handles one aggregate root
2. **Interface Segregation**: Define minimal, focused interfaces
3. **Dependency Inversion**: Services depend on abstractions, not implementations
4. **Domain-Driven Design**: Repositories align with business domains

### Architecture Layers

```text
┌─────────────────────────────────────┐
│         API Routes Layer            │
├─────────────────────────────────────┤
│         Service Layer               │
│   (Business Logic & Orchestration)  │
├─────────────────────────────────────┤
│      Repository Interface Layer     │
│        (Abstract Contracts)         │
├─────────────────────────────────────┤
│    Repository Implementation Layer  │
│      (SupabaseDatabase Class)       │
├─────────────────────────────────────┤
│         Supabase Client             │
│      (External Dependency)          │
└─────────────────────────────────────┘
```

## Detailed Design

### 1. Core Abstractions

#### 1.1 Base Repository Interface
```python
# python/src/server/repositories/interfaces/base_repository.py
from abc import ABC, abstractmethod
from typing import Generic, TypeVar, Optional, List, Dict, Any

T = TypeVar('T')

class IBaseRepository(ABC, Generic[T]):
    """Base repository interface defining common database operations."""
    
    @abstractmethod
    async def create(self, entity: T) -> T:
        """Create a new entity."""
        pass
    
    @abstractmethod
    async def get_by_id(self, id: Any) -> Optional[T]:
        """Retrieve entity by ID."""
        pass
    
    @abstractmethod
    async def update(self, id: Any, data: Dict[str, Any]) -> Optional[T]:
        """Update entity by ID."""
        pass
    
    @abstractmethod
    async def delete(self, id: Any) -> bool:
        """Delete entity by ID."""
        pass
    
    @abstractmethod
    async def list(self, filters: Optional[Dict[str, Any]] = None, 
                   limit: Optional[int] = None, 
                   offset: Optional[int] = None) -> List[T]:
        """List entities with optional filtering and pagination."""
        pass
```

#### 1.2 Unit of Work Pattern
```python
# python/src/server/repositories/interfaces/unit_of_work.py
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager

class IUnitOfWork(ABC):
    """Unit of Work pattern for transaction management."""
    
    @abstractmethod
    @asynccontextmanager
    async def transaction(self):
        """Context manager for database transactions."""
        pass
    
    @abstractmethod
    async def commit(self):
        """Commit the current transaction."""
        pass
    
    @abstractmethod
    async def rollback(self):
        """Rollback the current transaction."""
        pass
```

### 2. Domain-Specific Repositories

#### 2.1 Knowledge Base Repositories
```python
# python/src/server/repositories/interfaces/knowledge_repository.py
class ISourceRepository(IBaseRepository[Source]):
    """Repository for archon_sources table."""
    
    @abstractmethod
    async def get_by_source_id(self, source_id: str) -> Optional[Source]:
        pass
    
    @abstractmethod
    async def update_metadata(self, source_id: str, metadata: Dict) -> bool:
        pass

class IDocumentRepository(IBaseRepository[Document]):
    """Repository for archon_crawled_pages table."""
    
    @abstractmethod
    async def create_batch(self, documents: List[Document]) -> List[Document]:
        pass
    
    @abstractmethod
    async def vector_search(self, embedding: List[float], 
                          limit: int = 10,
                          source_filter: Optional[str] = None) -> List[Document]:
        pass
    
    @abstractmethod
    async def hybrid_search(self, query: str, 
                          embedding: List[float],
                          limit: int = 10) -> List[Document]:
        pass

class ICodeExampleRepository(IBaseRepository[CodeExample]):
    """Repository for archon_code_examples table."""
    
    @abstractmethod
    async def search_by_summary(self, query: str, limit: int = 5) -> List[CodeExample]:
        pass
```

#### 2.2 Project Management Repositories
```python
# python/src/server/repositories/interfaces/project_repository.py
class IProjectRepository(IBaseRepository[Project]):
    """Repository for archon_projects table."""
    
    @abstractmethod
    async def get_with_tasks(self, project_id: UUID) -> Optional[ProjectWithTasks]:
        pass
    
    @abstractmethod
    async def update_jsonb_field(self, project_id: UUID, 
                                field: str, 
                                value: Dict) -> bool:
        pass
    
    @abstractmethod
    async def get_pinned(self) -> List[Project]:
        pass

class ITaskRepository(IBaseRepository[Task]):
    """Repository for archon_tasks table."""
    
    @abstractmethod
    async def get_by_status(self, project_id: UUID, 
                           status: TaskStatus) -> List[Task]:
        pass
    
    @abstractmethod
    async def update_status(self, task_id: UUID, 
                          status: TaskStatus) -> Optional[Task]:
        pass
    
    @abstractmethod
    async def archive(self, task_id: UUID) -> bool:
        pass

class IVersionRepository(IBaseRepository[DocumentVersion]):
    """Repository for archon_document_versions table."""
    
    @abstractmethod
    async def create_snapshot(self, project_id: UUID, 
                            field_name: str,
                            content: Dict,
                            change_summary: str) -> DocumentVersion:
        pass
    
    @abstractmethod
    async def get_version_history(self, project_id: UUID, 
                                field_name: str) -> List[DocumentVersion]:
        pass
    
    @abstractmethod
    async def restore_version(self, version_id: UUID) -> bool:
        pass
```

#### 2.3 Configuration Repository
```python
# python/src/server/repositories/interfaces/settings_repository.py
class ISettingsRepository(IBaseRepository[Setting]):
    """Repository for archon_settings table."""
    
    @abstractmethod
    async def get_by_category(self, category: str) -> List[Setting]:
        pass
    
    @abstractmethod
    async def upsert(self, key: str, value: str, 
                    encrypted: bool = False) -> Setting:
        pass
    
    @abstractmethod
    async def get_decrypted(self, key: str) -> Optional[str]:
        pass
```

### 3. Concrete Implementation

#### 3.1 SupabaseDatabase Class
```python
# python/src/server/repositories/implementations/supabase_database.py
from supabase import Client
from typing import Optional
import logging

class SupabaseDatabase:
    """
    Concrete implementation of all repository interfaces using Supabase.
    Single point of contact for all database operations.
    """
    
    def __init__(self, client: Optional[Client] = None):
        self._client = client or self._get_default_client()
        self._logger = logging.getLogger(__name__)
        
        # Initialize repository implementations
        self.sources = SupabaseSourceRepository(self._client)
        self.documents = SupabaseDocumentRepository(self._client)
        self.code_examples = SupabaseCodeExampleRepository(self._client)
        self.projects = SupabaseProjectRepository(self._client)
        self.tasks = SupabaseTaskRepository(self._client)
        self.versions = SupabaseVersionRepository(self._client)
        self.settings = SupabaseSettingsRepository(self._client)
        self.prompts = SupabasePromptRepository(self._client)
    
    @staticmethod
    def _get_default_client() -> Client:
        """Get default Supabase client from environment."""
        from src.server.services.client_manager import get_supabase_client
        return get_supabase_client()
    
    async def transaction(self):
        """Provide transaction context for atomic operations."""
        # Implement transaction handling
        pass
    
    async def health_check(self) -> bool:
        """Verify database connectivity."""
        try:
            response = await self._client.table('archon_settings').select('key').limit(1).execute()
            return True
        except Exception as e:
            self._logger.error(f"Database health check failed: {e}")
            return False
```

#### 3.2 Repository Implementation Example
```python
# python/src/server/repositories/implementations/supabase_repositories.py
class SupabaseDocumentRepository(IDocumentRepository):
    """Supabase implementation of document repository."""
    
    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_crawled_pages'
    
    async def create(self, entity: Document) -> Document:
        response = self._client.table(self._table)\
            .insert(entity.dict())\
            .execute()
        return Document(**response.data[0])
    
    async def create_batch(self, documents: List[Document]) -> List[Document]:
        data = [doc.dict() for doc in documents]
        response = self._client.table(self._table)\
            .insert(data)\
            .execute()
        return [Document(**item) for item in response.data]
    
    async def vector_search(self, embedding: List[float], 
                          limit: int = 10,
                          source_filter: Optional[str] = None) -> List[Document]:
        # Call Supabase RPC function for vector search
        params = {
            'query_embedding': embedding,
            'match_count': limit
        }
        if source_filter:
            params['source_filter'] = source_filter
            
        response = self._client.rpc('match_archon_crawled_pages', params).execute()
        return [Document(**item) for item in response.data]
```

### 4. Service Layer Refactoring

#### 4.1 Before (Current Implementation)
```python
# Current tight coupling to Supabase
class DocumentStorageService:
    def __init__(self, supabase_client=None):
        self.supabase = supabase_client or get_supabase_client()
    
    async def store_documents(self, documents):
        # Direct Supabase operations
        response = self.supabase.table('archon_crawled_pages').insert(documents).execute()
```

#### 4.2 After (Repository Pattern)
```python
# Refactored with repository pattern
class DocumentStorageService:
    def __init__(self, database: Optional[SupabaseDatabase] = None):
        self.db = database or SupabaseDatabase()
    
    async def store_documents(self, documents: List[Document]):
        # Use repository abstraction
        return await self.db.documents.create_batch(documents)
```

### 5. Dependency Injection

#### 5.1 Application Factory
```python
# python/src/server/core/dependencies.py
from functools import lru_cache
from typing import Optional

class DatabaseProvider:
    """Singleton provider for database instance."""
    
    _instance: Optional[SupabaseDatabase] = None
    
    @classmethod
    def get_database(cls) -> SupabaseDatabase:
        if cls._instance is None:
            cls._instance = SupabaseDatabase()
        return cls._instance
    
    @classmethod
    def set_database(cls, database: SupabaseDatabase):
        """Allow injection for testing."""
        cls._instance = database

@lru_cache()
def get_database() -> SupabaseDatabase:
    """FastAPI dependency for database injection."""
    return DatabaseProvider.get_database()
```

#### 5.2 FastAPI Integration
```python
# python/src/server/api_routes/knowledge_routes.py
from fastapi import APIRouter, Depends
from src.server.core.dependencies import get_database

router = APIRouter()

@router.post("/crawl")
async def crawl_website(
    request: CrawlRequest,
    db: SupabaseDatabase = Depends(get_database)
):
    service = CrawlService(database=db)
    return await service.crawl(request.url)
```

## Implementation Plan

### Phase 1: Foundation (Week 1)
1. **Create repository interfaces**
   - Define base repository interface
   - Create domain-specific repository interfaces
   - Define data models/entities

2. **Implement SupabaseDatabase class**
   - Create concrete repository implementations
   - Implement transaction support
   - Add connection management

3. **Setup dependency injection**
   - Create database provider
   - Configure FastAPI dependencies
   - Add configuration management

### Phase 2: Core Services Migration (Week 2)
1. **Migrate Knowledge Base services**
   - DocumentStorageService
   - RAGService
   - SearchService
   - SourceManagementService

2. **Migrate Project Management services**
   - ProjectService
   - TaskService
   - VersioningService
   - DocumentService

3. **Migrate Configuration services**
   - CredentialService
   - SettingsService
   - PromptService

### Phase 3: API Routes Update (Week 3)
1. **Update all API route handlers**
   - Inject database dependency
   - Remove direct Supabase imports
   - Update error handling

2. **Update MCP server modules**
   - ProjectModule
   - RAGModule
   - Update HTTP client calls

3. **Update Agent services**
   - DocumentAgent
   - RAGAgent
   - Remove Supabase dependencies

### Phase 4: Testing & Validation (Week 4)
1. **Create test infrastructure**
   - Mock repository implementations
   - Test database provider
   - Integration test setup

2. **Write comprehensive tests**
   - Unit tests for repositories
   - Service layer tests
   - API integration tests

3. **Performance validation**
   - Benchmark query performance
   - Connection pooling verification
   - Load testing

## Migration Strategy

### Step-by-Step Migration Process

1. **Parallel Implementation**
   - Build new repository layer alongside existing code
   - No breaking changes during development
   - Maintain backward compatibility

2. **Service-by-Service Migration**
   - Start with least critical services
   - Migrate one service at a time
   - Verify functionality after each migration

3. **Gradual Rollout**
   - Use feature flags for new implementation
   - A/B test repository vs direct access
   - Monitor performance metrics

4. **Cleanup Phase**
   - Remove old direct Supabase imports
   - Delete deprecated code
   - Update documentation

## Testing Strategy

### 1. Unit Testing
```python
# tests/repositories/test_document_repository.py
class MockDocumentRepository(IDocumentRepository):
    def __init__(self):
        self.documents = []
    
    async def create_batch(self, documents: List[Document]):
        self.documents.extend(documents)
        return documents

async def test_document_storage_service():
    mock_db = Mock(spec=SupabaseDatabase)
    mock_db.documents = MockDocumentRepository()
    
    service = DocumentStorageService(database=mock_db)
    result = await service.store_documents([...])
    
    assert len(result) == expected_count
```

### 2. Integration Testing
```python
# tests/integration/test_supabase_repositories.py
@pytest.mark.integration
async def test_vector_search():
    db = SupabaseDatabase()
    
    # Create test documents
    test_docs = [...]
    await db.documents.create_batch(test_docs)
    
    # Perform vector search
    results = await db.documents.vector_search(
        embedding=[...],
        limit=5
    )
    
    assert len(results) <= 5
```

### 3. Performance Testing
- Query execution time benchmarks
- Connection pool utilization
- Concurrent request handling
- Memory usage profiling

## Benefits & Impact

### Immediate Benefits
1. **Testability**: Easy unit testing with mock repositories
2. **Maintainability**: Clear separation of concerns
3. **Flexibility**: Easier to modify database queries
4. **Documentation**: Self-documenting interfaces

### Long-term Benefits
1. **Database Agnostic**: Can switch databases without service changes
2. **Performance Optimization**: Centralized query optimization
3. **Caching Layer**: Easy to add caching at repository level
4. **Audit & Logging**: Centralized database operation logging

### Risk Mitigation
1. **Performance Risk**: Benchmark all operations
2. **Data Integrity**: Comprehensive transaction testing
3. **Backward Compatibility**: Parallel implementation approach
4. **Rollback Plan**: Feature flags for quick rollback

## Success Criteria

### Functional Requirements
- ✅ All existing functionality maintained
- ✅ No performance degradation
- ✅ All tests passing
- ✅ Zero data loss during migration

### Non-Functional Requirements
- ✅ 90% code coverage for repositories
- ✅ Query performance within 5% of current
- ✅ Memory usage stable
- ✅ Connection pool efficiency maintained

### Acceptance Criteria
1. All 27+ services migrated to repository pattern
2. No direct Supabase imports in service layer
3. Complete test suite with >90% coverage
4. Performance benchmarks meet targets
5. Documentation updated

## Task Breakdown

### High Priority Tasks (Must Have)
1. **Create base repository interfaces** (4 hours)
2. **Implement SupabaseDatabase class** (8 hours)
3. **Migrate DocumentStorageService** (4 hours)
4. **Migrate RAGService** (4 hours)
5. **Migrate ProjectService** (4 hours)
6. **Update knowledge API routes** (2 hours)
7. **Create unit tests for repositories** (6 hours)

### Medium Priority Tasks (Should Have)
8. **Migrate remaining storage services** (8 hours)
9. **Implement transaction support** (4 hours)
10. **Update MCP server modules** (4 hours)
11. **Create integration tests** (6 hours)
12. **Performance benchmarking** (4 hours)

### Low Priority Tasks (Nice to Have)
13. **Add caching layer** (4 hours)
14. **Implement query optimization** (4 hours)
15. **Add comprehensive logging** (2 hours)
16. **Create migration documentation** (2 hours)

## Technical Decisions

### Design Choices
1. **Repository per Aggregate**: Each major entity gets its own repository
2. **Async by Default**: All repository methods are async
3. **Generic Base**: Use Python generics for type safety
4. **JSONB Support**: Native support for Supabase JSONB operations

### Technology Stack
- **Python 3.12**: Latest Python features
- **Pydantic V2**: For data validation
- **AsyncIO**: For async operations
- **Supabase Python Client**: Current implementation
- **Pytest**: For testing framework

### Code Organization
```text
python/src/server/
├── repositories/
│   ├── interfaces/
│   │   ├── __init__.py
│   │   ├── base_repository.py
│   │   ├── knowledge_repository.py
│   │   ├── project_repository.py
│   │   └── settings_repository.py
│   ├── implementations/
│   │   ├── __init__.py
│   │   ├── supabase_database.py
│   │   ├── supabase_repositories.py
│   │   └── mock_repositories.py
│   └── __init__.py
├── core/
│   ├── dependencies.py
│   └── exceptions.py
└── services/
    └── (refactored services)
```

## Conclusion

This specification provides a comprehensive plan for implementing the Repository Pattern in Archon Server. The approach minimizes risk through parallel implementation while providing significant benefits in testability, maintainability, and future flexibility. The phased migration strategy ensures continuous operation while systematically improving the codebase architecture.

---

**Next Steps**:
1. Review and approve specification
2. Create project tasks in Archon
3. Begin Phase 1 implementation
4. Set up testing infrastructure
5. Start service migration