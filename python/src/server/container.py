"""
Dependency Injection Container for Archon Server.

Provides centralized access to all repositories and services with proper
lifecycle management for different storage backends.

Usage:
    # At application startup (in main.py lifespan)
    await container.initialize()

    # Get repositories anywhere in the application
    pages_repo = container.crawled_pages_repository
    sources_repo = container.sources_repository

    # At application shutdown
    await container.shutdown()

Configuration:
    Set REPOSITORY_TYPE environment variable:
    - "supabase" (default): Use Supabase/PostgREST
    - "postgres": Use direct PostgreSQL with asyncpg
    - "memory": Use in-memory storage (for testing)
"""

import os
from typing import TYPE_CHECKING

from .config.logfire_config import get_logger

if TYPE_CHECKING:
    from .domain.interfaces.crawled_pages_repository import ICrawledPagesRepository
    from .domain.interfaces.sources_repository import ISourcesRepository
    from .domain.interfaces.code_examples_repository import ICodeExamplesRepository

logger = get_logger(__name__)


class Container:
    """
    Application container for dependency injection.

    Manages the lifecycle of all repositories and provides
    centralized access throughout the application.

    This container is a singleton - use the global `container` instance.

    Example:
        >>> from server.container import container
        >>> await container.initialize()
        >>> pages = await container.crawled_pages_repository.count()
        >>> await container.shutdown()
    """

    _instance: "Container | None" = None
    _initialized: bool = False

    def __new__(cls) -> "Container":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        # Only initialize once
        if hasattr(self, "_init_done"):
            return
        self._init_done = True
        self._initialized = False
        self._storage_type: str | None = None

    @property
    def storage_type(self) -> str:
        """Get the configured storage type."""
        if self._storage_type is None:
            self._storage_type = os.getenv("REPOSITORY_TYPE", "supabase").lower()
        return self._storage_type

    @property
    def is_initialized(self) -> bool:
        """Check if the container is initialized."""
        return self._initialized

    async def initialize(self) -> None:
        """
        Initialize the container and all dependencies.

        For PostgreSQL, this creates the connection pool.
        For Supabase and InMemory, initialization is lazy.

        Should be called once at application startup.
        """
        if self._initialized:
            logger.warning("Container already initialized")
            return

        logger.info(f"Initializing container with storage type: {self.storage_type}")

        try:
            # Initialize PostgreSQL pool if needed
            if self.storage_type == "postgres":
                from .infrastructure.repository_factory import initialize_postgres
                await initialize_postgres()
                logger.info("PostgreSQL pool initialized")

            # Pre-warm repositories (optional, for eager loading)
            # This validates configuration early
            _ = self.crawled_pages_repository
            _ = self.sources_repository
            _ = self.code_examples_repository

            self._initialized = True
            logger.info("Container initialized successfully")

        except Exception as e:
            logger.error(f"Container initialization failed: {e}")
            raise

    async def shutdown(self) -> None:
        """
        Shutdown the container and cleanup resources.

        Closes PostgreSQL pool if active.
        Should be called at application shutdown.
        """
        if not self._initialized:
            logger.warning("Container not initialized, nothing to shutdown")
            return

        logger.info("Shutting down container...")

        try:
            # Close PostgreSQL pool if active
            if self.storage_type == "postgres":
                from .infrastructure.repository_factory import close_postgres
                await close_postgres()
                logger.info("PostgreSQL pool closed")

            # Reset repository singletons
            from .infrastructure.repository_factory import reset_repositories_sync
            reset_repositories_sync()

            self._initialized = False
            logger.info("Container shutdown complete")

        except Exception as e:
            logger.error(f"Container shutdown error: {e}")
            raise

    @property
    def crawled_pages_repository(self) -> "ICrawledPagesRepository":
        """
        Get the crawled pages repository.

        Returns the appropriate implementation based on REPOSITORY_TYPE.
        """
        from .infrastructure.repository_factory import get_crawled_pages_repository
        return get_crawled_pages_repository()

    @property
    def sources_repository(self) -> "ISourcesRepository":
        """
        Get the sources repository.

        Returns the appropriate implementation based on REPOSITORY_TYPE.
        """
        from .infrastructure.repository_factory import get_sources_repository
        return get_sources_repository()

    @property
    def code_examples_repository(self) -> "ICodeExamplesRepository":
        """
        Get the code examples repository.

        Returns the appropriate implementation based on REPOSITORY_TYPE.
        """
        from .infrastructure.repository_factory import get_code_examples_repository
        return get_code_examples_repository()

    # Convenience methods for common operations

    async def health_check(self) -> dict:
        """
        Perform a health check on the storage backend.

        Returns:
            Dict with health status information
        """
        status = {
            "storage_type": self.storage_type,
            "initialized": self._initialized,
            "healthy": False,
        }

        if not self._initialized:
            status["error"] = "Container not initialized"
            return status

        try:
            # Try to count sources as a basic health check
            count = await self.sources_repository.count()
            status["healthy"] = True
            status["sources_count"] = count
        except Exception as e:
            status["error"] = str(e)

        return status

    @classmethod
    def reset(cls) -> None:
        """
        Reset the container singleton.

        For testing purposes only.
        """
        cls._instance = None
        logger.info("Container singleton reset")


# Global container instance
container = Container()


# Convenience functions for direct access

def get_crawled_pages_repository() -> "ICrawledPagesRepository":
    """Get the crawled pages repository from the global container."""
    return container.crawled_pages_repository


def get_sources_repository() -> "ISourcesRepository":
    """Get the sources repository from the global container."""
    return container.sources_repository


def get_code_examples_repository() -> "ICodeExamplesRepository":
    """Get the code examples repository from the global container."""
    return container.code_examples_repository
