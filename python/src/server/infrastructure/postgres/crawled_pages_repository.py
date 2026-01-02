"""
PostgreSQL implementation of ICrawledPagesRepository.

Uses asyncpg for async database access and pgvector for vector similarity search.
"""

import json
from typing import Any

from asyncpg import Pool, Record

from ...config.logfire_config import get_logger
from ...domain.interfaces.crawled_pages_repository import ICrawledPagesRepository
from ...domain.models.crawled_page import CrawledPage, CrawledPageCreate, CrawledPageMetadata
from ...domain.models.search_result import SearchResult

logger = get_logger(__name__)

# Similarity threshold for vector search results
SIMILARITY_THRESHOLD = 0.05


class PostgresCrawledPagesRepository(ICrawledPagesRepository):
    """
    PostgreSQL-backed repository for crawled pages.

    Uses asyncpg for high-performance async database access and
    pgvector for native vector similarity search.

    Args:
        pool: asyncpg connection pool
        table_name: Name of the crawled pages table (default: archon_crawled_pages)
    """

    def __init__(self, pool: Pool, table_name: str = "archon_crawled_pages"):
        self.pool = pool
        self.table_name = table_name
        self._logger = logger.bind(repository="PostgresCrawledPagesRepository")

    def _row_to_model(self, row: Record) -> CrawledPage:
        """Convert a database row to a CrawledPage model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        # Parse embedding if present (pgvector returns as string)
        def parse_embedding(value):
            if value is None:
                return None
            if isinstance(value, str):
                if value.startswith('[') and value.endswith(']'):
                    return json.loads(value)
                return None
            if hasattr(value, '__iter__'):
                return list(value)
            return None

        return CrawledPage(
            id=str(row["id"]) if row.get("id") else None,
            url=row["url"],
            chunk_number=row.get("chunk_number", 0),
            content=row["content"],
            metadata=CrawledPageMetadata(**metadata) if metadata else CrawledPageMetadata(),
            source_id=row.get("source_id", ""),
            page_id=row.get("page_id"),
            embedding_768=parse_embedding(row.get("embedding_768")),
            embedding_1024=parse_embedding(row.get("embedding_1024")),
            embedding_1536=parse_embedding(row.get("embedding_1536")),
            embedding_3072=parse_embedding(row.get("embedding_3072")),
            llm_chat_model=row.get("llm_chat_model"),
            embedding_model=row.get("embedding_model"),
            embedding_dimension=row.get("embedding_dimension"),
            created_at=row.get("created_at"),
        )

    async def get_by_id(self, id: str) -> CrawledPage | None:
        """Get a crawled page by its ID."""
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"SELECT * FROM {self.table_name} WHERE id = $1",
                    id
                )

                if not row:
                    return None

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"get_by_id failed: {e}", id=id)
            raise

    async def find_by_url(self, url: str) -> list[CrawledPage]:
        """Find all chunks for a given URL."""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT * FROM {self.table_name}
                    WHERE url = $1
                    ORDER BY chunk_number
                    """,
                    url
                )

                return [self._row_to_model(row) for row in rows]

        except Exception as e:
            self._logger.error(f"find_by_url failed: {e}", url=url)
            raise

    async def find_by_source(self, source_id: str) -> list[CrawledPage]:
        """Find all pages for a given source."""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT * FROM {self.table_name}
                    WHERE source_id = $1
                    ORDER BY url, chunk_number
                    """,
                    source_id
                )

                return [self._row_to_model(row) for row in rows]

        except Exception as e:
            self._logger.error(f"find_by_source failed: {e}", source_id=source_id)
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

        Uses pgvector's cosine distance operator (<=>) for similarity search.
        """
        try:
            # Determine which embedding column to use based on dimension
            dim = len(embedding)
            if dim == 768:
                embedding_col = "embedding_768"
            elif dim == 1024:
                embedding_col = "embedding_1024"
            elif dim == 1536:
                embedding_col = "embedding_1536"
            elif dim == 3072:
                embedding_col = "embedding_3072"
            else:
                # Default to 1536
                embedding_col = "embedding_1536"
                self._logger.warning(f"Unknown embedding dimension {dim}, using {embedding_col}")

            # Build query
            query = f"""
                SELECT *,
                       1 - ({embedding_col} <=> $1::vector) as similarity
                FROM {self.table_name}
                WHERE {embedding_col} IS NOT NULL
            """

            params: list[Any] = [str(embedding)]
            param_idx = 2

            # Add source filter
            if source_id:
                query += f" AND source_id = ${param_idx}"
                params.append(source_id)
                param_idx += 1

            # Add metadata filter (only 'source' key for backward compatibility)
            if filter_metadata and "source" in filter_metadata:
                query += f" AND metadata->>'source' = ${param_idx}"
                params.append(filter_metadata["source"])
                param_idx += 1

            query += f" ORDER BY {embedding_col} <=> $1::vector LIMIT ${param_idx}"
            params.append(match_count)

            async with self.pool.acquire() as conn:
                rows = await conn.fetch(query, *params)

                results: list[SearchResult[CrawledPage]] = []
                for row in rows:
                    similarity = float(row.get("similarity", 0.0))
                    # Clip to valid range
                    similarity = max(0.0, min(1.0, similarity))
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
            embedding_col = None
            if page.embedding and page.embedding_dimension:
                dim = page.embedding_dimension
                if dim == 768:
                    embedding_col = "embedding_768"
                elif dim == 1024:
                    embedding_col = "embedding_1024"
                elif dim == 1536:
                    embedding_col = "embedding_1536"
                elif dim == 3072:
                    embedding_col = "embedding_3072"

            # Build column list and values
            columns = [
                "url", "chunk_number", "content", "metadata",
                "source_id", "page_id", "llm_chat_model",
                "embedding_model", "embedding_dimension"
            ]
            values = [
                page.url, page.chunk_number, page.content,
                json.dumps(page.metadata), page.source_id, page.page_id,
                page.llm_chat_model, page.embedding_model, page.embedding_dimension
            ]

            if embedding_col and page.embedding:
                columns.append(embedding_col)
                values.append(str(page.embedding))

            placeholders = ", ".join(f"${i+1}" for i in range(len(values)))
            # Add ::vector cast for embedding
            if embedding_col:
                placeholder_list = [f"${i+1}" for i in range(len(values) - 1)]
                placeholder_list.append(f"${len(values)}::vector")
                placeholders = ", ".join(placeholder_list)

            query = f"""
                INSERT INTO {self.table_name} ({", ".join(columns)})
                VALUES ({placeholders})
                RETURNING *
            """

            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(query, *values)

                if not row:
                    raise RuntimeError("Insert returned no data")

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"insert failed: {e}", url=page.url)
            raise

    async def insert_batch(self, pages: list[CrawledPageCreate]) -> list[CrawledPage]:
        """Insert multiple page chunks in a batch."""
        if not pages:
            return []

        try:
            results: list[CrawledPage] = []

            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    for page in pages:
                        # Determine embedding column
                        embedding_col = None
                        if page.embedding and page.embedding_dimension:
                            dim = page.embedding_dimension
                            if dim == 768:
                                embedding_col = "embedding_768"
                            elif dim == 1024:
                                embedding_col = "embedding_1024"
                            elif dim == 1536:
                                embedding_col = "embedding_1536"
                            elif dim == 3072:
                                embedding_col = "embedding_3072"

                        columns = [
                            "url", "chunk_number", "content", "metadata",
                            "source_id", "page_id", "llm_chat_model",
                            "embedding_model", "embedding_dimension"
                        ]
                        values = [
                            page.url, page.chunk_number, page.content,
                            json.dumps(page.metadata), page.source_id, page.page_id,
                            page.llm_chat_model, page.embedding_model, page.embedding_dimension
                        ]

                        if embedding_col and page.embedding:
                            columns.append(embedding_col)
                            values.append(str(page.embedding))

                        # Build placeholders with vector cast
                        if embedding_col:
                            placeholder_list = [f"${i+1}" for i in range(len(values) - 1)]
                            placeholder_list.append(f"${len(values)}::vector")
                            placeholders = ", ".join(placeholder_list)
                        else:
                            placeholders = ", ".join(f"${i+1}" for i in range(len(values)))

                        query = f"""
                            INSERT INTO {self.table_name} ({", ".join(columns)})
                            VALUES ({placeholders})
                            RETURNING *
                        """

                        row = await conn.fetchrow(query, *values)
                        if row:
                            results.append(self._row_to_model(row))

            self._logger.info(f"insert_batch inserted {len(results)} pages")

            return results

        except Exception as e:
            self._logger.error(f"insert_batch failed: {e}", count=len(pages))
            raise

    async def delete_by_url(self, url: str) -> int:
        """Delete all chunks for a given URL."""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    f"DELETE FROM {self.table_name} WHERE url = $1",
                    url
                )

                # Parse "DELETE X" to get count (asyncpg returns "DELETE N")
                try:
                    deleted_count = int(result.split()[-1])
                except (ValueError, IndexError):
                    self._logger.warning(f"Could not parse delete result: {result}")
                    deleted_count = 0
                self._logger.info(f"delete_by_url deleted {deleted_count} chunks", url=url)

                return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_url failed: {e}", url=url)
            raise

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all pages from a specific source."""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    f"DELETE FROM {self.table_name} WHERE source_id = $1",
                    source_id
                )

                deleted_count = int(result.split()[-1])
                self._logger.info(f"delete_by_source deleted {deleted_count} pages", source_id=source_id)

                return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_source failed: {e}", source_id=source_id)
            raise

    async def count(self, source_id: str | None = None) -> int:
        """Count pages in the repository."""
        try:
            async with self.pool.acquire() as conn:
                if source_id:
                    count = await conn.fetchval(
                        f"SELECT COUNT(*) FROM {self.table_name} WHERE source_id = $1",
                        source_id
                    )
                else:
                    count = await conn.fetchval(
                        f"SELECT COUNT(*) FROM {self.table_name}"
                    )

                return count or 0

        except Exception as e:
            self._logger.error(f"count failed: {e}", source_id=source_id)
            raise

    async def list_unique_urls(self, source_id: str | None = None) -> list[str]:
        """List all unique URLs in the repository."""
        try:
            async with self.pool.acquire() as conn:
                if source_id:
                    rows = await conn.fetch(
                        f"""
                        SELECT DISTINCT url FROM {self.table_name}
                        WHERE source_id = $1
                        ORDER BY url
                        """,
                        source_id
                    )
                else:
                    rows = await conn.fetch(
                        f"SELECT DISTINCT url FROM {self.table_name} ORDER BY url"
                    )

                return [row["url"] for row in rows]

        except Exception as e:
            self._logger.error(f"list_unique_urls failed: {e}", source_id=source_id)
            raise
