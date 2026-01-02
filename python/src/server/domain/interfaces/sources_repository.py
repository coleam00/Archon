"""
ISourcesRepository Interface.

Defines the contract for documentation sources storage operations.
Implementations: SupabaseSourcesRepository, PostgresSourcesRepository, InMemorySourcesRepository
"""

from abc import ABC, abstractmethod
from typing import Any

from ..models.source import Source, SourceCreate


class ISourcesRepository(ABC):
    """
    Abstract interface for documentation sources repository.

    This interface defines all operations for managing documentation
    sources in the knowledge base.

    Example:
        >>> repo = get_sources_repository()  # From factory
        >>> sources = await repo.list_all()
        >>> for source in sources:
        ...     print(f"{source.title}: {source.pages_count} pages")
    """

    @abstractmethod
    async def get_by_id(self, source_id: str) -> Source | None:
        """
        Get a source by its ID.

        Args:
            source_id: Unique source identifier

        Returns:
            Source if found, None otherwise
        """
        pass

    @abstractmethod
    async def get_by_url(self, url: str) -> Source | None:
        """
        Get a source by its base URL.

        Args:
            url: Base URL of the source

        Returns:
            Source if found, None otherwise
        """
        pass

    @abstractmethod
    async def list_all(self) -> list[Source]:
        """
        List all sources.

        Returns:
            List of all Source objects, ordered by created_at desc
        """
        pass

    @abstractmethod
    async def search(self, query: str) -> list[Source]:
        """
        Search sources by title or description.

        Args:
            query: Search query

        Returns:
            List of matching Source objects
        """
        pass

    @abstractmethod
    async def create(self, source: SourceCreate) -> Source:
        """
        Create a new source.

        Args:
            source: The source data to create

        Returns:
            The created Source

        Raises:
            ValueError: If source_id already exists
        """
        pass

    @abstractmethod
    async def update(self, source_id: str, updates: dict[str, Any]) -> Source | None:
        """
        Update an existing source.

        Args:
            source_id: The source to update
            updates: Dictionary of fields to update

        Returns:
            Updated Source if found, None otherwise
        """
        pass

    @abstractmethod
    async def update_counts(
        self, source_id: str, pages_count: int | None = None, chunks_count: int | None = None
    ) -> None:
        """
        Update page and chunk counts for a source.

        Args:
            source_id: The source to update
            pages_count: New pages count (optional)
            chunks_count: New chunks count (optional)
        """
        pass

    @abstractmethod
    async def update_status(self, source_id: str, status: str) -> None:
        """
        Update the crawl status of a source.

        Args:
            source_id: The source to update
            status: New status (pending, crawling, completed, failed)
        """
        pass

    @abstractmethod
    async def delete(self, source_id: str) -> bool:
        """
        Delete a source and all its associated data.

        Note: This should cascade delete to crawled_pages and code_examples.

        Args:
            source_id: The source to delete

        Returns:
            True if deleted, False if not found
        """
        pass

    @abstractmethod
    async def count(self) -> int:
        """
        Count total number of sources.

        Returns:
            Number of sources in the repository
        """
        pass
