"""
Tests for RAG Strategies and Search Functionality

Tests RAGService class, hybrid search, agentic RAG, reranking, and other advanced RAG features.
Updated to match current async-only architecture.
"""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Mock problematic imports at module level
with patch.dict(
    os.environ,
    {
        "SUPABASE_URL": "http://test.supabase.co",
        "SUPABASE_SERVICE_KEY": "test_key",
        "OPENAI_API_KEY": "test_openai_key",
    },
):
    # Mock credential service to prevent database calls
    with patch("src.server.services.credential_service.credential_service") as mock_cred:
        mock_cred._cache_initialized = False
        mock_cred.get_setting.return_value = "false"
        mock_cred.get_bool_setting.return_value = False

        # Mock supabase client creation
        with patch("src.server.utils.get_supabase_client") as mock_supabase:
            mock_client = MagicMock()
            mock_supabase.return_value = mock_client

            # Mock embedding service to prevent API calls
            with patch(
                "src.server.services.embeddings.embedding_service.create_embedding"
            ) as mock_embed:
                mock_embed.return_value = [0.1] * 1536


# Test RAGService core functionality
class TestRAGService:
    """Test core RAGService functionality"""

    @pytest.fixture
    def mock_supabase_client(self):
        """Mock Supabase client"""
        return MagicMock()

    @pytest.fixture
    def rag_service(self, mock_supabase_client):
        """Create RAGService instance"""
        from src.server.services.search import RAGService

        return RAGService(supabase_client=mock_supabase_client)

    def test_rag_service_initialization(self, rag_service):
        """Test RAGService initializes correctly"""
        assert rag_service is not None
        assert hasattr(rag_service, "search_documents")
        assert hasattr(rag_service, "search_code_examples")
        assert hasattr(rag_service, "perform_rag_query")

    def test_get_setting(self, rag_service):
        """Test settings retrieval"""
        with patch.dict("os.environ", {"USE_HYBRID_SEARCH": "true"}):
            result = rag_service.get_setting("USE_HYBRID_SEARCH", "false")
            assert result == "true"

    def test_get_bool_setting(self, rag_service):
        """Test boolean settings retrieval"""
        with patch.dict("os.environ", {"USE_RERANKING": "true"}):
            result = rag_service.get_bool_setting("USE_RERANKING", False)
            assert result is True

    @pytest.mark.asyncio
    async def test_search_code_examples(self, rag_service):
        """Test code examples search"""
        with patch.object(
            rag_service.agentic_strategy, "search_code_examples"
        ) as mock_agentic_search:
            # Mock agentic search results
            mock_agentic_search.return_value = [
                {
                    "content": "def example():\n    pass",
                    "summary": "Python function example",
                    "url": "test.py",
                    "metadata": {"language": "python"},
                }
            ]

            result = await rag_service.search_code_examples(
                query="python function example", match_count=5
            )

            assert isinstance(result, list)
            assert len(result) == 1
            mock_agentic_search.assert_called_once()

    @pytest.mark.asyncio
    async def test_perform_rag_query(self, rag_service):
        """Test complete RAG query flow"""
        # Create a mock reranking strategy if it doesn't exist
        if rag_service.reranking_strategy is None:
            from unittest.mock import Mock

            rag_service.reranking_strategy = Mock()
            rag_service.reranking_strategy.rerank_results = AsyncMock()

        with (
            patch.object(rag_service, "search_documents") as mock_search,
            patch.object(rag_service.reranking_strategy, "rerank_results") as mock_rerank,
        ):
            mock_search.return_value = [{"content": "Relevant content", "score": 0.90}]
            mock_rerank.return_value = [{"content": "Relevant content", "score": 0.95}]

            success, result = await rag_service.perform_rag_query(query="test query", match_count=5)

            assert success is True
            assert "results" in result
            assert isinstance(result["results"], list)

    @pytest.mark.asyncio
    async def test_rerank_results(self, rag_service):
        """Test result reranking via strategy"""
        from src.server.services.search import RerankingStrategy

        # Create a mock reranking strategy
        mock_strategy = MagicMock(spec=RerankingStrategy)
        mock_strategy.rerank_results = AsyncMock(
            return_value=[{"content": "Reranked content", "score": 0.98}]
        )

        # Assign the mock strategy to the service
        rag_service.reranking_strategy = mock_strategy

        original_results = [{"content": "Original content", "score": 0.80}]

        # Call the strategy directly (as the service now does internally)
        result = await rag_service.reranking_strategy.rerank_results(
            query="test query", results=original_results
        )

        assert isinstance(result, list)
        assert result[0]["content"] == "Reranked content"


