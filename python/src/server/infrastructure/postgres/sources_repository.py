"""
PostgreSQL implementation of ISourcesRepository.

Uses asyncpg for async database access.
"""

import json
from datetime import datetime, timezone
from typing import Any

from asyncpg import Pool, Record

from ...config.logfire_config import get_logger
from ...domain.interfaces.sources_repository import ISourcesRepository
from ...domain.models.source import Source, SourceCreate

logger = get_logger(__name__)


class PostgresSourcesRepository(ISourcesRepository):
    """
    PostgreSQL-backed repository for documentation sources.

    Uses asyncpg for high-performance async database access.

    Args:
        pool: asyncpg connection pool
        table_name: Name of the sources table (default: archon_sources)
    """

    def __init__(self, pool: Pool, table_name: str = "archon_sources"):
        self.pool = pool
        self.table_name = table_name
        self._logger = logger.bind(repository="PostgresSourcesRepository")

    def _row_to_model(self, row: Record) -> Source:
        """Convert a database row to a Source model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            metadata = json.loads(metadata)

        return Source(
            source_id=row["source_id"],
            url=row.get("url", ""),
            title=row.get("title"),
            description=row.get("description"),
            metadata=metadata,
            pages_count=row.get("pages_count", 0),
            chunks_count=row.get("chunks_count", 0),
            status=row.get("status", "pending"),
            created_at=row.get("created_at"),
            updated_at=row.get("updated_at"),
        )

    async def get_by_id(self, source_id: str) -> Source | None:
        """Get a source by its ID."""
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"SELECT * FROM {self.table_name} WHERE source_id = $1",
                    source_id
                )

                if not row:
                    return None

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"get_by_id failed: {e}", source_id=source_id)
            raise

    async def get_by_url(self, url: str) -> Source | None:
        """Get a source by its base URL."""
        try:
            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"SELECT * FROM {self.table_name} WHERE url = $1",
                    url
                )

                if not row:
                    return None

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"get_by_url failed: {e}", url=url)
            raise

    async def list_all(self) -> list[Source]:
        """List all sources."""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"SELECT * FROM {self.table_name} ORDER BY created_at DESC"
                )

                return [self._row_to_model(row) for row in rows]

        except Exception as e:
            self._logger.error(f"list_all failed: {e}")
            raise

    async def search(self, query: str) -> list[Source]:
        """Search sources by title or description."""
        try:
            search_pattern = f"%{query}%"

            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    f"""
                    SELECT * FROM {self.table_name}
                    WHERE title ILIKE $1 OR description ILIKE $1
                    ORDER BY created_at DESC
                    """,
                    search_pattern
                )

                return [self._row_to_model(row) for row in rows]

        except Exception as e:
            self._logger.error(f"search failed: {e}", query=query)
            raise

    async def create(self, source: SourceCreate) -> Source:
        """Create a new source."""
        try:
            now = datetime.now(timezone.utc)

            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"""
                    INSERT INTO {self.table_name}
                    (source_id, url, title, description, metadata, pages_count, chunks_count, status, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING *
                    """,
                    source.source_id,
                    source.url,
                    source.title,
                    source.description,
                    json.dumps(source.metadata),
                    0,  # pages_count
                    0,  # chunks_count
                    "pending",  # status
                    now,
                    now,
                )

                if not row:
                    raise RuntimeError("Insert returned no data")

                self._logger.info(f"Created source: {source.source_id}")

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"create failed: {e}", source_id=source.source_id)
            raise

    async def update(self, source_id: str, updates: dict[str, Any]) -> Source | None:
        """Update an existing source."""
        try:
            # Add updated_at timestamp
            updates["updated_at"] = datetime.now(timezone.utc)

            # Build SET clause dynamically
            set_clauses = []
            values = []
            param_idx = 1

            for key, value in updates.items():
                if key == "metadata" and isinstance(value, dict):
                    value = json.dumps(value)
                set_clauses.append(f"{key} = ${param_idx}")
                values.append(value)
                param_idx += 1

            values.append(source_id)

            query = f"""
                UPDATE {self.table_name}
                SET {", ".join(set_clauses)}
                WHERE source_id = ${param_idx}
                RETURNING *
            """

            async with self.pool.acquire() as conn:
                row = await conn.fetchrow(query, *values)

                if not row:
                    return None

                self._logger.info(f"Updated source: {source_id}", updates=list(updates.keys()))

                return self._row_to_model(row)

        except Exception as e:
            self._logger.error(f"update failed: {e}", source_id=source_id)
            raise

    async def update_counts(
        self, source_id: str, pages_count: int | None = None, chunks_count: int | None = None
    ) -> None:
        """Update page and chunk counts for a source."""
        try:
            now = datetime.now(timezone.utc)

            # Build update query based on provided counts
            set_clauses = ["updated_at = $1"]
            values: list[Any] = [now]
            param_idx = 2

            if pages_count is not None:
                set_clauses.append(f"pages_count = ${param_idx}")
                values.append(pages_count)
                param_idx += 1

            if chunks_count is not None:
                set_clauses.append(f"chunks_count = ${param_idx}")
                values.append(chunks_count)
                param_idx += 1

            values.append(source_id)

            query = f"""
                UPDATE {self.table_name}
                SET {", ".join(set_clauses)}
                WHERE source_id = ${param_idx}
            """

            async with self.pool.acquire() as conn:
                await conn.execute(query, *values)

            self._logger.info(
                f"Updated counts for source: {source_id}",
                pages_count=pages_count,
                chunks_count=chunks_count,
            )

        except Exception as e:
            self._logger.error(f"update_counts failed: {e}", source_id=source_id)
            raise

    async def update_status(self, source_id: str, status: str) -> None:
        """Update the crawl status of a source."""
        try:
            now = datetime.now(timezone.utc)

            async with self.pool.acquire() as conn:
                await conn.execute(
                    f"""
                    UPDATE {self.table_name}
                    SET status = $1, updated_at = $2
                    WHERE source_id = $3
                    """,
                    status,
                    now,
                    source_id,
                )

            self._logger.info(f"Updated status for source: {source_id}", status=status)

        except Exception as e:
            self._logger.error(f"update_status failed: {e}", source_id=source_id)
            raise

    async def delete(self, source_id: str) -> bool:
        """Delete a source and all its associated data."""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    f"DELETE FROM {self.table_name} WHERE source_id = $1",
                    source_id
                )

                # Parse "DELETE X" to get count
                deleted_count = int(result.split()[-1])
                deleted = deleted_count > 0

                if deleted:
                    self._logger.info(f"Deleted source: {source_id}")
                else:
                    self._logger.warning(f"Source not found for deletion: {source_id}")

                return deleted

        except Exception as e:
            self._logger.error(f"delete failed: {e}", source_id=source_id)
            raise

    async def count(self) -> int:
        """Count total number of sources."""
        try:
            async with self.pool.acquire() as conn:
                count = await conn.fetchval(
                    f"SELECT COUNT(*) FROM {self.table_name}"
                )

                return count or 0

        except Exception as e:
            self._logger.error(f"count failed: {e}")
            raise
