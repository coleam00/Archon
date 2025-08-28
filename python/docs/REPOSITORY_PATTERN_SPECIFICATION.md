# Repository Pattern Architecture Specification

## Executive Summary

The Archon project implements a comprehensive Repository Pattern with advanced features including lazy loading, type safety, dependency injection, and transaction management. This specification documents the architecture design, implementation patterns, and usage guidelines for the repository system.

## Architecture Overview

### Core Components

```mermaid
graph TB
    A[Application Layer] --> B[Unit of Work]
    B --> C[Repository Interfaces]
    C --> D[Repository Implementations]
    D --> E[Database Layer]
    
    F[Dependency Container] --> B
    F --> C
    G[Lazy Loading System] --> D
    H[Transaction Manager] --> B
    I[Type Safety System] --> C
```

### Component Responsibilities

1. **Repository Interfaces** (`interfaces/`): Define contracts for data access
2. **Repository Implementations** (`implementations/`): Concrete database implementations
3. **Unit of Work** (`unit_of_work.py`): Transaction and consistency management
4. **Dependency Container** (`dependency_injection.py`): Service registration and resolution
5. **Lazy Loading System** (`lazy_imports.py`): Performance optimization and import management
6. **Configuration System** (`database_config.py`): Environment-specific configuration

## Design Principles

### 1. Interface Segregation

Each domain has its own repository interface to avoid coupling:

```python
# Knowledge domain repositories
from .interfaces.knowledge_repository import (
    ISourceRepository,
    IDocumentRepository, 
    ICodeExampleRepository
)

# Project domain repositories
from .interfaces.project_repository import (
    IProjectRepository,
    ITaskRepository,
    IVersionRepository
)

# Settings domain repositories
from .interfaces.settings_repository import (
    ISettingsRepository,
    IPromptRepository
)
```

### 2. Type Safety

All repositories use Generic types for entity safety:

```python
class IBaseRepository(ABC, Generic[EntityType]):
    async def create(self, entity: EntityType) -> EntityType:
        """Create with full type safety"""
        pass
    
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[EntityType]:
        """Retrieve with optional return type"""
        pass
```

### 3. Lazy Loading

Repository implementations are loaded only when accessed:

```python
class LazySupabaseDatabase(IUnitOfWork):
    @property
    def sources(self) -> ISourceRepository:
        """Repository loaded on first access"""
        return self._get_repository('sources', 'ISourceRepository')
```

### 4. Transaction Management

Unit of Work ensures consistency across operations:

```python
async with database.transaction() as uow:
    user = await uow.users.create(user_data)
    await uow.audit_logs.create(audit_entry)
    # Both operations commit together or rollback if either fails
```

## Repository Interface Specifications

### Base Repository Interface

All repositories inherit from `IBaseRepository[EntityType]`:

```python
class IBaseRepository(ABC, Generic[EntityType]):
    # Core CRUD operations
    async def create(self, entity: EntityType) -> EntityType
    async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[EntityType]
    async def update(self, id: Union[str, UUID, int], data: Dict[str, Any]) -> Optional[EntityType]
    async def delete(self, id: Union[str, UUID, int], *, soft_delete: bool = False) -> bool
    
    # Query operations
    async def list(self, *, filters: Optional[Dict[str, Any]] = None, 
                   pagination: Optional[PaginationParams] = None) -> List[EntityType]
    async def count(self, filters: Optional[Dict[str, Any]] = None) -> int
    async def exists(self, id: Union[str, UUID, int]) -> bool
    
    # Batch operations
    async def create_batch(self, entities: Sequence[EntityType]) -> OperationResult[EntityType]
    async def update_batch(self, updates: Sequence[Dict[str, Any]]) -> OperationResult[EntityType]
    async def delete_batch(self, ids: Sequence[Union[str, UUID, int]]) -> int
```

### Type Definitions

The system uses comprehensive type definitions for safety:

