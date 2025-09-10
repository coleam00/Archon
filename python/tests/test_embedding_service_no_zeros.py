"""
Tests for embedding service to ensure no zero embeddings are returned.

These tests verify that the embedding service raises appropriate exceptions
instead of returning zero embeddings, following the "fail fast and loud" principle.
"""

from unittest.mock import AsyncMock, Mock, patch

import openai
import pytest

from src.server.services.embeddings.embedding_exceptions import (
    EmbeddingAPIError,
    EmbeddingQuotaExhaustedError,
    EmbeddingRateLimitError,
)
from src.server.services.embeddings.embedding_service import (
    EmbeddingBatchResult,
    create_embedding,
    create_embeddings_batch,
)


class TestNoZeroEmbeddings:
    """Test that no zero embeddings are ever returned."""

    # Note: Removed test_sync_from_async_context_raises_exception
    # as sync versions no longer exist - everything is async-only now

    @pytest.mark.asyncio
    async def test_async_quota_exhausted_returns_failure(self) -> None:
        """Test that quota exhaustion returns failure result instead of zeros."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-small"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-small",
                "model_string": "openai:text-embedding-3-small",
                "embedding_dimensions": 1536,
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock the client to raise quota error
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create.side_effect = openai.RateLimitError(
                "insufficient_quota: You have exceeded your quota", response=Mock(), body=None
            )
            mock_client.return_value = mock_ctx

            # Single embedding still raises for backward compatibility
            with pytest.raises(EmbeddingQuotaExhaustedError) as exc_info:
                await create_embedding("test text")

            assert "quota exhausted" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_async_rate_limit_raises_exception(self) -> None:
        """Test that rate limit errors raise exception after retries."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-small"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-small",
                "model_string": "openai:text-embedding-3-small",
                "embedding_dimensions": 1536,
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock the client to raise rate limit error
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create.side_effect = openai.RateLimitError(
                "rate_limit_exceeded: Too many requests", response=Mock(), body=None
            )
            mock_client.return_value = mock_ctx

            with pytest.raises(EmbeddingRateLimitError) as exc_info:
                await create_embedding("test text")

            assert "rate limit" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_async_api_error_raises_exception(self) -> None:
        """Test that API errors raise exception instead of returning zeros."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-small"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-small",
                "model_string": "openai:text-embedding-3-small",
                "embedding_dimensions": 1536,
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock the client to raise generic error
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create.side_effect = Exception(
                "Network error"
            )
            mock_client.return_value = mock_ctx

            with pytest.raises(EmbeddingAPIError) as exc_info:
                await create_embedding("test text")

            assert "failed to create embedding" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_batch_handles_partial_failures(self) -> None:
        """Test that batch processing can handle partial failures gracefully."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-small"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-small",
                "model_string": "openai:text-embedding-3-small",
                "embedding_dimensions": 1536,
                "batch_size": 2,  # Small batch size for testing
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock successful response for first batch, failure for second
            mock_ctx = AsyncMock()
            mock_response = Mock()
            mock_response.data = [Mock(embedding=[0.1] * 1536), Mock(embedding=[0.2] * 1536)]

            # First call succeeds, second fails
            mock_ctx.__aenter__.return_value.embeddings.create.side_effect = [
                mock_response,
                Exception("API Error"),
            ]
            mock_client.return_value = mock_ctx

            with patch(
                "src.server.services.embeddings.embedding_service.get_embedding_model",
                new_callable=AsyncMock,
                return_value="text-embedding-ada-002",
            ):
                # Process 4 texts (batch size will be 2)
                texts = ["text1", "text2", "text3", "text4"]
                result = await create_embeddings_batch(texts)

                # Check result structure
                assert isinstance(result, EmbeddingBatchResult)
                assert result.success_count == 2  # First batch succeeded
                assert result.failure_count == 2  # Second batch failed
                assert len(result.embeddings) == 2
                assert len(result.failed_items) == 2

                # Verify no zero embeddings were created
                for embedding in result.embeddings:
                    assert not all(v == 0.0 for v in embedding)

    @pytest.mark.asyncio
    async def test_configurable_embedding_dimensions(self) -> None:
        """Test that embedding dimensions can be configured via settings."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-large",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-large"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-large",
                "model_string": "openai:text-embedding-3-large",
                "embedding_dimensions": 3072,  # Different dimensions
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock successful response
            mock_ctx = AsyncMock()
            mock_create = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create = mock_create

            # Setup mock response
            mock_response = Mock()
            mock_response.data = [Mock(embedding=[0.1] * 3072)]  # Different dimensions
            mock_create.return_value = mock_response
            mock_client.return_value = mock_ctx

            with patch(
                "src.server.services.embeddings.embedding_service.get_embedding_model",
                new_callable=AsyncMock,
                return_value="text-embedding-3-large",
            ):
                result = await create_embeddings_batch(["test text"])

                # Verify the dimensions parameter was passed correctly
                mock_create.assert_called_once()
                call_args = mock_create.call_args
                assert call_args.kwargs["dimensions"] == 3072

                # Verify result
                assert result.success_count == 1
                assert len(result.embeddings[0]) == 3072

    @pytest.mark.asyncio
    async def test_default_embedding_dimensions(self) -> None:
        """Test that default dimensions (1536) are used when not configured."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-small"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-small",
                "model_string": "openai:text-embedding-3-small",
                "embedding_dimensions": 1536,  # Default dimensions
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock successful response
            mock_ctx = AsyncMock()
            mock_create = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create = mock_create

            # Setup mock response with default dimensions
            mock_response = Mock()
            mock_response.data = [Mock(embedding=[0.1] * 1536)]
            mock_create.return_value = mock_response
            mock_client.return_value = mock_ctx

            with patch(
                "src.server.services.embeddings.embedding_service.get_embedding_model",
                new_callable=AsyncMock,
                return_value="text-embedding-3-small",
            ):
                result = await create_embeddings_batch(["test text"])

                # Verify the default dimensions parameter was used
                mock_create.assert_called_once()
                call_args = mock_create.call_args
                assert call_args.kwargs["dimensions"] == 1536

                # Verify result
                assert result.success_count == 1
                assert len(result.embeddings[0]) == 1536

    @pytest.mark.asyncio
    async def test_batch_quota_exhausted_stops_process(self) -> None:
        """Test that quota exhaustion stops processing remaining batches."""
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-ada-002",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-ada-002"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-ada-002",
                "model_string": "openai:text-embedding-ada-002",
                "embedding_dimensions": 1536,
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock quota exhaustion
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create.side_effect = openai.RateLimitError(
                "insufficient_quota: Quota exceeded", response=Mock(), body=None
            )
            mock_client.return_value = mock_ctx

            with patch(
                "src.server.services.embeddings.embedding_service.get_embedding_model",
                new_callable=AsyncMock,
                return_value="text-embedding-ada-002",
            ):
                texts = ["text1", "text2", "text3", "text4"]
                result = await create_embeddings_batch(texts)

                # All should fail due to quota
                assert result.success_count == 0
                assert result.failure_count == 4
                assert len(result.embeddings) == 0
                assert all("quota" in item["error"].lower() for item in result.failed_items)

    @pytest.mark.asyncio
    async def test_no_zero_vectors_in_results(self) -> None:
        """Test that no function ever returns a zero vector [0.0] * 1536."""
        # This is a meta-test to ensure our implementation never creates zero vectors

        # Helper to check if a value is a zero embedding
        def is_zero_embedding(value):
            if not isinstance(value, list):
                return False
            if len(value) != 1536:
                return False
            return all(v == 0.0 for v in value)

        # Test data that should never produce zero embeddings
        test_text = "This is a test"

        # Test: Batch function with error should return failure result, not zeros
        with patch(
            "src.server.services.llm_provider_service._get_provider_config"
        ) as mock_get_provider_config, \
             patch(
                 "src.server.services.provider_optimization_service.ProviderOptimizationService.get_provider_optimization"
             ) as mock_get_optimization, \
             patch(
                 "src.server.services.embeddings.embedding_service.get_llm_client"
             ) as mock_client:
            
            # Mock provider config
            mock_get_provider_config.return_value = {
                "provider": "openai",
                "model": "text-embedding-3-small",
                "api_key": "test-key",
                "base_url": None,
                "service_config": {"default_model": "openai:text-embedding-3-small"}
            }
            
            # Mock optimization service
            mock_get_optimization.return_value = {
                "provider": "openai",
                "model_id": "text-embedding-3-small",
                "model_string": "openai:text-embedding-3-small",
                "embedding_dimensions": 1536,
                "batch_size": 100,
                "supports_dimensions": True,
                "base_url": None,
                "cost_per_million": "medium",
                "max_input_tokens": 8000
            }
            
            # Mock the client to raise an error
            mock_ctx = AsyncMock()
            mock_ctx.__aenter__.return_value.embeddings.create.side_effect = Exception("Test error")
            mock_client.return_value = mock_ctx

            result = await create_embeddings_batch([test_text])
            # Should return result with failures, not zeros
            assert isinstance(result, EmbeddingBatchResult)
            assert len(result.embeddings) == 0
            assert result.failure_count == 1
            # Verify no zero embeddings in the result
            for embedding in result.embeddings:
                assert not is_zero_embedding(embedding)


