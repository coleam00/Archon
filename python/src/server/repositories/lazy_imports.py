"""
Lazy import system for repository implementations.

This module provides lazy loading capabilities for repository implementations
to reduce startup time and memory usage. It uses deferred imports and caching
to load repository classes only when they are actually needed.

The lazy loading system provides:
- Reduced startup time by deferring imports
- Memory efficiency by only loading used repositories
- Type safety through proper type hints
- Circular import prevention
- Error handling for missing dependencies

Usage:
    ```python
    from src.server.repositories.lazy_imports import get_repository_class
    
    # Repository class is imported only when first accessed
    RepositoryClass = get_repository_class("SupabaseSourceRepository")
    instance = RepositoryClass(client)
    ```
"""

import importlib
import logging
import threading
from typing import Any, Dict, Type, Optional, Union, Protocol, runtime_checkable
from functools import lru_cache
from collections.abc import Callable


logger = logging.getLogger(__name__)


class LazyImportError(Exception):
    """Raised when a lazy import operation fails."""
    pass


@runtime_checkable
class RepositoryProtocol(Protocol):
    """Protocol that all repository classes should implement."""
    
    def __init__(self, client: Any) -> None:
        """Initialize repository with client."""
        ...


class RepositoryRegistry:
    """
    Registry for repository implementations with lazy loading support.
    
    This class maintains a mapping of repository names to their import paths
    and provides lazy loading capabilities with thread-safe caching.
    """
    
    # Registry mapping repository names to their import information
    REPOSITORY_REGISTRY: Dict[str, Dict[str, str]] = {
        # Supabase implementations
        "SupabaseSourceRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabaseSourceRepository",
            "interface": "ISourceRepository"
        },
        "SupabaseDocumentRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories", 
            "class": "SupabaseDocumentRepository",
            "interface": "IDocumentRepository"
        },
        "SupabaseCodeExampleRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabaseCodeExampleRepository", 
            "interface": "ICodeExampleRepository"
        },
        "SupabaseProjectRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabaseProjectRepository",
            "interface": "IProjectRepository" 
        },
        "SupabaseTaskRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabaseTaskRepository",
            "interface": "ITaskRepository"
        },
        "SupabaseVersionRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabaseVersionRepository",
            "interface": "IVersionRepository"
        },
        "SupabaseSettingsRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabaseSettingsRepository",
            "interface": "ISettingsRepository"
        },
        "SupabasePromptRepository": {
            "module": "src.server.repositories.implementations.supabase_repositories",
            "class": "SupabasePromptRepository", 
            "interface": "IPromptRepository"
        },
        
        # Mock implementations
        "MockSourceRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockSourceRepository",
            "interface": "ISourceRepository"
        },
        "MockDocumentRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockDocumentRepository",
            "interface": "IDocumentRepository"
        },
        "MockCodeExampleRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockCodeExampleRepository",
            "interface": "ICodeExampleRepository" 
        },
        "MockProjectRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockProjectRepository",
            "interface": "IProjectRepository"
        },
        "MockTaskRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockTaskRepository",
            "interface": "ITaskRepository"
        },
        "MockVersionRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockVersionRepository",
            "interface": "IVersionRepository"
        },
        "MockSettingsRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockSettingsRepository",
            "interface": "ISettingsRepository"
        },
        "MockPromptRepository": {
            "module": "src.server.repositories.implementations.mock_repositories",
            "class": "MockPromptRepository",
            "interface": "IPromptRepository"
        }
    }
    
    def __init__(self):
        """Initialize the registry with thread-safe caching."""
        self._cache: Dict[str, Type[Any]] = {}
        self._lock = threading.RLock()
        self._loading: Dict[str, threading.Event] = {}
    
    @lru_cache(maxsize=32)
    def get_repository_class(self, name: str) -> Type[RepositoryProtocol]:
        """
        Get a repository class by name with thread-safe lazy loading.
        
        Args:
            name: The repository class name to load
            
        Returns:
            The repository class type
            
        Raises:
            LazyImportError: If the repository cannot be loaded
        """
        with self._lock:
            # Check cache first
            if name in self._cache:
                logger.debug(f"Repository class {name} found in cache")
                return self._cache[name]
            
            # Check if another thread is already loading this repository
            if name in self._loading:
                logger.debug(f"Waiting for {name} to be loaded by another thread")
                # Release lock while waiting
                event = self._loading[name]
                self._lock.release()
                try:
                    event.wait(timeout=30.0)  # 30 second timeout
                    if not event.is_set():
                        raise LazyImportError(f"Timeout waiting for {name} to be loaded")
                finally:
                    self._lock.acquire()
                
                # Check cache again after waiting
                if name in self._cache:
                    return self._cache[name]
                else:
                    raise LazyImportError(f"Repository {name} failed to load in other thread")
            
            # Mark as loading
            loading_event = threading.Event()
            self._loading[name] = loading_event
            
            try:
                # Load the repository class
                logger.info(f"Lazy loading repository class: {name}")
                repository_class = self._load_repository_class(name)
                
                # Cache the result
                self._cache[name] = repository_class
                logger.debug(f"Cached repository class: {name}")
                
                return repository_class
            
            finally:
                # Mark as loaded and remove from loading set
                loading_event.set()
                self._loading.pop(name, None)
    
    def _load_repository_class(self, name: str) -> Type[RepositoryProtocol]:
        """
        Load a repository class from its module.
        
        Args:
            name: The repository class name to load
            
        Returns:
            The loaded repository class
            
        Raises:
            LazyImportError: If the repository cannot be loaded
        """
        # Get repository info from registry
        if name not in self.REPOSITORY_REGISTRY:
            available = list(self.REPOSITORY_REGISTRY.keys())
            raise LazyImportError(
                f"Repository '{name}' not found in registry. "
                f"Available repositories: {', '.join(available)}"
            )
        
        repo_info = self.REPOSITORY_REGISTRY[name]
        module_path = repo_info["module"]
        class_name = repo_info["class"]
        
        try:
            # Import the module
            logger.debug(f"Importing module: {module_path}")
            module = importlib.import_module(module_path)
            
            # Get the class from the module
            if not hasattr(module, class_name):
                raise LazyImportError(
                    f"Class '{class_name}' not found in module '{module_path}'"
                )
            
            repository_class = getattr(module, class_name)
            
            # Validate that it implements the repository protocol
            if not issubclass(repository_class, RepositoryProtocol):
                logger.warning(
                    f"Repository class {name} does not implement RepositoryProtocol"
                )
            
            logger.info(f"Successfully loaded repository class: {name}")
            return repository_class
        
        except ImportError as e:
            error_msg = f"Failed to import repository '{name}' from '{module_path}': {e}"
            logger.error(error_msg)
            raise LazyImportError(error_msg) from e
        
        except Exception as e:
            error_msg = f"Unexpected error loading repository '{name}': {e}"
            logger.error(error_msg, exc_info=True)
            raise LazyImportError(error_msg) from e
    
    def preload_repositories(self, names: Optional[list[str]] = None) -> Dict[str, Union[Type[Any], Exception]]:
        """
        Preload repository classes to warm the cache.
        
        Args:
            names: List of repository names to preload. If None, preload all.
            
        Returns:
            Dictionary mapping repository names to loaded classes or exceptions
        """
        if names is None:
            names = list(self.REPOSITORY_REGISTRY.keys())
        
        results = {}
        for name in names:
            try:
                repository_class = self.get_repository_class(name)
                results[name] = repository_class
                logger.debug(f"Preloaded repository: {name}")
            except Exception as e:
                results[name] = e
                logger.warning(f"Failed to preload repository {name}: {e}")
        
        loaded_count = sum(1 for v in results.values() if not isinstance(v, Exception))
        logger.info(f"Preloaded {loaded_count}/{len(names)} repositories")
        
        return results
    
    def get_available_repositories(self) -> Dict[str, Dict[str, str]]:
        """
        Get information about all available repositories.
        
        Returns:
            Dictionary mapping repository names to their metadata
        """
        return self.REPOSITORY_REGISTRY.copy()
    
    def clear_cache(self):
        """Clear the repository class cache."""
        with self._lock:
            self._cache.clear()
            logger.info("Repository class cache cleared")
    
    def get_cache_stats(self) -> Dict[str, Any]:
        """
        Get statistics about the repository cache.
        
        Returns:
            Dictionary with cache statistics
        """
        with self._lock:
            return {
                "cached_count": len(self._cache),
                "cached_repositories": list(self._cache.keys()),
                "loading_count": len(self._loading),
                "loading_repositories": list(self._loading.keys()),
                "total_available": len(self.REPOSITORY_REGISTRY)
            }