```python
# Pagination parameters
class PaginationParams(TypedDict):
    limit: NotRequired[int]  # 1-10000
    offset: NotRequired[int]  # >= 0

# Filter operators
class FilterOperator(str, Enum):
    EQ = "eq"           # Equal
    NE = "ne"           # Not equal
    GT = "gt"           # Greater than
    LIKE = "like"       # Pattern matching
    IN = "in"           # Value in list
    IS_NULL = "is_null" # Field is null

# Ordering specification
class OrderingField(TypedDict):
    field: str
    direction: SortDirection  # ASC, DESC
    nulls_first: NotRequired[bool]

# Operation results
class OperationResult(TypedDict, Generic[EntityType]):
    success: bool
    entities: NotRequired[List[EntityType]]
    affected_count: NotRequired[int]
    error: NotRequired[str]
```

## Domain-Specific Repository Interfaces

### Knowledge Domain

```python
class ISourceRepository(IBaseRepository[Source]):
    """Repository for managing knowledge sources (websites, documents)"""
    async def get_by_url(self, url: str) -> Optional[Source]
    async def get_sources_by_type(self, source_type: SourceType) -> List[Source]
    async def update_crawl_status(self, source_id: str, status: CrawlStatus) -> Source

class IDocumentRepository(IBaseRepository[Document]):
    """Repository for managing document chunks with embeddings"""
    async def search_by_embedding(self, embedding: List[float], limit: int = 10) -> List[Document]
    async def get_by_source_id(self, source_id: str) -> List[Document]
    async def bulk_insert_with_embeddings(self, documents: List[Document]) -> OperationResult[Document]

class ICodeExampleRepository(IBaseRepository[CodeExample]):
    """Repository for extracted code examples"""
    async def search_by_language(self, language: str) -> List[CodeExample]
    async def get_by_tags(self, tags: List[str]) -> List[CodeExample]
```

### Project Domain

```python
class IProjectRepository(IBaseRepository[Project]):
    """Repository for project management"""
    async def get_with_tasks(self, project_id: str) -> Optional[ProjectWithTasks]
    async def get_by_github_repo(self, repo_url: str) -> Optional[Project]
    async def update_status(self, project_id: str, status: ProjectStatus) -> Project

class ITaskRepository(IBaseRepository[Task]):
    """Repository for task management"""
    async def get_by_project_id(self, project_id: str) -> List[Task]
    async def get_by_status(self, status: TaskStatus) -> List[Task]
    async def update_status(self, task_id: str, status: TaskStatus) -> Task
    async def get_tasks_by_priority(self, project_id: str) -> List[Task]

class IVersionRepository(IBaseRepository[Version]):
    """Repository for version control"""
    async def get_versions_by_document(self, document_id: str) -> List[Version]
    async def create_version_snapshot(self, entity_id: str, content: Dict[str, Any]) -> Version
    async def restore_version(self, version_id: str) -> Dict[str, Any]
```

## Lazy Loading Implementation

### Performance Benefits

- **Startup Time**: Reduced from ~520ms to ~9ms (98% improvement)
- **Memory Usage**: Only loaded repositories consume memory
- **Import Safety**: Prevents circular dependency issues
- **Error Isolation**: Import errors only affect specific repositories

### Implementation Details

```python
class LazyRepositoryLoader:
    """Thread-safe lazy loading with caching"""
    
    def __init__(self):
        self._cache: Dict[str, Any] = {}
        self._registry: Dict[str, RepositoryMetadata] = {}
        self._lock = threading.RLock()
    
    def get_repository_class(self, interface_name: str) -> type:
        """Load repository class with caching"""
        with self._lock:
            if interface_name in self._cache:
                return self._cache[interface_name]
            
            metadata = self._registry.get(interface_name)
            if not metadata:
                raise LazyImportError(f"Repository {interface_name} not registered")
            
            # Dynamic import with error handling
            module = importlib.import_module(metadata.module_path)
            cls = getattr(module, metadata.class_name)
            
            self._cache[interface_name] = cls
            return cls
```

### Repository Registration

```python
# Repository registry with metadata
REPOSITORY_REGISTRY = {
    'ISourceRepository': RepositoryMetadata(
        interface_name='ISourceRepository',
        implementation_name='SupabaseSourceRepository',
        module_path='src.server.repositories.implementations.supabase_repositories',
        class_name='SupabaseSourceRepository',
        dependencies=['supabase_client'],
        description='Supabase implementation for source management'
    ),
    # Additional repositories...
}
```

