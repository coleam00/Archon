"""
Unit of Work pattern interface for transaction management.

This module provides the IUnitOfWork interface that defines the contract
for managing database transactions across multiple repository operations.
It ensures data consistency and provides rollback capabilities for complex
operations that span multiple entities.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncContextManager, Self, TypeVar

# Import repository exceptions

# Type variable for Unit of Work implementations
TUnitOfWork = TypeVar('TUnitOfWork', bound='IUnitOfWork')


class IUnitOfWork(ABC):
    """
    Abstract Unit of Work interface for managing database transactions.
    
    The Unit of Work pattern maintains a list of objects affected by a business
    transaction and coordinates writing out changes and resolving concurrency problems.
    This interface provides transaction management capabilities for operations that
    span multiple repositories or require atomic behavior.
    
    Example:
        ```python
        async with unit_of_work.transaction() as uow:
            await uow.users.create(user)
            await uow.profiles.create(profile)
            # Both operations commit together or rollback if either fails
        ```
    """

    @abstractmethod
    def transaction(self) -> AsyncContextManager[Self]:
        """
        Context manager for database transactions.
        
        Provides automatic transaction management with commit on successful completion
        and rollback on exceptions. All repository operations within this context
        will be part of the same transaction.
        
        Yields:
            Self - The unit of work instance (or transaction-scoped UoW) for executing transactional operations
            
        Raises:
            TransactionError: If transaction management fails
            DatabaseOperationError: If underlying database operations fail
            
        Example:
            ```python
            async with uow.transaction() as uow_context:
                user = await uow_context.users.create(user_data)
                await uow_context.audit_logs.create(audit_entry)
                # Automatic commit on success, rollback on exception
            ```
        """
        pass

    @abstractmethod
    async def commit(self) -> None:
        """
        Manually commit the current transaction.
        
        Commits all pending changes within the current transaction context.
        This method should only be called when managing transactions manually
        rather than using the transaction context manager.
        
        Raises:
            TransactionError: If no active transaction or commit fails
            DatabaseOperationError: If database commit operation fails
        """
        pass

    @abstractmethod
    async def rollback(self) -> None:
        """
        Manually rollback the current transaction.
        
        Discards all pending changes within the current transaction context.
        This method should only be called when managing transactions manually
        or in error recovery scenarios.
        
        Raises:
            TransactionError: If no active transaction or rollback fails
            DatabaseOperationError: If database rollback operation fails
        """
        pass

    @abstractmethod
    async def begin(self) -> None:
        """
        Manually begin a new transaction.
        
        Starts a new database transaction context. This method should only be
        used when managing transactions manually rather than using the
        transaction context manager.
        
        Raises:
            TransactionError: If a transaction is already active or begin fails
            DatabaseOperationError: If database transaction start fails
        """
        pass

    @abstractmethod
    async def is_active(self) -> bool:
        """
        Check if a transaction is currently active.
        
        Returns:
            True if a transaction is currently active, False otherwise
        """
        pass

    @abstractmethod
    async def savepoint(self, name: str) -> str:
        """
        Create a savepoint within the current transaction.
        
        Savepoints allow for partial rollback within a transaction, enabling
        more granular error recovery and nested transaction-like behavior.
        
        Args:
            name: Name identifier for the savepoint
            
        Returns:
            The savepoint identifier that can be used for rollback
            
        Raises:
            TransactionError: If no active transaction or savepoint creation fails
            DatabaseOperationError: If database savepoint operation fails
        """
        pass

    @abstractmethod
    async def rollback_to_savepoint(self, savepoint_id: str) -> None:
        """
        Rollback to a specific savepoint within the current transaction.
        
        Discards all changes made after the specified savepoint while preserving
        changes made before it. The transaction remains active after rollback.
        
        Args:
            savepoint_id: The savepoint identifier to rollback to
            
        Raises:
            TransactionError: If savepoint doesn't exist or rollback fails
            DatabaseOperationError: If database rollback operation fails
        """
        pass

    @abstractmethod
    async def release_savepoint(self, savepoint_id: str) -> None:
        """
        Release a savepoint, making its changes permanent within the transaction.
        
        Once released, a savepoint can no longer be used for rollback but its
        changes become part of the main transaction context.
        
        Args:
            savepoint_id: The savepoint identifier to release
            
        Raises:
            TransactionError: If savepoint doesn't exist or release fails
            DatabaseOperationError: If database release operation fails
        """
        pass

    @abstractmethod
    async def close(self) -> None:
        """
        Close the database connection and clean up resources.
        
        This method should be called when the unit of work is no longer needed,
        typically during application shutdown or cleanup phases.
        
        Raises:
            DatabaseOperationError: If cleanup operations fail
        """
        pass

    @abstractmethod
    async def health_check(self) -> bool:
        """
        Perform a health check on the database connection.
        
        Returns:
            True if the database is accessible and healthy, False otherwise
        """
        pass


class ITransactionContext(ABC):
    """
    Interface for transaction context management.
    
    Provides access to all repositories within a transactional context,
    ensuring that all operations are part of the same database transaction.
    """

    @abstractmethod
    def get_repository(self, repository_type: type) -> Any:
        """
        Get a repository instance within the current transaction context.
        
        Args:
            repository_type: The type of repository to retrieve
            
        Returns:
            Repository instance configured for the current transaction
            
        Raises:
            RepositoryError: If repository type is not supported
        """
        pass


class TransactionError(Exception):
    """Exception raised for transaction management errors."""

    def __init__(self, message: str, original_error: Exception | None = None):
        super().__init__(message)
        self.original_error = original_error


class SavepointError(TransactionError):
    """Exception raised for savepoint-related errors."""
    pass


class NestedTransactionError(TransactionError):
    """Exception raised when attempting to nest transactions incorrectly."""
    pass
