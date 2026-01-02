"""
ICodeExamplesRepository Interface.

Defines the contract for code examples storage operations.
Implementations: SupabaseCodeExamplesRepository, PostgresCodeExamplesRepository, InMemoryCodeExamplesRepository
"""

from abc import ABC, abstractmethod
from typing import Any

from ..models.code_example import CodeExample, CodeExampleCreate
from ..models.search_result import SearchResult


class ICodeExamplesRepository(ABC):
    """
    Abstract interface for code examples repository.

    This interface defines all operations for managing code examples
    extracted from documentation.

    Example:
        >>> repo = get_code_examples_repository()  # From factory
        >>> examples = await repo.search_similar(embedding, match_count=3)
        >>> for result in examples:
        ...     print(f"{result.item.language}: {result.similarity:.2f}")
    """

    @abstractmethod
    async def get_by_id(self, id: str) -> CodeExample | None:
        """
        Get a code example by its ID.

        Args:
            id: UUID of the code example

        Returns:
            CodeExample if found, None otherwise
        """
        pass

    @abstractmethod
    async def find_by_source(self, source_id: str) -> list[CodeExample]:
        """
        Find all code examples for a given source.

        Args:
            source_id: The source identifier

        Returns:
            List of CodeExample objects for this source
        """
        pass

    @abstractmethod
    async def find_by_page_url(self, page_url: str) -> list[CodeExample]:
        """
        Find all code examples from a specific page.

        Args:
            page_url: URL of the page

        Returns:
            List of CodeExample objects from this page
        """
        pass

    @abstractmethod
    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        language: str | None = None,
    ) -> list[SearchResult[CodeExample]]:
        """
        Search for code examples similar to the given embedding.

        Uses vector similarity search (cosine distance) to find
        semantically similar code.

        Args:
            embedding: Query embedding vector
            match_count: Maximum number of results
            source_id: Optional source filter
            language: Optional programming language filter

        Returns:
            List of SearchResult with CodeExample and similarity score
        """
        pass

    @abstractmethod
    async def insert(self, example: CodeExampleCreate) -> CodeExample:
        """
        Insert a new code example.

        Args:
            example: The code example data to insert

        Returns:
            The inserted CodeExample with generated ID
        """
        pass

    @abstractmethod
    async def insert_batch(self, examples: list[CodeExampleCreate]) -> list[CodeExample]:
        """
        Insert multiple code examples in a batch.

        Args:
            examples: List of code examples to insert

        Returns:
            List of inserted CodeExample objects with generated IDs
        """
        pass

    @abstractmethod
    async def delete_by_source(self, source_id: str) -> int:
        """
        Delete all code examples from a specific source.

        Args:
            source_id: The source identifier

        Returns:
            Number of examples deleted
        """
        pass

    @abstractmethod
    async def delete_by_page_url(self, page_url: str) -> int:
        """
        Delete all code examples from a specific page.

        Args:
            page_url: URL of the page

        Returns:
            Number of examples deleted
        """
        pass

    @abstractmethod
    async def count(self, source_id: str | None = None) -> int:
        """
        Count code examples in the repository.

        Args:
            source_id: Optional source filter

        Returns:
            Number of examples matching the filter
        """
        pass

    @abstractmethod
    async def list_languages(self, source_id: str | None = None) -> list[str]:
        """
        List all unique programming languages.

        Args:
            source_id: Optional source filter

        Returns:
            Sorted list of unique language identifiers
        """
        pass
