"""
PostgreSQL implementation of ICodeExamplesRepository.

Uses asyncpg for async database access and pgvector for vector similarity search.
"""

import json
from typing import Any

from asyncpg import Pool, Record

from ...config.logfire_config import get_logger
from ...domain.interfaces.code_examples_repository import ICodeExamplesRepository
from ...domain.models.code_example import CodeExample, CodeExampleCreate
from ...domain.models.search_result import SearchResult

logger = get_logger(__name__)

# Similarity threshold for vector search results
SIMILARITY_THRESHOLD = 0.05


class PostgresCodeExamplesRepository(ICodeExamplesRepository):
    """
    PostgreSQL-backed repository for code examples.

    Uses asyncpg for high-performance async database access and
    pgvector for native vector similarity search.

    Args:
        pool: asyncpg connection pool
        table_name: Name of the code examples table (default: archon_code_examples)
    """

    def __init__(self, pool: Pool, table_name: str = "archon_code_examples"):
        self.pool = pool
        self.table_name = table_name
        self._logger = logger.bind(repository="PostgresCodeExamplesRepository")

    def _row_to_model(self, row: Record) -> CodeExample:
        """Convert a database row to a CodeExample model."""
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

        return CodeExample(
            id=str(row["id"]) if row.get("id") else None,
            source_id=row.get("source_id", ""),
            page_url=row.get("page_url", ""),
            code=row.get("code", ""),
            language=row.get("language"),
            summary=row.get("summary"),
            context=row.get("context"),
            metadata=metadata,
            embedding_768=parse_embedding(row.get("embedding_768")),
            embedding_1024=parse_embedding(row.get("embedding_1024")),
            embedding_1536=parse_embedding(row.get("embedding_1536")),
            embedding_3072=parse_embedding(row.get("embedding_3072")),
            embedding_model=row.get("embedding_model"),
            embedding_dimension=row.get("embedding_dimension"),
            created_at=row.get("created_at"),
        )

    async def get_by_id(self, id: str) -> CodeExample | None:
        """Get a code example by its ID."""
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

    async def find_by_source(self, source_id: str) -> list[CodeExample]:
        """Find all code examples for a given source."""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT * FROM {self.table_name}
                    WHERE source_id = $1
                    ORDER BY created_at DESC
                    """,
                    source_id
                )

                return [self._row_to_model(row) for row in rows]

        except Exception as e:
            self._logger.error(f"find_by_source failed: {e}", source_id=source_id)
            raise

    async def find_by_page_url(self, page_url: str) -> list[CodeExample]:
        """Find all code examples from a specific page."""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT * FROM {self.table_name}
                    WHERE page_url = $1
                    ORDER BY created_at
                    """,
                    page_url
                )

                return [self._row_to_model(row) for row in rows]

        except Exception as e:
            self._logger.error(f"find_by_page_url failed: {e}", page_url=page_url)
            raise

    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        language: str | None = None,
    ) -> list[SearchResult[CodeExample]]:
        """
        Search for code examples similar to the given embedding.

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

            # Add language filter
            if language:
                query += f" AND language = ${param_idx}"
                params.append(language)
                param_idx += 1

            query += f" ORDER BY {embedding_col} <=> $1::vector LIMIT ${param_idx}"
            params.append(match_count)

            async with self.pool.acquire() as conn:
                rows = await conn.fetch(query, *params)

                results: list[SearchResult[CodeExample]] = []
                for row in rows:
                    similarity = float(row.get("similarity", 0.0))
                    # Clip to valid range
                    similarity = max(0.0, min(1.0, similarity))
                    if similarity >= SIMILARITY_THRESHOLD:
                        example = self._row_to_model(row)
                        results.append(SearchResult(item=example, similarity=similarity))

                self._logger.info(
                    f"search_similar returned {len(results)} results",
                    match_count=match_count,
                    source_id=source_id,
                    language=language,
                )

                return results

        except Exception as e:
            self._logger.error(f"search_similar failed: {e}")
            raise

    async def insert(self, example: CodeExampleCreate) -> CodeExample:
        """Insert a new code example."""
        try:
            # Determine embedding column
            embedding_col = None
            if example.embedding and example.embedding_dimension:
                dim = example.embedding_dimension
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
                "source_id", "page_url", "code", "language", "summary",
                "context", "metadata", "embedding_model", "embedding_dimension"
            ]
            values = [
                example.source_id, example.page_url, example.code,
                example.language, example.summary, example.context,
                json.dumps(example.metadata), example.embedding_model,
                example.embedding_dimension
            ]

            if embedding_col and example.embedding:
                columns.append(embedding_col)
                values.append(str(example.embedding))

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

            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(query, *values)

                if not row:
                    raise RuntimeError("Insert returned no data")

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"insert failed: {e}", page_url=example.page_url)
            raise

    async def insert_batch(self, examples: list[CodeExampleCreate]) -> list[CodeExample]:
        """Insert multiple code examples in a batch."""
        if not examples:
            return []

        try:
            results: list[CodeExample] = []

            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    for example in examples:
                        # Determine embedding column
                        embedding_col = None
                        if example.embedding and example.embedding_dimension:
                            dim = example.embedding_dimension
                            if dim == 768:
                                embedding_col = "embedding_768"
                            elif dim == 1024:
                                embedding_col = "embedding_1024"
                            elif dim == 1536:
                                embedding_col = "embedding_1536"
                            elif dim == 3072:
                                embedding_col = "embedding_3072"

                        columns = [
                            "source_id", "page_url", "code", "language", "summary",
                            "context", "metadata", "embedding_model", "embedding_dimension"
                        ]
                        values = [
                            example.source_id, example.page_url, example.code,
                            example.language, example.summary, example.context,
                            json.dumps(example.metadata), example.embedding_model,
                            example.embedding_dimension
                        ]

                        if embedding_col and example.embedding:
                            columns.append(embedding_col)
                            values.append(str(example.embedding))

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

            self._logger.info(f"insert_batch inserted {len(results)} examples")

            return results

        except Exception as e:
            self._logger.error(f"insert_batch failed: {e}", count=len(examples))
            raise

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all code examples from a specific source."""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    f"DELETE FROM {self.table_name} WHERE source_id = $1",
                    source_id
                )

                # Parse "DELETE X" to get count
                deleted_count = int(result.split()[-1])
                self._logger.info(f"delete_by_source deleted {deleted_count} examples", source_id=source_id)

                return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_source failed: {e}", source_id=source_id)
            raise

    async def delete_by_page_url(self, page_url: str) -> int:
        """Delete all code examples from a specific page."""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    f"DELETE FROM {self.table_name} WHERE page_url = $1",
                    page_url
                )

                # Parse "DELETE X" to get count
                deleted_count = int(result.split()[-1])
                self._logger.info(f"delete_by_page_url deleted {deleted_count} examples", page_url=page_url)

                return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_page_url failed: {e}", page_url=page_url)
            raise

    async def count(self, source_id: str | None = None) -> int:
        """Count code examples in the repository."""
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

    async def list_languages(self, source_id: str | None = None) -> list[str]:
        """List all unique programming languages."""
        try:
            async with self.pool.acquire() as conn:
                if source_id:
                    rows = await conn.fetch(
                        f"""
                        SELECT DISTINCT language FROM {self.table_name}
                        WHERE source_id = $1 AND language IS NOT NULL
                        ORDER BY language
                        """,
                        source_id
                    )
                else:
                    rows = await conn.fetch(
                        f"""
                        SELECT DISTINCT language FROM {self.table_name}
                        WHERE language IS NOT NULL
                        ORDER BY language
                        """
                    )

                return [row["language"] for row in rows]

        except Exception as e:
            self._logger.error(f"list_languages failed: {e}", source_id=source_id)
            raise
