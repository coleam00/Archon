"""
Domain Layer for Archon Server.

This module provides the core domain abstractions following the Repository Pattern.
It enables database-agnostic code by defining interfaces that can be implemented
by different backends (Supabase, PostgreSQL, InMemory).

Usage:
    from server.domain import ICrawledPagesRepository, CrawledPage
    from server.domain import ISourcesRepository, Source
    from server.domain import ICodeExamplesRepository, CodeExample

Design Principles:
    - Async-first: All repository methods are async for consistency
    - Backend-agnostic: No Supabase/PostgreSQL specifics in interfaces
    - Pydantic models: Type-safe domain models with validation
    - Factory pattern: Use repository_factory for instantiation
"""

# Domain Models
from .models.crawled_page import CrawledPage, CrawledPageCreate, CrawledPageMetadata
from .models.source import Source, SourceCreate
from .models.code_example import CodeExample, CodeExampleCreate
from .models.search_result import SearchResult

# Repository Interfaces
from .interfaces.crawled_pages_repository import ICrawledPagesRepository
from .interfaces.sources_repository import ISourcesRepository
from .interfaces.code_examples_repository import ICodeExamplesRepository
from .interfaces.embedding_service import IEmbeddingService

__all__ = [
    # Models
    "CrawledPage",
    "CrawledPageCreate",
    "CrawledPageMetadata",
    "Source",
    "SourceCreate",
    "CodeExample",
    "CodeExampleCreate",
    "SearchResult",
    # Interfaces
    "ICrawledPagesRepository",
    "ISourcesRepository",
    "ICodeExamplesRepository",
    "IEmbeddingService",
]
