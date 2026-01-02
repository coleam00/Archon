"""
InMemory implementation of ICodeExamplesRepository.

Provides fast in-memory storage for unit testing without database dependencies.
"""

import uuid
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from ...domain.interfaces.code_examples_repository import ICodeExamplesRepository
from ...domain.models.code_example import CodeExample, CodeExampleCreate
from ...domain.models.search_result import SearchResult
from .vector_utils import cosine_similarity

# Similarity threshold for vector search results
SIMILARITY_THRESHOLD = 0.05


class InMemoryCodeExamplesRepository(ICodeExamplesRepository):
    """
    In-memory repository for code examples.

    Stores all data in memory for fast unit testing.
    Thread-safe with locking for concurrent access.

    Example:
        >>> repo = InMemoryCodeExamplesRepository()
        >>> example = await repo.insert(CodeExampleCreate(...))
        >>> results = await repo.search_similar(embedding, match_count=5)
    """

    def __init__(self):
        self._examples: dict[str, CodeExample] = {}
        self._lock = Lock()

    def _get_embedding(self, example: CodeExample) -> list[float] | None:
        """Get the active embedding from an example based on its dimension."""
        if example.embedding_dimension == 768:
            return example.embedding_768
        elif example.embedding_dimension == 1024:
            return example.embedding_1024
        elif example.embedding_dimension == 1536:
            return example.embedding_1536
        elif example.embedding_dimension == 3072:
            return example.embedding_3072
        # Fallback: try to find any available embedding
        return (
            example.embedding_1536 or example.embedding_768 or
            example.embedding_1024 or example.embedding_3072
        )

    async def get_by_id(self, id: str) -> CodeExample | None:
        """Get a code example by its ID."""
        with self._lock:
            return self._examples.get(id)

    async def find_by_source(self, source_id: str) -> list[CodeExample]:
        """Find all code examples for a given source."""
        with self._lock:
            examples = [
                ex for ex in self._examples.values()
                if ex.source_id == source_id
            ]
            # Sort by created_at descending
            return sorted(
                examples,
                key=lambda e: e.created_at or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True
            )

    async def find_by_page_url(self, page_url: str) -> list[CodeExample]:
        """Find all code examples from a specific page."""
        with self._lock:
            examples = [
                ex for ex in self._examples.values()
                if ex.page_url == page_url
            ]
            # Sort by created_at
            return sorted(
                examples,
                key=lambda e: e.created_at or datetime.min.replace(tzinfo=timezone.utc)
            )

    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        language: str | None = None,
    ) -> list[SearchResult[CodeExample]]:
        """
        Search for code examples similar to the given embedding.

        Uses cosine similarity for vector search simulation.
        """
        with self._lock:
            results: list[tuple[CodeExample, float]] = []

            for example in self._examples.values():
                # Apply source filter
                if source_id and example.source_id != source_id:
                    continue

                # Apply language filter
                if language and example.language != language:
                    continue

                # Get example embedding
                example_embedding = self._get_embedding(example)
                if not example_embedding:
                    continue

                # Check dimension match
                if len(example_embedding) != len(embedding):
                    continue

                # Calculate similarity
                try:
                    similarity = cosine_similarity(embedding, example_embedding)
                except ValueError:
                    continue

                if similarity >= SIMILARITY_THRESHOLD:
                    results.append((example, similarity))

            # Sort by similarity (descending) and take top matches
            results.sort(key=lambda x: x[1], reverse=True)
            results = results[:match_count]

            return [
                SearchResult(item=example, similarity=sim)
                for example, sim in results
            ]

    async def insert(self, example: CodeExampleCreate) -> CodeExample:
        """Insert a new code example."""
        with self._lock:
            example_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)

            # Determine which embedding column to use
            embedding_768 = None
            embedding_1024 = None
            embedding_1536 = None
            embedding_3072 = None

            if example.embedding and example.embedding_dimension:
                if example.embedding_dimension == 768:
                    embedding_768 = example.embedding
                elif example.embedding_dimension == 1024:
                    embedding_1024 = example.embedding
                elif example.embedding_dimension == 1536:
                    embedding_1536 = example.embedding
                elif example.embedding_dimension == 3072:
                    embedding_3072 = example.embedding

            created_example = CodeExample(
                id=example_id,
                source_id=example.source_id,
                page_url=example.page_url,
                code=example.code,
                language=example.language,
                summary=example.summary,
                context=example.context,
                metadata=example.metadata,
                embedding_768=embedding_768,
                embedding_1024=embedding_1024,
                embedding_1536=embedding_1536,
                embedding_3072=embedding_3072,
                embedding_model=example.embedding_model,
                embedding_dimension=example.embedding_dimension,
                created_at=now,
            )

            self._examples[example_id] = created_example
            return created_example

    async def insert_batch(self, examples: list[CodeExampleCreate]) -> list[CodeExample]:
        """Insert multiple code examples in a batch."""
        results = []
        for example in examples:
            created = await self.insert(example)
            results.append(created)
        return results

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all code examples from a specific source."""
        with self._lock:
            to_delete = [
                example_id for example_id, example in self._examples.items()
                if example.source_id == source_id
            ]
            for example_id in to_delete:
                del self._examples[example_id]
            return len(to_delete)

    async def delete_by_page_url(self, page_url: str) -> int:
        """Delete all code examples from a specific page."""
        with self._lock:
            to_delete = [
                example_id for example_id, example in self._examples.items()
                if example.page_url == page_url
            ]
            for example_id in to_delete:
                del self._examples[example_id]
            return len(to_delete)

    async def count(self, source_id: str | None = None) -> int:
        """Count code examples in the repository."""
        with self._lock:
            if source_id:
                return sum(
                    1 for example in self._examples.values()
                    if example.source_id == source_id
                )
            return len(self._examples)

    async def list_languages(self, source_id: str | None = None) -> list[str]:
        """List all unique programming languages."""
        with self._lock:
            languages = set()
            for example in self._examples.values():
                if source_id and example.source_id != source_id:
                    continue
                if example.language:
                    languages.add(example.language)
            return sorted(languages)

    # Test helper methods

    def clear(self) -> None:
        """Clear all stored examples (for test cleanup)."""
        with self._lock:
            self._examples.clear()

    def get_all(self) -> list[CodeExample]:
        """Get all stored examples (for test assertions)."""
        with self._lock:
            return list(self._examples.values())

    def set_example(self, example: CodeExample) -> None:
        """Directly set an example (for test setup)."""
        with self._lock:
            if example.id:
                self._examples[example.id] = example
