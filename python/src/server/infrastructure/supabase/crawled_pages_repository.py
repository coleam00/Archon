"""
Supabase implementation of ICrawledPagesRepository.

Uses Supabase PostgREST client for CRUD operations and RPC for vector search.
"""

from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger
from ...domain.interfaces.crawled_pages_repository import ICrawledPagesRepository
from ...domain.models.crawled_page import CrawledPage, CrawledPageCreate, CrawledPageMetadata
from ...domain.models.search_result import SearchResult

logger = get_logger(__name__)

# Similarity threshold for vector search results
SIMILARITY_THRESHOLD = 0.05


class SupabaseCrawledPagesRepository(ICrawledPagesRepository):
    """
    Supabase-backed repository for crawled pages.

    Uses the archon_crawled_pages table for storage and
    match_archon_crawled_pages RPC for vector similarity search.

    Args:
        client: Supabase client instance
        table_name: Name of the crawled pages table (default: archon_crawled_pages)
    """

    def __init__(self, client: Client, table_name: str = "archon_crawled_pages"):
        self.client = client
        self.table_name = table_name
        self._logger = logger.bind(repository="SupabaseCrawledPagesRepository")

    def _row_to_model(self, row: dict[str, Any]) -> CrawledPage:
        """Convert a database row to a CrawledPage model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            import json
            metadata = json.loads(metadata)

        return CrawledPage(
            id=str(row["id"]) if row.get("id") else None,
            url=row["url"],
            chunk_number=row.get("chunk_number", 0),
            content=row["content"],
            metadata=CrawledPageMetadata(**metadata) if metadata else CrawledPageMetadata(),
            source_id=row.get("source_id", ""),
            page_id=row.get("page_id"),
            embedding_768=row.get("embedding_768"),
            embedding_1024=row.get("embedding_1024"),
            embedding_1536=row.get("embedding_1536"),
            embedding_3072=row.get("embedding_3072"),
            llm_chat_model=row.get("llm_chat_model"),
            embedding_model=row.get("embedding_model"),
            embedding_dimension=row.get("embedding_dimension"),
            created_at=row.get("created_at"),
        )

    async def get_by_id(self, id: str) -> CrawledPage | None:
        """Get a crawled page by its ID."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("id", id)
                .execute()
            )

            if not response.data:
                return None

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"get_by_id failed: {e}", id=id, exc_info=True)
            raise

    async def find_by_url(self, url: str) -> list[CrawledPage]:
        """Find all chunks for a given URL."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("url", url)
                .order("chunk_number")
                .execute()
            )

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"find_by_url failed: {e}", url=url, exc_info=True)
            raise

    async def find_by_source(self, source_id: str) -> list[CrawledPage]:
        """Find all pages for a given source."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("source_id", source_id)
                .order("url")
                .order("chunk_number")
                .execute()
            )

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"find_by_source failed: {e}", source_id=source_id, exc_info=True)
            raise

    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        filter_metadata: dict[str, Any] | None = None,
    ) -> list[SearchResult[CrawledPage]]:
        """
        Search for pages similar to the given embedding.

        Uses the match_archon_crawled_pages RPC function for vector search.
        """
        try:
            # Build RPC parameters
            rpc_params: dict[str, Any] = {
                "query_embedding": embedding,
                "match_count": match_count,
            }

            # Add source filter
            if source_id:
                rpc_params["source_filter"] = source_id
                rpc_params["filter"] = {}
            elif filter_metadata:
                rpc_params["filter"] = filter_metadata
            else:
                rpc_params["filter"] = {}

            # Execute RPC
            response = self.client.rpc("match_archon_crawled_pages", rpc_params).execute()

            # Process results
            results: list[SearchResult[CrawledPage]] = []
            if response.data:
                for row in response.data:
                    similarity = float(row.get("similarity", 0.0))
                    if similarity >= SIMILARITY_THRESHOLD:
                        page = self._row_to_model(row)
                        results.append(SearchResult(item=page, similarity=similarity))

            self._logger.info(
                f"search_similar returned {len(results)} results",
                match_count=match_count,
                source_id=source_id,
            )

            return results

        except Exception as e:
            self._logger.error(f"search_similar failed: {e}", exc_info=True)
            raise

    async def insert(self, page: CrawledPageCreate) -> CrawledPage:
        """Insert a new crawled page chunk."""
        try:
            # Determine embedding column
            embedding_column = None
            if page.embedding and page.embedding_dimension:
                dim = page.embedding_dimension
                if dim == 768:
                    embedding_column = "embedding_768"
                elif dim == 1024:
                    embedding_column = "embedding_1024"
                elif dim == 1536:
                    embedding_column = "embedding_1536"
                elif dim == 3072:
                    embedding_column = "embedding_3072"

            # Build insert data
            data: dict[str, Any] = {
                "url": page.url,
                "chunk_number": page.chunk_number,
                "content": page.content,
                "metadata": page.metadata,
                "source_id": page.source_id,
                "page_id": page.page_id,
                "llm_chat_model": page.llm_chat_model,
                "embedding_model": page.embedding_model,
                "embedding_dimension": page.embedding_dimension,
            }

            if embedding_column and page.embedding:
                data[embedding_column] = page.embedding

            response = self.client.table(self.table_name).insert(data).execute()

            if not response.data:
                raise RuntimeError("Insert returned no data")

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"insert failed: {e}", url=page.url, exc_info=True)
            raise

    async def insert_batch(self, pages: list[CrawledPageCreate]) -> list[CrawledPage]:
        """Insert multiple page chunks in a batch."""
        if not pages:
            return []

        try:
            batch_data: list[dict[str, Any]] = []

            for page in pages:
                # Determine embedding column
                embedding_column = None
                if page.embedding and page.embedding_dimension:
                    dim = page.embedding_dimension
                    if dim == 768:
                        embedding_column = "embedding_768"
                    elif dim == 1024:
                        embedding_column = "embedding_1024"
                    elif dim == 1536:
                        embedding_column = "embedding_1536"
                    elif dim == 3072:
                        embedding_column = "embedding_3072"

                data: dict[str, Any] = {
                    "url": page.url,
                    "chunk_number": page.chunk_number,
                    "content": page.content,
                    "metadata": page.metadata,
                    "source_id": page.source_id,
                    "page_id": page.page_id,
                    "llm_chat_model": page.llm_chat_model,
                    "embedding_model": page.embedding_model,
                    "embedding_dimension": page.embedding_dimension,
                }

                if embedding_column and page.embedding:
                    data[embedding_column] = page.embedding

                batch_data.append(data)

            response = self.client.table(self.table_name).insert(batch_data).execute()

            self._logger.info(f"insert_batch inserted {len(response.data)} pages")

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"insert_batch failed: {e}", count=len(pages), exc_info=True)
            raise

    async def delete_by_url(self, url: str) -> int:
        """Delete all chunks for a given URL."""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("url", url)
                .execute()
            )

            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"delete_by_url deleted {deleted_count} chunks", url=url)

            return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_url failed: {e}", url=url, exc_info=True)
            raise

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all pages from a specific source."""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("source_id", source_id)
                .execute()
            )

            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"delete_by_source deleted {deleted_count} pages", source_id=source_id)

            return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_source failed: {e}", source_id=source_id, exc_info=True)
            raise

    async def count(self, source_id: str | None = None) -> int:
        """Count pages in the repository."""
        try:
            query = self.client.table(self.table_name).select("id", count="exact")

            if source_id:
                query = query.eq("source_id", source_id)

            response = query.execute()

            return response.count if response.count else 0

        except Exception as e:
            self._logger.error(f"count failed: {e}", source_id=source_id, exc_info=True)
            raise

    async def list_unique_urls(self, source_id: str | None = None) -> list[str]:
        """List all unique URLs in the repository."""
        try:
            query = self.client.table(self.table_name).select("url")

            if source_id:
                query = query.eq("source_id", source_id)

            response = query.execute()

            # Extract unique URLs and sort
            urls = sorted(set(row["url"] for row in response.data))

            return urls

        except Exception as e:
            self._logger.error(f"list_unique_urls failed: {e}", source_id=source_id, exc_info=True)
            raise
