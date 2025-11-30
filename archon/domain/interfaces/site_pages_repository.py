"""
Repository interface for site pages.

This module defines the abstract interface for accessing and managing site pages
in the knowledge base, following the Repository Pattern.
"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any
from ..models.site_page import SitePage
from ..models.search_result import SearchResult


class ISitePagesRepository(ABC):
    """
    Abstract interface for site pages repository.

    This interface defines all operations for managing documentation pages
    in the knowledge base. Implementations can use different storage backends
    (Supabase, PostgreSQL, in-memory, etc.) as long as they respect this contract.

    All methods are async to support efficient I/O operations.
    """

    @abstractmethod
    async def get_by_id(self, id: int) -> Optional[SitePage]:
        """
        Retrieve a page by its unique identifier.

        Args:
            id: The unique page identifier

        Returns:
            The page if found, None otherwise

        Example:
            >>> page = await repository.get_by_id(42)
            >>> if page:
            ...     print(page.title)
        """
        pass

    @abstractmethod
    async def find_by_url(self, url: str) -> List[SitePage]:
        """
        Find all chunks for a given URL.

        A single documentation page may be split into multiple chunks,
        each with its own chunk_number. This method returns all chunks
        for the specified URL.

        Args:
            url: The full URL to search for

        Returns:
            List of pages/chunks for that URL, ordered by chunk_number

        Example:
            >>> chunks = await repository.find_by_url("https://ai.pydantic.dev/agents/")
            >>> print(f"Found {len(chunks)} chunks")
        """
        pass

    @abstractmethod
    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        """
        Search for pages similar to the given embedding.

        Performs a vector similarity search (typically cosine similarity)
        to find the most relevant pages.

        Args:
            embedding: Query embedding vector (typically 1536 dimensions for OpenAI)
            limit: Maximum number of results to return
            filter: Optional filter criteria (e.g., {"metadata.source": "pydantic_ai_docs"})

        Returns:
            List of search results, ordered by similarity (highest first)

        Example:
            >>> from archon.infrastructure.openai import OpenAIEmbeddingService
            >>> embedding_service = OpenAIEmbeddingService()
            >>> query_embedding = await embedding_service.get_embedding("how to build agents")
            >>> results = await repository.search_similar(query_embedding, limit=3)
            >>> for result in results:
            ...     print(f"{result.similarity:.2f} - {result.page.title}")
        """
        pass

    @abstractmethod
    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        """
        List all unique URLs in the knowledge base.

        Args:
            source: Optional source filter (e.g., "pydantic_ai_docs")

        Returns:
            Sorted list of unique URLs

        Example:
            >>> urls = await repository.list_unique_urls(source="pydantic_ai_docs")
            >>> print(f"Found {len(urls)} unique pages")
        """
        pass

    @abstractmethod
    async def insert(self, page: SitePage) -> SitePage:
        """
        Insert a new page into the repository.

        Args:
            page: The page to insert (id should be None)

        Returns:
            The inserted page with its generated id

        Raises:
            ValueError: If page.id is not None

        Example:
            >>> new_page = SitePage(
            ...     url="https://example.com/docs",
            ...     chunk_number=0,
            ...     title="Example",
            ...     content="...",
            ...     metadata=SitePageMetadata(source="example_docs")
            ... )
            >>> inserted = await repository.insert(new_page)
            >>> print(f"Inserted with ID: {inserted.id}")
        """
        pass

    @abstractmethod
    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]:
        """
        Insert multiple pages in a single batch operation.

        This method should be more efficient than calling insert() multiple times.

        Args:
            pages: List of pages to insert (all ids should be None)

        Returns:
            List of inserted pages with their generated ids

        Raises:
            ValueError: If any page has a non-None id

        Example:
            >>> pages_to_insert = [page1, page2, page3]
            >>> inserted = await repository.insert_batch(pages_to_insert)
            >>> print(f"Inserted {len(inserted)} pages")
        """
        pass

    @abstractmethod
    async def delete_by_source(self, source: str) -> int:
        """
        Delete all pages from a specific source.

        Useful for refreshing documentation from a single source.

        Args:
            source: The source identifier to delete

        Returns:
            Number of pages deleted

        Example:
            >>> deleted_count = await repository.delete_by_source("pydantic_ai_docs")
            >>> print(f"Deleted {deleted_count} pages from pydantic_ai_docs")
        """
        pass

    @abstractmethod
    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        """
        Count pages in the repository.

        Args:
            filter: Optional filter criteria (e.g., {"metadata.source": "pydantic_ai_docs"})

        Returns:
            Number of pages matching the filter

        Example:
            >>> total = await repository.count()
            >>> pydantic_count = await repository.count({"metadata.source": "pydantic_ai_docs"})
            >>> print(f"Total: {total}, Pydantic AI docs: {pydantic_count}")
        """
        pass
