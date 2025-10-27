"""
Embedding Service

Handles all OpenAI embedding operations with proper rate limiting and error handling.
"""

import asyncio
import inspect
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx
import numpy as np
import openai

from ...config.logfire_config import safe_span, search_logger
from ..credential_service import credential_service
from ..llm_provider_service import get_embedding_model, get_llm_client
from ..threading_service import get_threading_service
from .embedding_exceptions import (
    EmbeddingAPIError,
    EmbeddingError,
    EmbeddingQuotaExhaustedError,
    EmbeddingRateLimitError,
)


@dataclass
class EmbeddingBatchResult:
    """Result of batch embedding creation with success/failure tracking."""

    embeddings: list[list[float]] = field(default_factory=list)
    failed_items: list[dict[str, Any]] = field(default_factory=list)
    success_count: int = 0
    failure_count: int = 0
    texts_processed: list[str] = field(default_factory=list)  # Successfully processed texts

    def add_success(self, embedding: list[float], text: str):
        """Add a successful embedding."""
        self.embeddings.append(embedding)
        self.texts_processed.append(text)
        self.success_count += 1

    def add_failure(self, text: str, error: Exception, batch_index: int | None = None):
        """Add a failed item with error details."""
        error_dict = {
            "text": text[:200] if text else None,
            "error": str(error),
            "error_type": type(error).__name__,
            "batch_index": batch_index,
        }

        # Add extra context from EmbeddingError if available
        if isinstance(error, EmbeddingError):
            error_dict.update(error.to_dict())

        self.failed_items.append(error_dict)
        self.failure_count += 1

    @property
    def has_failures(self) -> bool:
        return self.failure_count > 0

    @property
    def total_requested(self) -> int:
        return self.success_count + self.failure_count


class EmbeddingProviderAdapter(ABC):
    """Adapter interface for embedding providers."""

    @abstractmethod
    async def create_embeddings(
        self,
        texts: list[str],
        model: str,
        dimensions: int | None = None,
    ) -> list[list[float]]:
        """Create embeddings for the given texts."""


class OpenAICompatibleEmbeddingAdapter(EmbeddingProviderAdapter):
    """Adapter for providers using the OpenAI embeddings API shape."""
    
    def __init__(self, client: Any):
        self._client = client
    
    async def create_embeddings(
        self,
        texts: list[str],
        model: str,
        dimensions: int | None = None,
    ) -> list[list[float]]:
        request_args: dict[str, Any] = {
            "model": model,
            "input": texts,
        }
        if dimensions is not None:
            request_args["dimensions"] = dimensions
            
        response = await self._client.embeddings.create(**request_args)
        return [item.embedding for item in response.data]


