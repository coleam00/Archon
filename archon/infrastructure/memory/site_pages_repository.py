"""
In-memory implementation of the ISitePagesRepository interface.

This module provides a simple in-memory implementation for testing purposes.
It stores pages in a Python list and simulates vector similarity search using
cosine similarity calculations.
"""

import logging
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
from archon.domain.models.site_page import SitePage
from archon.domain.models.search_result import SearchResult

logger = logging.getLogger("archon.repository.memory")


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """
    Calculate cosine similarity between two vectors.

    Args:
        vec1: First vector
        vec2: Second vector

    Returns:
        Cosine similarity score (0.0 to 1.0)
    """
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0

    # Calculate dot product
    dot_product = sum(a * b for a, b in zip(vec1, vec2))

    # Calculate magnitudes
    magnitude1 = sum(a * a for a in vec1) ** 0.5
    magnitude2 = sum(b * b for b in vec2) ** 0.5

    # Avoid division by zero
    if magnitude1 == 0 or magnitude2 == 0:
        return 0.0

    # Return cosine similarity
    return dot_product / (magnitude1 * magnitude2)


class InMemorySitePagesRepository(ISitePagesRepository):
    """
    In-memory implementation of the site pages repository.

    This class stores pages in a Python list and provides all the same
    operations as the Supabase implementation, but without requiring a database.

    Useful for:
    - Unit testing without database setup
    - Local development
    - Integration tests
    """

    def __init__(self):
        """Initialize the repository with an empty list of pages."""
        self._pages: List[SitePage] = []
        self._next_id: int = 1

    def clear(self):
        """Clear all pages from the repository. Useful for tests."""
        self._pages.clear()
        self._next_id = 1

    async def get_by_id(self, id: int) -> Optional[SitePage]:
        """
        Retrieve a page by its unique identifier.

        Args:
            id: The unique page identifier

        Returns:
            The page if found, None otherwise
        """
        logger.debug(f"get_by_id(id={id})")

        for page in self._pages:
            if page.id == id:
                logger.info(f"get_by_id(id={id}) -> found")
                return page

        logger.debug(f"get_by_id(id={id}) -> None")
        return None

    async def find_by_url(self, url: str) -> List[SitePage]:
        """
        Find all chunks for a given URL.

        Args:
            url: The full URL to search for

        Returns:
            List of pages/chunks for that URL, ordered by chunk_number
        """
        logger.debug(f"find_by_url(url={url})")

        pages = [page for page in self._pages if page.url == url]
        pages.sort(key=lambda p: p.chunk_number)

        logger.info(f"find_by_url(url={url}) -> {len(pages)} pages")
        return pages

    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        """
        Search for pages similar to the given embedding.

        Uses cosine similarity to rank pages by relevance.

        Args:
            embedding: Query embedding vector
            limit: Maximum number of results to return
            filter: Optional filter criteria (e.g., {"source": "pydantic_ai_docs"})

        Returns:
            List of search results, ordered by similarity (highest first)
        """
        logger.debug(
            f"search_similar(embedding_len={len(embedding)}, limit={limit}, filter={filter})"
        )

        # Filter pages based on the filter criteria
        candidates = self._pages

        if filter:
            candidates = []
            for page in self._pages:
                match = True

                for key, value in filter.items():
                    # Handle metadata filters
                    if key.startswith("metadata."):
                        metadata_key = key.replace("metadata.", "")
                        metadata_value = getattr(page.metadata, metadata_key, None)
                        if metadata_value != value:
                            match = False
                            break
                    # Handle direct field filters
                    elif key == "source":
                        # Special handling for "source" as a shortcut to metadata.source
                        if page.metadata.source != value:
                            match = False
                            break
                    else:
                        if getattr(page, key, None) != value:
                            match = False
                            break

                if match:
                    candidates.append(page)

        # Calculate similarity for each candidate that has an embedding
        results = []
        for page in candidates:
            if page.embedding:
                similarity = cosine_similarity(embedding, page.embedding)
                results.append(SearchResult(page=page, similarity=similarity))

        # Sort by similarity (descending) and limit
        results.sort(key=lambda r: r.similarity, reverse=True)
        results = results[:limit]

        logger.info(
            f"search_similar(embedding_len={len(embedding)}, limit={limit}) -> {len(results)} results"
        )
        return results

    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        """
        List all unique URLs in the knowledge base.

        Args:
            source: Optional source filter (e.g., "pydantic_ai_docs")

        Returns:
            Sorted list of unique URLs
        """
        logger.debug(f"list_unique_urls(source={source})")

        # Filter by source if provided
        if source:
            urls = [
                page.url for page in self._pages if page.metadata.source == source
            ]
        else:
            urls = [page.url for page in self._pages]

        # Get unique URLs and sort
        unique_urls = sorted(set(urls))

        logger.info(f"list_unique_urls(source={source}) -> {len(unique_urls)} urls")
        return unique_urls

    async def insert(self, page: SitePage) -> SitePage:
        """
        Insert a new page into the repository.

        Args:
            page: The page to insert (id should be None)

        Returns:
            The inserted page with its generated id

        Raises:
            ValueError: If page.id is not None
        """
        if page.id is not None:
            raise ValueError("Cannot insert a page with an existing id")

        logger.debug(f"insert(url={page.url}, chunk_number={page.chunk_number})")

        # Create a copy with generated id and created_at
        page_dict = page.model_dump()
        page_dict["id"] = self._next_id
        page_dict["created_at"] = datetime.now(timezone.utc)

        new_page = SitePage(**page_dict)

        # Store the page
        self._pages.append(new_page)
        self._next_id += 1

        logger.info(
            f"insert(url={page.url}, chunk_number={page.chunk_number}) -> id={new_page.id}"
        )
        return new_page

    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]:
        """
        Insert multiple pages in a single batch operation.

        Args:
            pages: List of pages to insert (all ids should be None)

        Returns:
            List of inserted pages with their generated ids

        Raises:
            ValueError: If any page has a non-None id
        """
        if any(page.id is not None for page in pages):
            raise ValueError("Cannot insert pages with existing ids")

        logger.debug(f"insert_batch(pages_count={len(pages)})")

        inserted_pages = []
        for page in pages:
            inserted_page = await self.insert(page)
            inserted_pages.append(inserted_page)

        logger.info(
            f"insert_batch(pages_count={len(pages)}) -> inserted {len(inserted_pages)} pages"
        )
        return inserted_pages

    async def delete_by_source(self, source: str) -> int:
        """
        Delete all pages from a specific source.

        Args:
            source: The source identifier to delete

        Returns:
            Number of pages deleted
        """
        logger.debug(f"delete_by_source(source={source})")

        # Count pages before deletion
        initial_count = len(self._pages)

        # Filter out pages with matching source
        self._pages = [
            page for page in self._pages if page.metadata.source != source
        ]

        # Calculate deleted count
        deleted_count = initial_count - len(self._pages)

        logger.info(f"delete_by_source(source={source}) -> deleted {deleted_count} pages")
        return deleted_count

    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        """
        Count pages in the repository.

        Args:
            filter: Optional filter criteria (e.g., {"metadata.source": "pydantic_ai_docs"})

        Returns:
            Number of pages matching the filter
        """
        logger.debug(f"count(filter={filter})")

        if not filter:
            count = len(self._pages)
            logger.info(f"count(filter={filter}) -> {count}")
            return count

        # Apply filters
        matching_pages = []
        for page in self._pages:
            match = True

            for key, value in filter.items():
                # Handle metadata filters
                if key.startswith("metadata."):
                    metadata_key = key.replace("metadata.", "")
                    metadata_value = getattr(page.metadata, metadata_key, None)
                    if metadata_value != value:
                        match = False
                        break
                # Handle direct field filters
                else:
                    if getattr(page, key, None) != value:
                        match = False
                        break

            if match:
                matching_pages.append(page)

        count = len(matching_pages)
        logger.info(f"count(filter={filter}) -> {count}")
        return count
