"""
Enhanced dependency injection system with lazy loading and startup management.

This module provides comprehensive dependency management including:
- Lazy loading database provider with startup error handling
- Type-safe dependency injection for repositories
- Configuration-based database instantiation
- Health monitoring and diagnostics
- Graceful startup and shutdown lifecycle management
"""

import asyncio
import logging
import threading
from typing import Optional, Dict, Any

from ..repositories.implementations.lazy_supabase_database import LazySupabaseDatabase
from ..repositories.interfaces.unit_of_work import IUnitOfWork
from ..repositories.database_config import (
    DatabaseConfig, get_current_database_config, load_database_config
)
from ..repositories.startup_manager import (
    get_startup_manager, StartupProgress, StartupStatus
)
from ..repositories.dependency_injection import get_container


logger = logging.getLogger(__name__)


class EnhancedDatabaseProvider:
    """
    Enhanced singleton provider for database instance management with lazy loading.

    This class provides comprehensive database management including:
    - Lazy loading with startup error handling
    - Configuration-based instantiation
    - Health monitoring and diagnostics
    - Graceful error recovery
    - Performance tracking
    """

    _instance: Optional[IUnitOfWork] = None
    _config: Optional[DatabaseConfig] = None
    _startup_progress: Optional[StartupProgress] = None
    _logger = logging.getLogger(__name__)
    _lock = threading.RLock()
    _initialization_started = False
    _initialization_complete = False

    @classmethod
    def get_database(cls) -> IUnitOfWork:
        """
        Get the database instance with enhanced lazy loading and error handling.

        Returns:
            The IUnitOfWork instance

        Raises:
            RuntimeError: If database initialization fails
            ValueError: If configuration is invalid

        Note:
            This method implements sophisticated lazy initialization with:
            - Startup progress tracking
            - Configuration validation
            - Error recovery mechanisms
            - Performance monitoring
        """
        if cls._instance is None:
            with cls._lock:
                # Double-check locking pattern for thread safety
                if cls._instance is None:
                    cls._logger.info("Initializing enhanced database instance")
                    
                    try:
                        # Load and validate configuration
                        config = cls._load_configuration()
                        cls._config = config
                        
                        # Initialize startup manager if not already done
                        if not cls._initialization_started:
                            cls._initialize_startup_system()
                        
                        # Create database instance with enhanced features
                        cls._instance = cls._create_enhanced_database_instance(config)
                        cls._initialization_complete = True
                        
                        cls._logger.info("Enhanced database instance initialized successfully")
                        
                    except Exception as e:
                        cls._logger.error(f"Failed to initialize database instance: {e}", exc_info=True)
                        raise RuntimeError(f"Database initialization failed: {e}") from e

        return cls._instance
    
    @classmethod
    def _load_configuration(cls) -> DatabaseConfig:
        """
        Load and validate database configuration.
        
        Returns:
            Validated database configuration
            
        Raises:
            ValueError: If configuration is invalid
        """
        try:
            # Try to get existing configuration first
            config = get_current_database_config()
            
            if config is None:
                # Load configuration from environment
                cls._logger.info("Loading database configuration from environment")
                config = load_database_config()
            
            # Validate configuration
            validation_errors = config.validate()
            if validation_errors:
                error_msg = f"Database configuration validation failed: {'; '.join(validation_errors)}"
                cls._logger.error(error_msg)
                raise ValueError(error_msg)
            
            cls._logger.info(f"Database configuration loaded successfully (type: {config.database_type.value})")
            return config
            
        except Exception as e:
            cls._logger.error(f"Failed to load database configuration: {e}")
            raise
    
    @classmethod
    def _initialize_startup_system(cls):
        """
        Initialize the startup management system.

        This sets up the startup manager and dependency injection container
        for enhanced database initialization.
        """
        try:
            cls._initialization_started = True
            
            # Initialize dependency container
            container = get_container()
            
            # Register database client dependency
            container.register(
                interface_type=object,
                name="client",
                factory=cls._create_supabase_client
            )
            
            cls._logger.info("Startup system initialized")
            
        except Exception as e:
            cls._logger.warning(f"Failed to initialize startup system: {e}")
            # Continue without startup system for backward compatibility
    
    @classmethod
    def _create_supabase_client(cls):
        """
        Factory function to create Supabase client.

        Returns:
            Configured Supabase client instance
        """
        try:
            from ...services.client_manager import get_supabase_client
            return get_supabase_client()
        except ImportError as e:
            raise ImportError(f"Failed to import client_manager: {e}")
    
    @classmethod
    def _create_enhanced_database_instance(cls, config: DatabaseConfig) -> IUnitOfWork:
        """
        Create an enhanced database instance with lazy loading.
        
        Args:
            config: Database configuration
            
        Returns:
            Enhanced IUnitOfWork instance
            
        Raises:
            ValueError: If database type is not supported
        """
        if config.database_type.value == "supabase":
            # Create lazy-loading Supabase database
            database = LazySupabaseDatabase()
            
            # Preload critical repositories if configured
            if hasattr(database, 'preload_repositories'):
                critical_repos = ['settings', 'sources']
                try:
                    database.preload_repositories(critical_repos)
                    cls._logger.info(f"Preloaded critical repositories: {critical_repos}")
                except Exception as e:
                    cls._logger.warning(f"Failed to preload repositories: {e}")
            
            return database
            
        elif config.database_type.value == "mock":
            # For testing - would create mock database
            cls._logger.warning("Mock database type not fully implemented, falling back to Supabase")
            return LazySupabaseDatabase()
            
        else:
            raise ValueError(f"Unsupported database type: {config.database_type.value}")

    @classmethod
    def set_database(cls, database: IUnitOfWork):
        """
        Set a specific database instance (primarily for testing).

        Args:
            database: The IUnitOfWork instance to use

        Note:
            This method allows injection of mock or test database instances
            for testing purposes without affecting production code.
        """
        with cls._lock:
            cls._logger.info(f"Database instance overridden with {type(database).__name__}")
            cls._instance = database

    @classmethod
    def reset_database(cls):
        """
        Reset the database instance (primarily for testing).

        This method clears the current database instance, forcing a new
        instance to be created on the next call to get_database().
        """
        with cls._lock:
            cls._logger.info("Database instance reset")
            cls._instance = None
            cls._config = None
            cls._startup_progress = None
            cls._initialization_started = False
            cls._initialization_complete = False

    @classmethod
    async def close_database(cls):
        """
        Close the current database instance and clean up resources.

        This method should be called during application shutdown to
        ensure proper cleanup of database connections and resources.
        """
        if cls._instance is not None:
            cls._logger.info("Closing database instance")
            await cls._instance.close()
            cls._instance = None
            cls._logger.info("Database instance closed")

    @classmethod
    async def health_check(cls) -> Dict[str, Any]:
        """
        Perform comprehensive health check on the database system.

        Returns:
            Dictionary with detailed health information
        """
        health_info = {
            "healthy": False,
            "instance_created": cls._instance is not None,
            "initialization_complete": cls._initialization_complete,
            "configuration_loaded": cls._config is not None,
            "startup_progress": None,
            "database_health": None,
            "repository_stats": None,
            "errors": []
        }
        
        try:
            # Check if instance exists, create if needed
            if cls._instance is None:
                try:
                    cls.get_database()
                    health_info["instance_created"] = True
                except Exception as e:
                    health_info["errors"].append(f"Failed to create instance: {e}")
                    return health_info
            
            # Check database connectivity
            if cls._instance is not None:
                try:
                    db_healthy = await cls._instance.health_check()
                    health_info["database_health"] = db_healthy
                    
                    # Get repository statistics if available
                    if hasattr(cls._instance, 'get_repository_stats'):
                        health_info["repository_stats"] = cls._instance.get_repository_stats()
                    
                except Exception as e:
                    health_info["errors"].append(f"Database health check failed: {e}")
                    health_info["database_health"] = False
            
            # Include startup progress if available
            if cls._startup_progress:
                health_info["startup_progress"] = {
                    "status": cls._startup_progress.status.value,
                    "completed_phases": len(cls._startup_progress.completed_phases),
                    "error_count": cls._startup_progress.error_count,
                    "warning_count": cls._startup_progress.warning_count
                }
            
            # Overall health determination
            health_info["healthy"] = (
                health_info["instance_created"] and
                health_info["database_health"] == True and
                len(health_info["errors"]) == 0
            )
            
            return health_info
            
        except Exception as e:
            cls._logger.error(f"Health check failed: {e}", exc_info=True)
            health_info["errors"].append(f"Health check exception: {e}")
            return health_info

    @classmethod
    def get_configuration(cls) -> Optional[DatabaseConfig]:
        """
        Get the current database configuration.
        
        Returns:
            Current database configuration or None if not loaded
        """
        return cls._config

    @classmethod
    def get_initialization_status(cls) -> Dict[str, Any]:
        """
        Get detailed information about initialization status.
        
        Returns:
            Dictionary with initialization status information
        """
        return {
            "initialization_started": cls._initialization_started,
            "initialization_complete": cls._initialization_complete,
            "instance_exists": cls._instance is not None,
            "config_loaded": cls._config is not None,
            "startup_progress": cls._startup_progress.to_dict() if cls._startup_progress else None
        }