class GoogleEmbeddingAdapter(EmbeddingProviderAdapter):
    """Adapter for Google's native embedding endpoint."""

    async def create_embeddings(
        self,
        texts: list[str],
        model: str,
        dimensions: int | None = None,
    ) -> list[list[float]]:
        try:
            google_api_key = await credential_service.get_credential("GOOGLE_API_KEY")
            if not google_api_key:
                raise EmbeddingAPIError("Google API key not found")

            async with httpx.AsyncClient(timeout=30.0) as http_client:
                embeddings = await asyncio.gather(
                    *(
                        self._fetch_single_embedding(http_client, google_api_key, model, text, dimensions)
                        for text in texts
                    )
                )

            return embeddings

        except httpx.HTTPStatusError as error:
            error_content = error.response.text
            search_logger.error(
                f"Google embedding API returned {error.response.status_code} - {error_content}",
                exc_info=True,
            )
            raise EmbeddingAPIError(
                f"Google embedding API error: {error.response.status_code} - {error_content}",
                original_error=error,
            ) from error
        except Exception as error:
            search_logger.error(f"Error calling Google embedding API: {error}", exc_info=True)
            raise EmbeddingAPIError(
                f"Google embedding error: {str(error)}", original_error=error
            ) from error

    async def _fetch_single_embedding(
        self,
        http_client: httpx.AsyncClient,
        api_key: str,
        model: str,
        text: str,
        dimensions: int | None = None,
    ) -> list[float]:
        if model.startswith("models/"):
            url_model = model[len("models/") :]
            payload_model = model
        else:
            url_model = model
            payload_model = f"models/{model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{url_model}:embedContent"
        headers = {
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "model": payload_model,
            "content": {"parts": [{"text": text}]},
        }

        # Add output_dimensionality parameter if dimensions are specified and supported
        if dimensions is not None and dimensions > 0:
            model_name = payload_model.removeprefix("models/")
            if model_name.startswith("textembedding-gecko"):
                supported_dimensions = {128, 256, 512, 768}
            else:
                supported_dimensions = {128, 256, 512, 768, 1024, 1536, 2048, 3072}

            if dimensions in supported_dimensions:
                payload["outputDimensionality"] = dimensions
            else:
                search_logger.warning(
                    f"Requested dimension {dimensions} is not supported by Google model '{model_name}'. "
                    "Falling back to the provider default."
                )

        response = await http_client.post(url, headers=headers, json=payload)
        response.raise_for_status()

        result = response.json()
        embedding = result.get("embedding", {})
        values = embedding.get("values") if isinstance(embedding, dict) else None
        if not isinstance(values, list):
            raise EmbeddingAPIError(f"Invalid embedding payload from Google: {result}")

        # Normalize embeddings for dimensions < 3072 as per Google's documentation
        actual_dimension = len(values)
        if actual_dimension > 0 and actual_dimension < 3072:
            values = self._normalize_embedding(values)

        return values

    def _normalize_embedding(self, embedding: list[float]) -> list[float]:
        """Normalize embedding vector for dimensions < 3072."""
        try:
            embedding_array = np.array(embedding, dtype=np.float32)
            norm = np.linalg.norm(embedding_array)
            if norm > 0:
                normalized = embedding_array / norm
                return normalized.tolist()
            else:
                search_logger.warning("Zero-norm embedding detected, returning unnormalized")
                return embedding
        except Exception as e:
            search_logger.error(f"Failed to normalize embedding: {e}")
            # Return original embedding if normalization fails
            return embedding


def _get_embedding_adapter(provider: str, client: Any) -> EmbeddingProviderAdapter:
    provider_name = (provider or "").lower()
    if provider_name == "google":
        return GoogleEmbeddingAdapter()
    return OpenAICompatibleEmbeddingAdapter(client)


async def _maybe_await(value: Any) -> Any:
    """Await the value if it is awaitable, otherwise return as-is."""

    return await value if inspect.isawaitable(value) else value

# Provider-aware client factory
get_openai_client = get_llm_client


async def create_embedding(text: str, provider: str | None = None) -> list[float]:
    """
    Create an embedding for a single text using the configured provider.

    Args:
        text: Text to create an embedding for
        provider: Optional provider override

    Returns:
        List of floats representing the embedding

    Raises:
        EmbeddingQuotaExhaustedError: When OpenAI quota is exhausted
        EmbeddingRateLimitError: When rate limited
        EmbeddingAPIError: For other API errors
    """
    try:
        result = await create_embeddings_batch([text], provider=provider)
        if not result.embeddings:
            # Check if there were failures
            if result.has_failures and result.failed_items:
                # Re-raise the original error for single embeddings
                error_info = result.failed_items[0]
                error_msg = error_info.get("error", "Unknown error")
                if "quota" in error_msg.lower():
                    raise EmbeddingQuotaExhaustedError(
                        f"OpenAI quota exhausted: {error_msg}", text_preview=text
                    )
                elif "rate" in error_msg.lower():
                    raise EmbeddingRateLimitError(f"Rate limit hit: {error_msg}", text_preview=text)
                else:
                    raise EmbeddingAPIError(
                        f"Failed to create embedding: {error_msg}", text_preview=text
                    )
            else:
                raise EmbeddingAPIError(
                    "No embeddings returned from batch creation", text_preview=text
                )
        return result.embeddings[0]
    except EmbeddingError:
        # Re-raise our custom exceptions
        raise
    except Exception as e:
        # Convert to appropriate exception type
        error_msg = str(e)
        search_logger.error(f"Embedding creation failed: {error_msg}", exc_info=True)
        search_logger.error(f"Failed text preview: {text[:100]}...")

        if "insufficient_quota" in error_msg:
            raise EmbeddingQuotaExhaustedError(
                f"OpenAI quota exhausted: {error_msg}", text_preview=text
            )
        elif "rate_limit" in error_msg.lower():
            raise EmbeddingRateLimitError(f"Rate limit hit: {error_msg}", text_preview=text)
        else:
            raise EmbeddingAPIError(
                f"Embedding error: {error_msg}", text_preview=text, original_error=e
            )


