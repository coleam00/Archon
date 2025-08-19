"""
Base Vector Store Abstract Class

Provides the abstract interface for all vector database implementations.
Supports both Supabase pgvector and Qdrant with a unified API.
"""

import os
import uuid
from abc import ABC, abstractmethod
from typing import Any

from ...config.logfire_config import get_logger

logger = get_logger(__name__)
security_logger = get_logger("security.vector_store")


def _should_log_detailed_errors() -> bool:
    """Determine if detailed error logging should be enabled based on environment."""
    return os.getenv("LOG_LEVEL", "INFO").upper() == "DEBUG" or os.getenv("ARCHON_DEV_MODE", "false").lower() == "true"


class VectorDocument:
    """Data structure for vector documents across all providers."""

    def __init__(
        self,
        id: str | None = None,
        url: str = "",
        chunk_number: int = 0,
        content: str = "",
        embedding: list[float] | None = None,
        metadata: dict[str, Any] | None = None,
        source_id: str = "",
    ):
        self.id = id
        self.url = url
        self.chunk_number = chunk_number
        self.content = content
        self.embedding = embedding or []
        self.metadata = metadata or {}
        self.source_id = source_id

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "url": self.url,
            "chunk_number": self.chunk_number,
            "content": self.content,
            "embedding": self.embedding,
            "metadata": self.metadata,
            "source_id": self.source_id,
        }
        if self.id:
            result["id"] = self.id
        return result


