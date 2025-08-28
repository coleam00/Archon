"""
Base repository interface defining common database operations.

This module provides the foundational IBaseRepository interface that all
domain-specific repositories should inherit from. It uses Python generics
to provide type safety while maintaining flexibility for different entity types.
"""

from __future__ import annotations

import builtins
from abc import ABC, abstractmethod
from collections.abc import Sequence
from datetime import datetime
from enum import Enum
from typing import (
    Any,
    Generic,
    Literal,
    NotRequired,
    Protocol,
    TypedDict,
    TypeVar,
    overload,
    runtime_checkable,
)
from uuid import UUID

# Import custom exceptions

# Generic type variables for enhanced type safety
EntityType = TypeVar('EntityType')  # The entity type this repository manages
IdType = TypeVar('IdType', str, UUID, int)  # Supported ID types
FilterType = TypeVar('FilterType', bound=dict[str, Any])  # Filter parameter type


# Ordering and sorting type definitions
class SortDirection(str, Enum):
    """Enumeration of supported sort directions with validation."""
    ASC = "asc"
    DESC = "desc"
    ASCENDING = "ascending"
    DESCENDING = "descending"


class OrderingField(TypedDict):
    """Type definition for ordering field specification."""
    field: str
    direction: SortDirection
    nulls_first: NotRequired[bool]  # Whether NULL values should come first


# Pagination and filtering type definitions
class PaginationParams(TypedDict):
    """Type definition for pagination parameters with validation."""
    limit: NotRequired[int]  # Maximum number of results (1-10000)
    offset: NotRequired[int]  # Number of results to skip (>=0)


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
    field: str
    operator: FilterOperator
    value: Any
    case_sensitive: NotRequired[bool]


# Result type definitions
class OperationResult(TypedDict, Generic[EntityType]):
    """Type definition for operation results with metadata."""
    success: bool
    entity: NotRequired[EntityType]
    entities: NotRequired[list[EntityType]]
    affected_count: NotRequired[int]
    error: NotRequired[str]
    metadata: NotRequired[dict[str, Any]]


class PaginatedResult(TypedDict, Generic[EntityType]):
    """Type definition for paginated query results."""
    entities: list[EntityType]
    total_count: int
    page_size: int
    current_offset: int
    has_more: bool
    metadata: NotRequired[dict[str, Any]]


# Protocol for validatable entities
@runtime_checkable
class ValidatableEntity(Protocol):
    """Protocol for entities that support validation."""

    def validate(self) -> bool:
        """Validate entity data."""
        ...

    def get_validation_errors(self) -> list[str]:
        """Get list of validation errors."""
        ...


# Protocol for timestamped entities
@runtime_checkable
class TimestampedEntity(Protocol):
    """Protocol for entities with automatic timestamps."""

    created_at: datetime | None
    updated_at: datetime | None


# Protocol for versioned entities
@runtime_checkable
class VersionedEntity(Protocol):
    """Protocol for entities with version control."""

    version: str | None
    last_modified_by: str | None


