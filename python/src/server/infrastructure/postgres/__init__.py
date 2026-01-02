"""
PostgreSQL Infrastructure Layer.

Provides PostgreSQL-backed implementations of repository interfaces
using asyncpg for async database access and pgvector for vector search.

Usage:
    from server.infrastructure.postgres import (
        PostgresConnectionManager,
        create_postgres_pool,
        PostgresCrawledPagesRepository,
        PostgresSourcesRepository,
        PostgresCodeExamplesRepository,
    )

    # Initialize connection pool
    pool = await create_postgres_pool()

    # Create repositories
    pages_repo = PostgresCrawledPagesRepository(pool)
    sources_repo = PostgresSourcesRepository(pool)
    examples_repo = PostgresCodeExamplesRepository(pool)

Requirements:
    - asyncpg>=0.29.0
    - PostgreSQL 14+ with pgvector extension
"""

from .connection import PostgresConnectionManager, create_postgres_pool
from .crawled_pages_repository import PostgresCrawledPagesRepository
from .sources_repository import PostgresSourcesRepository
from .code_examples_repository import PostgresCodeExamplesRepository

__all__ = [
    # Connection management
    "PostgresConnectionManager",
    "create_postgres_pool",
    # Repositories
    "PostgresCrawledPagesRepository",
    "PostgresSourcesRepository",
    "PostgresCodeExamplesRepository",
]
