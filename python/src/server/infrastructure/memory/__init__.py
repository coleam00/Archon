"""
InMemory Infrastructure Layer.

Provides in-memory implementations of repository interfaces
for fast unit testing without database dependencies.

Usage:
    from server.infrastructure.memory import (
        InMemoryCrawledPagesRepository,
        InMemorySourcesRepository,
        InMemoryCodeExamplesRepository,
    )

    # Create repositories for testing
    pages_repo = InMemoryCrawledPagesRepository()
    sources_repo = InMemorySourcesRepository()
    examples_repo = InMemoryCodeExamplesRepository()

Features:
    - Ultra-fast tests (no I/O)
    - No external dependencies
    - Simulated vector search with cosine similarity
    - Thread-safe operations
"""

from .crawled_pages_repository import InMemoryCrawledPagesRepository
from .sources_repository import InMemorySourcesRepository
from .code_examples_repository import InMemoryCodeExamplesRepository
from .vector_utils import cosine_similarity

__all__ = [
    "InMemoryCrawledPagesRepository",
    "InMemorySourcesRepository",
    "InMemoryCodeExamplesRepository",
    "cosine_similarity",
]
