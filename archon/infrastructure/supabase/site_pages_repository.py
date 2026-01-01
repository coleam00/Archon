"""
Supabase implementation of the ISitePagesRepository interface.

This module provides a concrete implementation using Supabase as the backend.
"""

import logging
from typing import Optional, List, Dict, Any
from supabase import Client
from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
from archon.domain.models.site_page import SitePage
from archon.domain.models.search_result import SearchResult
from .mappers import dict_to_site_page, site_page_to_dict, dict_to_search_result

logger = logging.getLogger("archon.repository.supabase")


class SupabaseSitePagesRepository(ISitePagesRepository):
    """
    Supabase implementation of the site pages repository.

    This class uses the Supabase client to interact with the site_pages table.
    It handles all CRUD operations and vector similarity search.

    Args:
        client: Supabase client instance
    """

    def __init__(self, client: Client):
        """
        Initialize the repository with a Supabase client.

        Args:
            client: Configured Supabase client
        """
        self.client = client
        self.table_name = "site_pages"

    async def get_by_id(self, id: int) -> Optional[SitePage]:
        """
        Retrieve a page by its unique identifier.

        Args:
            id: The unique page identifier

        Returns:
            The page if found, None otherwise
        """
        logger.debug(f"get_by_id(id={id})")

        try:
            result = self.client.from_(self.table_name).select("*").eq("id", id).execute()

            if not result.data:
                logger.debug(f"get_by_id(id={id}) -> None")
                return None

            page = dict_to_site_page(result.data[0])
            logger.info(f"get_by_id(id={id}) -> found page with url={page.url}")
            return page

        except Exception as e:
            logger.error(f"get_by_id(id={id}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to get page by id {id}") from e

    async def find_by_url(self, url: str) -> List[SitePage]:
        """
        Find all chunks for a given URL.

        Args:
            url: The full URL to search for

        Returns:
            List of pages/chunks for that URL, ordered by chunk_number
        """
        logger.debug(f"find_by_url(url={url})")

        try:
            result = (
                self.client.from_(self.table_name)
                .select("*")
                .eq("url", url)
                .order("chunk_number")
                .execute()
            )

            pages = [dict_to_site_page(data) for data in result.data]
            logger.info(f"find_by_url(url={url}) -> {len(pages)} pages")
            return pages

        except Exception as e:
            logger.error(f"find_by_url(url={url}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to find pages by URL {url}") from e

    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        """
        Search for pages similar to the given embedding.

        Uses the Supabase match_site_pages RPC function for vector similarity search.

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

        try:
            # Build RPC parameters
            rpc_params = {
                "query_embedding": embedding,
                "match_count": limit,
            }

            # Add filter if provided
            if filter:
                rpc_params["filter"] = filter

            # Call the Supabase RPC function
            result = self.client.rpc("match_site_pages", rpc_params).execute()

            # Convert results to SearchResult objects
            search_results = [dict_to_search_result(data) for data in result.data]

            logger.info(
                f"search_similar(embedding_len={len(embedding)}, limit={limit}) -> {len(search_results)} results"
            )
            return search_results

        except Exception as e:
            logger.error(f"search_similar() -> ERROR: {e}")
            raise RuntimeError("Failed to search similar pages") from e

    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        """
        List all unique URLs in the knowledge base.

        Args:
            source: Optional source filter (e.g., "pydantic_ai_docs")

        Returns:
            Sorted list of unique URLs
        """
        logger.debug(f"list_unique_urls(source={source})")

        try:
            query = self.client.from_(self.table_name).select("url")

            # Apply source filter if provided
            if source:
                query = query.eq("metadata->>source", source)

            result = query.execute()

            # Extract unique URLs and sort
            urls = sorted(set(doc["url"] for doc in result.data))

            logger.info(f"list_unique_urls(source={source}) -> {len(urls)} urls")
            return urls

        except Exception as e:
            logger.error(f"list_unique_urls(source={source}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to list unique URLs for source {source}") from e

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

        try:
            data = site_page_to_dict(page)
            result = self.client.table(self.table_name).insert(data).execute()

            inserted_page = dict_to_site_page(result.data[0])
            logger.info(
                f"insert(url={page.url}, chunk_number={page.chunk_number}) -> id={inserted_page.id}"
            )
            return inserted_page

        except Exception as e:
            logger.error(f"insert(url={page.url}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to insert page {page.url}") from e

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

        try:
            # Convert all pages to dicts
            data_list = [site_page_to_dict(page) for page in pages]

            # Batch insert
            result = self.client.table(self.table_name).insert(data_list).execute()

            # Convert results back to domain models
            inserted_pages = [dict_to_site_page(data) for data in result.data]

            logger.info(f"insert_batch(pages_count={len(pages)}) -> inserted {len(inserted_pages)} pages")
            return inserted_pages

        except Exception as e:
            logger.error(f"insert_batch(pages_count={len(pages)}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to insert batch of {len(pages)} pages") from e

    async def delete_by_source(self, source: str) -> int:
        """
        Delete all pages from a specific source.

        Args:
            source: The source identifier to delete

        Returns:
            Number of pages deleted
        """
        logger.debug(f"delete_by_source(source={source})")

        try:
            result = (
                self.client.table(self.table_name)
                .delete()
                .eq("metadata->>source", source)
                .execute()
            )

            # Count deleted rows
            deleted_count = len(result.data) if result.data else 0

            logger.info(f"delete_by_source(source={source}) -> deleted {deleted_count} pages")
            return deleted_count

        except Exception as e:
            logger.error(f"delete_by_source(source={source}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to delete pages for source {source}") from e

    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        """
        Count pages in the repository.

        Args:
            filter: Optional filter criteria (e.g., {"source": "pydantic_ai_docs"})

        Returns:
            Number of pages matching the filter
        """
        logger.debug(f"count(filter={filter})")

        try:
            query = self.client.from_(self.table_name).select("id", count="exact")

            # Apply filters if provided
            if filter:
                for key, value in filter.items():
                    # Handle metadata filters
                    if key.startswith("metadata."):
                        metadata_key = key.replace("metadata.", "")
                        query = query.eq(f"metadata->>{metadata_key}", value)
                    else:
                        query = query.eq(key, value)

            result = query.execute()

            # Supabase returns count in the count attribute
            count_result = result.count if hasattr(result, "count") else len(result.data)

            logger.info(f"count(filter={filter}) -> {count_result}")
            return count_result

        except Exception as e:
            logger.error(f"count(filter={filter}) -> ERROR: {e}")
            raise RuntimeError(f"Failed to count pages with filter {filter}") from e