## Dependency Injection System

### Container Configuration

```python
class DependencyContainer:
    """Type-safe dependency injection with lifecycle management"""
    
    def register(self, 
                interface_type: Type[T], 
                implementation_name: str,
                lifecycle: DependencyLifecycle = DependencyLifecycle.SINGLETON):
        """Register dependency with lifecycle management"""
        
    def resolve(self, interface_type: Type[T]) -> T:
        """Resolve dependency with type safety"""
        
    def health_check(self) -> Dict[str, Any]:
        """Verify all dependencies are healthy"""
```

### Lifecycle Management

```python
class DependencyLifecycle(Enum):
    SINGLETON = "singleton"    # Single instance, cached
    SCOPED = "scoped"         # Per-request instance
    TRANSIENT = "transient"   # New instance each time
```

## Database Configuration System

### Environment-Specific Configuration

```python
@dataclass
class DatabaseConfig:
    database_type: DatabaseType
    environment: Environment
    connection: ConnectionConfig
    security: SecurityConfig
    performance: PerformanceConfig
    monitoring: MonitoringConfig
    features: FeatureConfig

class Environment(Enum):
    DEVELOPMENT = "development"  # Relaxed validation, debug features
    TESTING = "testing"         # Minimal resources, fast setup  
    STAGING = "staging"         # Production-like with monitoring
    PRODUCTION = "production"   # Full security, performance optimized
```

### Configuration Validation

```python
def validate_config(config: DatabaseConfig) -> ValidationResult:
    """Comprehensive configuration validation"""
    
    # Environment-specific security requirements
    if config.environment == Environment.PRODUCTION:
        if not config.security.ssl_required:
            raise ConfigurationError("SSL required in production")
        if not config.security.certificate_path:
            raise ConfigurationError("SSL certificate required in production")
    
    # Connection parameter validation
    if config.connection.pool_size < 1 or config.connection.pool_size > 100:
        raise ConfigurationError("Pool size must be between 1 and 100")
    
    return ValidationResult(valid=True, warnings=[], errors=[])
```

## Unit of Work Implementation

### Transaction Management

```python
class SupabaseUnitOfWork(IUnitOfWork):
    """Unit of Work implementation with transaction support"""
    
    @asynccontextmanager
    async def transaction(self):
        """Transaction context manager with automatic rollback"""
        async with self._client.transaction() as tx:
            try:
                # Create transaction-scoped repositories
                transaction_uow = TransactionUnitOfWork(tx, self._container)
                yield transaction_uow
                await tx.commit()
            except Exception:
                await tx.rollback()
                raise
    
    async def savepoint(self, name: str) -> str:
        """Create named savepoint for partial rollback"""
        savepoint_id = f"sp_{name}_{uuid4().hex[:8]}"
        await self._client.execute(f"SAVEPOINT {savepoint_id}")
        return savepoint_id
    
    async def rollback_to_savepoint(self, savepoint_id: str) -> None:
        """Rollback to specific savepoint"""
        await self._client.execute(f"ROLLBACK TO SAVEPOINT {savepoint_id}")
```

### Repository Access

```python
class LazySupabaseDatabase(IUnitOfWork):
    """Lazy-loading database with all repositories"""
    
    @property
    def sources(self) -> ISourceRepository:
        return self._get_repository('sources', 'ISourceRepository')
    
    @property  
    def documents(self) -> IDocumentRepository:
        return self._get_repository('documents', 'IDocumentRepository')
    
    @property
    def projects(self) -> IProjectRepository:
        return self._get_repository('projects', 'IProjectRepository')
    
    def _get_repository(self, name: str, interface_name: str) -> Any:
        """Lazy load repository with caching and error handling"""
        if name not in self._repository_cache:
            try:
                repo_class = get_repository_class(interface_name)
                instance = repo_class(self._client)
                self._repository_cache[name] = instance
            except Exception as e:
                logger.error(f"Failed to load repository {name}: {e}")
                raise LazyImportError(f"Could not load {interface_name}: {e}")
        
        return self._repository_cache[name]
```