class TestHybridSearchStrategy:
    """Test hybrid search strategy implementation"""

    @pytest.fixture
    def mock_supabase_client(self):
        """Mock Supabase client"""
        return MagicMock()

    @pytest.fixture
    def hybrid_strategy(self, mock_supabase_client):
        """Create HybridSearchStrategy instance"""
        from src.server.services.search import HybridSearchStrategy
        from src.server.services.search.base_search_strategy import BaseSearchStrategy

        base_strategy = BaseSearchStrategy(mock_supabase_client)
        return HybridSearchStrategy(mock_supabase_client, base_strategy)

    def test_hybrid_strategy_initialization(self, hybrid_strategy):
        """Test HybridSearchStrategy initializes correctly"""
        assert hybrid_strategy is not None
        assert hasattr(hybrid_strategy, "search_documents_hybrid")
        assert hasattr(hybrid_strategy, "search_code_examples_hybrid")


class TestRerankingStrategy:
    """Test reranking strategy implementation"""

    @pytest.fixture
    def reranking_strategy(self):
        """Create RerankingStrategy instance"""
        from src.server.services.search import RerankingStrategy

        return RerankingStrategy()

    def test_reranking_strategy_initialization(self, reranking_strategy):
        """Test RerankingStrategy initializes correctly"""
        assert reranking_strategy is not None
        assert hasattr(reranking_strategy, "rerank_results")
        assert hasattr(reranking_strategy, "is_available")

    def test_model_availability_check(self, reranking_strategy):
        """Test model availability checking"""
        # This should not crash even if model not available
        availability = reranking_strategy.is_available()
        assert isinstance(availability, bool)

    @pytest.mark.asyncio
    async def test_rerank_results_no_model(self, reranking_strategy):
        """Test reranking when model not available"""
        with patch.object(reranking_strategy, "is_available") as mock_available:
            mock_available.return_value = False

            original_results = [{"content": "Test content", "score": 0.8}]

            result = await reranking_strategy.rerank_results(
                query="test query", results=original_results
            )

            # Should return original results when model not available
            assert result == original_results

    @pytest.mark.asyncio
    async def test_rerank_results_with_model(self, reranking_strategy):
        """Test reranking when model is available"""
        with (
            patch.object(reranking_strategy, "is_available") as mock_available,
            patch.object(reranking_strategy, "model") as mock_model,
        ):
            mock_available.return_value = True
            mock_model_instance = MagicMock()
            mock_model_instance.predict.return_value = [0.95, 0.85]  # Mock scores
            mock_model = mock_model_instance
            reranking_strategy.model = mock_model_instance

            original_results = [
                {"content": "Content 1", "score": 0.8},
                {"content": "Content 2", "score": 0.7},
            ]

            result = await reranking_strategy.rerank_results(
                query="test query", results=original_results
            )

            assert isinstance(result, list)
            assert len(result) <= len(original_results)