class IBaseRepository(ABC, Generic[EntityType]):
    """
    Abstract base repository interface defining common database operations.
    
    This interface provides a standardized contract for all repository implementations,
    ensuring consistent behavior across different domain entities while maintaining
    type safety through Python generics.
    
    Type Parameters:
        T: The entity type that this repository manages
    
    Example:
        ```python
        class UserRepository(IBaseRepository[User]):
            async def create(self, entity: User) -> User:
                # Implementation specific to User entities
                pass
        ```
    """

    # Core CRUD operations with enhanced type safety
    @abstractmethod
    async def create(self, entity: EntityType) -> EntityType:
        """
        Create a new entity in the database with validation and constraint checking.
        
        Args:
            entity: The entity instance to create (must implement ValidatableEntity if validation needed)
            
        Returns:
            The created entity with database-generated fields populated (id, timestamps)
            
        Raises:
            ValidationError: If entity data fails validation rules
            DuplicateEntityError: If entity violates uniqueness constraints
            ConstraintViolationError: If entity violates database constraints
            DatabaseOperationError: If database operation fails
            
        Type Safety:
            - Input entity must be of type EntityType
            - Returned entity guaranteed to have id and timestamps populated
            - Validation performed if entity implements ValidatableEntity protocol
        """
        pass

    @overload
    async def get_by_id(self, id: UUID) -> EntityType | None: ...
    @overload
    async def get_by_id(self, id: str) -> EntityType | None: ...
    @overload
    async def get_by_id(self, id: int) -> EntityType | None: ...

    @abstractmethod
    async def get_by_id(self, id: str | UUID | int) -> EntityType | None:
        """
        Retrieve an entity by its unique identifier with type safety.
        
        Args:
            id: The unique identifier (UUID for primary keys, str for natural keys, int for legacy IDs)
            
        Returns:
            The entity if found, None if not found (never raises for missing entities)
            
        Raises:
            ValidationError: If id format is invalid
            DatabaseConnectionError: If database connection fails
            DatabaseOperationError: If database query fails
            
        Type Safety:
            - Accepts only valid ID types (UUID, str, int)
            - Returns strongly typed Optional[EntityType]
            - None return indicates entity not found (not an error condition)
        """
        pass

    @abstractmethod
    async def update(
        self,
        id: str | UUID | int,
        data: dict[str, Any],
        *,
        validate: bool = True,
        ignore_missing: bool = False
    ) -> EntityType | None:
        """
        Update an existing entity with validation and concurrency control.
        
        Args:
            id: Unique identifier of entity to update
            data: Dictionary of field updates (only changed fields)
            validate: Whether to perform validation on updated entity
            ignore_missing: If True, return None for missing entities instead of raising
            
        Returns:
            Updated entity with new timestamps, None if not found and ignore_missing=True
            
        Raises:
            EntityNotFoundError: If entity doesn't exist and ignore_missing=False
            ValidationError: If updated data fails validation (when validate=True)
            ConcurrencyError: If entity was modified by another process
            ConstraintViolationError: If update violates constraints
            DatabaseOperationError: If database update fails
            
        Type Safety:
            - Validates data keys against entity schema
            - Returns fully typed entity with updated fields
            - Automatically updates updated_at timestamp if supported
        """
        pass

    @abstractmethod
    async def delete(self, id: str | UUID | int, *, soft_delete: bool = False) -> bool:
        """
        Delete an entity with support for soft deletion.
        
        Args:
            id: Unique identifier of entity to delete
            soft_delete: If True, mark as deleted instead of removing from database
            
        Returns:
            True if entity was deleted, False if not found
            
        Raises:
            ConstraintViolationError: If deletion violates foreign key constraints
            DatabaseOperationError: If database deletion fails
            
        Type Safety:
            - Validates ID type and format
            - Boolean return clearly indicates operation success
            - Soft delete preserves referential integrity when supported
        """
        pass

    # Enhanced list method with comprehensive filtering and ordering
    @overload
    async def list(
        self,
        *,
        filters: dict[str, Any] | None = None,
        pagination: PaginationParams | None = None,
        ordering: builtins.list[OrderingField] | None = None,
        return_total_count: Literal[False] = False
    ) -> builtins.list[EntityType]: ...

    @overload
    async def list(
        self,
        *,
        filters: dict[str, Any] | None = None,
        pagination: PaginationParams | None = None,
        ordering: builtins.list[OrderingField] | None = None,
        return_total_count: Literal[True]
    ) -> PaginatedResult[EntityType]: ...

    @abstractmethod
    async def list(
        self,
        *,
        filters: dict[str, Any] | None = None,
        pagination: PaginationParams | None = None,
        ordering: builtins.list[OrderingField] | None = None,
        return_total_count: bool = False
    ) -> builtins.list[EntityType] | PaginatedResult[EntityType]:
        """
        List entities with advanced filtering, pagination, and guaranteed ordering.
        
        Args:
            filters: Simple field-value filters or complex FilterCondition objects
            pagination: Limit and offset parameters with validation
            ordering: List of fields to sort by with direction and null handling
            return_total_count: Whether to return paginated result with total count
            
        Returns:
            List of entities or paginated result with metadata
            
        Raises:
            ValidationError: If filter values or pagination params are invalid
            QueryError: If ordering fields don't exist or query construction fails
            DatabaseOperationError: If database query fails
            
        Type Safety & Ordering Guarantees:
            - Results always ordered by: specified ordering, then created_at DESC, then id ASC
            - Pagination parameters validated (limit 1-10000, offset >= 0)
            - Filter values type-checked against entity schema
            - Deterministic ordering ensures consistent pagination
        """
        pass

    @abstractmethod
    async def count(
        self,
        filters: dict[str, Any] | None = None,
        *,
        distinct_field: str | None = None
    ) -> int:
        """
        Count entities with optional distinct counting.
        
        Args:
            filters: Same filter format as list() method
            distinct_field: If provided, count distinct values of this field
            
        Returns:
            Number of entities/distinct values matching criteria
            
        Raises:
            ValidationError: If filter parameters are invalid
            QueryError: If distinct_field doesn't exist
            DatabaseOperationError: If count query fails
            
        Type Safety:
            - Validates filter types and values
            - Returns non-negative integer count
            - Distinct counting validates field existence
        """
        pass

    @abstractmethod
    async def exists(
        self,
        id: str | UUID | int,
        *,
        additional_filters: dict[str, Any] | None = None
    ) -> bool:
        """
        Check entity existence with optional additional conditions.
        
        Args:
            id: Primary identifier to check
            additional_filters: Additional conditions entity must meet
            
        Returns:
            True if entity exists and matches all conditions
            
        Raises:
            ValidationError: If id format or filters are invalid
            DatabaseOperationError: If existence check fails
            
        Type Safety:
            - Validates ID type and format
            - Boolean return with no ambiguity
            - Additional filters follow same validation as list()
        """
        pass

    # Batch operations with detailed error tracking
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
            batch_size: Number of entities to process in each database batch
            validate_all: Whether to validate all entities before processing
            stop_on_first_error: Whether to abort on first error or continue
            
        Returns:
            Operation result with success/failure details and created entities
            
        Raises:
            ValidationError: If validate_all=True and any entity is invalid
            BatchOperationError: If batch processing encounters errors
            DatabaseOperationError: If database batch operation fails
            
        Type Safety & Error Handling:
            - Validates all entities implement required protocols
            - Returns detailed results with per-item success/failure status
            - Failed entities include specific error messages
            - Successful entities guaranteed to have IDs populated
        """
        pass

    @abstractmethod
    async def update_batch(
        self,
        updates: Sequence[dict[str, Any]],
        *,
        batch_size: int = 100,
        validate_updates: bool = True
    ) -> OperationResult[EntityType]:
        """
        Update multiple entities with validation and error tracking.
        
        Args:
            updates: Sequence of update dictionaries, each must contain 'id' key
            batch_size: Number of updates to process in each batch
            validate_updates: Whether to validate update data
            
        Returns:
            Operation result with updated entities and error details
            
        Raises:
            ValidationError: If any update dictionary is invalid
            BatchOperationError: If batch processing encounters errors
            DatabaseOperationError: If database batch update fails
            
        Type Safety:
            - Validates each update dict has required 'id' key
            - Type-checks update values against entity schema
            - Returns typed entities with updated fields
        """
        pass

    @abstractmethod
    async def delete_batch(
        self,
        ids: Sequence[str | UUID | int],
        *,
        batch_size: int = 100,
        soft_delete: bool = False
    ) -> int:
        """
        Delete multiple entities with optional soft deletion.
        
        Args:
            ids: Sequence of entity identifiers to delete
            batch_size: Number of deletions to process in each batch
            soft_delete: Whether to perform soft deletion
            
        Returns:
            Number of entities actually deleted (may be less than input if some not found)
            
        Raises:
            ValidationError: If any ID format is invalid
            ConstraintViolationError: If deletions violate foreign key constraints
            DatabaseOperationError: If batch deletion fails
            
        Type Safety:
            - Validates all IDs are proper types and formats
            - Return count guaranteed to be <= len(ids)
            - Batch processing ensures transaction consistency
        """
        pass
