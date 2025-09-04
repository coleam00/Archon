"""
Comprehensive Tests for Async Embedding Service

Tests all aspects of the async embedding service after sync function removal.
Covers both success and error scenarios with thorough edge case testing.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import openai
import pytest

from src.server.services.embeddings.embedding_exceptions import (
    EmbeddingAPIError,
)
from src.server.services.embeddings.embedding_service import (
    EmbeddingBatchResult,
    create_embedding,
    create_embeddings_batch,
)


class AsyncContextManager:
    """Helper class for properly mocking async context managers"""

    def __init__(self, return_value):
        self.return_value = return_value

    async def __aenter__(self):
        return self.return_value

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


class TestAsyncEmbeddingService:
    """Test suite for async embedding service functions"""

    @pytest.fixture
    def mock_llm_client(self):
        """Mock LLM client for testing"""
        mock_client = MagicMock()
        mock_embeddings = MagicMock()
        mock_response = MagicMock()
        mock_response.data = [
            MagicMock(embedding=[0.1, 0.2, 0.3] + [0.0] * 1533)  # 1536 dimensions
        ]
        mock_embeddings.create = AsyncMock(return_value=mock_response)
        mock_client.embeddings = mock_embeddings
        return mock_client

    @pytest.fixture
    def mock_threading_service(self):
        """Mock threading service for testing"""
        mock_service = MagicMock()
        # Create a proper async context manager
        rate_limit_ctx = AsyncContextManager(None)
        mock_service.rate_limited_operation.return_value = rate_limit_ctx
        return mock_service

    @pytest.mark.asyncio
    async def test_create_embedding_success(self, mock_llm_client, mock_threading_service):
        """Test successful single embedding creation"""
        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        # Mock credential service properly
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )

                        # Setup proper async context manager
                        mock_get_client.return_value = AsyncContextManager(mock_llm_client)

                        result = await create_embedding("test text")

                        # Verify the result
                        assert len(result) == 1536
                        assert result[0] == 0.1
                        assert result[1] == 0.2
                        assert result[2] == 0.3

                        # Verify API was called correctly
                        mock_llm_client.embeddings.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_embedding_empty_text(self, mock_llm_client, mock_threading_service):
        """Test embedding creation with empty text"""
        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )

                        mock_get_client.return_value = AsyncContextManager(mock_llm_client)

                        result = await create_embedding("")

                        # Should still work with empty text
                        assert len(result) == 1536
                        mock_llm_client.embeddings.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_embedding_api_error_raises_exception(self, mock_threading_service):
        """Test embedding creation with API error - should raise exception"""
        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )

                        # Setup client to raise an error
                        mock_client = MagicMock()
                        mock_client.embeddings.create = AsyncMock(
                            side_effect=Exception("API Error")
                        )
                        mock_get_client.return_value = AsyncContextManager(mock_client)

                        # Should raise exception now instead of returning zero embeddings
                        with pytest.raises(EmbeddingAPIError):
                            await create_embedding("test text")

    @pytest.mark.asyncio
    async def test_create_embeddings_batch_success(self, mock_llm_client, mock_threading_service):
        """Test successful batch embedding creation"""
        # Setup mock response for multiple embeddings
        mock_response = MagicMock()
        mock_response.data = [
            MagicMock(embedding=[0.1, 0.2, 0.3] + [0.0] * 1533),
            MagicMock(embedding=[0.4, 0.5, 0.6] + [0.0] * 1533),
        ]
        mock_llm_client.embeddings.create = AsyncMock(return_value=mock_response)

        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )

                        mock_get_client.return_value = AsyncContextManager(mock_llm_client)

                        result = await create_embeddings_batch(["text1", "text2"])

                        # Verify the result is EmbeddingBatchResult
                        assert isinstance(result, EmbeddingBatchResult)
                        assert result.success_count == 2
                        assert result.failure_count == 0
                        assert len(result.embeddings) == 2
                        assert len(result.embeddings[0]) == 1536
                        assert len(result.embeddings[1]) == 1536
                        assert result.embeddings[0][0] == 0.1
                        assert result.embeddings[1][0] == 0.4

                        mock_llm_client.embeddings.create.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_embeddings_batch_empty_list(self):
        """Test batch embedding with empty list"""
        result = await create_embeddings_batch([])
        assert isinstance(result, EmbeddingBatchResult)
        assert result.success_count == 0
        assert result.failure_count == 0
        assert result.embeddings == []

    @pytest.mark.asyncio
    async def test_create_embeddings_batch_rate_limit_error(self, mock_threading_service):
        """Test batch embedding with rate limit error"""
        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )

                        # Setup client to raise rate limit error (not quota)
                        mock_client = MagicMock()
                        # Create a proper RateLimitError with required attributes
                        error = openai.RateLimitError(
                            "Rate limit exceeded",
                            response=MagicMock(),
                            body={"error": {"message": "Rate limit exceeded"}},
                        )
                        mock_client.embeddings.create = AsyncMock(side_effect=error)
                        mock_get_client.return_value = AsyncContextManager(mock_client)

                        result = await create_embeddings_batch(["text1", "text2"])

                        # Should return result with failures, not zero embeddings
                        assert isinstance(result, EmbeddingBatchResult)
                        assert result.success_count == 0
                        assert result.failure_count == 2
                        assert len(result.embeddings) == 0
                        assert len(result.failed_items) == 2

    @pytest.mark.asyncio
    async def test_create_embeddings_batch_quota_exhausted(self, mock_threading_service):
        """Test batch embedding with quota exhausted error"""
        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )

                        # Setup client to raise quota exhausted error
                        mock_client = MagicMock()
                        error = openai.RateLimitError(
                            "insufficient_quota",
                            response=MagicMock(),
                            body={"error": {"message": "insufficient_quota"}},
                        )
                        mock_client.embeddings.create = AsyncMock(side_effect=error)
                        mock_get_client.return_value = AsyncContextManager(mock_client)

                        # Mock progress callback
                        progress_callback = AsyncMock()

                        result = await create_embeddings_batch(
                            ["text1", "text2"], progress_callback=progress_callback
                        )

                        # Should return result with failures, not zero embeddings
                        assert isinstance(result, EmbeddingBatchResult)
                        assert result.success_count == 0
                        assert result.failure_count == 2
                        assert len(result.embeddings) == 0
                        assert len(result.failed_items) == 2
                        # Verify quota exhausted is in error messages
                        assert any("quota" in item["error"].lower() for item in result.failed_items)


    @pytest.mark.asyncio
    async def test_create_embeddings_batch_with_progress_callback(
        self, mock_llm_client, mock_threading_service
    ):
        """Test batch embedding with progress callback"""
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1] * 1536)]
        mock_llm_client.embeddings.create = AsyncMock(return_value=mock_response)

        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "1"}
                        )

                        mock_get_client.return_value = AsyncContextManager(mock_llm_client)

                        # Mock progress callback
                        progress_callback = AsyncMock()

                        result = await create_embeddings_batch(
                            ["text1"], progress_callback=progress_callback
                        )

                        # Verify result
                        assert isinstance(result, EmbeddingBatchResult)
                        assert result.success_count == 1

                        # Verify progress callback was called
                        progress_callback.assert_called()

    @pytest.mark.asyncio
    async def test_provider_override(self, mock_llm_client, mock_threading_service):
        """Test that provider override parameter is properly passed through"""
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1] * 1536)]
        mock_llm_client.embeddings.create = AsyncMock(return_value=mock_response)

        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model"
                ) as mock_get_model:
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "10"}
                        )
                        mock_get_model.return_value = "custom-model"

                        mock_get_client.return_value = AsyncContextManager(mock_llm_client)

                        await create_embedding("test text", provider="custom-provider")

                        # Verify provider was passed to get_llm_client
                        mock_get_client.assert_called_with(
                            provider="custom-provider", use_embedding_provider=True
                        )
                        mock_get_model.assert_called_with(provider="custom-provider")

    @pytest.mark.asyncio
    async def test_create_embeddings_batch_large_batch_splitting(
        self, mock_llm_client, mock_threading_service
    ):
        """Test that large batches are properly split according to batch size settings"""
        mock_response = MagicMock()
        mock_response.data = [
            MagicMock(embedding=[0.1] * 1536) for _ in range(2)
        ]  # 2 embeddings per call
        mock_llm_client.embeddings.create = AsyncMock(return_value=mock_response)

        with patch(
            "src.server.services.embeddings.embedding_service.get_threading_service",
            return_value=mock_threading_service,
        ):
            with patch(
                "src.server.services.embeddings.embedding_service.get_llm_client"
            ) as mock_get_client:
                with patch(
                    "src.server.services.embeddings.embedding_service.get_embedding_model",
                    return_value="text-embedding-3-small",
                ):
                    with patch(
                        "src.server.services.embeddings.embedding_service.credential_service"
                    ) as mock_cred:
                        # Set batch size to 2
                        mock_cred.get_credentials_by_category = AsyncMock(
                            return_value={"EMBEDDING_BATCH_SIZE": "2"}
                        )

                        mock_get_client.return_value = AsyncContextManager(mock_llm_client)

                        # Test with 5 texts (should require 3 API calls: 2+2+1)
                        texts = ["text1", "text2", "text3", "text4", "text5"]
                        result = await create_embeddings_batch(texts)

                        # Should have made 3 API calls due to batching
                        assert mock_llm_client.embeddings.create.call_count == 3

                        # Result should be EmbeddingBatchResult
                        assert isinstance(result, EmbeddingBatchResult)
                        # Should have 5 embeddings total (for 5 input texts)
                        # Even though mock returns 2 per call, we only process as many as we requested
                        assert result.success_count == 5
                        assert len(result.embeddings) == 5
                        assert result.texts_processed == texts
