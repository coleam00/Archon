"""
Lazy-loading SupabaseDatabase - Enhanced database abstraction class.

This module provides an enhanced SupabaseDatabase class that uses lazy loading
to initialize repository implementations only when needed. This reduces startup
time, memory usage, and prevents circular import issues.

Features:
- Lazy loading of repository implementations
- Reduced startup time and memory usage
- Better error handling for missing dependencies
- Circular import prevention
- Type-safe repository access
- Transaction support through Unit of Work pattern
"""

import logging
from contextlib import asynccontextmanager
from typing import Optional, Any, Dict

from supabase import Client

from ..interfaces.unit_of_work import IUnitOfWork
from ..interfaces.knowledge_repository import (
    ISourceRepository,
    IDocumentRepository, 
    ICodeExampleRepository
)
from ..interfaces.project_repository import (
    IProjectRepository,
    ITaskRepository,
    IVersionRepository
)
from ..interfaces.settings_repository import (
    ISettingsRepository,
    IPromptRepository
)
from ..lazy_imports import get_repository_class, LazyImportError


class LazySupabaseDatabase(IUnitOfWork):
    """
    Enhanced Supabase database implementation with lazy loading.
    
    This class serves as the single point of contact for all database operations,
    providing access to all repository implementations through lazy loading.
    It follows the Unit of Work pattern to ensure data consistency across operations.
    
    Benefits of lazy loading:
    - Faster startup time (repositories loaded only when accessed)
    - Reduced memory usage (unused repositories not loaded)
    - Better error isolation (import errors only affect used repositories)
    - Circular import prevention
    - Type-safe repository access through interfaces
    """
    
    def __init__(self, client: Optional[Client] = None):
        """
        Initialize the database with an optional Supabase client.
        
        Args:
            client: Optional Supabase client. If not provided, will use default client.
        """
        self._client = client or self._get_default_client()
        self._logger = logging.getLogger(__name__)
        
        # Lazy-loaded repository instances (cached after first access)
        self._repositories: Dict[str, Any] = {}
        
        # Repository class mappings for lazy loading
        self._repository_mappings = {
            'sources': 'SupabaseSourceRepository',
            'documents': 'SupabaseDocumentRepository',
            'code_examples': 'SupabaseCodeExampleRepository',
            'projects': 'SupabaseProjectRepository',
            'tasks': 'SupabaseTaskRepository',
            'versions': 'SupabaseVersionRepository',
            'settings': 'SupabaseSettingsRepository',
            'prompts': 'SupabasePromptRepository'
        }
        
        # Transaction state management
        self._active = False
        self._savepoints = {}
        self._savepoint_counter = 0
        
        # Performance tracking
        self._repository_load_times: Dict[str, float] = {}
        
        self._logger.info("LazySupabaseDatabase initialized with lazy-loading repository system")
    
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
    
    def _get_repository(self, repo_name: str) -> Any:
        """
        Get or create a repository instance using lazy loading.
        
        Args:
            repo_name: Name of the repository to load
            
        Returns:
            The repository instance
            
        Raises:
            LazyImportError: If the repository cannot be loaded
            ValueError: If repository name is not recognized
        """
        # Return cached instance if available
        if repo_name in self._repositories:
            self._logger.debug(f"Returning cached repository: {repo_name}")
            return self._repositories[repo_name]
        
        # Validate repository name
        if repo_name not in self._repository_mappings:
            available = list(self._repository_mappings.keys())
            raise ValueError(
                f"Unknown repository: {repo_name}. "
                f"Available: {', '.join(available)}"
            )
        
        class_name = self._repository_mappings[repo_name]
        
        try:
            import time
            start_time = time.time()
            
            self._logger.debug(f"Lazy loading repository: {repo_name} ({class_name})")
            repository_class = get_repository_class(class_name)
            repository_instance = repository_class(self._client)
            
            # Cache the instance
            self._repositories[repo_name] = repository_instance
            
            # Track load time for performance monitoring
            load_time = time.time() - start_time
            self._repository_load_times[repo_name] = load_time
            
            self._logger.info(f"Successfully loaded repository: {repo_name} ({load_time:.3f}s)")
            return repository_instance
            
        except LazyImportError as e:
            error_msg = f"Failed to lazy load repository {repo_name}: {e}"
            self._logger.error(error_msg)
            raise LazyImportError(error_msg) from e
        
        except Exception as e:
            error_msg = f"Unexpected error loading repository {repo_name}: {e}"
            self._logger.error(error_msg, exc_info=True)
            raise RuntimeError(error_msg) from e
    
    @property
    def sources(self) -> ISourceRepository:
        """Get the sources repository with lazy loading."""
        return self._get_repository('sources')
    
    @property
    def documents(self) -> IDocumentRepository:
        """Get the documents repository with lazy loading."""
        return self._get_repository('documents')
    
    @property
    def code_examples(self) -> ICodeExampleRepository:
        """Get the code examples repository with lazy loading."""
        return self._get_repository('code_examples')
    
    @property
    def projects(self) -> IProjectRepository:
        """Get the projects repository with lazy loading."""
        return self._get_repository('projects')
    
    @property
    def tasks(self) -> ITaskRepository:
        """Get the tasks repository with lazy loading."""
        return self._get_repository('tasks')
    
    @property
    def versions(self) -> IVersionRepository:
        """Get the versions repository with lazy loading."""
        return self._get_repository('versions')
    
    @property
    def settings(self) -> ISettingsRepository:
        """Get the settings repository with lazy loading."""
        return self._get_repository('settings')
    
    @property
    def prompts(self) -> IPromptRepository:
        """Get the prompts repository with lazy loading."""
        return self._get_repository('prompts')
    
    def preload_repositories(self, repo_names: Optional[list[str]] = None):
        """
        Preload specified repositories to warm the cache.
        
        Args:
            repo_names: List of repository names to preload. If None, preload all.
        """
        if repo_names is None:
            repo_names = list(self._repository_mappings.keys())
        
        loaded_count = 0
        for repo_name in repo_names:
            try:
                self._get_repository(repo_name)
                loaded_count += 1
            except Exception as e:
                self._logger.warning(f"Failed to preload repository {repo_name}: {e}")
        
        self._logger.info(f"Preloaded {loaded_count}/{len(repo_names)} repositories")
    
    def get_repository_stats(self) -> Dict[str, Any]:
        """
        Get statistics about repository loading and usage.
        
        Returns:
            Dictionary with repository statistics
        """
        return {
            "loaded_repositories": list(self._repositories.keys()),
            "available_repositories": list(self._repository_mappings.keys()),
            "loaded_count": len(self._repositories),
            "available_count": len(self._repository_mappings),
            "load_times": self._repository_load_times.copy(),
            "total_load_time": sum(self._repository_load_times.values())
        }
    
    def clear_repository_cache(self):
        """Clear the repository cache, forcing reload on next access."""
        cleared_count = len(self._repositories)
        self._repositories.clear()
        self._repository_load_times.clear()
        self._logger.info(f"Cleared {cleared_count} repositories from cache")
    
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
        # Clear repository cache on close
        self.clear_repository_cache()
        # Supabase client doesn't require explicit closing
        # This method is provided for interface compatibility
    
    def __repr__(self) -> str:
        """String representation of the database instance."""
        loaded_repos = len(self._repositories)
        total_repos = len(self._repository_mappings)
        return f"LazySupabaseDatabase(client={type(self._client).__name__}, loaded_repos={loaded_repos}/{total_repos})"


# Alias for backward compatibility
SupabaseDatabase = LazySupabaseDatabase