class TestEmbeddingBatchResult:
    """Test the EmbeddingBatchResult dataclass."""

    def test_batch_result_initialization(self) -> None:
        """Test that EmbeddingBatchResult initializes correctly."""
        result = EmbeddingBatchResult()
        assert result.success_count == 0
        assert result.failure_count == 0
        assert result.embeddings == []
        assert result.failed_items == []
        assert not result.has_failures

    def test_batch_result_add_success(self) -> None:
        """Test adding successful embeddings."""
        result = EmbeddingBatchResult()
        embedding = [0.1] * 1536
        text = "test text"

        result.add_success(embedding, text)

        assert result.success_count == 1
        assert result.failure_count == 0
        assert len(result.embeddings) == 1
        assert result.embeddings[0] == embedding
        assert result.texts_processed[0] == text
        assert not result.has_failures

    def test_batch_result_add_failure(self) -> None:
        """Test adding failed items."""
        result = EmbeddingBatchResult()
        error = EmbeddingAPIError("Test error", text_preview="test")

        result.add_failure("test text", error, batch_index=0)

        assert result.success_count == 0
        assert result.failure_count == 1
        assert len(result.failed_items) == 1
        assert result.has_failures

        failed_item = result.failed_items[0]
        assert failed_item["error"] == "Test error"
        assert failed_item["error_type"] == "EmbeddingAPIError"
        # batch_index comes from the error's to_dict() method which includes it
        assert "batch_index" in failed_item  # Just check it exists

    def test_batch_result_mixed_results(self) -> None:
        """Test batch result with both successes and failures."""
        result = EmbeddingBatchResult()

        # Add successes
        result.add_success([0.1] * 1536, "text1")
        result.add_success([0.2] * 1536, "text2")

        # Add failures
        result.add_failure("text3", Exception("Error 1"), 1)
        result.add_failure("text4", Exception("Error 2"), 1)

        assert result.success_count == 2
        assert result.failure_count == 2
        assert result.total_requested == 4
        assert result.has_failures
        assert len(result.embeddings) == 2
        assert len(result.failed_items) == 2
