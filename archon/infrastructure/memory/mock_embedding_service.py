"""
Mock Embedding Service for testing.

Provides fake embeddings without calling external APIs.
"""
from typing import List

from archon.domain import IEmbeddingService


class MockEmbeddingService(IEmbeddingService):
    """
    Mock implementation of IEmbeddingService for testing.

    Returns deterministic fake embeddings based on text hash.
    """

    def __init__(self, embedding_dimension: int = 1536):
        """
        Initialize the mock service.

        Args:
            embedding_dimension: Size of the embedding vector (default: 1536 for OpenAI)
        """
        self._dimension = embedding_dimension

    async def get_embedding(self, text: str) -> List[float]:
        """
        Generate a fake embedding for a text.

        The embedding is deterministic based on the text hash,
        so the same text always produces the same embedding.

        Args:
            text: The text to embed

        Returns:
            A list of floats representing the fake embedding
        """
        # Use hash to generate deterministic values
        text_hash = hash(text)

        # Generate embedding based on hash
        embedding = []
        for i in range(self._dimension):
            # Create a value between -1 and 1
            value = ((text_hash + i) % 2000 - 1000) / 1000.0
            embedding.append(value)

        return embedding

    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate fake embeddings for multiple texts.

        Args:
            texts: List of texts to embed

        Returns:
            List of embedding vectors
        """
        return [await self.get_embedding(text) for text in texts]