class VectorSearchResult:
    """Search result structure for vector queries."""

    def __init__(
        self,
        id: str,
        url: str,
        chunk_number: int,
        content: str,
        metadata: dict[str, Any],
        source_id: str,
        similarity: float,
        summary: str | None = None,
    ):
        self.id = id
        self.url = url
        self.chunk_number = chunk_number
        self.content = content
        self.metadata = metadata
        self.source_id = source_id
        self.similarity = similarity
        self.summary = summary

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for API responses."""
        result = {
            "id": self.id,
            "url": self.url,
            "chunk_number": self.chunk_number,
            "content": self.content,
            "metadata": self.metadata,
            "source_id": self.source_id,
            "similarity": self.similarity,
        }
        if self.summary:
            result["summary"] = self.summary
        return result


class BaseVectorStore(ABC):
    """
    Abstract base class for all vector database implementations.

    This class defines the interface that all vector stores must implement,
    providing a unified API for vector operations across different backends.
    """

    def __init__(self):
        """Initialize the vector store."""
        self.connected = False
        self.collections = set()

    def _generate_operation_id(self) -> str:
        """Generate operation ID for forensic traceability."""
        return str(uuid.uuid4())[:8]

    def _log_security_event(self, event_type: str, operation_id: str, details: dict[str, Any] | None = None) -> None:
        """Log security events with operation correlation."""
        security_logger.info(f"{event_type} - operation: {operation_id}", extra=details or {})

    def _log_validation_error(self, operation_id: str, error_details: str | None = None) -> None:
        """Log data validation errors with operation correlation and environment-appropriate detail level."""
        if _should_log_detailed_errors() and error_details:
            logger.error(
                f"Data validation failed - operation: {operation_id} - details: {error_details}", exc_info=True
            )
        else:
            logger.error(f"Data validation failed - operation: {operation_id}", exc_info=True)
        security_logger.warning(f"Data validation failure detected - operation: {operation_id}")

    @abstractmethod
    async def connect(self, **kwargs) -> bool:
        """
        Connect to the vector database.

        Args:
            **kwargs: Provider-specific connection parameters

        Returns:
            bool: True if connection successful, False otherwise
        """
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Disconnect from the vector database."""
        pass

    @abstractmethod
    async def create_collection(
        self, collection_name: str, vector_size: int = 1536, distance_metric: str = "cosine", **kwargs
    ) -> bool:
        """
        Create or ensure a collection exists.

        Args:
            collection_name: Name of the collection
            vector_size: Dimension of vectors (default: 1536 for OpenAI)
            distance_metric: Distance metric ("cosine", "euclidean", "dot")
            **kwargs: Provider-specific parameters

        Returns:
            bool: True if collection exists/created, False otherwise
        """
        pass

    @abstractmethod
    async def upsert_vectors(
        self,
        collection_name: str,
        documents: list[VectorDocument],
        batch_size: int = 100,
    ) -> dict[str, Any]:
        """
        Insert or update vectors in the collection.

        Args:
            collection_name: Target collection name
            documents: List of VectorDocument objects to upsert
            batch_size: Batch size for bulk operations

        Returns:
            Dict with operation results including success/failure counts
        """
        pass

    @abstractmethod
    async def search(
        self,
        collection_name: str,
        query_embedding: list[float],
        match_count: int = 5,
        filter_metadata: dict[str, Any] | None = None,
        similarity_threshold: float = 0.15,
    ) -> list[VectorSearchResult]:
        """
        Perform vector similarity search.

        Args:
            collection_name: Collection to search in
            query_embedding: Query vector
            match_count: Maximum results to return
            filter_metadata: Metadata filters to apply
            similarity_threshold: Minimum similarity score

        Returns:
            List of VectorSearchResult objects
        """
        pass

    @abstractmethod
    async def delete(
        self,
        collection_name: str,
        filter_criteria: dict[str, Any],
        batch_size: int = 100,
    ) -> dict[str, Any]:
        """
        Delete vectors based on filter criteria.

        Args:
            collection_name: Collection to delete from
            filter_criteria: Criteria for deletion (e.g., {"url": ["url1", "url2"]})
            batch_size: Batch size for bulk deletions

        Returns:
            Dict with deletion results
        """
        pass

    @abstractmethod
    async def update_metadata(
        self,
        collection_name: str,
        document_id: str,
        metadata: dict[str, Any],
    ) -> bool:
        """
        Update metadata for a specific document.

        Args:
            collection_name: Collection containing the document
            document_id: Unique identifier for the document
            metadata: New metadata to set

        Returns:
            bool: True if update successful, False otherwise
        """
        pass

    @abstractmethod
    async def get_collection_info(self, collection_name: str) -> dict[str, Any]:
        """
        Get information about a collection.

        Args:
            collection_name: Name of the collection

        Returns:
            Dict containing collection metadata and stats
        """
        pass

    @abstractmethod
    async def list_collections(self) -> list[str]:
        """
        List all available collections.

        Returns:
            List of collection names
        """
        pass

    # Common utility methods that subclasses can use
    def validate_embedding(self, embedding: list[float], expected_size: int = 1536) -> bool:
        """
        Validate embedding dimensions and values.

        Args:
            embedding: Vector to validate
            expected_size: Expected dimension count

        Returns:
            bool: True if valid, False otherwise
        """
        if not embedding or not isinstance(embedding, list):
            logger.error("Embedding must be a non-empty list")
            return False

        if len(embedding) != expected_size:
            logger.error(f"Embedding dimension mismatch: got {len(embedding)}, expected {expected_size}")
            return False

        if not all(isinstance(x, int | float) for x in embedding):
            logger.error("Embedding must contain only numeric values")
            return False

        # Check for zero vectors (often indicates errors)
        if all(x == 0 for x in embedding):
            logger.warning("Zero embedding detected - this may indicate an error")
            return False

        return True

    def validate_document(self, document: VectorDocument) -> bool:
        """
        Validate a vector document.

        Args:
            document: Document to validate

        Returns:
            bool: True if valid, False otherwise
        """
        if not isinstance(document, VectorDocument):
            logger.error("Document must be a VectorDocument instance")
            return False

        if not document.url or not document.content:
            logger.error("Document must have url and content")
            return False

        if not self.validate_embedding(document.embedding):
            return False

        return True

    def extract_source_filter(self, filter_metadata: dict[str, Any] | None) -> str | None:
        """
        Extract source filter from metadata in a provider-agnostic way.

        Args:
            filter_metadata: Filter metadata dict

        Returns:
            Source ID if found, None otherwise
        """
        if not filter_metadata:
            return None

        # Support both "source" and "source_id" keys for compatibility
        return filter_metadata.get("source") or filter_metadata.get("source_id")

    async def health_check(self) -> dict[str, Any]:
        """
        Perform a health check on the vector store.

        Returns:
            Dict with health status information
        """
        try:
            collections = await self.list_collections()
            return {
                "connected": self.connected,
                "collections_count": len(collections),
                "collections": collections,
                "status": "healthy",
            }
        except Exception as e:
            logger.error(f"Health check failed: {e}", exc_info=True)
            return {"connected": False, "error": str(e), "status": "unhealthy"}
