"""
IEmbeddingService Interface.

Defines the contract for embedding generation services.
Implementations: OpenAIEmbeddingService, OllamaEmbeddingService, MockEmbeddingService
"""

from abc import ABC, abstractmethod


class IEmbeddingService(ABC):
    """
    Abstract interface for embedding generation services.

    This interface defines the contract for generating vector embeddings
    from text. Implementations can use different providers (OpenAI, Ollama, etc.).

    Example:
        >>> service = get_embedding_service()  # From factory
        >>> embedding = await service.generate("How do I use agents?")
        >>> print(f"Dimension: {len(embedding)}")
    """

    @abstractmethod
    async def generate(self, text: str) -> list[float]:
        """
        Generate an embedding for a single text.

        Args:
            text: The text to embed

        Returns:
            Vector embedding as a list of floats

        Raises:
            ValueError: If text is empty
            RuntimeError: If embedding generation fails
        """
        pass

    @abstractmethod
    async def generate_batch(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for multiple texts.

        Optimized for batch processing. May use parallelization
        or batched API calls depending on the implementation.

        Args:
            texts: List of texts to embed

        Returns:
            List of embeddings in the same order as input texts

        Raises:
            ValueError: If texts list is empty
            RuntimeError: If embedding generation fails
        """
        pass

    @property
    @abstractmethod
    def dimension(self) -> int:
        """
        Get the embedding dimension.

        Returns:
            Number of dimensions in the embedding vectors
            (e.g., 1536 for OpenAI text-embedding-3-small)
        """
        pass

    @property
    @abstractmethod
    def model_name(self) -> str:
        """
        Get the model name.

        Returns:
            Name of the embedding model being used
        """
        pass
