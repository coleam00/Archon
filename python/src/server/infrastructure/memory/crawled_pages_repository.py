"""
InMemory implementation of ICrawledPagesRepository.

Provides fast in-memory storage for unit testing without database dependencies.
"""

import uuid
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from ...domain.interfaces.crawled_pages_repository import ICrawledPagesRepository
from ...domain.models.crawled_page import CrawledPage, CrawledPageCreate, CrawledPageMetadata
from ...domain.models.search_result import SearchResult
from .vector_utils import cosine_similarity

# Similarity threshold for vector search results
SIMILARITY_THRESHOLD = 0.05


class InMemoryCrawledPagesRepository(ICrawledPagesRepository):
    """
    In-memory repository for crawled pages.

    Stores all data in memory for fast unit testing.
    Thread-safe with locking for concurrent access.

    Example:
        >>> repo = InMemoryCrawledPagesRepository()
        >>> page = await repo.insert(CrawledPageCreate(...))
        >>> results = await repo.search_similar(embedding, match_count=5)
    """

    def __init__(self):
        self._pages: dict[str, CrawledPage] = {}
        self._lock = Lock()

    def _get_embedding(self, page: CrawledPage) -> list[float] | None:
        """Get the active embedding from a page based on its dimension."""
        if page.embedding_dimension == 768:
            return page.embedding_768
        elif page.embedding_dimension == 1024:
            return page.embedding_1024
        elif page.embedding_dimension == 1536:
            return page.embedding_1536
        elif page.embedding_dimension == 3072:
            return page.embedding_3072
        # Fallback: try to find any available embedding
        return (
            page.embedding_1536 or page.embedding_768 or
            page.embedding_1024 or page.embedding_3072
        )

    async def get_by_id(self, id: str) -> CrawledPage | None:
        """Get a crawled page by its ID."""
        with self._lock:
            return self._pages.get(id)

    async def find_by_url(self, url: str) -> list[CrawledPage]:
        """Find all chunks for a given URL."""
        with self._lock:
            pages = [
                page for page in self._pages.values()
                if page.url == url
            ]
            return sorted(pages, key=lambda p: p.chunk_number)

    async def find_by_source(self, source_id: str) -> list[CrawledPage]:
        """Find all pages for a given source."""
        with self._lock:
            pages = [
                page for page in self._pages.values()
                if page.source_id == source_id
            ]
            return sorted(pages, key=lambda p: (p.url, p.chunk_number))

    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        filter_metadata: dict[str, Any] | None = None,
    ) -> list[SearchResult[CrawledPage]]:
        """
        Search for pages similar to the given embedding.

        Uses cosine similarity for vector search simulation.
        """
        with self._lock:
            results: list[tuple[CrawledPage, float]] = []

            for page in self._pages.values():
                # Apply source filter
                if source_id and page.source_id != source_id:
                    continue

                # Apply metadata filter
                if filter_metadata and "source" in filter_metadata:
                    page_source = page.metadata.source if page.metadata else None
                    if page_source != filter_metadata["source"]:
                        continue

                # Get page embedding
                page_embedding = self._get_embedding(page)
                if not page_embedding:
                    continue

                # Check dimension match
                if len(page_embedding) != len(embedding):
                    continue

                # Calculate similarity
                try:
                    similarity = cosine_similarity(embedding, page_embedding)
                except ValueError:
                    continue

                if similarity >= SIMILARITY_THRESHOLD:
                    results.append((page, similarity))

            # Sort by similarity (descending) and take top matches
            results.sort(key=lambda x: x[1], reverse=True)
            results = results[:match_count]

            return [
                SearchResult(item=page, similarity=sim)
                for page, sim in results
            ]

    async def insert(self, page: CrawledPageCreate) -> CrawledPage:
        """Insert a new crawled page chunk."""
        with self._lock:
            page_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)

            # Determine which embedding column to use
            embedding_768 = None
            embedding_1024 = None
            embedding_1536 = None
            embedding_3072 = None

            if page.embedding and page.embedding_dimension:
                if page.embedding_dimension == 768:
                    embedding_768 = page.embedding
                elif page.embedding_dimension == 1024:
                    embedding_1024 = page.embedding
                elif page.embedding_dimension == 1536:
                    embedding_1536 = page.embedding
                elif page.embedding_dimension == 3072:
                    embedding_3072 = page.embedding

            # Parse metadata
            metadata = page.metadata
            if isinstance(metadata, dict):
                metadata = CrawledPageMetadata(**metadata)
            elif metadata is None:
                metadata = CrawledPageMetadata()

            created_page = CrawledPage(
                id=page_id,
                url=page.url,
                chunk_number=page.chunk_number,
                content=page.content,
                metadata=metadata,
                source_id=page.source_id,
                page_id=page.page_id,
                embedding_768=embedding_768,
                embedding_1024=embedding_1024,
                embedding_1536=embedding_1536,
                embedding_3072=embedding_3072,
                llm_chat_model=page.llm_chat_model,
                embedding_model=page.embedding_model,
                embedding_dimension=page.embedding_dimension,
                created_at=now,
            )

            self._pages[page_id] = created_page
            return created_page

    async def insert_batch(self, pages: list[CrawledPageCreate]) -> list[CrawledPage]:
        """Insert multiple page chunks in a batch."""
        results = []
        for page in pages:
            created = await self.insert(page)
            results.append(created)
        return results

    async def delete_by_url(self, url: str) -> int:
        """Delete all chunks for a given URL."""
        with self._lock:
            to_delete = [
                page_id for page_id, page in self._pages.items()
                if page.url == url
            ]
            for page_id in to_delete:
                del self._pages[page_id]
            return len(to_delete)

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all pages from a specific source."""
        with self._lock:
            to_delete = [
                page_id for page_id, page in self._pages.items()
                if page.source_id == source_id
            ]
            for page_id in to_delete:
                del self._pages[page_id]
            return len(to_delete)

    async def count(self, source_id: str | None = None) -> int:
        """Count pages in the repository."""
        with self._lock:
            if source_id:
                return sum(
                    1 for page in self._pages.values()
                    if page.source_id == source_id
                )
            return len(self._pages)

    async def list_unique_urls(self, source_id: str | None = None) -> list[str]:
        """List all unique URLs in the repository."""
        with self._lock:
            urls = set()
            for page in self._pages.values():
                if source_id and page.source_id != source_id:
                    continue
                urls.add(page.url)
            return sorted(urls)

    # Test helper methods

    def clear(self) -> None:
        """Clear all stored pages (for test cleanup)."""
        with self._lock:
            self._pages.clear()

    def get_all(self) -> list[CrawledPage]:
        """Get all stored pages (for test assertions)."""
        with self._lock:
            return list(self._pages.values())
