"""
Domain models for Archon's knowledge base.

This package contains pure domain models with no external dependencies
beyond Pydantic.
"""

from .site_page import SitePage, SitePageMetadata
from .search_result import SearchResult

__all__ = [
    "SitePage",
    "SitePageMetadata",
    "SearchResult",
]
