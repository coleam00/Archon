"""
Supabase implementation of ISourcesRepository.

Uses Supabase PostgREST client for CRUD operations on documentation sources.
"""

from datetime import datetime, timezone
from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger
from ...domain.interfaces.sources_repository import ISourcesRepository
from ...domain.models.source import Source, SourceCreate

logger = get_logger(__name__)


class SupabaseSourcesRepository(ISourcesRepository):
    """
    Supabase-backed repository for documentation sources.

    Uses the archon_sources table for storage.

    Args:
        client: Supabase client instance
        table_name: Name of the sources table (default: archon_sources)
    """

    def __init__(self, client: Client, table_name: str = "archon_sources"):
        self.client = client
        self.table_name = table_name
        self._logger = logger.bind(repository="SupabaseSourcesRepository")

    def _row_to_model(self, row: dict[str, Any]) -> Source:
        """Convert a database row to a Source model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            import json
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
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("source_id", source_id)
                .execute()
            )

            if not response.data:
                return None

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"get_by_id failed: {e}", source_id=source_id)
            raise

    async def get_by_url(self, url: str) -> Source | None:
        """Get a source by its base URL."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("url", url)
                .execute()
            )

            if not response.data:
                return None

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"get_by_url failed: {e}", url=url)
            raise

    async def list_all(self) -> list[Source]:
        """List all sources."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .order("created_at", desc=True)
                .execute()
            )

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"list_all failed: {e}")
            raise

    async def search(self, query: str) -> list[Source]:
        """Search sources by title or description."""
        try:
            # Use ilike for case-insensitive search
            response = (
                self.client.table(self.table_name)
                .select("*")
                .or_(f"title.ilike.%{query}%,description.ilike.%{query}%")
                .order("created_at", desc=True)
                .execute()
            )

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"search failed: {e}", query=query)
            raise

    async def create(self, source: SourceCreate) -> Source:
        """Create a new source."""
        try:
            now = datetime.now(timezone.utc).isoformat()

            data = {
                "source_id": source.source_id,
                "url": source.url,
                "title": source.title,
                "description": source.description,
                "metadata": source.metadata,
                "pages_count": 0,
                "chunks_count": 0,
                "status": "pending",
                "created_at": now,
                "updated_at": now,
            }

            response = self.client.table(self.table_name).insert(data).execute()

            if not response.data:
                raise RuntimeError("Insert returned no data")

            self._logger.info(f"Created source: {source.source_id}")

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"create failed: {e}", source_id=source.source_id)
            raise

    async def update(self, source_id: str, updates: dict[str, Any]) -> Source | None:
        """Update an existing source."""
        try:
            # Add updated_at timestamp
            updates["updated_at"] = datetime.now(timezone.utc).isoformat()

            response = (
                self.client.table(self.table_name)
                .update(updates)
                .eq("source_id", source_id)
                .execute()
            )

            if not response.data:
                return None

            self._logger.info(f"Updated source: {source_id}", updates=list(updates.keys()))

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"update failed: {e}", source_id=source_id)
            raise

    async def update_counts(
        self, source_id: str, pages_count: int | None = None, chunks_count: int | None = None
    ) -> None:
        """Update page and chunk counts for a source."""
        try:
            updates: dict[str, Any] = {
                "updated_at": datetime.now(timezone.utc).isoformat()
            }

            if pages_count is not None:
                updates["pages_count"] = pages_count
            if chunks_count is not None:
                updates["chunks_count"] = chunks_count

            self.client.table(self.table_name).update(updates).eq("source_id", source_id).execute()

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
            updates = {
                "status": status,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }

            self.client.table(self.table_name).update(updates).eq("source_id", source_id).execute()

            self._logger.info(f"Updated status for source: {source_id}", status=status)

        except Exception as e:
            self._logger.error(f"update_status failed: {e}", source_id=source_id)
            raise

    async def delete(self, source_id: str) -> bool:
        """Delete a source and all its associated data."""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("source_id", source_id)
                .execute()
            )

            deleted = len(response.data) > 0 if response.data else False

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
            response = (
                self.client.table(self.table_name)
                .select("*", count="exact")
                .execute()
            )

            return response.count if response.count else 0

        except Exception as e:
            self._logger.error(f"count failed: {e}")
            raise
