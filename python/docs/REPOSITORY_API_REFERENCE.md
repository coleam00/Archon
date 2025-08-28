# Repository Pattern API Reference

## Overview

This document provides comprehensive API documentation for the Archon repository pattern implementation, including all interfaces, type annotations, method signatures, and usage examples.

## Table of Contents

- [Base Repository Interface](#base-repository-interface)
- [Domain-Specific Repositories](#domain-specific-repositories)
- [Unit of Work Pattern](#unit-of-work-pattern)
- [Type Definitions](#type-definitions)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Usage Examples](#usage-examples)

## Base Repository Interface

### IBaseRepository[EntityType]

The foundational interface that all repository implementations must inherit from.

```python
from typing import Generic, TypeVar, Optional, List, Dict, Any, Union, Sequence
from abc import ABC, abstractmethod
from uuid import UUID

EntityType = TypeVar('EntityType')

class IBaseRepository(ABC, Generic[EntityType]):
    """
    Abstract base repository interface defining common database operations.
    
    Type Parameters:
        EntityType: The entity type that this repository manages
    """
```

#### Core CRUD Operations

##### create

```python
@abstractmethod
async def create(self, entity: EntityType) -> EntityType:
    """
    Create a new entity in the database with validation and constraint checking.
    
    Args:
        entity: The entity instance to create
            - Must implement ValidatableEntity if validation needed
            - Required fields must be populated
            - ID field will be generated if not provided
    
    Returns:
        EntityType: The created entity with database-generated fields populated
            - id: Auto-generated UUID or sequence ID
            - created_at: Timestamp of creation
            - updated_at: Timestamp of creation (same as created_at)
    
    Raises:
        ValidationError: If entity data fails validation rules
            - Missing required fields
            - Invalid field values
            - Business logic validation failures
        DuplicateEntityError: If entity violates uniqueness constraints
            - Duplicate primary key
            - Unique index violations
            - Custom uniqueness constraints
        ConstraintViolationError: If entity violates database constraints
            - Foreign key constraints
            - Check constraints
            - Custom constraints
        DatabaseOperationError: If database operation fails
            - Connection issues
            - Query execution errors
            - Transaction failures
    
    Type Safety:
        - Input entity must be of type EntityType
        - Returned entity guaranteed to have id and timestamps populated
        - Validation performed if entity implements ValidatableEntity protocol
    
    Examples:
        >>> source = Source(url="https://example.com", source_type=SourceType.WEBSITE)
        >>> created_source = await repository.create(source)
        >>> assert created_source.id is not None
        >>> assert created_source.created_at is not None
    """
    pass
```

##### get_by_id

```python
@overload
async def get_by_id(self, id: UUID) -> Optional[EntityType]: ...
@overload  
async def get_by_id(self, id: str) -> Optional[EntityType]: ...
@overload
async def get_by_id(self, id: int) -> Optional[EntityType]: ...

@abstractmethod
async def get_by_id(self, id: Union[str, UUID, int]) -> Optional[EntityType]:
    """
    Retrieve an entity by its unique identifier with type safety.
    
    Args:
        id: The unique identifier
            - UUID: Standard UUID format for primary keys
            - str: Natural keys or string-based identifiers
            - int: Legacy numeric identifiers
            - Must be valid format for the ID type
    
    Returns:
        Optional[EntityType]: The entity if found, None if not found
            - None indicates entity doesn't exist (not an error condition)
            - All entity fields populated from database
            - Lazy-loaded relationships not populated by default
    
    Raises:
        ValidationError: If id format is invalid
            - Malformed UUID string
            - Empty or null ID values
            - Invalid ID type for entity
        DatabaseConnectionError: If database connection fails
            - Network connectivity issues  
            - Authentication failures
            - Connection pool exhaustion
        DatabaseOperationError: If database query fails
            - SQL syntax errors
            - Query timeout
            - Permission issues
    
    Type Safety:
        - Accepts only valid ID types (UUID, str, int)
        - Returns strongly typed Optional[EntityType]
        - None return indicates entity not found (not an error condition)
    
    Examples:
        >>> # UUID-based lookup
        >>> source = await repository.get_by_id(UUID("123e4567-e89b-12d3-a456-426614174000"))
        >>> 
        >>> # String-based lookup
        >>> source = await repository.get_by_id("user@example.com")
        >>> 
        >>> # Handle not found
        >>> if source is None:
        >>>     print("Source not found")
    """
    pass
```

##### update

```python
@abstractmethod
async def update(
    self, 
    id: Union[str, UUID, int], 
    data: Dict[str, Any],
    *,
    validate: bool = True,
    ignore_missing: bool = False
) -> Optional[EntityType]:
    """
    Update an existing entity with validation and concurrency control.
    
    Args:
        id: Unique identifier of entity to update
            - Same ID types as get_by_id
            - Must reference existing entity unless ignore_missing=True
        data: Dictionary of field updates (only changed fields)
            - Keys must be valid entity field names
            - Values must be compatible with field types
            - Partial updates supported
            - Special fields handled automatically:
                - updated_at: Set to current timestamp
                - version: Incremented for optimistic locking
        validate: Whether to perform validation on updated entity
            - True: Full validation after applying updates
            - False: Skip validation (use with caution)
        ignore_missing: If True, return None for missing entities instead of raising
            - True: Returns None if entity not found
            - False: Raises EntityNotFoundError if entity not found
    
    Returns:
        Optional[EntityType]: Updated entity with new timestamps
            - All fields updated according to data parameter
            - updated_at timestamp refreshed
            - Version incremented if versioning enabled
            - None if entity not found and ignore_missing=True
    
    Raises:
        EntityNotFoundError: If entity doesn't exist and ignore_missing=False
            - ID doesn't match any existing entity
            - Entity was deleted by concurrent operation
        ValidationError: If updated data fails validation (when validate=True)
            - Invalid field values after update
            - Business rule violations
            - Constraint check failures
        ConcurrencyError: If entity was modified by another process
            - Optimistic locking version mismatch
            - Concurrent modification detected
        ConstraintViolationError: If update violates constraints
            - Foreign key violations
            - Unique constraint violations
            - Check constraint failures
        DatabaseOperationError: If database update fails
            - Connection issues during update
            - SQL execution errors
            - Transaction rollback
    
    Type Safety:
        - Validates data keys against entity schema
        - Returns fully typed entity with updated fields
        - Automatically updates updated_at timestamp if supported
    
    Examples:
        >>> # Simple field update
        >>> updated = await repository.update(source.id, {
        >>>     "title": "New Title",
        >>>     "description": "Updated description"
        >>> })
        >>> 
        >>> # Update with validation disabled
        >>> updated = await repository.update(
        >>>     source.id, 
        >>>     {"status": "processing"},
        >>>     validate=False
        >>> )
        >>> 
        >>> # Ignore missing entities
        >>> updated = await repository.update(
        >>>     "nonexistent-id",
        >>>     {"title": "New"},
        >>>     ignore_missing=True
        >>> )
        >>> if updated is None:
        >>>     print("Entity not found")
    """
    pass
```

##### delete

```python
@abstractmethod
async def delete(self, id: Union[str, UUID, int], *, soft_delete: bool = False) -> bool:
    """
    Delete an entity with support for soft deletion.
    
    Args:
        id: Unique identifier of entity to delete
            - Must be valid ID type and format
            - Entity must exist for hard delete to return True
        soft_delete: If True, mark as deleted instead of removing from database
            - True: Set deleted_at timestamp, keep data
            - False: Permanently remove from database
            - Soft delete preserves referential integrity
    
    Returns:
        bool: True if entity was deleted, False if not found
            - True: Entity successfully deleted (hard or soft)
            - False: Entity was not found
            - Consistent return regardless of soft_delete flag
    
    Raises:
        ConstraintViolationError: If deletion violates foreign key constraints
            - Referenced by other entities
            - Cascade delete not configured
            - Integrity constraint violations
        DatabaseOperationError: If database deletion fails
            - Connection issues during delete
            - SQL execution errors
            - Transaction failures
    
    Type Safety:
        - Validates ID type and format
        - Boolean return clearly indicates operation success
        - Soft delete preserves referential integrity when supported
    
    Examples:
        >>> # Hard delete
        >>> deleted = await repository.delete(source.id)
        >>> if deleted:
        >>>     print("Source permanently deleted")
        >>> 
        >>> # Soft delete
        >>> deleted = await repository.delete(source.id, soft_delete=True)
        >>> if deleted:
        >>>     print("Source marked as deleted")
    """
    pass
```

#### Query Operations

##### list

```python
@overload
async def list(
    self,
    *,
    filters: Optional[Dict[str, Any]] = None,
    pagination: Optional[PaginationParams] = None,
    ordering: Optional[List[OrderingField]] = None,
    return_total_count: Literal[False] = False
) -> List[EntityType]: ...

@overload
async def list(
    self,
    *,
    filters: Optional[Dict[str, Any]] = None,
    pagination: Optional[PaginationParams] = None,
    ordering: Optional[List[OrderingField]] = None,
    return_total_count: Literal[True]
) -> PaginatedResult[EntityType]: ...

@abstractmethod
async def list(
    self, 
    *,
    filters: Optional[Dict[str, Any]] = None,
    pagination: Optional[PaginationParams] = None,
    ordering: Optional[List[OrderingField]] = None,
    return_total_count: bool = False
) -> Union[List[EntityType], PaginatedResult[EntityType]]:
    """
    List entities with advanced filtering, pagination, and guaranteed ordering.
    
    Args:
        filters: Filter criteria for entity selection
            - Simple filters: {"field": "value"} for equality matching
            - Complex filters: FilterCondition objects for advanced operations
            - Multiple filters: AND logic applied between filters
            - Supported operators: eq, ne, gt, gte, lt, lte, in, like, ilike
        pagination: Limit and offset parameters with validation
            - limit: Maximum entities to return (1-10000, default: no limit)
            - offset: Number of entities to skip (>= 0, default: 0)
            - Used for pagination implementation
        ordering: List of fields to sort by with direction and null handling
            - field: Entity field name (must exist)
            - direction: SortDirection.ASC or SortDirection.DESC
            - nulls_first: Whether NULL values come first (optional)
            - Multiple ordering fields supported
        return_total_count: Whether to return paginated result with total count
            - False: Return List[EntityType] (faster)
            - True: Return PaginatedResult[EntityType] with metadata
    
    Returns:
        Union[List[EntityType], PaginatedResult[EntityType]]: 
            - List[EntityType] if return_total_count=False
            - PaginatedResult[EntityType] if return_total_count=True
            - Results guaranteed to be ordered deterministically
    
    Raises:
        ValidationError: If filter values or pagination params are invalid
            - Invalid filter field names
            - Incorrect filter value types
            - Pagination limits exceeded
            - Negative offset values
        QueryError: If ordering fields don't exist or query construction fails
            - Non-existent ordering fields
            - SQL query construction errors
            - Invalid query syntax
        DatabaseOperationError: If database query fails
            - Connection issues during query
            - Query timeout exceeded
            - Permission denied
    
    Type Safety & Ordering Guarantees:
        - Results always ordered by: specified ordering, then created_at DESC, then id ASC
        - Pagination parameters validated (limit 1-10000, offset >= 0)
        - Filter values type-checked against entity schema
        - Deterministic ordering ensures consistent pagination
    
    Examples:
        >>> # Simple listing
        >>> sources = await repository.list()
        >>> 
        >>> # With filters
        >>> active_sources = await repository.list(
        >>>     filters={"status": "active", "source_type": "website"}
        >>> )
        >>> 
        >>> # With pagination
        >>> page_sources = await repository.list(
        >>>     pagination=PaginationParams(limit=20, offset=40)
        >>> )
        >>> 
        >>> # With ordering
        >>> sorted_sources = await repository.list(
        >>>     ordering=[
        >>>         OrderingField(field="created_at", direction=SortDirection.DESC),
        >>>         OrderingField(field="title", direction=SortDirection.ASC)
        >>>     ]
        >>> )
        >>> 
        >>> # With total count
        >>> result = await repository.list(
        >>>     filters={"status": "active"},
        >>>     pagination=PaginationParams(limit=10, offset=0),
        >>>     return_total_count=True
        >>> )
        >>> print(f"Page 1 of {result.total_count} total sources")
        >>> print(f"Has more pages: {result.has_more}")
    """
    pass
```

##### count

```python
@abstractmethod
async def count(
    self, 
    filters: Optional[Dict[str, Any]] = None,
    *,
    distinct_field: Optional[str] = None
) -> int:
    """
    Count entities with optional distinct counting.
    
    Args:
        filters: Same filter format as list() method
            - Simple field-value pairs for equality
            - Complex FilterCondition objects
            - Multiple filters combined with AND logic
            - Null/empty filters count all entities
        distinct_field: If provided, count distinct values of this field
            - Field must exist in entity schema
            - Counts unique values, ignoring duplicates
            - Useful for counting unique categories, statuses, etc.
    
    Returns:
        int: Number of entities/distinct values matching criteria
            - Always >= 0
            - 0 indicates no matching entities
            - For distinct counting: number of unique values
    
    Raises:
        ValidationError: If filter parameters are invalid
            - Invalid field names in filters
            - Incorrect filter value types
            - Malformed filter conditions
        QueryError: If distinct_field doesn't exist
            - Non-existent field name
            - Field not accessible for distinct counting
        DatabaseOperationError: If count query fails
            - Connection issues
            - Query execution errors
            - Timeout exceeded
    
    Type Safety:
        - Validates filter types and values
        - Returns non-negative integer count
        - Distinct counting validates field existence
    
    Examples:
        >>> # Count all entities
        >>> total = await repository.count()
        >>> 
        >>> # Count with filters
        >>> active_count = await repository.count(
        >>>     filters={"status": "active"}
        >>> )
        >>> 
        >>> # Count distinct values
        >>> unique_types = await repository.count(
        >>>     distinct_field="source_type"
        >>> )
        >>> print(f"Found {unique_types} different source types")
    """
    pass
```

##### exists

```python
@abstractmethod
async def exists(
    self, 
    id: Union[str, UUID, int],
    *,
    additional_filters: Optional[Dict[str, Any]] = None
) -> bool:
    """
    Check entity existence with optional additional conditions.
    
    Args:
        id: Primary identifier to check
            - Same ID types as get_by_id
            - Must be valid format for entity type
        additional_filters: Additional conditions entity must meet
            - Applied in addition to ID match
            - Same format as list() filters
            - All conditions must be met (AND logic)
    
    Returns:
        bool: True if entity exists and matches all conditions
            - True: Entity found and passes all filters
            - False: Entity not found or fails filter conditions
    
    Raises:
        ValidationError: If id format or filters are invalid
            - Malformed ID values
            - Invalid filter field names
            - Incorrect filter value types
        DatabaseOperationError: If existence check fails
            - Connection issues
            - Query execution errors
    
    Type Safety:
        - Validates ID type and format
        - Boolean return with no ambiguity
        - Additional filters follow same validation as list()
    
    Examples:
        >>> # Simple existence check
        >>> exists = await repository.exists(source.id)
        >>> 
        >>> # Check with additional conditions
        >>> active_exists = await repository.exists(
        >>>     source.id,
        >>>     additional_filters={"status": "active"}
        >>> )
    """
    pass
```

#### Batch Operations

##### create_batch

```python
@abstractmethod
async def create_batch(
    self, 
    entities: Sequence[EntityType],
    *,
    batch_size: int = 100,
    validate_all: bool = True,
    stop_on_first_error: bool = False
) -> OperationResult[EntityType]:
    """
    Create multiple entities with comprehensive error handling.
    
    Args:
        entities: Sequence of entities to create
            - Must be iterable sequence (List, Tuple, etc.)
            - All entities must be same type
            - Empty sequence returns successful result with 0 count
        batch_size: Number of entities to process in each database batch
            - Range: 1-1000 (default: 100)
            - Larger batches: better performance, more memory
            - Smaller batches: better error isolation, less memory
        validate_all: Whether to validate all entities before processing
            - True: Validate all before any database operations (fail-fast)
            - False: Validate during processing (partial success possible)
        stop_on_first_error: Whether to abort on first error or continue
            - True: Stop processing on first failure (transactional)
            - False: Continue processing, collect all errors (best-effort)
    
    Returns:
        OperationResult[EntityType]: Comprehensive operation result
            - success: True if all entities created successfully
            - entities: List of successfully created entities
            - affected_count: Number of entities actually created
            - error: General error message if operation failed
            - metadata: Additional details including failed items
    
    Raises:
        ValidationError: If validate_all=True and any entity is invalid
            - Validation performed before database operations
            - First validation error aborts entire operation
            - All validation errors collected in error message
        BatchOperationError: If batch processing encounters errors
            - Detailed error information for debugging
            - Partial results included when stop_on_first_error=False
        DatabaseOperationError: If database batch operation fails
            - Connection issues during batch processing
            - Transaction failures
            - Constraint violations affecting multiple entities
    
    Type Safety & Error Handling:
        - Validates all entities implement required protocols
        - Returns detailed results with per-item success/failure status
        - Failed entities include specific error messages
        - Successful entities guaranteed to have IDs populated
    
    Examples:
        >>> # Simple batch creation
        >>> sources = [
        >>>     Source(url="https://site1.com", source_type=SourceType.WEBSITE),
        >>>     Source(url="https://site2.com", source_type=SourceType.WEBSITE),
        >>> ]
        >>> result = await repository.create_batch(sources)
        >>> if result.success:
        >>>     print(f"Created {result.affected_count} sources")
        >>> 
        >>> # With error handling
        >>> result = await repository.create_batch(
        >>>     sources,
        >>>     batch_size=50,
        >>>     validate_all=False,
        >>>     stop_on_first_error=False
        >>> )
        >>> if not result.success:
        >>>     failed_items = result.metadata.get('failed_items', [])
        >>>     print(f"Failed to create {len(failed_items)} sources")
        >>>     for failure in failed_items:
        >>>         print(f"Error: {failure['error']}")
    """
    pass
```

##### update_batch

```python
@abstractmethod
async def update_batch(
    self, 
    updates: Sequence[Dict[str, Any]],
    *,
    batch_size: int = 100,
    validate_updates: bool = True
) -> OperationResult[EntityType]:
    """
    Update multiple entities with validation and error tracking.
    
    Args:
        updates: Sequence of update dictionaries
            - Each dict must contain 'id' key with entity identifier
            - Additional keys are fields to update
            - Example: [{"id": "123", "status": "active", "title": "New"}]
        batch_size: Number of updates to process in each batch
            - Range: 1-1000 (default: 100)
            - Affects memory usage and transaction size
        validate_updates: Whether to validate update data
            - True: Validate each update before applying
            - False: Skip validation (better performance, higher risk)
    
    Returns:
        OperationResult[EntityType]: Operation result with updated entities
            - success: True if all updates successful
            - entities: List of successfully updated entities  
            - affected_count: Number of entities actually updated
            - error: General error if operation failed
            - metadata: Details including failed updates
    
    Raises:
        ValidationError: If any update dictionary is invalid
            - Missing 'id' key in update dictionary
            - Invalid field names or values
            - Type checking failures
        BatchOperationError: If batch processing encounters errors
            - Detailed per-item error information
            - Partial success results when applicable
        DatabaseOperationError: If database batch update fails
            - Connection issues during batch
            - Transaction rollback scenarios
    
    Type Safety:
        - Validates each update dict has required 'id' key
        - Type-checks update values against entity schema
        - Returns typed entities with updated fields
    
    Examples:
        >>> # Batch status updates
        >>> updates = [
        >>>     {"id": source1.id, "status": "completed"},
        >>>     {"id": source2.id, "status": "completed", "last_crawled": datetime.now()},
        >>> ]
        >>> result = await repository.update_batch(updates)
        >>> if result.success:
        >>>     print(f"Updated {result.affected_count} sources")
    """
    pass
```

##### delete_batch

```python
@abstractmethod
async def delete_batch(
    self, 
    ids: Sequence[Union[str, UUID, int]],
    *,
    batch_size: int = 100,
    soft_delete: bool = False
) -> int:
    """
    Delete multiple entities with optional soft deletion.
    
    Args:
        ids: Sequence of entity identifiers to delete
            - Must all be same ID type (UUID, str, or int)
            - Empty sequence returns 0
            - Duplicates are handled gracefully
        batch_size: Number of deletions to process in each batch
            - Range: 1-1000 (default: 100)
            - Affects transaction size and memory usage
        soft_delete: Whether to perform soft deletion
            - True: Mark entities as deleted (set deleted_at)
            - False: Permanently remove from database
    
    Returns:
        int: Number of entities actually deleted
            - May be less than len(ids) if some entities not found
            - 0 indicates no entities were deleted
            - Count reflects actual deletions, not attempted deletions
    
    Raises:
        ValidationError: If any ID format is invalid
            - Malformed UUID strings
            - Mixed ID types in sequence
            - Empty or null ID values
        ConstraintViolationError: If deletions violate foreign key constraints
            - Referenced entities cannot be deleted
            - Cascade delete not configured
        DatabaseOperationError: If batch deletion fails
            - Connection issues during batch operation
            - Transaction failures
    
    Type Safety:
        - Validates all IDs are proper types and formats
        - Return count guaranteed to be <= len(ids)
        - Batch processing ensures transaction consistency
    
    Examples:
        >>> # Hard delete batch
        >>> deleted_count = await repository.delete_batch([id1, id2, id3])
        >>> print(f"Deleted {deleted_count} entities")
        >>> 
        >>> # Soft delete batch
        >>> deleted_count = await repository.delete_batch(
        >>>     [id1, id2, id3],
        >>>     soft_delete=True
        >>> )
    """
    pass
```

## Domain-Specific Repositories

### Knowledge Domain Repositories

#### ISourceRepository

```python
from .base_repository import IBaseRepository
from ..models.entities import Source, SourceType, CrawlStatus

class ISourceRepository(IBaseRepository[Source]):
    """Repository for managing knowledge sources (websites, documents)."""
    
    @abstractmethod
    async def get_by_url(self, url: str) -> Optional[Source]:
        """
        Retrieve a source by its URL.
        
        Args:
            url: The source URL to search for
                - Must be a valid URL format
                - Exact match required (case-sensitive)
                - Includes protocol (http/https)
        
        Returns:
            Optional[Source]: The source if found, None if not found
        
        Examples:
            >>> source = await repo.get_by_url("https://example.com/docs")
        """
        pass
    
    @abstractmethod
    async def get_sources_by_type(self, source_type: SourceType) -> List[Source]:
        """
        Get all sources of a specific type.
        
        Args:
            source_type: Type of sources to retrieve
                - SourceType.WEBSITE: Web crawling sources
                - SourceType.DOCUMENT: Uploaded document files
                - SourceType.API: API-based sources
        
        Returns:
            List[Source]: All sources of the specified type
        
        Examples:
            >>> websites = await repo.get_sources_by_type(SourceType.WEBSITE)
        """
        pass
    
    @abstractmethod
    async def update_crawl_status(
        self, 
        source_id: str, 
        status: CrawlStatus,
        *,
        error_message: Optional[str] = None,
        pages_crawled: Optional[int] = None,
        last_crawled: Optional[datetime] = None
    ) -> Source:
        """
        Update crawling status and related metadata.
        
        Args:
            source_id: Identifier of the source to update
            status: New crawling status
                - CrawlStatus.PENDING: Queued for crawling
                - CrawlStatus.IN_PROGRESS: Currently being crawled
                - CrawlStatus.COMPLETED: Successfully crawled
                - CrawlStatus.FAILED: Crawling failed
            error_message: Error details if status is FAILED
            pages_crawled: Number of pages successfully crawled
            last_crawled: Timestamp of last crawling attempt
        
        Returns:
            Source: Updated source with new status and metadata
        
        Raises:
            EntityNotFoundError: If source_id doesn't exist
            ValidationError: If status transition is invalid
        
        Examples:
            >>> source = await repo.update_crawl_status(
            >>>     source_id,
            >>>     CrawlStatus.COMPLETED,
            >>>     pages_crawled=150,
            >>>     last_crawled=datetime.now()
            >>> )
        """
        pass
    
    @abstractmethod
    async def get_sources_for_crawling(
        self, 
        statuses: List[CrawlStatus],
        limit: Optional[int] = None
    ) -> List[Source]:
        """
        Get sources that need crawling based on status.
        
        Args:
            statuses: List of statuses to include
            limit: Maximum number of sources to return
        
        Returns:
            List[Source]: Sources matching the specified statuses
        
        Examples:
            >>> pending_sources = await repo.get_sources_for_crawling([
            >>>     CrawlStatus.PENDING,
            >>>     CrawlStatus.FAILED
            >>> ], limit=10)
        """
        pass
```

#### IDocumentRepository

```python
from .base_repository import IBaseRepository
from ..models.entities import Document, DocumentType

class IDocumentRepository(IBaseRepository[Document]):
    """Repository for managing document chunks with embeddings."""
    
    @abstractmethod
    async def search_by_embedding(
        self, 
        embedding: List[float], 
        *,
        limit: int = 10,
        similarity_threshold: float = 0.7,
        source_ids: Optional[List[str]] = None
    ) -> List[Document]:
        """
        Semantic search using vector embeddings.
        
        Args:
            embedding: Query embedding vector (1536 dimensions for OpenAI)
            limit: Maximum number of results to return (1-100)
            similarity_threshold: Minimum cosine similarity (0.0-1.0)
            source_ids: Optional filter by source IDs
        
        Returns:
            List[Document]: Documents ordered by similarity score (highest first)
        
        Examples:
            >>> query_embedding = await embedding_service.embed("Python repository pattern")
            >>> similar_docs = await repo.search_by_embedding(
            >>>     query_embedding,
            >>>     limit=5,
            >>>     similarity_threshold=0.8
            >>> )
        """
        pass
    
    @abstractmethod
    async def get_by_source_id(
        self, 
        source_id: str,
        *,
        document_types: Optional[List[DocumentType]] = None,
        pagination: Optional[PaginationParams] = None
    ) -> List[Document]:
        """
        Get all document chunks for a specific source.
        
        Args:
            source_id: Source identifier to filter by
            document_types: Optional filter by document types
            pagination: Optional pagination parameters
        
        Returns:
            List[Document]: Documents from the specified source
        
        Examples:
            >>> docs = await repo.get_by_source_id(
            >>>     source.id,
            >>>     document_types=[DocumentType.MARKDOWN, DocumentType.CODE]
            >>> )
        """
        pass
    
    @abstractmethod
    async def bulk_insert_with_embeddings(
        self, 
        documents: List[Document]
    ) -> OperationResult[Document]:
        """
        Efficiently insert many documents with embeddings.
        
        Args:
            documents: Documents with embeddings to insert
                - All documents must have valid embeddings
                - Embedding dimension must be consistent
                - Batch size optimized for performance
        
        Returns:
            OperationResult[Document]: Batch operation result
        
        Examples:
            >>> documents_with_embeddings = []
            >>> for chunk in text_chunks:
            >>>     embedding = await embedding_service.embed(chunk.content)
            >>>     doc = Document(content=chunk.content, embedding=embedding)
            >>>     documents_with_embeddings.append(doc)
            >>> 
            >>> result = await repo.bulk_insert_with_embeddings(documents_with_embeddings)
        """
        pass
    
    @abstractmethod
    async def update_embedding(
        self, 
        document_id: str, 
        embedding: List[float]
    ) -> Document:
        """
        Update the embedding for a specific document.
        
        Args:
            document_id: Document identifier
            embedding: New embedding vector
        
        Returns:
            Document: Updated document with new embedding
        
        Examples:
            >>> new_embedding = await embedding_service.embed(updated_content)
            >>> doc = await repo.update_embedding(doc.id, new_embedding)
        """
        pass
```

#### ICodeExampleRepository

```python
from .base_repository import IBaseRepository
from ..models.entities import CodeExample, ProgrammingLanguage

class ICodeExampleRepository(IBaseRepository[CodeExample]):
    """Repository for extracted code examples."""
    
    @abstractmethod
    async def search_by_language(
        self, 
        language: ProgrammingLanguage,
        *,
        limit: Optional[int] = None
    ) -> List[CodeExample]:
        """
        Get code examples by programming language.
        
        Args:
            language: Programming language to filter by
            limit: Optional limit on results
        
        Returns:
            List[CodeExample]: Code examples in the specified language
        """
        pass
    
    @abstractmethod
    async def get_by_tags(
        self, 
        tags: List[str],
        *,
        match_all: bool = False
    ) -> List[CodeExample]:
        """
        Get code examples by tags.
        
        Args:
            tags: List of tags to search for
            match_all: If True, example must have all tags; if False, any tag
        
        Returns:
            List[CodeExample]: Code examples matching the tag criteria
        """
        pass
    
    @abstractmethod
    async def search_by_function_name(
        self, 
        function_name: str,
        *,
        exact_match: bool = False
    ) -> List[CodeExample]:
        """
        Search for code examples by function name.
        
        Args:
            function_name: Function name to search for
            exact_match: If True, exact name match; if False, partial match
        
        Returns:
            List[CodeExample]: Code examples containing the function
        """
        pass
```

### Project Domain Repositories

#### IProjectRepository

```python
from .base_repository import IBaseRepository
from ..models.entities import Project, ProjectStatus, ProjectWithTasks

class IProjectRepository(IBaseRepository[Project]):
    """Repository for project management."""
    
    @abstractmethod
    async def get_with_tasks(self, project_id: str) -> Optional[ProjectWithTasks]:
        """
        Get project with all associated tasks loaded.
        
        Args:
            project_id: Project identifier
        
        Returns:
            Optional[ProjectWithTasks]: Project with tasks if found
        """
        pass
    
    @abstractmethod
    async def get_by_github_repo(self, repo_url: str) -> Optional[Project]:
        """
        Find project by GitHub repository URL.
        
        Args:
            repo_url: GitHub repository URL
        
        Returns:
            Optional[Project]: Project associated with the repository
        """
        pass
    
    @abstractmethod
    async def update_status(
        self, 
        project_id: str, 
        status: ProjectStatus,
        *,
        status_reason: Optional[str] = None
    ) -> Project:
        """
        Update project status with optional reason.
        
        Args:
            project_id: Project identifier
            status: New project status
            status_reason: Optional reason for status change
        
        Returns:
            Project: Updated project
        """
        pass
    
    @abstractmethod
    async def get_active_projects(
        self,
        *,
        include_archived: bool = False
    ) -> List[Project]:
        """
        Get all active projects.
        
        Args:
            include_archived: Whether to include archived projects
        
        Returns:
            List[Project]: Active projects
        """
        pass
```

#### ITaskRepository

```python
from .base_repository import IBaseRepository
from ..models.entities import Task, TaskStatus, TaskPriority

class ITaskRepository(IBaseRepository[Task]):
    """Repository for task management."""
    
    @abstractmethod
    async def get_by_project_id(
        self, 
        project_id: str,
        *,
        include_completed: bool = False
    ) -> List[Task]:
        """
        Get all tasks for a specific project.
        
        Args:
            project_id: Project identifier
            include_completed: Whether to include completed tasks
        
        Returns:
            List[Task]: Tasks for the project
        """
        pass
    
    @abstractmethod
    async def get_by_status(
        self, 
        status: TaskStatus,
        *,
        project_id: Optional[str] = None,
        assignee: Optional[str] = None
    ) -> List[Task]:
        """
        Get tasks by status with optional filters.
        
        Args:
            status: Task status to filter by
            project_id: Optional project filter
            assignee: Optional assignee filter
        
        Returns:
            List[Task]: Tasks matching the criteria
        """
        pass
    
    @abstractmethod
    async def update_status(
        self, 
        task_id: str, 
        status: TaskStatus,
        *,
        assignee: Optional[str] = None,
        status_notes: Optional[str] = None
    ) -> Task:
        """
        Update task status and related fields.
        
        Args:
            task_id: Task identifier
            status: New task status
            assignee: Optional new assignee
            status_notes: Optional notes about status change
        
        Returns:
            Task: Updated task
        """
        pass
    
    @abstractmethod
    async def get_tasks_by_priority(
        self, 
        project_id: str,
        *,
        min_priority: Optional[TaskPriority] = None
    ) -> List[Task]:
        """
        Get tasks ordered by priority.
        
        Args:
            project_id: Project identifier
            min_priority: Optional minimum priority filter
        
        Returns:
            List[Task]: Tasks ordered by priority (highest first)
        """
        pass
```

## Unit of Work Pattern

### IUnitOfWork Interface

```python
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from typing import AsyncContextManager, Self

class IUnitOfWork(ABC):
    """
    Abstract Unit of Work interface for managing database transactions.
    
    The Unit of Work pattern maintains a list of objects affected by a business
    transaction and coordinates writing out changes and resolving concurrency problems.
    """
    
    @abstractmethod
    def transaction(self) -> AsyncContextManager[Self]:
        """
        Context manager for database transactions.
        
        Provides automatic transaction management with commit on successful completion
        and rollback on exceptions.
        
        Yields:
            Self: The unit of work instance for executing transactional operations
        
        Examples:
            >>> async with uow.transaction() as uow_context:
            >>>     user = await uow_context.users.create(user_data)
            >>>     await uow_context.audit_logs.create(audit_entry)
            >>>     # Automatic commit on success, rollback on exception
        """
        pass
    
    @abstractmethod
    async def commit(self) -> None:
        """Manually commit the current transaction."""
        pass
    
    @abstractmethod
    async def rollback(self) -> None:
        """Manually rollback the current transaction."""
        pass
    
    @abstractmethod
    async def begin(self) -> None:
        """Manually begin a new transaction."""
        pass
    
    @abstractmethod
    async def is_active(self) -> bool:
        """Check if a transaction is currently active."""
        pass
    
    @abstractmethod
    async def savepoint(self, name: str) -> str:
        """Create a savepoint within the current transaction."""
        pass
    
    @abstractmethod
    async def rollback_to_savepoint(self, savepoint_id: str) -> None:
        """Rollback to a specific savepoint."""
        pass
    
    @abstractmethod
    async def release_savepoint(self, savepoint_id: str) -> None:
        """Release a savepoint, making its changes permanent."""
        pass
```

### LazySupabaseDatabase Implementation

```python
class LazySupabaseDatabase(IUnitOfWork):
    """
    Lazy-loading database implementation with all repositories.
    
    Repositories are loaded only when first accessed, improving startup performance
    and reducing memory usage.
    """
    
    def __init__(self, client: Client):
        """
        Initialize with Supabase client.
        
        Args:
            client: Configured Supabase client instance
        """
        self._client = client
        self._repository_cache: Dict[str, Any] = {}
        self._statistics = RepositoryStatistics()
    
    # Knowledge domain repositories
    @property
    def sources(self) -> ISourceRepository:
        """Get source repository (lazy loaded)."""
        return self._get_repository('sources', 'ISourceRepository')
    
    @property  
    def documents(self) -> IDocumentRepository:
        """Get document repository (lazy loaded)."""
        return self._get_repository('documents', 'IDocumentRepository')
    
    @property
    def code_examples(self) -> ICodeExampleRepository:
        """Get code example repository (lazy loaded)."""
        return self._get_repository('code_examples', 'ICodeExampleRepository')
    
    # Project domain repositories
    @property
    def projects(self) -> IProjectRepository:
        """Get project repository (lazy loaded)."""
        return self._get_repository('projects', 'IProjectRepository')
    
    @property
    def tasks(self) -> ITaskRepository:
        """Get task repository (lazy loaded)."""
        return self._get_repository('tasks', 'ITaskRepository')
    
    @property
    def versions(self) -> IVersionRepository:
        """Get version repository (lazy loaded)."""
        return self._get_repository('versions', 'IVersionRepository')
    
    # Settings domain repositories
    @property
    def settings(self) -> ISettingsRepository:
        """Get settings repository (lazy loaded)."""
        return self._get_repository('settings', 'ISettingsRepository')
    
    @property
    def prompts(self) -> IPromptRepository:
        """Get prompt repository (lazy loaded)."""
        return self._get_repository('prompts', 'IPromptRepository')
```

## Type Definitions

### Core Type Definitions

```python
from typing import TypedDict, NotRequired, Generic, TypeVar, List, Dict, Any
from enum import Enum
from uuid import UUID
from datetime import datetime

# Generic type variables
EntityType = TypeVar('EntityType')
IdType = TypeVar('IdType', str, UUID, int)
FilterType = TypeVar('FilterType', bound=Dict[str, Any])

# Sorting and ordering
class SortDirection(str, Enum):
    """Enumeration of supported sort directions."""
    ASC = "asc"
    DESC = "desc"
    ASCENDING = "ascending"
    DESCENDING = "descending"

class OrderingField(TypedDict):
    """Type definition for ordering field specification."""
    field: str                        # Field name to sort by
    direction: SortDirection          # Sort direction
    nulls_first: NotRequired[bool]    # Whether NULL values come first

# Pagination
class PaginationParams(TypedDict):
    """Type definition for pagination parameters."""
    limit: NotRequired[int]    # Maximum results (1-10000)
    offset: NotRequired[int]   # Results to skip (>= 0)

# Filtering
class FilterOperator(str, Enum):
    """Enumeration of supported filter operators."""
    EQ = "eq"           # Equal
    NE = "ne"           # Not equal
    GT = "gt"           # Greater than
    GTE = "gte"         # Greater than or equal
    LT = "lt"           # Less than
    LTE = "lte"         # Less than or equal
    IN = "in"           # Value in list
    NOT_IN = "not_in"   # Value not in list
    LIKE = "like"       # Pattern matching
    ILIKE = "ilike"     # Case-insensitive pattern matching
    IS_NULL = "is_null" # Field is null
    NOT_NULL = "not_null" # Field is not null
    CONTAINS = "contains" # Array/JSON contains value
    CONTAINED_BY = "contained_by" # Value contained by array/JSON

class FilterCondition(TypedDict):
    """Type definition for complex filter conditions."""
    field: str                          # Field name to filter
    operator: FilterOperator            # Filter operator
    value: Any                          # Filter value
    case_sensitive: NotRequired[bool]   # Case sensitivity for string operations

# Operation results
class OperationResult(TypedDict, Generic[EntityType]):
    """Type definition for operation results with metadata."""
    success: bool                               # Operation success status
    entity: NotRequired[EntityType]             # Single entity result
    entities: NotRequired[List[EntityType]]     # Multiple entities result
    affected_count: NotRequired[int]            # Number of affected entities
    error: NotRequired[str]                     # Error message if failed
    metadata: NotRequired[Dict[str, Any]]       # Additional operation metadata

class PaginatedResult(TypedDict, Generic[EntityType]):
    """Type definition for paginated query results."""
    entities: List[EntityType]         # Entities in current page
    total_count: int                   # Total entities matching criteria
    page_size: int                     # Requested page size
    current_offset: int                # Current page offset
    has_more: bool                     # Whether more pages available
    metadata: NotRequired[Dict[str, Any]]  # Additional pagination metadata
```

### Entity Protocols

```python
from typing import Protocol, runtime_checkable, List, Optional
from datetime import datetime

@runtime_checkable
class ValidatableEntity(Protocol):
    """Protocol for entities that support validation."""
    
    def validate(self) -> bool:
        """
        Validate entity data.
        
        Returns:
            bool: True if entity is valid, False otherwise
        """
        ...
    
    def get_validation_errors(self) -> List[str]:
        """
        Get list of validation errors.
        
        Returns:
            List[str]: List of validation error messages
        """
        ...

@runtime_checkable  
class TimestampedEntity(Protocol):
    """Protocol for entities with automatic timestamps."""
    
    created_at: Optional[datetime]  # Creation timestamp
    updated_at: Optional[datetime]  # Last update timestamp

@runtime_checkable
class VersionedEntity(Protocol):
    """Protocol for entities with version control."""
    
    version: Optional[str]           # Entity version identifier
    last_modified_by: Optional[str]  # User who last modified entity

@runtime_checkable
class SoftDeletableEntity(Protocol):
    """Protocol for entities supporting soft deletion."""
    
    deleted_at: Optional[datetime]   # Soft deletion timestamp
    is_deleted: bool                 # Soft deletion flag
```

## Error Handling

### Exception Hierarchy

```python
class RepositoryError(Exception):
    """Base class for all repository errors."""
    
    def __init__(self, message: str, original_error: Optional[Exception] = None):
        super().__init__(message)
        self.original_error = original_error
        self.timestamp = datetime.utcnow()

# Validation errors
class ValidationError(RepositoryError):
    """Data validation failures."""
    
    def __init__(self, message: str, validation_errors: Optional[List[str]] = None):
        super().__init__(message)
        self.validation_errors = validation_errors or []

class ConstraintViolationError(RepositoryError):
    """Database constraint violations."""
    
    def __init__(self, message: str, constraint_name: Optional[str] = None):
        super().__init__(message)
        self.constraint_name = constraint_name

# Entity errors  
class EntityNotFoundError(RepositoryError):
    """Requested entity does not exist."""
    
    def __init__(self, entity_type: str, entity_id: Any):
        message = f"{entity_type} with ID '{entity_id}' not found"
        super().__init__(message)
        self.entity_type = entity_type
        self.entity_id = entity_id

class DuplicateEntityError(RepositoryError):
    """Entity already exists (uniqueness violation)."""
    
    def __init__(self, entity_type: str, field_name: str, field_value: Any):
        message = f"{entity_type} with {field_name}='{field_value}' already exists"
        super().__init__(message)
        self.entity_type = entity_type
        self.field_name = field_name
        self.field_value = field_value

# Operation errors
class DatabaseConnectionError(RepositoryError):
    """Database connection failures."""
    pass

class DatabaseOperationError(RepositoryError):
    """Database operation failures."""
    pass

class ConcurrencyError(RepositoryError):
    """Concurrent modification conflicts."""
    
    def __init__(self, message: str, expected_version: Optional[str] = None, 
                 actual_version: Optional[str] = None):
        super().__init__(message)
        self.expected_version = expected_version
        self.actual_version = actual_version

class QueryError(RepositoryError):
    """Query construction or execution errors."""
    
    def __init__(self, message: str, query: Optional[str] = None):
        super().__init__(message)
        self.query = query

# Batch operation errors
class BatchOperationError(RepositoryError):
    """Batch operation failures with detailed results."""
    
    def __init__(self, message: str, failed_items: List[Dict[str, Any]]):
        super().__init__(message)
        self.failed_items = failed_items
        self.failed_count = len(failed_items)

class DataIntegrityError(RepositoryError):
    """Data integrity constraint violations."""
    pass
```

## Configuration

### Database Configuration

```python
from dataclasses import dataclass
from enum import Enum
from typing import Optional

class DatabaseType(str, Enum):
    SUPABASE = "supabase"
    POSTGRESQL = "postgresql"  
    SQLITE = "sqlite"

class Environment(str, Enum):
    DEVELOPMENT = "development"
    TESTING = "testing"
    STAGING = "staging"
    PRODUCTION = "production"

@dataclass
class ConnectionConfig:
    """Database connection configuration."""
    host: str
    port: int
    database: str
    username: str
    password: str
    pool_size: int = 10
    max_connections: int = 20
    connection_timeout: int = 30
    query_timeout: int = 60

@dataclass
class SecurityConfig:
    """Database security configuration."""
    ssl_required: bool = True
    ssl_mode: str = "require"
    certificate_path: Optional[str] = None
    verify_ssl_cert: bool = True

@dataclass
class PerformanceConfig:
    """Database performance configuration."""
    query_cache_size: int = 1000
    connection_pool_recycle: int = 3600
    slow_query_threshold: float = 1.0
    batch_size: int = 100

@dataclass
class DatabaseConfig:
    """Comprehensive database configuration."""
    database_type: DatabaseType
    environment: Environment
    connection: ConnectionConfig
    security: SecurityConfig
    performance: PerformanceConfig
    
    def validate(self) -> None:
        """Validate configuration based on environment."""
        if self.environment == Environment.PRODUCTION:
            if not self.security.ssl_required:
                raise ValueError("SSL required in production")
            if self.connection.pool_size < 5:
                raise ValueError("Minimum pool size of 5 required in production")
```

## Usage Examples

### Basic Repository Operations

```python
async def basic_repository_usage():
    """Examples of basic repository operations."""
    
    # Initialize database with lazy loading
    db = LazySupabaseDatabase(supabase_client)
    
    # Create a new source
    source = Source(
        url="https://example.com/docs",
        source_type=SourceType.WEBSITE,
        title="Example Documentation"
    )
    created_source = await db.sources.create(source)
    print(f"Created source with ID: {created_source.id}")
    
    # Retrieve by ID with type safety
    found_source = await db.sources.get_by_id(created_source.id)
    if found_source:
        print(f"Found source: {found_source.title}")
    
    # Update with validation
    updated_source = await db.sources.update(
        created_source.id,
        {
            "title": "Updated Documentation",
            "description": "Updated description",
            "last_updated": datetime.now()
        }
    )
    
    # Check existence
    exists = await db.sources.exists(created_source.id)
    print(f"Source exists: {exists}")
    
    # Delete (soft delete available)
    deleted = await db.sources.delete(created_source.id, soft_delete=True)
    print(f"Source deleted: {deleted}")

async def advanced_querying():
    """Examples of advanced querying operations."""
    
    db = LazySupabaseDatabase(supabase_client)
    
    # Complex filtering and pagination
    active_sources = await db.sources.list(
        filters={
            "status": "active",
            "source_type": SourceType.WEBSITE
        },
        pagination=PaginationParams(limit=20, offset=0),
        ordering=[
            OrderingField(field="created_at", direction=SortDirection.DESC),
            OrderingField(field="title", direction=SortDirection.ASC)
        ],
        return_total_count=True
    )
    
    print(f"Page 1 of {active_sources.total_count} sources")
    print(f"Has more pages: {active_sources.has_more}")
    
    # Count with filters
    website_count = await db.sources.count(
        filters={"source_type": SourceType.WEBSITE}
    )
    print(f"Total websites: {website_count}")
    
    # Distinct counting
    unique_types = await db.sources.count(distinct_field="source_type")
    print(f"Unique source types: {unique_types}")

async def batch_operations():
    """Examples of batch operations."""
    
    db = LazySupabaseDatabase(supabase_client)
    
    # Batch creation
    sources = [
        Source(url=f"https://site{i}.com", source_type=SourceType.WEBSITE)
        for i in range(1, 101)
    ]
    
    result = await db.sources.create_batch(
        sources,
        batch_size=25,
        validate_all=True,
        stop_on_first_error=False
    )
    
    if result.success:
        print(f"Successfully created {result.affected_count} sources")
    else:
        print(f"Batch creation failed: {result.error}")
        failed_items = result.metadata.get('failed_items', [])
        for failure in failed_items:
            print(f"Failed: {failure['error']}")
    
    # Batch updates
    updates = [
        {"id": source.id, "status": "active", "last_checked": datetime.now()}
        for source in result.entities[:10]
    ]
    
    update_result = await db.sources.update_batch(updates)
    print(f"Updated {update_result.affected_count} sources")
    
    # Batch deletion
    ids_to_delete = [source.id for source in result.entities[10:20]]
    deleted_count = await db.sources.delete_batch(ids_to_delete, soft_delete=True)
    print(f"Soft deleted {deleted_count} sources")

async def transaction_usage():
    """Examples of transaction usage."""
    
    db = LazySupabaseDatabase(supabase_client)
    
    # Basic transaction
    async with db.transaction() as uow:
        # Create project
        project = await uow.projects.create(Project(
            name="New Project",
            description="Project description",
            github_repo="https://github.com/user/repo"
        ))
        
        # Create initial tasks
        tasks = [
            Task(project_id=project.id, title="Setup", status=TaskStatus.TODO),
            Task(project_id=project.id, title="Implementation", status=TaskStatus.TODO),
            Task(project_id=project.id, title="Testing", status=TaskStatus.TODO)
        ]
        
        task_result = await uow.tasks.create_batch(tasks)
        
        # Create initial documents
        documents = [
            Document(
                project_id=project.id,
                title="Requirements",
                content="Project requirements document"
            )
        ]
        
        await uow.documents.create_batch(documents)
        
        # All operations commit together or rollback on any failure
        print(f"Created project with {len(tasks)} tasks")
    
    # Savepoint usage for partial rollback
    async with db.transaction() as uow:
        # Create user
        user = await uow.users.create(user_data)
        
        # Create savepoint before risky operations
        savepoint_id = await uow.savepoint("before_profile_creation")
        
        try:
            # Risky operation that might fail
            profile = await uow.profiles.create(risky_profile_data)
            # Release savepoint - profile creation successful
            await uow.release_savepoint(savepoint_id)
        except Exception as e:
            # Rollback to savepoint - keep user, discard profile
            await uow.rollback_to_savepoint(savepoint_id)
            print(f"Profile creation failed, but user was kept: {e}")
        
        # Transaction commits with user (and profile if successful)

async def domain_specific_operations():
    """Examples of domain-specific repository operations."""
    
    db = LazySupabaseDatabase(supabase_client)
    
    # Knowledge domain operations
    source = await db.sources.get_by_url("https://python.org/docs")
    if source:
        # Update crawl status
        await db.sources.update_crawl_status(
            source.id,
            CrawlStatus.IN_PROGRESS,
            pages_crawled=50
        )
    
    # Semantic search in documents
    query_embedding = await embedding_service.embed("repository pattern Python")
    similar_docs = await db.documents.search_by_embedding(
        query_embedding,
        limit=10,
        similarity_threshold=0.8
    )
    
    # Code example search
    python_examples = await db.code_examples.search_by_language(
        ProgrammingLanguage.PYTHON
    )
    
    async_examples = await db.code_examples.get_by_tags(
        ["async", "await"],
        match_all=True
    )
    
    # Project domain operations
    project_with_tasks = await db.projects.get_with_tasks(project.id)
    if project_with_tasks:
        print(f"Project has {len(project_with_tasks.tasks)} tasks")
    
    # Task management
    todo_tasks = await db.tasks.get_by_status(TaskStatus.TODO)
    high_priority_tasks = await db.tasks.get_tasks_by_priority(
        project.id,
        min_priority=TaskPriority.HIGH
    )

async def error_handling_examples():
    """Examples of error handling patterns."""
    
    db = LazySupabaseDatabase(supabase_client)
    
    try:
        # This might raise various exceptions
        source = await db.sources.create(invalid_source_data)
    except ValidationError as e:
        print(f"Validation failed: {e}")
        for error in e.validation_errors:
            print(f"  - {error}")
    except DuplicateEntityError as e:
        print(f"Duplicate entity: {e.entity_type} with {e.field_name}={e.field_value}")
    except ConstraintViolationError as e:
        print(f"Constraint violation: {e}")
        if e.constraint_name:
            print(f"  Constraint: {e.constraint_name}")
    except DatabaseConnectionError as e:
        print(f"Database connection failed: {e}")
        # Implement retry logic or fallback
    except RepositoryError as e:
        print(f"Repository error: {e}")
        if e.original_error:
            print(f"  Original error: {e.original_error}")
    
    # Batch operation error handling
    try:
        result = await db.sources.create_batch(batch_data)
        if not result.success:
            print(f"Batch operation failed: {result.error}")
            # Handle partial failures
            failed_items = result.metadata.get('failed_items', [])
            for item in failed_items:
                print(f"Failed item: {item}")
    except BatchOperationError as e:
        print(f"Batch operation error: {e}")
        print(f"Failed {e.failed_count} items out of {len(batch_data)}")
```

This comprehensive API reference provides detailed documentation for all repository interfaces, type annotations, method signatures, and practical usage examples. The documentation emphasizes type safety, error handling, and performance considerations while providing clear examples for both basic and advanced use cases.