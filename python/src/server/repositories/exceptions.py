"""
Custom exceptions for repository operations with comprehensive error handling.

This module defines a hierarchy of repository-specific exceptions that provide
detailed error information, support for error recovery, and consistent error
handling patterns across all repository implementations.

Exception Hierarchy:
- RepositoryError (base)
  - ValidationError
  - EntityNotFoundError  
  - DuplicateEntityError
  - ConcurrencyError
  - DatabaseConnectionError
  - DatabaseOperationError
  - TransactionError
  - QueryError
  - ConstraintViolationError
  - DataIntegrityError
"""

from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from uuid import UUID


class RepositoryError(Exception):
    """
    Base exception for all repository operations.
    
    Provides comprehensive error context including operation details,
    entity information, and debugging metadata for enhanced error tracking.
    """
    
    def __init__(
        self,
        message: str,
        operation: Optional[str] = None,
        entity_type: Optional[str] = None,
        entity_id: Optional[Union[str, UUID, int]] = None,
        error_code: Optional[str] = None,
        original_error: Optional[Exception] = None,
        context: Optional[Dict[str, Any]] = None,
        retry_count: int = 0,
        **kwargs
    ):
        """
        Initialize repository error with comprehensive context.
        
        Args:
            message: Human-readable error description
            operation: Repository operation that failed (create, get, update, delete, list, etc.)
            entity_type: Type of entity being operated on (Source, Document, Project, etc.)
            entity_id: Identifier of specific entity that failed
            error_code: Application-specific error code for programmatic handling
            original_error: Underlying exception that caused this error
            context: Additional context data for debugging
            retry_count: Number of retry attempts made
            **kwargs: Additional metadata
        """
        super().__init__(message)
        self.message = message
        self.operation = operation
        self.entity_type = entity_type
        self.entity_id = entity_id
        self.error_code = error_code
        self.original_error = original_error
        self.context = context or {}
        self.retry_count = retry_count
        self.timestamp = datetime.utcnow()
        self.metadata = kwargs
        
        # Add original error details to context if available
        if original_error:
            self.context.update({
                'original_error_type': type(original_error).__name__,
                'original_error_message': str(original_error)
            })
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert exception to dictionary for JSON serialization and logging."""
        return {
            'error_type': self.__class__.__name__,
            'message': self.message,
            'operation': self.operation,
            'entity_type': self.entity_type,
            'entity_id': str(self.entity_id) if self.entity_id else None,
            'error_code': self.error_code,
            'retry_count': self.retry_count,
            'timestamp': self.timestamp.isoformat(),
            'context': self.context,
            'metadata': self.metadata
        }
    
    def is_retryable(self) -> bool:
        """Determine if this error can be retried."""
        return False  # Base implementation - specific subclasses override
    
    def get_suggested_action(self) -> str:
        """Get suggested action for handling this error."""
        return "Check logs for details and contact support if the issue persists."


class ValidationError(RepositoryError):
    """
    Raised when input data fails validation rules.
    
    Includes detailed information about which fields failed validation
    and what the validation requirements are.
    """
    
    def __init__(
        self,
        message: str,
        field_errors: Optional[Dict[str, List[str]]] = None,
        validation_rules: Optional[Dict[str, str]] = None,
        **kwargs
    ):
        """
        Initialize validation error with field-specific details.
        
        Args:
            message: General validation error message
            field_errors: Dictionary mapping field names to lists of error messages
            validation_rules: Dictionary mapping field names to validation rule descriptions
            **kwargs: Additional context
        """
        super().__init__(message, error_code="VALIDATION_FAILED", **kwargs)
        self.field_errors = field_errors or {}
        self.validation_rules = validation_rules or {}
        
        if field_errors:
            self.context['field_errors'] = field_errors
        if validation_rules:
            self.context['validation_rules'] = validation_rules
    
    def get_field_errors(self) -> Dict[str, List[str]]:
        """Get dictionary of field-specific validation errors."""
        return self.field_errors
    
    def has_field_error(self, field_name: str) -> bool:
        """Check if a specific field has validation errors."""
        return field_name in self.field_errors
    
    def get_suggested_action(self) -> str:
        """Get suggested action for validation errors."""
        if self.field_errors:
            fields = ", ".join(self.field_errors.keys())
            return f"Fix validation errors in fields: {fields}"
        return "Review input data against validation requirements."


class EntityNotFoundError(RepositoryError):
    """
    Raised when attempting to retrieve or modify a non-existent entity.
    
    Includes information about search criteria used and suggestions
    for alternative approaches.
    """
    
    def __init__(
        self,
        message: str,
        search_criteria: Optional[Dict[str, Any]] = None,
        **kwargs
    ):
        """
        Initialize entity not found error.
        
        Args:
            message: Error message
            search_criteria: Criteria used to search for the entity
            **kwargs: Additional context
        """
        super().__init__(message, error_code="ENTITY_NOT_FOUND", **kwargs)
        self.search_criteria = search_criteria or {}
        
        if search_criteria:
            self.context['search_criteria'] = search_criteria
    
    def get_suggested_action(self) -> str:
        """Get suggested action for entity not found errors."""
        if self.entity_id:
            return f"Verify that {self.entity_type or 'entity'} with ID {self.entity_id} exists."
        return f"Check if the {self.entity_type or 'entity'} exists or was recently deleted."


class DuplicateEntityError(RepositoryError):
    """
    Raised when attempting to create an entity that already exists.
    
    Includes information about conflicting fields and the existing entity
    if available for conflict resolution.
    """
    
    def __init__(
        self,
        message: str,
        conflicting_fields: Optional[List[str]] = None,
        existing_entity_id: Optional[Union[str, UUID, int]] = None,
        **kwargs
    ):
        """
        Initialize duplicate entity error.
        
        Args:
            message: Error message
            conflicting_fields: List of fields that caused the conflict
            existing_entity_id: ID of the existing conflicting entity
            **kwargs: Additional context
        """
        super().__init__(message, error_code="DUPLICATE_ENTITY", **kwargs)
        self.conflicting_fields = conflicting_fields or []
        self.existing_entity_id = existing_entity_id
        
        if conflicting_fields:
            self.context['conflicting_fields'] = conflicting_fields
        if existing_entity_id:
            self.context['existing_entity_id'] = str(existing_entity_id)
    
    def get_suggested_action(self) -> str:
        """Get suggested action for duplicate entity errors."""
        if self.conflicting_fields:
            fields = ", ".join(self.conflicting_fields)
            return f"Use different values for fields: {fields}, or update the existing entity."
        return "Use different identifying values or update the existing entity instead."


class ConcurrencyError(RepositoryError):
    """
    Raised when concurrent modifications cause conflicts.
    
    Includes information about concurrent operations and timestamps
    to help with conflict resolution strategies.
    """
    
    def __init__(
        self,
        message: str,
        expected_version: Optional[str] = None,
        actual_version: Optional[str] = None,
        last_modified: Optional[datetime] = None,
        **kwargs
    ):
        """
        Initialize concurrency error.
        
        Args:
            message: Error message
            expected_version: Version that was expected
            actual_version: Actual current version
            last_modified: Timestamp of last modification
            **kwargs: Additional context
        """
        super().__init__(message, error_code="CONCURRENCY_CONFLICT", **kwargs)
        self.expected_version = expected_version
        self.actual_version = actual_version
        self.last_modified = last_modified
        
        self.context.update({
            'expected_version': expected_version,
            'actual_version': actual_version,
            'last_modified': last_modified.isoformat() if last_modified else None
        })
    
    def is_retryable(self) -> bool:
        """Concurrency errors can be retried with fresh data."""
        return True
    
    def get_suggested_action(self) -> str:
        """Get suggested action for concurrency errors."""
        return "Refresh the entity data and retry the operation with the latest version."


class DatabaseConnectionError(RepositoryError):
    """
    Raised when database connection fails or is lost.
    
    Includes connection details and retry suggestions for
    connection recovery scenarios.
    """
    
    def __init__(
        self,
        message: str,
        connection_string: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        **kwargs
    ):
        """
        Initialize database connection error.
        
        Args:
            message: Error message
            connection_string: Sanitized connection string (no credentials)
            timeout_seconds: Connection timeout that was used
            **kwargs: Additional context
        """
        super().__init__(message, error_code="DATABASE_CONNECTION_FAILED", **kwargs)
        self.connection_string = connection_string
        self.timeout_seconds = timeout_seconds
        
        if connection_string:
            # Sanitize connection string for logging
            sanitized = self._sanitize_connection_string(connection_string)
            self.context['connection_string'] = sanitized
        if timeout_seconds:
            self.context['timeout_seconds'] = timeout_seconds
    
    def _sanitize_connection_string(self, conn_str: str) -> str:
        """Remove credentials from connection string for safe logging."""
        # Simple sanitization - replace passwords and tokens
        import re
        sanitized = re.sub(r'(password|token|key)=[^;&\s]*', r'\1=***', conn_str, flags=re.IGNORECASE)
        return sanitized
    
    def is_retryable(self) -> bool:
        """Connection errors are typically retryable."""
        return True
    
    def get_suggested_action(self) -> str:
        """Get suggested action for connection errors."""
        return "Check database connectivity, network status, and retry after a delay."


class DatabaseOperationError(RepositoryError):
    """
    Raised when database operations fail due to database-level issues.
    
    Includes SQL error codes, query information, and operation timing
    for database administration and debugging.
    """
    
    def __init__(
        self,
        message: str,
        sql_error_code: Optional[str] = None,
        query_info: Optional[str] = None,
        execution_time_ms: Optional[float] = None,
        affected_rows: Optional[int] = None,
        **kwargs
    ):
        """
        Initialize database operation error.
        
        Args:
            message: Error message
            sql_error_code: Database-specific error code
            query_info: Information about the query that failed (sanitized)
            execution_time_ms: Query execution time in milliseconds
            affected_rows: Number of rows affected by the operation
            **kwargs: Additional context
        """
        super().__init__(message, error_code="DATABASE_OPERATION_FAILED", **kwargs)
        self.sql_error_code = sql_error_code
        self.query_info = query_info
        self.execution_time_ms = execution_time_ms
        self.affected_rows = affected_rows
        
        self.context.update({
            'sql_error_code': sql_error_code,
            'query_info': query_info,
            'execution_time_ms': execution_time_ms,
            'affected_rows': affected_rows
        })
    
    def is_retryable(self) -> bool:
        """Some database errors are retryable (timeouts, deadlocks)."""
        if self.sql_error_code:
            # Common retryable SQL error patterns
            retryable_codes = ['40001', '40P01', '57014', 'HY000']  # Deadlock, timeout codes
            return any(code in (self.sql_error_code or '') for code in retryable_codes)
        return False
    
    def get_suggested_action(self) -> str:
        """Get suggested action for database operation errors."""
        if self.is_retryable():
            return "Retry the operation after a brief delay."
        return "Check database logs and system status. Contact database administrator if needed."


class QueryError(RepositoryError):
    """
    Raised when query construction or execution fails.
    
    Includes query parameters, filter information, and performance
    metrics for query optimization and debugging.
    """
    
    def __init__(
        self,
        message: str,
        query_type: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        sort_fields: Optional[List[str]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        **kwargs
    ):
        """
        Initialize query error.
        
        Args:
            message: Error message
            query_type: Type of query (select, insert, update, delete, vector_search, etc.)
            filters: Query filters that were applied
            sort_fields: Fields used for sorting
            limit: Query limit
            offset: Query offset
            **kwargs: Additional context
        """
        super().__init__(message, error_code="QUERY_FAILED", **kwargs)
        self.query_type = query_type
        self.filters = filters or {}
        self.sort_fields = sort_fields or []
        self.limit = limit
        self.offset = offset
        
        self.context.update({
            'query_type': query_type,
            'filters': filters,
            'sort_fields': sort_fields,
            'limit': limit,
            'offset': offset
        })
    
    def get_suggested_action(self) -> str:
        """Get suggested action for query errors."""
        return "Review query parameters and ensure all filters and sort fields are valid."


class ConstraintViolationError(RepositoryError):
    """
    Raised when database constraints are violated.
    
    Includes information about which constraints were violated
    and guidance for resolving constraint conflicts.
    """
    
    def __init__(
        self,
        message: str,
        constraint_name: Optional[str] = None,
        constraint_type: Optional[str] = None,
        violating_values: Optional[Dict[str, Any]] = None,
        **kwargs
    ):
        """
        Initialize constraint violation error.
        
        Args:
            message: Error message
            constraint_name: Name of the violated constraint
            constraint_type: Type of constraint (primary_key, foreign_key, unique, check, not_null)
            violating_values: Values that violated the constraint
            **kwargs: Additional context
        """
        super().__init__(message, error_code="CONSTRAINT_VIOLATION", **kwargs)
        self.constraint_name = constraint_name
        self.constraint_type = constraint_type
        self.violating_values = violating_values or {}
        
        self.context.update({
            'constraint_name': constraint_name,
            'constraint_type': constraint_type,
            'violating_values': violating_values
        })
    
    def get_suggested_action(self) -> str:
        """Get suggested action for constraint violations."""
        if self.constraint_type == 'foreign_key':
            return "Ensure referenced entities exist before creating relationships."
        elif self.constraint_type == 'unique':
            return "Use different values for unique fields or update existing records."
        elif self.constraint_type == 'not_null':
            return "Provide values for all required fields."
        elif self.constraint_type == 'check':
            return "Ensure field values meet constraint requirements."
        return "Review constraint requirements and adjust data accordingly."


class DataIntegrityError(RepositoryError):
    """
    Raised when data integrity checks fail.
    
    Includes information about integrity violations and
    suggestions for data cleanup and repair.
    """
    
    def __init__(
        self,
        message: str,
        integrity_check: Optional[str] = None,
        expected_value: Optional[Any] = None,
        actual_value: Optional[Any] = None,
        **kwargs
    ):
        """
        Initialize data integrity error.
        
        Args:
            message: Error message
            integrity_check: Name or type of integrity check that failed
            expected_value: Expected value
            actual_value: Actual value found
            **kwargs: Additional context
        """
        super().__init__(message, error_code="DATA_INTEGRITY_VIOLATION", **kwargs)
        self.integrity_check = integrity_check
        self.expected_value = expected_value
        self.actual_value = actual_value
        
        self.context.update({
            'integrity_check': integrity_check,
            'expected_value': expected_value,
            'actual_value': actual_value
        })
    
    def get_suggested_action(self) -> str:
        """Get suggested action for data integrity errors."""
        return "Run data integrity checks and repair inconsistent data before retrying."


class BatchOperationError(RepositoryError):
    """
    Raised when batch operations encounter failures.
    
    Includes detailed information about which items succeeded,
    which failed, and specific error details for each failure.
    """
    
    def __init__(
        self,
        message: str,
        total_items: int,
        successful_items: int,
        failed_items: int,
        item_errors: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ):
        """
        Initialize batch operation error.
        
        Args:
            message: Error message
            total_items: Total number of items in the batch
            successful_items: Number of items that succeeded
            failed_items: Number of items that failed
            item_errors: List of individual item errors with details
            **kwargs: Additional context
        """
        super().__init__(message, error_code="BATCH_OPERATION_FAILED", **kwargs)
        self.total_items = total_items
        self.successful_items = successful_items
        self.failed_items = failed_items
        self.item_errors = item_errors or []
        
        self.context.update({
            'total_items': total_items,
            'successful_items': successful_items,
            'failed_items': failed_items,
            'success_rate': (successful_items / total_items * 100) if total_items > 0 else 0,
            'item_errors': item_errors
        })
    
    def get_success_rate(self) -> float:
        """Get success rate as percentage."""
        return (self.successful_items / self.total_items * 100) if self.total_items > 0 else 0
    
    def is_partial_success(self) -> bool:
        """Check if batch had partial success."""
        return self.successful_items > 0 and self.failed_items > 0
    
    def get_suggested_action(self) -> str:
        """Get suggested action for batch operation errors."""
        if self.is_partial_success():
            return f"Review failed items ({self.failed_items}/{self.total_items}) and retry with corrected data."
        return "Review all item errors and fix underlying issues before retrying the batch."


# Repository-specific exception aliases for backward compatibility and convenience
SourceRepositoryError = RepositoryError
DocumentRepositoryError = RepositoryError
ProjectRepositoryError = RepositoryError
TaskRepositoryError = RepositoryError
SettingsRepositoryError = RepositoryError
VersionRepositoryError = RepositoryError
CodeExampleRepositoryError = RepositoryError
PromptRepositoryError = RepositoryError