"""
Documentation Service - Business logic for documentation operations.

This service encapsulates all documentation-related operations:
- Searching documentation with semantic similarity
- Retrieving full page content
- Listing available documentation

It orchestrates calls to repository and embedding service to provide
a clean, high-level API for agents.
"""

from typing import List, Optional, Dict, Any
import logging

from archon.domain import ISitePagesRepository, IEmbeddingService, SearchResult, SitePage

logger = logging.getLogger("archon.services.documentation")


class DocumentationService:
    """
    Service for documentation operations.

    This service provides high-level operations for working with documentation:
    - Semantic search across documentation
    - Full page content retrieval
    - Available pages listing

    The service handles embedding generation, repository queries, and result formatting.

    Example:
        >>> from archon.container import get_documentation_service
        >>> service = get_documentation_service()
        >>> results = await service.search_documentation("how to build agents", limit=5)
        >>> for result in results:
        ...     print(f"{result.similarity:.2f} - {result.page.title}")
    """

    def __init__(
        self,
        repository: ISitePagesRepository,
        embedding_service: IEmbeddingService,
    ):
        """
        Initialize the documentation service.

        Args:
            repository: Repository for accessing site pages
            embedding_service: Service for generating embeddings
        """
        self._repository = repository
        self._embedding_service = embedding_service
        logger.debug("DocumentationService initialized")

    async def search_documentation(
        self,
        query: str,
        limit: int = 5,
        source: Optional[str] = None,
    ) -> List[SearchResult]:
        """
        Search documentation using semantic similarity.

        This method:
        1. Generates an embedding for the query
        2. Searches the repository for similar pages
        3. Returns ranked results

        Args:
            query: Search query text
            limit: Maximum number of results to return (default: 5)
            source: Optional source filter (e.g., "pydantic_ai_docs")

        Returns:
            List of search results, ordered by similarity (highest first)

        Example:
            >>> results = await service.search_documentation(
            ...     "how to use tools with agents",
            ...     limit=3,
            ...     source="pydantic_ai_docs"
            ... )
            >>> print(f"Found {len(results)} results")
        """
        logger.debug(f"Searching documentation: query='{query}', limit={limit}, source={source}")

        # Generate embedding for the query
        embedding = await self._embedding_service.get_embedding(query)
        logger.debug(f"Generated embedding with {len(embedding)} dimensions")

        # Build filter if source specified
        filter_dict: Optional[Dict[str, Any]] = None
        if source:
            filter_dict = {"metadata.source": source}

        # Search for similar pages
        results = await self._repository.search_similar(
            embedding=embedding,
            limit=limit,
            filter=filter_dict,
        )

        logger.info(f"Found {len(results)} results for query: '{query}'")
        return results

    async def get_page_content(self, url: str) -> str:
        """
        Get the full content of a page from all its chunks.

        A single documentation page may be split into multiple chunks.
        This method retrieves all chunks and concatenates them into
        the complete page content.

        Args:
            url: Full URL of the page

        Returns:
            Full page content (all chunks concatenated)

        Raises:
            ValueError: If no chunks found for the URL

        Example:
            >>> content = await service.get_page_content(
            ...     "https://ai.pydantic.dev/agents/"
            ... )
            >>> print(f"Page length: {len(content)} characters")
        """
        logger.debug(f"Retrieving page content for: {url}")

        # Get all chunks for the URL
        chunks = await self._repository.find_by_url(url)

        if not chunks:
            raise ValueError(f"No content found for URL: {url}")

        # Sort by chunk_number to ensure correct order
        sorted_chunks = sorted(chunks, key=lambda c: c.chunk_number)

        # Concatenate content
        full_content = "\n\n".join(chunk.content for chunk in sorted_chunks)

        logger.info(f"Retrieved {len(chunks)} chunks for {url}, total length: {len(full_content)}")
        return full_content

    async def list_available_pages(
        self,
        source: Optional[str] = None
    ) -> List[str]:
        """
        List all available documentation pages (unique URLs).

        Args:
            source: Optional source filter (e.g., "pydantic_ai_docs")

        Returns:
            Sorted list of unique URLs

        Example:
            >>> urls = await service.list_available_pages(source="pydantic_ai_docs")
            >>> print(f"Found {len(urls)} pages")
            >>> for url in urls[:5]:
            ...     print(url)
        """
        logger.debug(f"Listing available pages for source: {source}")

        urls = await self._repository.list_unique_urls(source=source)

        logger.info(f"Found {len(urls)} unique pages" + (f" for source '{source}'" if source else ""))
        return urls

    async def get_page_metadata(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Get metadata for a specific page.

        Returns the metadata from the first chunk of the page.

        Args:
            url: Full URL of the page

        Returns:
            Page metadata as a dictionary, or None if page not found

        Example:
            >>> metadata = await service.get_page_metadata(
            ...     "https://ai.pydantic.dev/agents/"
            ... )
            >>> if metadata:
            ...     print(f"Source: {metadata.get('source')}")
        """
        logger.debug(f"Retrieving metadata for: {url}")

        chunks = await self._repository.find_by_url(url)

        if not chunks:
            logger.warning(f"No metadata found for URL: {url}")
            return None

        # Return metadata from first chunk
        first_chunk = chunks[0]
        metadata_dict = first_chunk.metadata.model_dump() if first_chunk.metadata else {}

        logger.debug(f"Retrieved metadata for {url}: {metadata_dict}")
        return metadata_dict

    async def count_pages(self, source: Optional[str] = None) -> int:
        """
        Count total number of pages (chunks) in the repository.

        Args:
            source: Optional source filter (e.g., "pydantic_ai_docs")

        Returns:
            Total number of page chunks

        Example:
            >>> total = await service.count_pages()
            >>> pydantic_count = await service.count_pages(source="pydantic_ai_docs")
            >>> print(f"Total: {total}, Pydantic AI: {pydantic_count}")
        """
        logger.debug(f"Counting pages for source: {source}")

        filter_dict: Optional[Dict[str, Any]] = None
        if source:
            filter_dict = {"metadata.source": source}

        count = await self._repository.count(filter=filter_dict)

        logger.info(f"Page count: {count}" + (f" for source '{source}'" if source else ""))
        return count
