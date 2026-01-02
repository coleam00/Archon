"""
Repository Factory for Archon Server.

Creates appropriate repository instances based on configuration.
Supports Supabase (default), PostgreSQL (Phase 4), and InMemory (Phase 5).

Usage:
    from server.infrastructure.repository_factory import (
        get_crawled_pages_repository,
        get_sources_repository,
        get_code_examples_repository,
        initialize_postgres,  # Call once at startup for postgres
    )

    # For PostgreSQL, initialize first:
    # await initialize_postgres()

    # Get repositories (uses REPOSITORY_TYPE env var)
    pages_repo = get_crawled_pages_repository()
    sources_repo = get_sources_repository()
"""

import os
from typing import TYPE_CHECKING

from ..config.logfire_config import get_logger

if TYPE_CHECKING:
    from asyncpg import Pool
    from ..domain.interfaces.crawled_pages_repository import ICrawledPagesRepository
    from ..domain.interfaces.sources_repository import ISourcesRepository
    from ..domain.interfaces.code_examples_repository import ICodeExamplesRepository

logger = get_logger(__name__)

# Supported storage types
SUPPORTED_STORAGE_TYPES = ["supabase", "postgres", "memory"]

# Singleton instances (lazy initialization)
_crawled_pages_repository: "ICrawledPagesRepository | None" = None
_sources_repository: "ISourcesRepository | None" = None
_code_examples_repository: "ICodeExamplesRepository | None" = None

# Client singletons
_supabase_client = None
_postgres_pool: "Pool | None" = None


def _get_storage_type() -> str:
    """Get the configured storage type from environment."""
    storage_type = os.getenv("REPOSITORY_TYPE", "supabase").lower()

    if storage_type not in SUPPORTED_STORAGE_TYPES:
        logger.warning(
            f"Invalid REPOSITORY_TYPE '{storage_type}', defaulting to 'supabase'. "
            f"Supported: {SUPPORTED_STORAGE_TYPES}"
        )
        return "supabase"

    return storage_type


def _get_supabase_client():
    """Get or create Supabase client singleton."""
    global _supabase_client

    if _supabase_client is None:
        from ..services.client_manager import get_supabase_client
        _supabase_client = get_supabase_client()

    return _supabase_client


def _get_postgres_pool() -> "Pool":
    """Get the PostgreSQL connection pool.

    Raises:
        RuntimeError: If pool is not initialized. Call initialize_postgres() first.
    """
    if _postgres_pool is None:
        raise RuntimeError(
            "PostgreSQL pool not initialized. "
            "Call await initialize_postgres() at application startup."
        )
    return _postgres_pool


async def initialize_postgres(
    host: str | None = None,
    port: int | None = None,
    database: str | None = None,
    user: str | None = None,
    password: str | None = None,
    min_size: int = 5,
    max_size: int = 20,
) -> "Pool":
    """
    Initialize the PostgreSQL connection pool.

    Must be called at application startup if using REPOSITORY_TYPE=postgres.

    Args:
        host: PostgreSQL host (default: from POSTGRES_HOST env)
        port: PostgreSQL port (default: from POSTGRES_PORT env or 5432)
        database: Database name (default: from POSTGRES_DB env)
        user: Database user (default: from POSTGRES_USER env)
        password: Database password (default: from POSTGRES_PASSWORD env)
        min_size: Minimum pool size
        max_size: Maximum pool size

    Returns:
        The initialized connection pool
    """
    global _postgres_pool

    if _postgres_pool is not None:
        logger.warning("PostgreSQL pool already initialized, returning existing pool")
        return _postgres_pool

    from .postgres import create_postgres_pool

    _postgres_pool = await create_postgres_pool(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        min_size=min_size,
        max_size=max_size,
    )

    logger.info("PostgreSQL pool initialized for repository factory")
    return _postgres_pool


async def close_postgres() -> None:
    """Close the PostgreSQL connection pool."""
    global _postgres_pool

    if _postgres_pool is not None:
        await _postgres_pool.close()
        _postgres_pool = None
        logger.info("PostgreSQL pool closed")


def get_crawled_pages_repository() -> "ICrawledPagesRepository":
    """
    Get the crawled pages repository instance.

    Returns the appropriate implementation based on REPOSITORY_TYPE env var:
    - "supabase" (default): SupabaseCrawledPagesRepository
    - "postgres": PostgresCrawledPagesRepository
    - "memory": InMemoryCrawledPagesRepository (Phase 5)

    Returns:
        ICrawledPagesRepository instance

    Raises:
        ValueError: If storage type is not supported
        RuntimeError: If postgres is requested but pool not initialized
    """
    global _crawled_pages_repository

    if _crawled_pages_repository is None:
        storage_type = _get_storage_type()

        if storage_type == "supabase":
            from .supabase.crawled_pages_repository import SupabaseCrawledPagesRepository

            client = _get_supabase_client()
            _crawled_pages_repository = SupabaseCrawledPagesRepository(client)
            logger.info("Created SupabaseCrawledPagesRepository")

        elif storage_type == "postgres":
            from .postgres import PostgresCrawledPagesRepository

            pool = _get_postgres_pool()
            _crawled_pages_repository = PostgresCrawledPagesRepository(pool)
            logger.info("Created PostgresCrawledPagesRepository")

        elif storage_type == "memory":
            from .memory import InMemoryCrawledPagesRepository

            _crawled_pages_repository = InMemoryCrawledPagesRepository()
            logger.info("Created InMemoryCrawledPagesRepository")

        else:
            raise ValueError(f"Unsupported storage type: {storage_type}")

    return _crawled_pages_repository


