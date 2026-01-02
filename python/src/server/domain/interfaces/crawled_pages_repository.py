"""
ICrawledPagesRepository Interface.

Defines the contract for crawled pages storage operations.
Implementations: SupabaseCrawledPagesRepository, PostgresCrawledPagesRepository, InMemoryCrawledPagesRepository
"""

from abc import ABC, abstractmethod
from typing import Any

from ..models.crawled_page import CrawledPage, CrawledPageCreate
from ..models.search_result import SearchResult


class ICrawledPagesRepository(ABC):
    """
    Abstract interface for crawled pages repository.

    This interface defines all operations for managing crawled page chunks
    in the knowledge base. Implementations must be async-compatible.

    Design Notes:
        - All methods are async for consistency across backends
        - Vector search uses embedding similarity (cosine distance)
        - Batch operations are optimized for bulk inserts
        - Source filtering is a common operation for RAG

    Example:
        >>> repo = get_crawled_pages_repository()  # From factory
        >>> pages = await repo.search_similar(embedding, match_count=5)
        >>> for result in pages:
        ...     print(f"{result.item.url}: {result.similarity:.2f}")
    """

    @abstractmethod
    async def get_by_id(self, id: str) -> CrawledPage | None:
        """
        Get a crawled page by its ID.

        Args:
            id: UUID of the page

        Returns:
            CrawledPage if found, None otherwise
        """
        pass

    @abstractmethod
    async def find_by_url(self, url: str) -> list[CrawledPage]:
        """
        Find all chunks for a given URL.

        Args:
            url: The full URL to search for

        Returns:
            List of CrawledPage chunks, ordered by chunk_number
        """
        pass

    @abstractmethod
    async def find_by_source(self, source_id: str) -> list[CrawledPage]:
        """
        Find all pages for a given source.

        Args:
            source_id: The source identifier

        Returns:
            List of CrawledPage chunks for this source
        """
        pass

    @abstractmethod
    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        filter_metadata: dict[str, Any] | None = None,
    ) -> list[SearchResult[CrawledPage]]:
        """
        Search for pages similar to the given embedding.

        Uses vector similarity search (cosine distance) to find
        semantically similar content.

        Args:
            embedding: Query embedding vector
            match_count: Maximum number of results
            source_id: Optional source filter
            filter_metadata: Optional additional metadata filters

        Returns:
            List of SearchResult with CrawledPage and similarity score
        """
        pass

    @abstractmethod
    async def insert(self, page: CrawledPageCreate) -> CrawledPage:
        """
        Insert a new crawled page chunk.

        Args:
            page: The page data to insert

        Returns:
            The inserted CrawledPage with generated ID

        Raises:
            ValueError: If required fields are missing
        """
        pass

    @abstractmethod
    async def insert_batch(self, pages: list[CrawledPageCreate]) -> list[CrawledPage]:
        """
        Insert multiple page chunks in a batch.

        Optimized for bulk inserts during crawling operations.

        Args:
            pages: List of pages to insert

        Returns:
            List of inserted CrawledPages with generated IDs
        """
        pass

    @abstractmethod
    async def delete_by_url(self, url: str) -> int:
        """
        Delete all chunks for a given URL.

        Args:
            url: The URL whose chunks should be deleted

        Returns:
            Number of chunks deleted
        """
        pass

    @abstractmethod
    async def delete_by_source(self, source_id: str) -> int:
        """
        Delete all pages from a specific source.

        Args:
            source_id: The source identifier

        Returns:
            Number of pages deleted
        """
        pass

    @abstractmethod
    async def count(self, source_id: str | None = None) -> int:
        """
        Count pages in the repository.

        Args:
            source_id: Optional source filter

        Returns:
            Number of pages matching the filter
        """
        pass

    @abstractmethod
    async def list_unique_urls(self, source_id: str | None = None) -> list[str]:
        """
        List all unique URLs in the repository.

        Args:
            source_id: Optional source filter

        Returns:
            Sorted list of unique URLs
        """
        pass
