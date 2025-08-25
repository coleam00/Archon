"""
SupabaseDatabase - Main database abstraction class.

This module provides the main SupabaseDatabase class that serves as the single point
of contact for all database operations. It initializes all repository implementations
and provides transaction support through the Unit of Work pattern.
"""

import logging
from contextlib import asynccontextmanager
from typing import Optional

from supabase import Client

from ..interfaces.unit_of_work import IUnitOfWork
from .supabase_repositories import (
    SupabaseDocumentRepository,
    SupabaseProjectRepository,
    SupabaseSettingsRepository,
    SupabaseSourceRepository,
    SupabaseTaskRepository,
    SupabaseVersionRepository,
    SupabaseCodeExampleRepository,
    SupabasePromptRepository,
)


class SupabaseDatabase(IUnitOfWork):
    """
    Concrete implementation of all repository interfaces using Supabase.
    
    This class serves as the single point of contact for all database operations,
    providing access to all repository implementations and transaction management.
    It follows the Unit of Work pattern to ensure data consistency across operations.
    """
    
    def __init__(self, client: Optional[Client] = None):
        """
        Initialize the database with an optional Supabase client.
        
        Args:
            client: Optional Supabase client. If not provided, will use default client.
        """
        self._client = client or self._get_default_client()
        self._logger = logging.getLogger(__name__)
        
        # Initialize repository implementations as properties
        self._sources: Optional[SupabaseSourceRepository] = None
        self._documents: Optional[SupabaseDocumentRepository] = None
        self._code_examples: Optional[SupabaseCodeExampleRepository] = None
        self._projects: Optional[SupabaseProjectRepository] = None
        self._tasks: Optional[SupabaseTaskRepository] = None
        self._versions: Optional[SupabaseVersionRepository] = None
        self._settings: Optional[SupabaseSettingsRepository] = None
        self._prompts: Optional[SupabasePromptRepository] = None
        
        # Transaction state management
        self._active = False
        self._savepoints = {}
        self._savepoint_counter = 0
        
        self._logger.info("SupabaseDatabase initialized with repository implementations")
    
    @staticmethod
    def _get_default_client() -> Client:
        """
        Get default Supabase client from environment.
        
        Returns:
            Configured Supabase client instance
            
        Raises:
            ImportError: If client_manager cannot be imported
            ValueError: If Supabase configuration is missing
        """
        try:
            from ...services.client_manager import get_supabase_client
            return get_supabase_client()
        except ImportError as e:
            raise ImportError(f"Failed to import client_manager: {e}")
    
    @property
    def sources(self) -> SupabaseSourceRepository:
        """Get or create the sources repository."""
        if self._sources is None:
            self._sources = SupabaseSourceRepository(self._client)
        return self._sources
    
    @property
    def documents(self) -> SupabaseDocumentRepository:
        """Get or create the documents repository."""
        if self._documents is None:
            self._documents = SupabaseDocumentRepository(self._client)
        return self._documents
    
    @property
    def code_examples(self) -> SupabaseCodeExampleRepository:
        """Get or create the code examples repository."""
        if self._code_examples is None:
            self._code_examples = SupabaseCodeExampleRepository(self._client)
        return self._code_examples
    
    @property
    def projects(self) -> SupabaseProjectRepository:
        """Get or create the projects repository."""
        if self._projects is None:
            self._projects = SupabaseProjectRepository(self._client)
        return self._projects
    
    @property
    def tasks(self) -> SupabaseTaskRepository:
        """Get or create the tasks repository."""
        if self._tasks is None:
            self._tasks = SupabaseTaskRepository(self._client)
        return self._tasks
    
    @property
    def versions(self) -> SupabaseVersionRepository:
        """Get or create the versions repository."""
        if self._versions is None:
            self._versions = SupabaseVersionRepository(self._client)
        return self._versions
    
    @property
    def settings(self) -> SupabaseSettingsRepository:
        """Get or create the settings repository."""
        if self._settings is None:
            self._settings = SupabaseSettingsRepository(self._client)
        return self._settings
    
    @property
    def prompts(self) -> SupabasePromptRepository:
        """Get or create the prompts repository."""
        if self._prompts is None:
            self._prompts = SupabasePromptRepository(self._client)
        return self._prompts
    
    @asynccontextmanager
    async def transaction(self):
        """
        Provide transaction context for atomic operations.
        
        Note: Current Supabase Python client doesn't support explicit transactions,
        so this implementation provides the interface for future extension.
        Individual operations are atomic by default.
        
        Yields:
            Self instance for chaining operations within transaction context
            
        Example:
            async with database.transaction():
                await database.projects.create(project_data)
                await database.tasks.create(task_data)
        """
        try:
            self._logger.debug("Starting database transaction")
            await self.begin()
            yield self
            await self.commit()
            self._logger.debug("Database transaction committed successfully")
        except Exception as e:
            self._logger.error(f"Database transaction failed: {e}")
            if self._active:
                await self.rollback()
            raise
    
    async def commit(self):
        """
        Commit the current transaction.
        
        Note: With Supabase, individual operations are auto-committed.
        This method validates that a transaction is active, then performs a no-op
        for Supabase compatibility.
        
        Raises:
            RuntimeError: If no active transaction exists
        """
        if not self._active:
            raise RuntimeError("Cannot commit: no active transaction")
        
        # Supabase auto-commits individual operations
        # This method is a no-op but maintained for interface compatibility
        self._active = False
        self._logger.debug("Transaction committed (Supabase auto-commits)")
    
    async def rollback(self):
        """
        Rollback the current transaction.
        
        Note: With Supabase, rollback would need to be implemented at the application level.
        This method validates that a transaction is active, logs a warning, then performs
        a no-op for Supabase compatibility.
        
        Raises:
            RuntimeError: If no active transaction exists
        """
        if not self._active:
            raise RuntimeError("Cannot rollback: no active transaction")
        
        # Supabase doesn't support rollback in the Python client
        # Application-level rollback would need to be implemented here
        self._logger.warning("Rollback requested but not implemented for Supabase (no-op)")
        self._active = False
    
    async def begin(self) -> None:
        """
        Begin a new transaction.
        
        Note: With Supabase, transactions are not explicitly managed.
        This method sets the internal active state for interface compatibility.
        """
        if self._active:
            self._logger.warning("Transaction already active")
        self._active = True
        self._logger.debug("Transaction begun (simulated)")
    
    async def is_active(self) -> bool:
        """
        Check if a transaction is currently active.
        
        Returns:
            True if a transaction is currently active, False otherwise
        """
        return self._active
    
    async def savepoint(self, name: str) -> str:
        """
        Create a savepoint within the current transaction.
        
        Note: Supabase doesn't support savepoints in the Python client.
        This implementation provides minimal compatibility.
        
        Args:
            name: Name identifier for the savepoint
            
        Returns:
            The savepoint identifier that can be used for rollback
        """
        if not self._active:
            self._logger.warning("Cannot create savepoint without active transaction")
        
        self._savepoint_counter += 1
        savepoint_id = f"{name}_{self._savepoint_counter}"
        self._savepoints[savepoint_id] = name
        self._logger.debug(f"Savepoint created: {savepoint_id}")
        return savepoint_id
    
    async def rollback_to_savepoint(self, savepoint_id: str) -> None:
        """
        Rollback to a specific savepoint within the current transaction.
        
        Note: Supabase doesn't support savepoint rollback in the Python client.
        This implementation provides minimal compatibility.
        
        Args:
            savepoint_id: The savepoint identifier to rollback to
        """
        if savepoint_id not in self._savepoints:
            self._logger.error(f"Savepoint not found: {savepoint_id}")
            raise ValueError(f"Savepoint '{savepoint_id}' does not exist")
        
        self._logger.debug(f"Rolled back to savepoint: {savepoint_id} (simulated)")
        # Remove all savepoints created after this one
        savepoints_to_remove = [
            sid for sid in self._savepoints 
            if int(sid.split('_')[-1]) > int(savepoint_id.split('_')[-1])
        ]
        for sid in savepoints_to_remove:
            del self._savepoints[sid]
    
    async def release_savepoint(self, savepoint_id: str) -> None:
        """
        Release a savepoint, making its changes permanent within the transaction.
        
        Note: Supabase doesn't support savepoint release in the Python client.
        This implementation provides minimal compatibility.
        
        Args:
            savepoint_id: The savepoint identifier to release
        """
        if savepoint_id not in self._savepoints:
            self._logger.error(f"Savepoint not found: {savepoint_id}")
            raise ValueError(f"Savepoint '{savepoint_id}' does not exist")
        
        del self._savepoints[savepoint_id]
        self._logger.debug(f"Savepoint released: {savepoint_id} (simulated)")
    
    async def health_check(self) -> bool:
        """
        Verify database connectivity and basic functionality.
        
        Returns:
            True if database is healthy and accessible, False otherwise
        """
        try:
            # Test basic connectivity by querying the settings table
            response = self._client.table('archon_settings').select('key').limit(1).execute()
            
            # Check if the query executed successfully
            if hasattr(response, 'data') and response.data is not None:
                self._logger.info("Database health check passed")
                return True
            else:
                self._logger.warning("Database health check failed: No data returned")
                return False
                
        except Exception as e:
            self._logger.error(f"Database health check failed: {e}", exc_info=True)
            return False
    
    def get_client(self) -> Client:
        """
        Get the underlying Supabase client.
        
        Returns:
            The Supabase client instance
            
        Note:
            This method is provided for cases where direct client access is needed,
            but it should be used sparingly to maintain abstraction.
        """
        return self._client
    
    async def close(self):
        """
        Close database connections and clean up resources.
        
        Note: Supabase client doesn't require explicit closing,
        but this method is provided for interface compatibility.
        """
        self._logger.info("Database connections closed")
        # Supabase client doesn't require explicit closing
        # This method is provided for interface compatibility
        pass
    
    def __repr__(self) -> str:
        """String representation of the database instance."""
        return f"SupabaseDatabase(client={type(self._client).__name__})"