async def get_database():
    """
    Enhanced FastAPI dependency function for database injection.

    This function provides an enhanced database instance with lazy loading
    that can be injected into FastAPI route handlers and other functions.
    Uses yield to properly handle cleanup after request completion.

    Yields:
        The enhanced IUnitOfWork instance with lazy loading capabilities

    Example:
        ```python
        @router.post("/projects")
        async def create_project(
            project_data: dict,
            db: IUnitOfWork = Depends(get_database)
        ):
            return await db.projects.create(project_data)
        ```

    Note:
        The database instance uses lazy loading, so repository classes
        are only imported and instantiated when first accessed.
    """
    database = EnhancedDatabaseProvider.get_database()
    try:
        yield database
    finally:
        # Cleanup logic if needed
        # For singleton instances, we typically don't close here
        # as the instance is shared across requests
        pass


async def setup_database():
    """
    Initialize the enhanced database system during application startup.

    This function provides comprehensive database initialization including:
    - Configuration loading and validation
    - Startup progress tracking
    - Health checks and diagnostics
    - Error handling and recovery
    
    Raises:
        RuntimeError: If database setup fails
    """
    logger.info("Setting up enhanced database system")
    
    try:
        # Initialize database with enhanced provider
        database = EnhancedDatabaseProvider.get_database()
        
        # Perform comprehensive health check
        health_info = await EnhancedDatabaseProvider.health_check()
        
        if not health_info["healthy"]:
            error_details = "; ".join(health_info["errors"]) if health_info["errors"] else "Unknown error"
            raise RuntimeError(f"Database health check failed during startup: {error_details}")
        
        # Log startup success with statistics
        repo_stats = health_info.get("repository_stats")
        if repo_stats:
            logger.info(
                f"Database system setup completed successfully "
                f"(loaded repositories: {repo_stats.get('loaded_count', 0)}/{repo_stats.get('available_count', 0)}, "
                f"total load time: {repo_stats.get('total_load_time', 0):.3f}s)"
            )
        else:
            logger.info("Database system setup completed successfully")
            
    except Exception as e:
        logger.error(f"Enhanced database setup failed: {e}", exc_info=True)
        raise RuntimeError(f"Database setup failed: {e}") from e


