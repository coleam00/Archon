"""
PostgreSQL implementation of the ISitePagesRepository interface.

Uses asyncpg for high-performance async database access and pgvector
for native vector similarity search.
"""

import logging
from typing import Optional, List, Dict, Any
import json
import asyncpg
from asyncpg import Pool

from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.domain.models.search_result import SearchResult

logger = logging.getLogger("archon.repository.postgres")

# Security: Whitelist of valid table names to prevent SQL injection
VALID_TABLE_NAMES = frozenset({"site_pages", "crawled_pages"})

# Security: Whitelist of valid column names for filtering
VALID_COLUMN_NAMES = frozenset({
    "id", "url", "chunk_number", "title", "summary",
    "content", "metadata", "embedding", "created_at"
})


class PostgresSitePagesRepository(ISitePagesRepository):
    """
    PostgreSQL implementation using asyncpg and pgvector.

    This repository provides direct PostgreSQL access without the Supabase
    abstraction layer, offering maximum performance and control.

    Args:
        pool: asyncpg connection pool
        table_name: Name of the site_pages table (default: "site_pages")
    """

    def __init__(self, pool: Pool, table_name: str = "site_pages"):
        """
        Initialize the repository with a connection pool.

        Args:
            pool: asyncpg connection pool
            table_name: Name of the table to use

        Raises:
            ValueError: If table_name is not in the whitelist
        """
        # Security: Validate table_name against whitelist
        if table_name not in VALID_TABLE_NAMES:
            raise ValueError(
                f"Invalid table name: {table_name}. "
                f"Allowed values: {', '.join(sorted(VALID_TABLE_NAMES))}"
            )
        self.pool = pool
        self.table_name = table_name

    @classmethod
    async def create(
        cls,
        host: str = "localhost",
        port: int = 5432,
        database: str = "archon",
        user: str = "postgres",
        password: str = "",
        min_size: int = 5,
        max_size: int = 20,
    ) -> "PostgresSitePagesRepository":
        """
        Factory method to create a repository with a connection pool.

        Args:
            host: PostgreSQL host
            port: PostgreSQL port
            database: Database name
            user: Database user
            password: Database password
            min_size: Minimum pool size
            max_size: Maximum pool size

        Returns:
            PostgresSitePagesRepository instance

        Example:
            >>> repo = await PostgresSitePagesRepository.create(
            ...     host="localhost",
            ...     database="archon",
            ...     user="postgres",
            ...     password="secret"
            ... )
        """
        pool = await asyncpg.create_pool(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
            min_size=min_size,
            max_size=max_size,
        )
        logger.info(f"Created PostgreSQL connection pool: {user}@{host}:{port}/{database}")
        return cls(pool)

    async def close(self) -> None:
        """Close the connection pool."""
        logger.debug("Closing connection pool")
        await self.pool.close()

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
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"SELECT * FROM {self.table_name} WHERE id = $1",
                    id
                )

                if not row:
                    logger.debug(f"get_by_id(id={id}) -> None")
                    return None

                page = self._row_to_site_page(row)
                logger.info(f"get_by_id(id={id}) -> found page with url={page.url}")
                return page

        except Exception as e:
            logger.exception(f"get_by_id(id={id}) -> ERROR")
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
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT * FROM {self.table_name}
                    WHERE url = $1
                    ORDER BY chunk_number
                    """,
                    url
                )

                pages = [self._row_to_site_page(row) for row in rows]
                logger.info(f"find_by_url(url={url}) -> {len(pages)} pages")
                return pages

        except Exception as e:
            logger.exception(f"find_by_url(url={url}) -> ERROR")
            raise RuntimeError(f"Failed to find pages by URL {url}") from e

    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        """
        Search for pages similar to the given embedding.

        Uses pgvector's cosine distance operator (<=>) for similarity search.

        Args:
            embedding: Query embedding vector (typically 1536 dimensions)
            limit: Maximum number of results to return
            filter: Optional filter criteria (e.g., {"source": "pydantic_ai_docs"})

        Returns:
            List of search results, ordered by similarity (highest first)
        """
        logger.debug(
            f"search_similar(embedding_len={len(embedding)}, limit={limit}, filter={filter})"
        )

        try:
            # Build the query with optional filter
            query = f"""
                SELECT *,
                       1 - (embedding <=> $1::vector) as similarity
                FROM {self.table_name}
                WHERE embedding IS NOT NULL
            """

            params = [str(embedding)]
            param_idx = 2

            # Apply filters if provided
            if filter:
                if "source" in filter:
                    query += f" AND metadata->>'source' = ${param_idx}"
                    params.append(filter["source"])
                    param_idx += 1

            query += f" ORDER BY embedding <=> $1::vector LIMIT ${param_idx}"
            params.append(limit)

            async with self.pool.acquire() as conn:
                rows = await conn.fetch(query, *params)

                results = []
                for row in rows:
                    page = self._row_to_site_page(row)
                    # Clip similarity to valid range [0, 1]
                    # Note: Can be negative with poorly normalized embeddings
                    similarity = max(0.0, min(1.0, float(row["similarity"])))
                    results.append(SearchResult(page=page, similarity=similarity))

                logger.info(
                    f"search_similar(embedding_len={len(embedding)}, limit={limit}) -> "
                    f"{len(results)} results"
                )
                return results

        except Exception as e:
            logger.exception("search_similar() -> ERROR")
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
            async with self.pool.acquire() as conn:
                if source:
                    rows = await conn.fetch(
                        f"""
                        SELECT DISTINCT url FROM {self.table_name}
                        WHERE metadata->>'source' = $1
                        ORDER BY url
                        """,
                        source
                    )
                else:
                    rows = await conn.fetch(
                        f"SELECT DISTINCT url FROM {self.table_name} ORDER BY url"
                    )

                urls = [row["url"] for row in rows]
                logger.info(f"list_unique_urls(source={source}) -> {len(urls)} urls")
                return urls

        except Exception as e:
            logger.exception(f"list_unique_urls(source={source}) -> ERROR")
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
            async with self.pool.acquire() as conn:
                # Prepare embedding for pgvector
                embedding_str = None
                if page.embedding:
                    embedding_str = str(page.embedding)

                row = await conn.fetchrow(
                    f"""
                    INSERT INTO {self.table_name}
                    (url, chunk_number, title, summary, content, metadata, embedding)
                    VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
                    RETURNING *
                    """,
                    page.url,
                    page.chunk_number,
                    page.title,
                    page.summary,
                    page.content,
                    page.metadata.model_dump_json() if page.metadata else "{}",
                    embedding_str,
                )

                inserted_page = self._row_to_site_page(row)
                logger.info(
                    f"insert(url={page.url}, chunk_number={page.chunk_number}) -> "
                    f"id={inserted_page.id}"
                )
                return inserted_page

        except Exception as e:
            logger.exception(f"insert(url={page.url}) -> ERROR")
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

        if not pages:
            return []

        try:
            async with self.pool.acquire() as conn:
                # Use a transaction for batch insert
                async with conn.transaction():
                    inserted = []
                    for page in pages:
                        # Prepare embedding
                        embedding_str = None
                        if page.embedding:
                            embedding_str = str(page.embedding)

                        row = await conn.fetchrow(
                            f"""
                            INSERT INTO {self.table_name}
                            (url, chunk_number, title, summary, content, metadata, embedding)
                            VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
                            RETURNING *
                            """,
                            page.url,
                            page.chunk_number,
                            page.title,
                            page.summary,
                            page.content,
                            page.metadata.model_dump_json() if page.metadata else "{}",
                            embedding_str,
                        )
                        inserted.append(self._row_to_site_page(row))

                logger.info(
                    f"insert_batch(pages_count={len(pages)}) -> "
                    f"inserted {len(inserted)} pages"
                )
                return inserted

        except Exception as e:
            logger.exception(f"insert_batch(pages_count={len(pages)}) -> ERROR")
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
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    f"""
                    DELETE FROM {self.table_name}
                    WHERE metadata->>'source' = $1
                    """,
                    source
                )

                # Parse "DELETE X" to get count
                deleted_count = int(result.split()[-1])
                logger.info(f"delete_by_source(source={source}) -> deleted {deleted_count}")
                return deleted_count

        except Exception as e:
            logger.exception(f"delete_by_source(source={source}) -> ERROR")
            raise RuntimeError(f"Failed to delete pages for source {source}") from e

    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        """
        Count pages in the repository.

        Args:
            filter: Optional filter criteria (e.g., {"metadata.source": "pydantic_ai_docs"})

        Returns:
            Number of pages matching the filter
        """
        logger.debug(f"count(filter={filter})")

        try:
            query = f"SELECT COUNT(*) FROM {self.table_name}"
            params = []
            param_idx = 1

            if filter:
                conditions = []
                for key, value in filter.items():
                    if key.startswith("metadata."):
                        # Handle metadata filters (metadata keys are user data, validated separately)
                        metadata_key = key.replace("metadata.", "")
                        # Sanitize metadata key: only allow alphanumeric and underscore
                        if not metadata_key.replace("_", "").isalnum():
                            logger.warning(f"Skipping invalid metadata key: {metadata_key}")
                            continue
                        conditions.append(f"metadata->>'{metadata_key}' = ${param_idx}")
                    else:
                        # Security: Validate column name against whitelist
                        if key not in VALID_COLUMN_NAMES:
                            logger.warning(f"Skipping invalid column name: {key}")
                            continue
                        conditions.append(f"{key} = ${param_idx}")
                    params.append(value)
                    param_idx += 1

                if conditions:
                    query += " WHERE " + " AND ".join(conditions)

            async with self.pool.acquire() as conn:
                count = await conn.fetchval(query, *params)
                logger.info(f"count(filter={filter}) -> {count}")
                return count

        except Exception as e:
            logger.exception(f"count(filter={filter}) -> ERROR")
            raise RuntimeError(f"Failed to count pages with filter {filter}") from e

    def _row_to_site_page(self, row: asyncpg.Record) -> SitePage:
        """
        Convert a database row to a SitePage domain model.

        Args:
            row: asyncpg Record from database query

        Returns:
            SitePage instance
        """
        # Parse metadata JSON
        metadata_dict = row["metadata"]
        if isinstance(metadata_dict, str):
            metadata_dict = json.loads(metadata_dict)

        # Parse embedding if present
        embedding = None
        if row["embedding"] is not None:
            # asyncpg returns pgvector as a string like "[0.1, 0.2, ...]"
            embedding_str = str(row["embedding"])
            if embedding_str.startswith('[') and embedding_str.endswith(']'):
                embedding = json.loads(embedding_str)
            else:
                # Handle alternative format
                embedding = list(row["embedding"])

        return SitePage(
            id=row["id"],
            url=row["url"],
            chunk_number=row["chunk_number"],
            title=row["title"],
            summary=row["summary"],
            content=row["content"],
            metadata=SitePageMetadata(**metadata_dict),
            embedding=embedding,
            created_at=row.get("created_at"),
        )
