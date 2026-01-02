"""
PostgreSQL Connection Management.

Provides connection pooling and management for PostgreSQL using asyncpg.
"""

import os
from typing import Optional

import asyncpg
from asyncpg import Pool

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class PostgresConnectionManager:
    """
    Manages PostgreSQL connection pool lifecycle.

    Provides a singleton-like pattern for connection pool management
    with support for graceful shutdown.

    Example:
        >>> manager = PostgresConnectionManager()
        >>> await manager.initialize()
        >>> pool = manager.pool
        >>> # Use pool...
        >>> await manager.close()
    """

    _instance: Optional["PostgresConnectionManager"] = None
    _pool: Optional[Pool] = None

    def __new__(cls) -> "PostgresConnectionManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @property
    def pool(self) -> Pool:
        """Get the connection pool."""
        if self._pool is None:
            raise RuntimeError(
                "PostgreSQL connection pool not initialized. "
                "Call await initialize() first."
            )
        return self._pool

    @property
    def is_initialized(self) -> bool:
        """Check if pool is initialized."""
        return self._pool is not None

    async def initialize(
        self,
        host: str | None = None,
        port: int | None = None,
        database: str | None = None,
        user: str | None = None,
        password: str | None = None,
        min_size: int = 5,
        max_size: int = 20,
    ) -> Pool:
        """
        Initialize the connection pool.

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
        if self._pool is not None:
            logger.warning("Pool already initialized, returning existing pool")
            return self._pool

        # Get configuration from environment with fallbacks
        host = host or os.getenv("POSTGRES_HOST", "localhost")
        port = port or int(os.getenv("POSTGRES_PORT", "5432"))
        database = database or os.getenv("POSTGRES_DB", "archon")
        user = user or os.getenv("POSTGRES_USER", "postgres")
        password = password or os.getenv("POSTGRES_PASSWORD", "")

        try:
            self._pool = await asyncpg.create_pool(
                host=host,
                port=port,
                database=database,
                user=user,
                password=password,
                min_size=min_size,
                max_size=max_size,
            )

            logger.info(
                f"PostgreSQL pool initialized: {user}@{host}:{port}/{database} "
                f"(min={min_size}, max={max_size})"
            )

            return self._pool

        except Exception as e:
            logger.error(f"Failed to initialize PostgreSQL pool: {e}")
            raise

    async def close(self) -> None:
        """Close the connection pool."""
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
            logger.info("PostgreSQL pool closed")

    @classmethod
    def reset(cls) -> None:
        """Reset the singleton instance (for testing)."""
        cls._instance = None
        cls._pool = None


async def create_postgres_pool(
    host: str | None = None,
    port: int | None = None,
    database: str | None = None,
    user: str | None = None,
    password: str | None = None,
    min_size: int = 5,
    max_size: int = 20,
) -> Pool:
    """
    Create a PostgreSQL connection pool.

    Convenience function that uses PostgresConnectionManager.

    Args:
        host: PostgreSQL host
        port: PostgreSQL port
        database: Database name
        user: Database user
        password: Database password
        min_size: Minimum pool size
        max_size: Maximum pool size

    Returns:
        asyncpg connection pool
    """
    manager = PostgresConnectionManager()
    return await manager.initialize(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        min_size=min_size,
        max_size=max_size,
    )
