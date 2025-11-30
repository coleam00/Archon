"""
PostgreSQL connection pool management.

Provides utilities for creating and managing asyncpg connection pools.
"""

import logging
from typing import Optional
import asyncpg
from asyncpg import Pool

logger = logging.getLogger("archon.postgres.connection")


_pool: Optional[Pool] = None


async def create_pool(
    host: str = "localhost",
    port: int = 5432,
    database: str = "archon",
    user: str = "postgres",
    password: str = "",
    min_size: int = 5,
    max_size: int = 20,
) -> Pool:
    """
    Create an asyncpg connection pool.

    Args:
        host: PostgreSQL host
        port: PostgreSQL port
        database: Database name
        user: Database user
        password: Database password
        min_size: Minimum number of connections in the pool
        max_size: Maximum number of connections in the pool

    Returns:
        asyncpg Pool instance

    Example:
        >>> pool = await create_pool(
        ...     host="localhost",
        ...     database="archon",
        ...     user="postgres",
        ...     password="secret"
        ... )
    """
    global _pool

    if _pool is not None:
        logger.warning("Pool already exists, returning existing pool")
        return _pool

    logger.info(
        f"Creating connection pool: {user}@{host}:{port}/{database} "
        f"(min={min_size}, max={max_size})"
    )

    try:
        _pool = await asyncpg.create_pool(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
            min_size=min_size,
            max_size=max_size,
        )

        logger.info("Connection pool created successfully")
        return _pool

    except Exception as e:
        logger.error(f"Failed to create connection pool: {e}")
        raise


async def close_pool() -> None:
    """
    Close the global connection pool.

    Should be called when the application shuts down.
    """
    global _pool

    if _pool is None:
        logger.warning("No pool to close")
        return

    logger.info("Closing connection pool")
    await _pool.close()
    _pool = None
    logger.info("Connection pool closed")


def get_pool() -> Optional[Pool]:
    """
    Get the current connection pool.

    Returns:
        The global pool instance, or None if not created

    Raises:
        RuntimeError: If pool has not been created
    """
    if _pool is None:
        raise RuntimeError(
            "Connection pool not initialized. Call create_pool() first."
        )
    return _pool
