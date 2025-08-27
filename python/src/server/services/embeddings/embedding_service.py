"""
Embedding Service

Handles all OpenAI embedding operations with proper rate limiting and error handling.
"""

import asyncio
import os
from dataclasses import dataclass, field
from typing import Any

import openai

from ...config.logfire_config import safe_span, search_logger
from ..credential_service import credential_service
from ..llm_provider_service import get_embedding_model, get_llm_client
from ..provider_manager import ProviderManager
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



async def _process_embeddings_with_client(
    client,
    texts: list[str],
    embedding_model: str,
    embedding_dimensions: int,
    skip_dimensions: bool,
    websocket: Any | None,
    progress_callback: Any | None,
    result: EmbeddingBatchResult,
    threading_service,
) -> EmbeddingBatchResult:
    """
    Helper function to process embeddings with a given client.
    Extracted to avoid code duplication between old and new systems.
    """
    # Default batch size
    batch_size = 100
    
    try:
        # Try to load from settings
        rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
        batch_size = int(rag_settings.get("EMBEDDING_BATCH_SIZE", "100"))
    except Exception as e:
        search_logger.warning(f"Failed to load batch size from settings: {e}, using default")
    
    total_tokens_used = 0
    
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        batch_index = i // batch_size
        
        try:
            # Estimate tokens for this batch
            batch_tokens = sum(len(text.split()) for text in batch) * 1.3
            total_tokens_used += batch_tokens
            
            # Rate limit each batch
            async with threading_service.rate_limited_operation(batch_tokens):
                retry_count = 0
                max_retries = 3
                
                while retry_count < max_retries:
                    try:
                        # Prepare parameters
                        create_params = {
                            "model": embedding_model,
                            "input": batch,
                        }
                        
                        # Only add dimensions if not skipped
                        if not skip_dimensions:
                            create_params["dimensions"] = embedding_dimensions
                        
                        search_logger.debug(f"Creating embeddings for batch {batch_index} with params: {create_params.keys()}")
                        response = await client.embeddings.create(**create_params)
                        
                        # Add successful embeddings
                        for text, item in zip(batch, response.data, strict=False):
                            result.add_success(item.embedding, text)
                        
                        break  # Success, exit retry loop
                        
                    except openai.RateLimitError as e:
                        error_message = str(e)
                        if "insufficient_quota" in error_message:
                            # Quota exhausted - stop everything
                            search_logger.error(f"⚠️ QUOTA EXHAUSTED at batch {batch_index}!")
                            
                            # Add remaining texts as failures
                            for text in texts[i:]:
                                result.add_failure(
                                    text,
                                    EmbeddingQuotaExhaustedError(
                                        "Quota exhausted",
                                        tokens_used=total_tokens_used,
                                    ),
                                    batch_index,
                                )
                            return result
                        else:
                            # Regular rate limit - retry
                            retry_count += 1
                            if retry_count < max_retries:
                                wait_time = 2**retry_count
                                search_logger.warning(f"Rate limit hit, retrying in {wait_time}s")
                                await asyncio.sleep(wait_time)
                            else:
                                raise
                                
        except Exception as e:
            # This batch failed - track failures but continue
            search_logger.error(f"Batch {batch_index} failed: {e}")
            
            for text in batch:
                if isinstance(e, EmbeddingError):
                    result.add_failure(text, e, batch_index)
                else:
                    result.add_failure(
                        text,
                        EmbeddingAPIError(f"Failed to create embedding: {str(e)}", original_error=e),
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
    
    return result


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
    websocket: Any | None = None,
    progress_callback: Any | None = None,
    provider: str | None = None,
    use_new_provider_manager: bool = True,  # Flag to use new system
    provider_manager: Any | None = None,  # Pass ProviderManager instance directly
) -> EmbeddingBatchResult:
    """
    Create embeddings for multiple texts with graceful failure handling.

    This function processes texts in batches and returns a structured result
    containing both successful embeddings and failed items. It follows the
    "skip, don't corrupt" principle - failed items are tracked but not stored
    with zero embeddings.

    Args:
        texts: List of texts to create embeddings for
        websocket: Optional WebSocket for progress updates
        progress_callback: Optional callback for progress reporting
        provider: Optional provider override
        use_new_provider_manager: Use the new simplified provider system
        provider_manager: Optional ProviderManager instance

    Returns:
        EmbeddingBatchResult with successful embeddings and failure details
    """
    if not texts:
        return EmbeddingBatchResult()

    # Validate that all items in texts are strings
    validated_texts = []
    for i, text in enumerate(texts):
        if not isinstance(text, str):
            search_logger.error(
                f"Invalid text type at index {i}: {type(text)}, value: {text}", exc_info=True
            )
            # Try to convert to string
            try:
                validated_texts.append(str(text))
            except Exception as e:
                search_logger.error(
                    f"Failed to convert text at index {i} to string: {e}", exc_info=True
                )
                validated_texts.append("")  # Use empty string as fallback
        else:
            validated_texts.append(text)

    texts = validated_texts

    result = EmbeddingBatchResult()
    threading_service = get_threading_service()

    with safe_span(
        "create_embeddings_batch", text_count=len(texts), total_chars=sum(len(t) for t in texts)
    ) as span:
        try:
            # Use new ProviderManager if enabled
            if use_new_provider_manager and provider_manager is not None:
                try:
                    
                    async with provider_manager.get_client('embeddings') as client:
                        # Get model and dimensions from provider manager
                        embedding_model = await provider_manager.get_model('embeddings')
                        embedding_dimensions = await provider_manager.get_embedding_dimensions('embeddings')
                        
                        # Get provider config to check if we should skip dimensions
                        config = await provider_manager.get_service_config('embeddings')
                        skip_dimensions = provider_manager.should_skip_dimensions(config['provider'])
                        
                        
                        # Process embeddings with the new system
                        return await _process_embeddings_with_client(
                            client, texts, embedding_model, embedding_dimensions,
                            skip_dimensions, websocket, progress_callback, result, threading_service
                        )
                        
                except Exception as e:
                    search_logger.error(f"Failed to use new ProviderManager, falling back to old system: {e}")
                    use_new_provider_manager = False  # Fall back to old system
            
            # Old system as fallback
            if not use_new_provider_manager:
                async with get_llm_client(provider=provider, use_embedding_provider=True) as client:
                    # Get model using old system
                    embedding_model = await get_embedding_model(provider=provider)
                    
                    # Load dimensions from settings
                    try:
                        rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
                        embedding_dimensions = int(rag_settings.get("EMBEDDING_DIMENSIONS", "1536"))
                    except Exception as e:
                        search_logger.warning(f"Failed to load embedding dimensions: {e}, using default")
                        embedding_dimensions = 1536
                    
                    # Determine if we should skip dimensions (for Google)
                    client_base_url = str(getattr(client, 'base_url', ''))
                    skip_dimensions = 'google' in client_base_url.lower() or 'generativelanguage' in client_base_url.lower()
                    
                    
                    # Process embeddings with the old system
                    return await _process_embeddings_with_client(
                        client, texts, embedding_model, embedding_dimensions,
                        skip_dimensions, websocket, progress_callback, result, threading_service
                    )

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

