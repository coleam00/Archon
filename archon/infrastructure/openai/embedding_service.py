"""
OpenAI implementation of the IEmbeddingService interface.

This module provides a wrapper around the OpenAI AsyncOpenAI client
for generating text embeddings.
"""

import logging
from typing import List, Optional
from openai import AsyncOpenAI
from archon.domain.interfaces.embedding_service import IEmbeddingService

logger = logging.getLogger("archon.embedding.openai")


class OpenAIEmbeddingService(IEmbeddingService):
    """
    OpenAI implementation of the embedding service.

    This class uses the OpenAI AsyncOpenAI client to generate embeddings
    using OpenAI's embedding models (e.g., text-embedding-3-small).

    Args:
        client: AsyncOpenAI client instance
        model: The embedding model to use (default: "text-embedding-3-small")
        dimensions: Optional output dimensions for the embedding (for text-embedding-3-* models)
    """

    def __init__(
        self,
        client: AsyncOpenAI,
        model: str = "text-embedding-3-small",
        dimensions: Optional[int] = None,
    ):
        """
        Initialize the embedding service with an OpenAI client.

        Args:
            client: Configured AsyncOpenAI client
            model: The embedding model to use
            dimensions: Optional output dimensions (for text-embedding-3-* models)
        """
        self.client = client
        self.model = model
        self.dimensions = dimensions

    async def get_embedding(self, text: str) -> List[float]:
        """
        Generate an embedding vector for a single text.

        Args:
            text: The text to embed

        Returns:
            Embedding vector (typically 1536 dimensions for text-embedding-3-small)

        Raises:
            ValueError: If text is empty
            Exception: If the embedding service API call fails
        """
        if not text or not text.strip():
            raise ValueError("Cannot generate embedding for empty text")

        logger.debug(f"get_embedding(text_len={len(text)}, model={self.model})")

        try:
            # Create embedding request
            kwargs = {
                "model": self.model,
                "input": text,
            }

            # Add dimensions parameter if specified (for text-embedding-3-* models)
            if self.dimensions is not None:
                kwargs["dimensions"] = self.dimensions

            response = await self.client.embeddings.create(**kwargs)

            embedding = response.data[0].embedding

            logger.info(
                f"get_embedding(text_len={len(text)}) -> embedding_dim={len(embedding)}"
            )
            return embedding

        except Exception as e:
            logger.error(f"get_embedding(text_len={len(text)}) -> ERROR: {e}")
            raise

    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple texts in a batch.

        This method leverages the OpenAI batch API endpoint for efficiency.

        Args:
            texts: List of texts to embed

        Returns:
            List of embedding vectors, in the same order as input texts

        Raises:
            ValueError: If any text is empty or if batch is too large
            Exception: If the embedding service API call fails
        """
        if not texts:
            raise ValueError("Cannot generate embeddings for empty list")

        if any(not text or not text.strip() for text in texts):
            raise ValueError("Cannot generate embedding for empty text in batch")

        logger.debug(
            f"get_embeddings_batch(texts_count={len(texts)}, model={self.model})"
        )

        try:
            # Create embedding request
            kwargs = {
                "model": self.model,
                "input": texts,
            }

            # Add dimensions parameter if specified (for text-embedding-3-* models)
            if self.dimensions is not None:
                kwargs["dimensions"] = self.dimensions

            response = await self.client.embeddings.create(**kwargs)

            # Extract embeddings in the correct order
            # OpenAI response includes an index for each embedding
            embeddings_with_index = [
                (data.index, data.embedding) for data in response.data
            ]
            embeddings_with_index.sort(key=lambda x: x[0])
            embeddings = [emb for _, emb in embeddings_with_index]

            logger.info(
                f"get_embeddings_batch(texts_count={len(texts)}) -> {len(embeddings)} embeddings"
            )
            return embeddings

        except Exception as e:
            logger.error(
                f"get_embeddings_batch(texts_count={len(texts)}) -> ERROR: {e}"
            )
            raise
