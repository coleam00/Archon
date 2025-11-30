"""
Domain interfaces for Archon's knowledge base.

This package contains abstract interfaces (ABCs) that define contracts
for repository and service implementations, following the Repository Pattern
and Dependency Inversion Principle.
"""

from .site_pages_repository import ISitePagesRepository
from .embedding_service import IEmbeddingService

__all__ = [
    "ISitePagesRepository",
    "IEmbeddingService",
]
