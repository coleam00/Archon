"""
Mappers for converting between Supabase dicts and domain models.

These functions handle the translation between the database representation
(raw dicts from Supabase) and the domain models (Pydantic models).
"""

from typing import Dict, Any
from datetime import datetime
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.domain.models.search_result import SearchResult


def dict_to_site_page(data: Dict[str, Any]) -> SitePage:
    """
    Convert a Supabase dict to a SitePage domain model.

    Args:
        data: Dictionary from Supabase query result

    Returns:
        SitePage domain model

    Example:
        >>> from archon.infrastructure.supabase.mappers import dict_to_site_page
        >>> supabase_dict = {
        ...     "id": 1,
        ...     "url": "https://example.com",
        ...     "chunk_number": 0,
        ...     "title": "Example",
        ...     "summary": "Summary",
        ...     "content": "Content",
        ...     "metadata": {"source": "example_docs"},
        ...     "embedding": [0.1, 0.2, 0.3],
        ...     "created_at": "2025-11-29T12:00:00+00:00"
        ... }
        >>> page = dict_to_site_page(supabase_dict)
        >>> print(page.id)
        1
    """
    # Parse metadata - it comes as a dict from Supabase JSONB
    metadata_dict = data.get("metadata", {})
    if not isinstance(metadata_dict, dict):
        metadata_dict = {}

    metadata = SitePageMetadata(**metadata_dict)

    # Parse created_at timestamp if present
    created_at = data.get("created_at")
    if created_at and isinstance(created_at, str):
        created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))

    return SitePage(
        id=data.get("id"),
        url=data["url"],
        chunk_number=data.get("chunk_number", 0),
        title=data.get("title"),
        summary=data.get("summary"),
        content=data.get("content"),
        metadata=metadata,
        embedding=data.get("embedding"),
        created_at=created_at,
    )


def site_page_to_dict(page: SitePage) -> Dict[str, Any]:
    """
    Convert a SitePage domain model to a dict for Supabase insertion.

    Args:
        page: SitePage domain model

    Returns:
        Dictionary ready for Supabase insert/update

    Example:
        >>> from archon.domain.models.site_page import SitePage, SitePageMetadata
        >>> from archon.infrastructure.supabase.mappers import site_page_to_dict
        >>> page = SitePage(
        ...     url="https://example.com",
        ...     chunk_number=0,
        ...     title="Example",
        ...     content="Content",
        ...     metadata=SitePageMetadata(source="example_docs")
        ... )
        >>> result = site_page_to_dict(page)
        >>> print(result["url"])
        https://example.com
    """
    data = {
        "url": page.url,
        "chunk_number": page.chunk_number,
        "title": page.title,
        "summary": page.summary,
        "content": page.content,
        "metadata": page.metadata.model_dump(),  # Pydantic v2 method
        "embedding": page.embedding,
    }

    # Only include id if it's set (for updates)
    if page.id is not None:
        data["id"] = page.id

    # Only include created_at if it's set
    if page.created_at is not None:
        data["created_at"] = page.created_at.isoformat()

    return data


def dict_to_search_result(data: Dict[str, Any]) -> SearchResult:
    """
    Convert a Supabase search result dict to a SearchResult domain model.

    Supabase's match_site_pages RPC returns dicts with a 'similarity' field
    plus all the site_pages columns.

    Args:
        data: Dictionary from Supabase RPC result

    Returns:
        SearchResult domain model

    Example:
        >>> from archon.infrastructure.supabase.mappers import dict_to_search_result
        >>> result_dict = {
        ...     "id": 1,
        ...     "url": "https://example.com",
        ...     "chunk_number": 0,
        ...     "title": "Example",
        ...     "content": "Content",
        ...     "metadata": {"source": "example_docs"},
        ...     "similarity": 0.85
        ... }
        >>> search_result = dict_to_search_result(result_dict)
        >>> print(search_result.similarity)
        0.85
    """
    # Extract similarity score
    similarity = data.get("similarity", 0.0)

    # Convert the rest to a SitePage
    page = dict_to_site_page(data)

    return SearchResult(page=page, similarity=similarity)
