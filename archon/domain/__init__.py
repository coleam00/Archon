"""
Domain layer for Archon's knowledge base.

This package contains the core business logic and entities, independent of
any infrastructure concerns (databases, APIs, etc.).

It follows the principles of:
- Clean Architecture (domain at the center)
- Dependency Inversion (depends on abstractions, not concretions)
- Repository Pattern (abstract data access)

Public API:
    Models:
        - SitePage: Represents a documentation page/chunk
        - SitePageMetadata: Metadata for a page
        - SearchResult: Result from vector similarity search

    Interfaces:
        - ISitePagesRepository: Contract for page repository implementations
        - IEmbeddingService: Contract for embedding service implementations
"""

from .models import SitePage, SitePageMetadata, SearchResult
from .interfaces import ISitePagesRepository, IEmbeddingService

__all__ = [
    # Models
    "SitePage",
    "SitePageMetadata",
    "SearchResult",
    # Interfaces
    "ISitePagesRepository",
    "IEmbeddingService",
]
