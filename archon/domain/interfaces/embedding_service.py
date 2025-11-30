"""
Embedding service interface.

This module defines the abstract interface for generating text embeddings
used in vector similarity search.
"""

from abc import ABC, abstractmethod
from typing import List


class IEmbeddingService(ABC):
    """
    Abstract interface for text embedding generation.

    This interface abstracts the embedding provider (OpenAI, Cohere, local models, etc.),
    allowing the application to switch providers without changing dependent code.

    All methods are async to support efficient API calls.
    """

    @abstractmethod
    async def get_embedding(self, text: str) -> List[float]:
        """
        Generate an embedding vector for a single text.

        Args:
            text: The text to embed (typically a query or document chunk)

        Returns:
            Embedding vector (typically 1536 dimensions for OpenAI text-embedding-3-small)

        Raises:
            ValueError: If text is empty or too long for the model
            Exception: If the embedding service API call fails

        Example:
            >>> service = OpenAIEmbeddingService()
            >>> embedding = await service.get_embedding("How to build AI agents?")
            >>> print(f"Embedding dimension: {len(embedding)}")
            Embedding dimension: 1536
        """
        pass

    @abstractmethod
    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple texts in a batch.

        This method should be more efficient than calling get_embedding() multiple times,
        as it can leverage batch API endpoints.

        Args:
            texts: List of texts to embed

        Returns:
            List of embedding vectors, in the same order as input texts

        Raises:
            ValueError: If any text is empty or if batch is too large
            Exception: If the embedding service API call fails

        Example:
            >>> service = OpenAIEmbeddingService()
            >>> texts = ["AI agents", "Vector search", "Pydantic models"]
            >>> embeddings = await service.get_embeddings_batch(texts)
            >>> print(f"Generated {len(embeddings)} embeddings")
            Generated 3 embeddings
        """
        pass
