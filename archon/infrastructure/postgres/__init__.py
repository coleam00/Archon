"""
PostgreSQL implementation of the repository interfaces.

This module provides direct PostgreSQL access using asyncpg for high-performance
async database operations with native pgvector support.
"""

from .site_pages_repository import PostgresSitePagesRepository
from .connection import create_pool, close_pool

__all__ = [
    "PostgresSitePagesRepository",
    "create_pool",
    "close_pool",
]