# Global registry instance
_repository_registry = RepositoryRegistry()


def get_repository_class(name: str) -> Type[RepositoryProtocol]:
    """
    Get a repository class by name with lazy loading.
    
    Args:
        name: The repository class name to load
        
    Returns:
        The repository class type
        
    Raises:
        LazyImportError: If the repository cannot be loaded
    """
    return _repository_registry.get_repository_class(name)


def preload_repositories(names: Optional[list[str]] = None) -> Dict[str, Union[Type[Any], Exception]]:
    """
    Preload repository classes to warm the cache.
    
    Args:
        names: List of repository names to preload. If None, preload all.
        
    Returns:
        Dictionary mapping repository names to loaded classes or exceptions
    """
    return _repository_registry.preload_repositories(names)


def get_available_repositories() -> Dict[str, Dict[str, str]]:
    """
    Get information about all available repositories.
    
    Returns:
        Dictionary mapping repository names to their metadata
    """
    return _repository_registry.get_available_repositories()


def clear_repository_cache():
    """Clear the repository class cache."""
    _repository_registry.clear_cache()


def get_cache_stats() -> Dict[str, Any]:
    """
    Get statistics about the repository cache.
    
    Returns:
        Dictionary with cache statistics
    """
    return _repository_registry.get_cache_stats()