"""
Supabase Infrastructure Layer.

Provides Supabase-backed implementations of repository interfaces.
Uses the Supabase Python client (PostgREST) for database operations.

Usage:
    from server.infrastructure.supabase import (
        SupabaseCrawledPagesRepository,
        SupabaseSourcesRepository,
        SupabaseCodeExamplesRepository,
    )
"""

from .crawled_pages_repository import SupabaseCrawledPagesRepository
from .sources_repository import SupabaseSourcesRepository
from .code_examples_repository import SupabaseCodeExamplesRepository

__all__ = [
    "SupabaseCrawledPagesRepository",
    "SupabaseSourcesRepository",
    "SupabaseCodeExamplesRepository",
]