def get_sources_repository() -> "ISourcesRepository":
    """
    Get the sources repository instance.

    Returns:
        ISourcesRepository instance
    """
    global _sources_repository

    if _sources_repository is None:
        storage_type = _get_storage_type()

        if storage_type == "supabase":
            from .supabase.sources_repository import SupabaseSourcesRepository

            client = _get_supabase_client()
            _sources_repository = SupabaseSourcesRepository(client)
            logger.info("Created SupabaseSourcesRepository")

        elif storage_type == "postgres":
            from .postgres import PostgresSourcesRepository

            pool = _get_postgres_pool()
            _sources_repository = PostgresSourcesRepository(pool)
            logger.info("Created PostgresSourcesRepository")

        elif storage_type == "memory":
            from .memory import InMemorySourcesRepository

            _sources_repository = InMemorySourcesRepository()
            logger.info("Created InMemorySourcesRepository")

        else:
            raise ValueError(f"Unsupported storage type: {storage_type}")

    return _sources_repository


def get_code_examples_repository() -> "ICodeExamplesRepository":
    """
    Get the code examples repository instance.

    Returns:
        ICodeExamplesRepository instance
    """
    global _code_examples_repository

    if _code_examples_repository is None:
        storage_type = _get_storage_type()

        if storage_type == "supabase":
            from .supabase.code_examples_repository import SupabaseCodeExamplesRepository

            client = _get_supabase_client()
            _code_examples_repository = SupabaseCodeExamplesRepository(client)
            logger.info("Created SupabaseCodeExamplesRepository")

        elif storage_type == "postgres":
            from .postgres import PostgresCodeExamplesRepository

            pool = _get_postgres_pool()
            _code_examples_repository = PostgresCodeExamplesRepository(pool)
            logger.info("Created PostgresCodeExamplesRepository")

        elif storage_type == "memory":
            from .memory import InMemoryCodeExamplesRepository

            _code_examples_repository = InMemoryCodeExamplesRepository()
            logger.info("Created InMemoryCodeExamplesRepository")

        else:
            raise ValueError(f"Unsupported storage type: {storage_type}")

    return _code_examples_repository


async def reset_repositories() -> None:
    """
    Reset all repository instances.

    Useful for testing or when configuration changes.
    Also closes PostgreSQL pool if initialized.
    """
    global _crawled_pages_repository, _sources_repository, _code_examples_repository
    global _supabase_client, _postgres_pool

    _crawled_pages_repository = None
    _sources_repository = None
    _code_examples_repository = None
    _supabase_client = None

    if _postgres_pool is not None:
        await _postgres_pool.close()
        _postgres_pool = None

    logger.info("Reset all repository instances")


def reset_repositories_sync() -> None:
    """
    Reset all repository instances synchronously.

    Note: Does NOT close PostgreSQL pool (use reset_repositories for that).
    Useful for testing when you don't need async cleanup.
    """
    global _crawled_pages_repository, _sources_repository, _code_examples_repository
    global _supabase_client

    _crawled_pages_repository = None
    _sources_repository = None
    _code_examples_repository = None
    _supabase_client = None

    logger.info("Reset all repository instances (sync)")


def override_crawled_pages_repository(repo: "ICrawledPagesRepository") -> None:
    """Override the crawled pages repository (for testing)."""
    global _crawled_pages_repository
    _crawled_pages_repository = repo
    logger.info(f"Overrode crawled pages repository with {type(repo).__name__}")


def override_sources_repository(repo: "ISourcesRepository") -> None:
    """Override the sources repository (for testing)."""
    global _sources_repository
    _sources_repository = repo
    logger.info(f"Overrode sources repository with {type(repo).__name__}")


def override_code_examples_repository(repo: "ICodeExamplesRepository") -> None:
    """Override the code examples repository (for testing)."""
    global _code_examples_repository
    _code_examples_repository = repo
    logger.info(f"Overrode code examples repository with {type(repo).__name__}")


def set_postgres_pool(pool: "Pool") -> None:
    """
    Set the PostgreSQL pool directly (for testing or custom initialization).

    Args:
        pool: asyncpg connection pool
    """
    global _postgres_pool
    _postgres_pool = pool
    logger.info("Set PostgreSQL pool directly")
