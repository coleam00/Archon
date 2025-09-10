"""
Custom exceptions for embedding service failures.

These exceptions follow the principle: "fail fast and loud" for data integrity issues,
while allowing batch processes to continue by skipping failed items.
"""

from typing import Any


class EmbeddingError(Exception):
    """Base exception for all embedding-related errors."""

    def __init__(
        self,
        message: str,
        text_preview: str | None = None,
        batch_index: int | None = None,
        **kwargs,
    ):
        """
        Initialize embedding error with context.

        Args:
            message: Error description
            text_preview: Preview of text that failed (max 200 chars)
            batch_index: Index in batch if applicable
            **kwargs: Additional metadata (e.g., error_type, retry_count)
        """
        self.text_preview = text_preview[:200] if text_preview else None
        self.batch_index = batch_index
        self.metadata = kwargs
        super().__init__(message)

    def to_dict(self) -> dict[str, Any]:
        """Convert exception to dictionary for JSON serialization."""
        return {
            "error_type": self.__class__.__name__,
            "message": str(self),
            "text_preview": self.text_preview,
            "batch_index": self.batch_index,
            "metadata": self.metadata,
        }


class EmbeddingQuotaExhaustedError(EmbeddingError):
    """
    Raised when API quota is exhausted.

    This is a CRITICAL error that should stop the entire process
    as continuing would be pointless without ability to create embeddings.
    """

    def __init__(self, message: str, tokens_used: int | None = None, **kwargs):
        super().__init__(message, **kwargs)
        self.tokens_used = tokens_used
        if tokens_used:
            self.metadata["tokens_used"] = tokens_used


class EmbeddingRateLimitError(EmbeddingError):
    """
    Raised when rate limit is hit after max retries.

    This error should skip the current batch but allow the process to continue
    with other batches after appropriate delay.
    """

    def __init__(self, message: str, retry_count: int = 0, **kwargs):
        super().__init__(message, **kwargs)
        self.retry_count = retry_count
        self.metadata["retry_count"] = retry_count


class EmbeddingAsyncContextError(EmbeddingError):
    """
    Raised when sync embedding function is called from async context.

    This indicates a code design issue that needs to be fixed by using
    the async version of the function.
    """

    pass


class EmbeddingAPIError(EmbeddingError):
    """
    Raised for general API failures (network, invalid response, etc).

    These errors should skip the affected item but allow the process
    to continue with other items.
    """

    def __init__(self, message: str, original_error: Exception | None = None, **kwargs):
        super().__init__(message, **kwargs)
        self.original_error = original_error
        if original_error:
            self.metadata["original_error_type"] = type(original_error).__name__
            self.metadata["original_error_message"] = str(original_error)


class EmbeddingValidationError(EmbeddingError):
    """
    Raised when embedding validation fails (e.g., zero vector detected).

    This should never happen in normal operation but indicates
    a serious issue if it does.
    """

    def __init__(self, message: str, embedding_sample: list | None = None, **kwargs):
        super().__init__(message, **kwargs)
        if embedding_sample:
            # Store first 10 values as sample
            self.metadata["embedding_sample"] = embedding_sample[:10]