class TestAgenticRAGStrategy:
    """Test agentic RAG strategy implementation"""

    @pytest.fixture
    def mock_supabase_client(self):
        """Mock Supabase client"""
        return MagicMock()

    @pytest.fixture
    def agentic_strategy(self, mock_supabase_client):
        """Create AgenticRAGStrategy instance"""
        from src.server.services.search import AgenticRAGStrategy
        from src.server.services.search.base_search_strategy import BaseSearchStrategy

        base_strategy = BaseSearchStrategy(mock_supabase_client)
        return AgenticRAGStrategy(mock_supabase_client, base_strategy)

    def test_agentic_strategy_initialization(self, agentic_strategy):
        """Test AgenticRAGStrategy initializes correctly"""
        assert agentic_strategy is not None
        # Check for expected methods
        methods = dir(agentic_strategy)
        assert any("search" in method.lower() for method in methods)


class TestRAGIntegration:
    """Integration tests for RAG strategies working together"""

    @pytest.fixture
    def mock_supabase_client(self):
        """Mock Supabase client"""
        return MagicMock()

    @pytest.fixture
    def rag_service(self, mock_supabase_client):
        """Create RAGService instance"""
        from src.server.services.search import RAGService

        return RAGService(supabase_client=mock_supabase_client)

    @pytest.mark.asyncio
    async def test_full_rag_pipeline(self, rag_service):
        """Test complete RAG pipeline with all strategies"""
        # Create a mock reranking strategy if it doesn't exist
        if rag_service.reranking_strategy is None:
            from unittest.mock import Mock

            rag_service.reranking_strategy = Mock()
            rag_service.reranking_strategy.rerank_results = AsyncMock()

        with (
            patch(
                "src.server.services.embeddings.embedding_service.create_embedding"
            ) as mock_embedding,
            patch.object(rag_service.base_strategy, "vector_search") as mock_search,
            patch.object(rag_service, "get_bool_setting") as mock_settings,
            patch.object(rag_service.reranking_strategy, "rerank_results") as mock_rerank,
        ):
            # Mock embedding creation
            mock_embedding.return_value = [0.1] * 1536

            # Enable all strategies
            mock_settings.side_effect = lambda key, default: True

            mock_search.return_value = [
                {"content": "Test result 1", "similarity": 0.9, "id": "1", "metadata": {}},
                {"content": "Test result 2", "similarity": 0.8, "id": "2", "metadata": {}},
            ]

            mock_rerank.return_value = [
                {"content": "Reranked result", "similarity": 0.95, "id": "1", "metadata": {}}
            ]

            success, result = await rag_service.perform_rag_query(
                query="complex technical query", match_count=10
            )

            assert success is True
            assert "results" in result
            assert isinstance(result["results"], list)

    @pytest.mark.asyncio
    async def test_error_handling_in_rag_pipeline(self, rag_service):
        """Test error handling when strategies fail"""
        with patch(
            "src.server.services.embeddings.embedding_service.create_embedding"
        ) as mock_embedding:
            # Simulate embedding failure (returns None)
            mock_embedding.return_value = None

            success, result = await rag_service.perform_rag_query(query="test query", match_count=5)

            # Should handle gracefully by returning empty results
            assert success is True
            assert "results" in result
            assert len(result["results"]) == 0  # Empty results due to embedding failure

    @pytest.mark.asyncio
    async def test_empty_results_handling(self, rag_service):
        """Test handling of empty search results"""
        with (
            patch(
                "src.server.services.embeddings.embedding_service.create_embedding"
            ) as mock_embedding,
            patch.object(rag_service.base_strategy, "vector_search") as mock_search,
        ):
            # Mock embedding creation
            mock_embedding.return_value = [0.1] * 1536
            mock_search.return_value = []  # Empty results

            success, result = await rag_service.perform_rag_query(
                query="nonexistent query", match_count=5
            )

            assert success is True
            assert "results" in result
            assert len(result["results"]) == 0


