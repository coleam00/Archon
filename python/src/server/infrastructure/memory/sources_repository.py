"""
InMemory implementation of ISourcesRepository.

Provides fast in-memory storage for unit testing without database dependencies.
"""

from datetime import datetime, timezone
from threading import Lock
from typing import Any

from ...domain.interfaces.sources_repository import ISourcesRepository
from ...domain.models.source import Source, SourceCreate


class InMemorySourcesRepository(ISourcesRepository):
    """
    In-memory repository for documentation sources.

    Stores all data in memory for fast unit testing.
    Thread-safe with locking for concurrent access.

    Example:
        >>> repo = InMemorySourcesRepository()
        >>> source = await repo.create(SourceCreate(...))
        >>> sources = await repo.list_all()
    """

    def __init__(self):
        self._sources: dict[str, Source] = {}
        self._lock = Lock()

    async def get_by_id(self, source_id: str) -> Source | None:
        """Get a source by its ID."""
        with self._lock:
            return self._sources.get(source_id)

    async def get_by_url(self, url: str) -> Source | None:
        """Get a source by its base URL."""
        with self._lock:
            for source in self._sources.values():
                if source.url == url:
                    return source
            return None

    async def list_all(self) -> list[Source]:
        """List all sources."""
        with self._lock:
            sources = list(self._sources.values())
            # Sort by created_at descending
            return sorted(
                sources,
                key=lambda s: s.created_at or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True
            )

    async def search(self, query: str) -> list[Source]:
        """Search sources by title or description."""
        with self._lock:
            query_lower = query.lower()
            matching = []

            for source in self._sources.values():
                title_match = source.title and query_lower in source.title.lower()
                desc_match = source.description and query_lower in source.description.lower()

                if title_match or desc_match:
                    matching.append(source)

            # Sort by created_at descending
            return sorted(
                matching,
                key=lambda s: s.created_at or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True
            )

    async def create(self, source: SourceCreate) -> Source:
        """Create a new source."""
        with self._lock:
            if source.source_id in self._sources:
                raise ValueError(f"Source already exists: {source.source_id}")

            now = datetime.now(timezone.utc)

            created_source = Source(
                source_id=source.source_id,
                url=source.url,
                title=source.title,
                description=source.description,
                metadata=source.metadata,
                pages_count=0,
                chunks_count=0,
                status="pending",
                created_at=now,
                updated_at=now,
            )

            self._sources[source.source_id] = created_source
            return created_source

    async def update(self, source_id: str, updates: dict[str, Any]) -> Source | None:
        """Update an existing source."""
        with self._lock:
            source = self._sources.get(source_id)
            if not source:
                return None

            # Create updated source
            source_dict = source.model_dump()
            source_dict.update(updates)
            source_dict["updated_at"] = datetime.now(timezone.utc)

            updated_source = Source(**source_dict)
            self._sources[source_id] = updated_source

            return updated_source

    async def update_counts(
        self, source_id: str, pages_count: int | None = None, chunks_count: int | None = None
    ) -> None:
        """Update page and chunk counts for a source."""
        with self._lock:
            source = self._sources.get(source_id)
            if not source:
                return

            source_dict = source.model_dump()
            source_dict["updated_at"] = datetime.now(timezone.utc)

            if pages_count is not None:
                source_dict["pages_count"] = pages_count
            if chunks_count is not None:
                source_dict["chunks_count"] = chunks_count

            self._sources[source_id] = Source(**source_dict)

    async def update_status(self, source_id: str, status: str) -> None:
        """Update the crawl status of a source."""
        with self._lock:
            source = self._sources.get(source_id)
            if not source:
                return

            source_dict = source.model_dump()
            source_dict["status"] = status
            source_dict["updated_at"] = datetime.now(timezone.utc)

            self._sources[source_id] = Source(**source_dict)

    async def delete(self, source_id: str) -> bool:
        """Delete a source and all its associated data."""
        with self._lock:
            if source_id in self._sources:
                del self._sources[source_id]
                return True
            return False

    async def count(self) -> int:
        """Count total number of sources."""
        with self._lock:
            return len(self._sources)

    # Test helper methods

    def clear(self) -> None:
        """Clear all stored sources (for test cleanup)."""
        with self._lock:
            self._sources.clear()

    def get_all(self) -> list[Source]:
        """Get all stored sources (for test assertions)."""
        with self._lock:
            return list(self._sources.values())

    def set_source(self, source: Source) -> None:
        """Directly set a source (for test setup)."""
        with self._lock:
            self._sources[source.source_id] = source
