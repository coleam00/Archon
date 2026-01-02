"""
Infrastructure Layer for Archon Server.

This module provides concrete implementations of the domain interfaces
for different storage backends.

Submodules:
    - supabase: Supabase/PostgREST implementations
    - postgres: Direct PostgreSQL + asyncpg implementations
    - memory: In-memory implementations for testing

Usage:
    # Use factory functions (recommended)
    from server.infrastructure.repository_factory import (
        get_crawled_pages_repository,
        get_sources_repository,
        get_code_examples_repository,
    )

    # Or import specific implementations
    from server.infrastructure.supabase import SupabaseCrawledPagesRepository
    from server.infrastructure.postgres import PostgresCrawledPagesRepository
    from server.infrastructure.memory import InMemoryCrawledPagesRepository
"""

from .repository_factory import (
    get_crawled_pages_repository,
    get_sources_repository,
    get_code_examples_repository,
    initialize_postgres,
    close_postgres,
    reset_repositories,
    reset_repositories_sync,
    override_crawled_pages_repository,
    override_sources_repository,
    override_code_examples_repository,
    set_postgres_pool,
)

__all__ = [
    # Factory functions
    "get_crawled_pages_repository",
    "get_sources_repository",
    "get_code_examples_repository",
    # PostgreSQL lifecycle
    "initialize_postgres",
    "close_postgres",
    # Testing utilities
    "reset_repositories",
    "reset_repositories_sync",
    "override_crawled_pages_repository",
    "override_sources_repository",
    "override_code_examples_repository",
    "set_postgres_pool",
]