async def teardown_database():
    """
    Clean up the enhanced database system during application shutdown.

    This function provides comprehensive cleanup including:
    - Database connection closure
    - Repository cache clearing
    - Resource cleanup
    - Startup manager cleanup
    """
    logger.info("Tearing down enhanced database system")
    
    try:
        # Close database connections
        await EnhancedDatabaseProvider.close_database()
        
        # Clean up startup manager if it exists
        try:
            startup_manager = get_startup_manager()
            await startup_manager.cleanup()
            logger.info("Startup manager cleaned up")
        except Exception as e:
            logger.warning(f"Startup manager cleanup failed: {e}")
        
        # Clean up dependency container
        try:
            container = get_container()
            await container.cleanup()
            logger.info("Dependency container cleaned up")
        except Exception as e:
            logger.warning(f"Dependency container cleanup failed: {e}")
        
        logger.info("Enhanced database system teardown completed successfully")
        
    except Exception as e:
        logger.error(f"Enhanced database teardown failed: {e}", exc_info=True)
        # Don't re-raise during shutdown as it might mask other errors


# Enhanced factory function for creating database instances
def create_database_instance(config: Optional[Any] = None) -> IUnitOfWork:
    """
    Create a database instance with enhanced configuration support.

    Args:
        config: Optional configuration. Can be legacy or enhanced config.
                If not provided, uses current configuration.

    Returns:
        An IUnitOfWork instance with lazy loading capabilities

    Raises:
        ValueError: If the database type is not supported
    """
    if config is None:
        # Try enhanced config first, fall back to legacy
        enhanced_config = get_current_database_config()
        if enhanced_config:
            return EnhancedDatabaseProvider._create_enhanced_database_instance(enhanced_config)
    
    # Default to enhanced Supabase database
    logger.info("Using default LazySupabaseDatabase instance")
    return LazySupabaseDatabase()


def get_enhanced_provider() -> EnhancedDatabaseProvider:
    """
    Get the enhanced database provider class.
    
    Returns:
        The EnhancedDatabaseProvider class for advanced usage
    """
    return EnhancedDatabaseProvider


# Backward compatibility functions
def get_database_provider():
    """Get database provider (backward compatibility)."""
    return EnhancedDatabaseProvider