async def create_embeddings_batch(
    texts: list[str],
    progress_callback: Any | None = None,
    provider: str | None = None,
) -> EmbeddingBatchResult:
    """
    Create embeddings for multiple texts with graceful failure handling.

    This function processes texts in batches and returns a structured result
    containing both successful embeddings and failed items. It follows the
    "skip, don't corrupt" principle - failed items are tracked but not stored
    with zero embeddings.

    Args:
        texts: List of texts to create embeddings for
        progress_callback: Optional callback for progress reporting
        provider: Optional provider override

    Returns:
        EmbeddingBatchResult with successful embeddings and failure details
    """
    if not texts:
        return EmbeddingBatchResult()

    result = EmbeddingBatchResult()

    # Validate that all items in texts are strings
    validated_texts = []
    for i, text in enumerate(texts):
        if isinstance(text, str):
            validated_texts.append(text)
            continue

        search_logger.error(
            f"Invalid text type at index {i}: {type(text)}, value: {text}", exc_info=True
        )
        try:
            converted = str(text)
            validated_texts.append(converted)
        except Exception as conversion_error:
            search_logger.error(
                f"Failed to convert text at index {i} to string: {conversion_error}",
                exc_info=True,
            )
            result.add_failure(
                repr(text),
                EmbeddingAPIError("Invalid text type", original_error=conversion_error),
                batch_index=None,
            )

    texts = validated_texts
    threading_service = get_threading_service()

    with safe_span(
        "create_embeddings_batch", text_count=len(texts), total_chars=sum(len(t) for t in texts)
    ) as span:
        try:
            embedding_config = await _maybe_await(
                credential_service.get_active_provider(service_type="embedding")
            )

            embedding_provider = provider or embedding_config.get("provider")

            if not isinstance(embedding_provider, str) or not embedding_provider.strip():
                embedding_provider = "openai"

            if not embedding_provider:
                search_logger.error("No embedding provider configured")
                raise ValueError("No embedding provider configured. Please set EMBEDDING_PROVIDER environment variable.")

            search_logger.info(f"Using embedding provider: '{embedding_provider}' (from EMBEDDING_PROVIDER setting)")
            async with get_llm_client(provider=embedding_provider, use_embedding_provider=True) as client:
                # Load batch size and dimensions from settings
                try:
                    rag_settings = await _maybe_await(
                        credential_service.get_credentials_by_category("rag_strategy")
                    )
                    batch_size = int(rag_settings.get("EMBEDDING_BATCH_SIZE", "100"))
                    embedding_dimensions = int(rag_settings.get("EMBEDDING_DIMENSIONS", "1536"))
                except Exception as e:
                    search_logger.warning(f"Failed to load embedding settings: {e}, using defaults")
                    batch_size = 100
                    embedding_dimensions = 1536

                total_tokens_used = 0
                adapter = _get_embedding_adapter(embedding_provider, client)
                dimensions_to_use = embedding_dimensions if embedding_dimensions > 0 else None

                for i in range(0, len(texts), batch_size):
                    batch = texts[i : i + batch_size]
                    batch_index = i // batch_size

                    try:
                        # Estimate tokens for this batch
                        batch_tokens = sum(len(text.split()) for text in batch) * 1.3
                        total_tokens_used += batch_tokens

                        # Create rate limit progress callback if we have a progress callback
                        rate_limit_callback = None
                        if progress_callback:
                            async def rate_limit_callback(data: dict):
                                # Send heartbeat during rate limit wait
                                processed = result.success_count + result.failure_count
                                message = f"Rate limited: {data.get('message', 'Waiting...')}"
                                await progress_callback(message, (processed / len(texts)) * 100)

                        # Rate limit each batch
                        async with threading_service.rate_limited_operation(batch_tokens, rate_limit_callback):
                            retry_count = 0
                            max_retries = 3

                            while retry_count < max_retries:
                                try:
                                    # Create embeddings for this batch
                                    embedding_model = await get_embedding_model(provider=embedding_provider)
                                    embeddings = await adapter.create_embeddings(
                                        batch,
                                        embedding_model,
                                        dimensions=dimensions_to_use,
                                    )

                                    for text, vector in zip(batch, embeddings, strict=False):
                                        result.add_success(vector, text)

                                    break  # Success, exit retry loop

                                except openai.RateLimitError as e:
                                    error_message = str(e)
                                    if "insufficient_quota" in error_message:
                                        # Quota exhausted is critical - stop everything
                                        tokens_so_far = total_tokens_used - batch_tokens
                                        cost_so_far = (tokens_so_far / 1_000_000) * 0.02

                                        search_logger.error(
                                            f"⚠️ QUOTA EXHAUSTED at batch {batch_index}! "
                                            f"Processed {result.success_count} texts successfully.",
                                            exc_info=True,
                                        )

                                        # Add remaining texts as failures
                                        for text in texts[i:]:
                                            result.add_failure(
                                                text,
                                                EmbeddingQuotaExhaustedError(
                                                    "OpenAI quota exhausted",
                                                    tokens_used=tokens_so_far,
                                                ),
                                                batch_index,
                                            )

                                        # Return what we have so far
                                        span.set_attribute("quota_exhausted", True)
                                        span.set_attribute("partial_success", True)
                                        return result

                                    else:
                                        # Regular rate limit - retry
                                        retry_count += 1
                                        if retry_count < max_retries:
                                            wait_time = 2**retry_count
                                            search_logger.warning(
                                                f"Rate limit hit for batch {batch_index}, "
                                                f"waiting {wait_time}s before retry {retry_count}/{max_retries}"
                                            )
                                            await asyncio.sleep(wait_time)
                                        else:
                                            raise  # Will be caught by outer try
                                except EmbeddingRateLimitError as e:
                                    retry_count += 1
                                    if retry_count < max_retries:
                                        wait_time = 2**retry_count
                                        search_logger.warning(
                                            f"Embedding rate limit for batch {batch_index}: {e}. "
                                            f"Waiting {wait_time}s before retry {retry_count}/{max_retries}"
                                        )
                                        await asyncio.sleep(wait_time)
                                    else:
                                        raise

                    except Exception as e:
                        # This batch failed - track failures but continue with next batch
                        search_logger.error(f"Batch {batch_index} failed: {e}", exc_info=True)

                        for text in batch:
                            if isinstance(e, EmbeddingError):
                                result.add_failure(text, e, batch_index)
                            else:
                                result.add_failure(
                                    text,
                                    EmbeddingAPIError(
                                        f"Failed to create embedding: {str(e)}", original_error=e
                                    ),
                                    batch_index,
                                )

                    # Progress reporting
                    if progress_callback:
                        processed = result.success_count + result.failure_count
                        progress = (processed / len(texts)) * 100

                        message = f"Processed {processed}/{len(texts)} texts"
                        if result.has_failures:
                            message += f" ({result.failure_count} failed)"

                        await progress_callback(message, progress)

                    # Yield control
                    await asyncio.sleep(0.01)

                span.set_attribute("embeddings_created", result.success_count)
                span.set_attribute("embeddings_failed", result.failure_count)
                span.set_attribute("success", not result.has_failures)
                span.set_attribute("total_tokens_used", total_tokens_used)

                return result

        except Exception as e:
            # Catastrophic failure - return what we have
            span.set_attribute("catastrophic_failure", True)
            search_logger.error(f"Catastrophic failure in batch embedding: {e}", exc_info=True)

            # Mark remaining texts as failed
            processed_count = result.success_count + result.failure_count
            for text in texts[processed_count:]:
                result.add_failure(
                    text, EmbeddingAPIError(f"Catastrophic failure: {str(e)}", original_error=e)
                )

            return result


# Deprecated functions - kept for backward compatibility
async def get_openai_api_key() -> str | None:
    """
    DEPRECATED: Use os.getenv("OPENAI_API_KEY") directly.
    API key is loaded into environment at startup.
    """
    return os.getenv("OPENAI_API_KEY")