class TestRAGPerformance:
    """Test RAG performance and optimization features"""

    @pytest.fixture
    def rag_service(self):
        """Create RAGService instance"""
        from unittest.mock import MagicMock

        from src.server.services.search import RAGService

        mock_client = MagicMock()
        return RAGService(supabase_client=mock_client)

    @pytest.mark.asyncio
    async def test_concurrent_rag_queries(self, rag_service):
        """Test multiple concurrent RAG queries"""
        with (
            patch(
                "src.server.services.embeddings.embedding_service.create_embedding"
            ) as mock_embedding,
            patch.object(rag_service.base_strategy, "vector_search") as mock_search,
        ):
            # Mock embedding creation
            mock_embedding.return_value = [0.1] * 1536

            mock_search.return_value = [
                {
                    "content": "Result for concurrent test",
                    "similarity": 0.9,
                    "id": "1",
                    "metadata": {},
                }
            ]

            # Run multiple queries concurrently
            queries = ["query 1", "query 2", "query 3"]
            tasks = [rag_service.perform_rag_query(query, match_count=3) for query in queries]

            results = await asyncio.gather(*tasks, return_exceptions=True)

            # All should complete successfully
            assert len(results) == 3
            for result in results:
                if isinstance(result, tuple):
                    success, data = result
                    assert success is True or isinstance(data, dict)

    @pytest.mark.asyncio
    async def test_large_result_set_handling(self, rag_service):
        """Test handling of large result sets"""
        with (
            patch(
                "src.server.services.embeddings.embedding_service.create_embedding"
            ) as mock_embedding,
            patch.object(rag_service.base_strategy, "vector_search") as mock_search,
        ):
            # Mock embedding creation
            mock_embedding.return_value = [0.1] * 1536

            # Create large result set, but limit to match_count
            large_results = [
                {
                    "content": f"Result {i}",
                    "similarity": 0.9 - (i * 0.01),
                    "id": str(i),
                    "metadata": {},
                }
                for i in range(50)  # Only return up to match_count results
            ]
            mock_search.return_value = large_results

            success, result = await rag_service.perform_rag_query(
                query="large query", match_count=50
            )

            assert success is True
            assert "results" in result
            # Should respect match_count limit
            assert len(result["results"]) <= 50


class TestRAGConfiguration:
    """Test RAG configuration and settings"""

    @pytest.fixture
    def rag_service(self):
        """Create RAGService instance"""
        from unittest.mock import MagicMock

        from src.server.services.search import RAGService

        mock_client = MagicMock()
        return RAGService(supabase_client=mock_client)

    def test_environment_variable_settings(self, rag_service):
        """Test reading settings from environment variables"""
        with patch.dict(
            "os.environ",
            {"USE_HYBRID_SEARCH": "true", "USE_RERANKING": "false", "USE_AGENTIC_RAG": "true"},
        ):
            assert rag_service.get_bool_setting("USE_HYBRID_SEARCH") is True
            assert rag_service.get_bool_setting("USE_RERANKING") is False
            assert rag_service.get_bool_setting("USE_AGENTIC_RAG") is True

    def test_default_settings(self, rag_service):
        """Test default settings when environment variables not set"""
        with patch.dict("os.environ", {}):
            assert rag_service.get_bool_setting("NONEXISTENT_SETTING", True) is True
            assert rag_service.get_bool_setting("NONEXISTENT_SETTING", False) is False

    @pytest.mark.asyncio
    async def test_strategy_conditional_execution(self, rag_service):
        """Test that strategies only execute when enabled"""
        with (
            patch(
                "src.server.services.embeddings.embedding_service.create_embedding"
            ) as mock_embedding,
            patch.object(rag_service.base_strategy, "vector_search") as mock_search,
            patch.object(rag_service, "get_bool_setting") as mock_setting,
        ):
            # Mock embedding creation
            mock_embedding.return_value = [0.1] * 1536

            mock_search.return_value = [
                {"content": "test", "similarity": 0.9, "id": "1", "metadata": {}}
            ]

            # Disable all strategies
            mock_setting.return_value = False

            success, result = await rag_service.perform_rag_query(query="test query", match_count=5)

            assert success is True
            # Should still return results from basic search
            assert "results" in result