## Error Handling Strategy

### Exception Hierarchy

```python
# Base exception
class RepositoryError(Exception):
    """Base class for all repository errors"""

# Validation errors
class ValidationError(RepositoryError):
    """Data validation failures"""

class ConstraintViolationError(RepositoryError):
    """Database constraint violations"""

# Entity errors  
class EntityNotFoundError(RepositoryError):
    """Requested entity does not exist"""

class DuplicateEntityError(RepositoryError):
    """Entity already exists (uniqueness violation)"""

# Operation errors
class DatabaseConnectionError(RepositoryError):
    """Database connection failures"""

class DatabaseOperationError(RepositoryError):
    """Database operation failures"""

class ConcurrencyError(RepositoryError):
    """Concurrent modification conflicts"""

# Batch operation errors
class BatchOperationError(RepositoryError):
    """Batch operation failures with detailed results"""
    
    def __init__(self, message: str, failed_items: List[Dict[str, Any]]):
        super().__init__(message)
        self.failed_items = failed_items
```

### Error Handling Guidelines

```python
async def create_with_validation(self, entity: EntityType) -> EntityType:
    """Create entity with comprehensive error handling"""
    try:
        # Validate entity if it supports validation
        if isinstance(entity, ValidatableEntity):
            if not entity.validate():
                errors = entity.get_validation_errors()
                raise ValidationError(f"Validation failed: {errors}")
        
        # Attempt creation
        result = await self._execute_create(entity)
        return result
        
    except IntegrityError as e:
        if "duplicate key" in str(e).lower():
            raise DuplicateEntityError(f"Entity already exists: {e}")
        else:
            raise ConstraintViolationError(f"Constraint violation: {e}")
    except ConnectionError as e:
        raise DatabaseConnectionError(f"Database connection failed: {e}")
    except Exception as e:
        raise DatabaseOperationError(f"Create operation failed: {e}")
```

## Performance Monitoring

### Repository Statistics

```python
class RepositoryStatistics:
    """Performance statistics for repository operations"""
    
    def __init__(self):
        self.load_times: Dict[str, float] = {}
        self.access_counts: Dict[str, int] = {}
        self.error_counts: Dict[str, int] = {}
        self.cache_hits: int = 0
        self.cache_misses: int = 0
    
    def record_repository_load(self, name: str, load_time: float):
        """Record repository loading performance"""
        self.load_times[name] = load_time
        if name not in self.access_counts:
            self.access_counts[name] = 0
    
    def record_access(self, name: str, from_cache: bool):
        """Record repository access"""
        self.access_counts[name] = self.access_counts.get(name, 0) + 1
        if from_cache:
            self.cache_hits += 1
        else:
            self.cache_misses += 1
```

### Health Monitoring

```python
async def repository_health_check(self) -> HealthStatus:
    """Comprehensive repository health check"""
    health = HealthStatus()
    
    # Check database connectivity
    try:
        await self._client.execute("SELECT 1")
        health.database_connection = True
    except Exception as e:
        health.database_connection = False
        health.errors.append(f"Database connection failed: {e}")
    
    # Check repository loading
    for name, metadata in REPOSITORY_REGISTRY.items():
        try:
            self._get_repository(name.lower(), name)
            health.repositories[name] = True
        except Exception as e:
            health.repositories[name] = False
            health.errors.append(f"Repository {name} failed to load: {e}")
    
    return health
```

## Usage Examples

### Basic Repository Usage

```python
# Get database instance (lazy loading)
db = LazySupabaseDatabase(client)

# Simple CRUD operations
source = await db.sources.create(Source(
    url="https://example.com",
    source_type=SourceType.WEBSITE
))

# Retrieve with type safety
found_source = await db.sources.get_by_id(source.id)
if found_source:
    print(f"Found source: {found_source.url}")

# Update with validation
await db.sources.update(source.id, {
    "status": CrawlStatus.COMPLETED,
    "last_crawled": datetime.utcnow()
})
```

### Advanced Query Operations

```python
# Complex filtering and pagination
results = await db.documents.list(
    filters={
        "source_id": source.id,
        "content_type": DocumentType.MARKDOWN
    },
    pagination=PaginationParams(limit=50, offset=0),
    ordering=[
        OrderingField(field="created_at", direction=SortDirection.DESC),
        OrderingField(field="id", direction=SortDirection.ASC)
    ],
    return_total_count=True
)

print(f"Found {len(results.entities)} documents out of {results.total_count}")
```

### Batch Operations

```python
# Batch creation with error handling
documents = [Document(...) for _ in range(100)]
result = await db.documents.create_batch(
    documents,
    batch_size=25,
    validate_all=True,
    stop_on_first_error=False
)

if result.success:
    print(f"Created {result.affected_count} documents")
else:
    print(f"Batch operation failed: {result.error}")
    # Handle individual failures
    for error in result.metadata.get('failed_items', []):
        print(f"Failed item: {error}")
```

### Transaction Usage

```python
# Transactional operations
async with db.transaction() as uow:
    # Create project
    project = await uow.projects.create(Project(
        name="New Project",
        description="Project description"
    ))
    
    # Create initial tasks
    tasks = [
        Task(project_id=project.id, title="Setup", status=TaskStatus.TODO),
        Task(project_id=project.id, title="Implementation", status=TaskStatus.TODO)
    ]
    
    await uow.tasks.create_batch(tasks)
    
    # All operations commit together or rollback on any failure
```

## Migration and Compatibility

### Backward Compatibility

The lazy loading implementation maintains full backward compatibility:

```python
# Existing code continues to work unchanged
from src.server.core.dependencies import get_database

# Enhanced usage (recommended)
from src.server.core.enhanced_dependencies import get_database

# Direct lazy loading usage
from src.server.repositories import LazySupabaseDatabase
db = LazySupabaseDatabase(client)
```

### Migration Path

1. **Phase 1**: Use existing dependencies alongside lazy loading
2. **Phase 2**: Gradually migrate to enhanced dependencies  
3. **Phase 3**: Adopt direct lazy loading for new code
4. **Phase 4**: Optional migration of legacy code

## Testing Strategy

### Unit Testing Repositories

```python
class TestSourceRepository:
    """Unit tests for source repository"""
    
    @pytest.fixture
    async def repository(self, mock_client):
        return SupabaseSourceRepository(mock_client)
    
    async def test_create_source(self, repository):
        source = Source(url="https://test.com", source_type=SourceType.WEBSITE)
        result = await repository.create(source)
        
        assert result.id is not None
        assert result.url == "https://test.com"
        assert result.created_at is not None
    
    async def test_get_by_url(self, repository):
        # Test URL-based retrieval
        source = await repository.get_by_url("https://test.com")
        assert source is not None
```

### Integration Testing

```python
class TestRepositoryIntegration:
    """Integration tests with real database"""
    
    async def test_lazy_loading_performance(self, db_config):
        start_time = time.time()
        db = LazySupabaseDatabase.from_config(db_config)
        setup_time = time.time() - start_time
        
        assert setup_time < 0.1  # Setup should be < 100ms
        
        # First access loads repository
        start_time = time.time()
        sources = db.sources
        load_time = time.time() - start_time
        
        assert load_time < 0.05  # Loading should be < 50ms
        
        # Subsequent access from cache
        start_time = time.time()
        sources_cached = db.sources
        cache_time = time.time() - start_time
        
        assert cache_time < 0.001  # Cache access should be < 1ms
        assert sources is sources_cached  # Same instance
```

## Conclusion

The Archon repository pattern implementation provides:

- ✅ **Type-Safe Data Access**: Full TypeScript-like type safety in Python
- ✅ **Lazy Loading Performance**: 98% startup time reduction
- ✅ **Transaction Management**: ACID compliance with Unit of Work
- ✅ **Dependency Injection**: Clean separation of concerns
- ✅ **Comprehensive Error Handling**: Detailed error context and recovery
- ✅ **Environment Flexibility**: Multi-environment configuration support
- ✅ **Testing Support**: Mock-friendly and integration test ready
- ✅ **Backward Compatibility**: Seamless migration path

This architecture provides a solid foundation for scalable, maintainable, and performant data access in the Archon knowledge management system.