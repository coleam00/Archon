"""
Simple, Fast RAG Tests

Focused tests that avoid complex initialization and database calls.
These tests verify the core RAG functionality without heavy dependencies.
"""

import os
from unittest.mock import MagicMock, patch

import pytest

# Set test environment variables
os.environ.update({
    "SUPABASE_URL": "http://test.supabase.co",
    "SUPABASE_SERVICE_KEY": "test_key",
    "OPENAI_API_KEY": "test_openai_key",
    "USE_HYBRID_SEARCH": "false",
    "USE_RERANKING": "false",
    "USE_AGENTIC_RAG": "false",
})


@pytest.fixture
def mock_supabase():
    """Mock supabase client"""
    client = MagicMock()
    client.rpc.return_value.execute.return_value.data = []
    client.from_.return_value.select.return_value.limit.return_value.execute.return_value.data = []
    return client


@pytest.fixture
def rag_service(mock_supabase):
    """Create RAGService with mocked dependencies"""
    with patch("src.server.utils.get_supabase_client", return_value=mock_supabase):
        with patch("src.server.services.credential_service.credential_service"):
            from src.server.services.search.rag_service import RAGService

            service = RAGService(supabase_client=mock_supabase)
            return service


class TestRAGServiceCore:
    """Core RAGService functionality tests"""

    def test_initialization(self, rag_service):
        """Test RAGService initializes correctly"""
        assert rag_service is not None
        assert hasattr(rag_service, "search_documents")
        assert hasattr(rag_service, "search_code_examples")
        assert hasattr(rag_service, "perform_rag_query")

    def test_settings_methods(self, rag_service):
        """Test settings retrieval methods"""
        # Test string setting
        result = rag_service.get_setting("TEST_SETTING", "default")
        assert isinstance(result, str)

        # Test boolean setting
        result = rag_service.get_bool_setting("TEST_BOOL", False)
        assert isinstance(result, bool)


class TestRAGServiceSearch:
    """Search functionality tests"""

    @pytest.mark.asyncio
    async def test_basic_vector_search(self, rag_service, mock_supabase):
        """Test basic vector search functionality"""
        # Mock the RPC response
        mock_response = MagicMock()
        mock_response.data = [
            {
                "id": "1",
                "content": "Test content",
                "similarity": 0.8,
                "metadata": {},
                "url": "test.com",
            }
        ]
        mock_supabase.rpc.return_value.execute.return_value = mock_response

        # Test the search
        query_embedding = [0.1] * 1536
        results = await rag_service.base_strategy.vector_search(
            query_embedding=query_embedding, match_count=5
        )

        assert isinstance(results, list)
        assert len(results) == 1
        assert results[0]["content"] == "Test content"

        # Verify RPC was called correctly
        mock_supabase.rpc.assert_called_once()
        call_args = mock_supabase.rpc.call_args[0]
        assert call_args[0] == "match_archon_crawled_pages"

    @pytest.mark.asyncio
    async def test_search_documents_with_embedding(self, rag_service):
        """Test document search with mocked embedding"""
        # Patch at the module level where it's called from RAGService
        with (
            patch("src.server.services.search.rag_service.create_embedding") as mock_embed,
            patch.object(rag_service.base_strategy, "vector_search") as mock_search,
        ):
            # Setup mocks
            mock_embed.return_value = [0.1] * 1536
            mock_search.return_value = [{"content": "Test result", "similarity": 0.9}]

            # Test search
            results = await rag_service.search_documents(query="test query", match_count=5)

            assert isinstance(results, list)
            assert len(results) == 1
            mock_embed.assert_called_once_with("test query")
            mock_search.assert_called_once()

    @pytest.mark.asyncio
    async def test_perform_rag_query_basic(self, rag_service):
        """Test complete RAG query pipeline"""
        with patch.object(rag_service, "search_documents") as mock_search:
            mock_search.return_value = [
                {"id": "1", "content": "Test content", "similarity": 0.8, "metadata": {}}
            ]

            success, result = await rag_service.perform_rag_query(query="test query", match_count=5)

            assert success is True
            assert "results" in result
            assert len(result["results"]) == 1
            assert result["results"][0]["content"] == "Test content"
            assert result["query"] == "test query"

    @pytest.mark.asyncio
    async def test_search_code_examples_delegation(self, rag_service):
        """Test code examples search delegates to agentic strategy"""
        with patch.object(rag_service.agentic_strategy, "search_code_examples") as mock_agentic:
            mock_agentic.return_value = [
                {"content": "def test(): pass", "summary": "Test function", "url": "test.py"}
            ]

            results = await rag_service.search_code_examples(query="test function", match_count=10)

            assert isinstance(results, list)
            mock_agentic.assert_called_once()


class TestHybridSearchCore:
    """Basic hybrid search tests"""

    @pytest.fixture
    def hybrid_strategy(self, mock_supabase):
        """Create hybrid search strategy"""
        from src.server.services.search.base_search_strategy import BaseSearchStrategy
        from src.server.services.search.hybrid_search_strategy import HybridSearchStrategy

        base_strategy = BaseSearchStrategy(mock_supabase)
        return HybridSearchStrategy(mock_supabase, base_strategy)

    def test_initialization(self, hybrid_strategy):
        """Test hybrid strategy initializes"""
        assert hybrid_strategy is not None
        assert hasattr(hybrid_strategy, "search_documents_hybrid")


class TestRerankingCore:
    """Basic reranking tests"""

    @pytest.fixture
    def reranking_strategy(self):
        """Create reranking strategy"""
        from src.server.services.search.reranking_strategy import RerankingStrategy

        return RerankingStrategy()

    def test_initialization(self, reranking_strategy):
        """Test reranking strategy initializes"""
        assert reranking_strategy is not None
        assert hasattr(reranking_strategy, "rerank_results")
        assert hasattr(reranking_strategy, "is_available")

    def test_availability_check(self, reranking_strategy):
        """Test model availability checking"""
        availability = reranking_strategy.is_available()
        assert isinstance(availability, bool)

    @pytest.mark.asyncio
    async def test_rerank_with_no_model(self, reranking_strategy):
        """Test reranking when no model is available"""
        # Force model to be None
        reranking_strategy.model = None

        original_results = [{"content": "Test content", "score": 0.8}]

        result = await reranking_strategy.rerank_results(
            query="test query", results=original_results
        )

        # Should return original results when no model
        assert result == original_results

    @pytest.mark.asyncio
    async def test_rerank_with_mock_model(self, reranking_strategy):
        """Test reranking with a mocked model"""
        # Create a mock model
        mock_model = MagicMock()
        mock_model.predict.return_value = [0.95, 0.85, 0.75]  # Mock rerank scores
        reranking_strategy.model = mock_model

        original_results = [
            {"content": "Content 1", "similarity": 0.8},
            {"content": "Content 2", "similarity": 0.7},
            {"content": "Content 3", "similarity": 0.9},
        ]

        result = await reranking_strategy.rerank_results(
            query="test query", results=original_results
        )

        # Should return reranked results
        assert isinstance(result, list)
        assert len(result) == 3

        # Results should be sorted by rerank_score
        scores = [r.get("rerank_score", 0) for r in result]
        assert scores == sorted(scores, reverse=True)

        # Highest rerank score should be first
        assert result[0]["rerank_score"] == 0.95


class TestAgenticRAGCore:
    """Basic agentic RAG tests"""

    @pytest.fixture
    def agentic_strategy(self, mock_supabase):
        """Create agentic RAG strategy"""
        from src.server.services.search.agentic_rag_strategy import AgenticRAGStrategy
        from src.server.services.search.base_search_strategy import BaseSearchStrategy

        base_strategy = BaseSearchStrategy(mock_supabase)
        return AgenticRAGStrategy(mock_supabase, base_strategy)

    def test_initialization(self, agentic_strategy):
        """Test agentic strategy initializes"""
        assert agentic_strategy is not None
        assert hasattr(agentic_strategy, "search_code_examples")
        assert hasattr(agentic_strategy, "is_enabled")

    def test_query_enhancement(self, agentic_strategy):
        """Test code query enhancement"""
        original_query = "python function"
        analysis = agentic_strategy.analyze_code_query(original_query)

        assert isinstance(analysis, dict)
        assert "is_code_query" in analysis
        assert "confidence" in analysis
        assert "languages" in analysis
        assert analysis["is_code_query"] is True
        assert "python" in analysis["languages"]


class TestRAGIntegrationSimple:
    """Simple integration tests"""

    @pytest.mark.asyncio
    async def test_error_handling(self, rag_service):
        """Test error handling in RAG pipeline"""
        with patch.object(rag_service, "search_documents") as mock_search:
            # Simulate an error
            mock_search.side_effect = Exception("Test error")

            success, result = await rag_service.perform_rag_query(query="test query", match_count=5)

            assert success is False
            assert "error" in result
            assert result["error"] == "Test error"

    @pytest.mark.asyncio
    async def test_empty_results_handling(self, rag_service):
        """Test handling of empty search results"""
        with patch.object(rag_service, "search_documents") as mock_search:
            mock_search.return_value = []

            success, result = await rag_service.perform_rag_query(
                query="empty query", match_count=5
            )

            assert success is True
            assert "results" in result
            assert len(result["results"]) == 0

    @pytest.mark.asyncio
    async def test_full_rag_pipeline_with_reranking(self, rag_service, mock_supabase):
        """Test complete RAG pipeline with reranking enabled"""
        # Create a mock reranking model
        mock_model = MagicMock()
        mock_model.predict.return_value = [0.95, 0.85, 0.75]

        # Initialize RAG service with reranking
        from src.server.services.search.reranking_strategy import RerankingStrategy

        reranking_strategy = RerankingStrategy()
        reranking_strategy.model = mock_model
        rag_service.reranking_strategy = reranking_strategy

        with (
            patch.object(rag_service, "search_documents") as mock_search,
            patch.object(rag_service, "get_bool_setting") as mock_settings,
        ):
            # Enable reranking
            mock_settings.return_value = True

            # Mock search results
            mock_search.return_value = [
                {"id": "1", "content": "Result 1", "similarity": 0.8, "metadata": {}},
                {"id": "2", "content": "Result 2", "similarity": 0.7, "metadata": {}},
                {"id": "3", "content": "Result 3", "similarity": 0.9, "metadata": {}},
            ]

            success, result = await rag_service.perform_rag_query(query="test query", match_count=5)

            assert success is True
            assert "results" in result
            assert len(result["results"]) == 3

            # Verify reranking was applied
            assert result["reranking_applied"] is True

            # Results should be sorted by rerank_score
            results = result["results"]
            rerank_scores = [r.get("rerank_score", 0) for r in results]
            assert rerank_scores == sorted(rerank_scores, reverse=True)

    @pytest.mark.asyncio
    async def test_hybrid_search_integration(self, rag_service):
        """Test RAG with hybrid search enabled"""
        with (
            patch("src.server.services.search.rag_service.create_embedding") as mock_embed,
            patch.object(rag_service.hybrid_strategy, "search_documents_hybrid") as mock_hybrid,
            patch.object(rag_service, "get_bool_setting") as mock_settings,
        ):
            # Mock embedding and enable hybrid search
            mock_embed.return_value = [0.1] * 1536
            mock_settings.return_value = True

            # Mock hybrid search results
            mock_hybrid.return_value = [
                {
                    "id": "1",
                    "content": "Hybrid result",
                    "similarity": 0.9,
                    "metadata": {},
                    "match_type": "hybrid",
                }
            ]

            results = await rag_service.search_documents(
                query="test query", use_hybrid_search=True, match_count=5
            )

            assert isinstance(results, list)
            assert len(results) == 1
            assert results[0]["content"] == "Hybrid result"
            mock_hybrid.assert_called_once()

    @pytest.mark.asyncio
    async def test_code_search_with_agentic_rag(self, rag_service):
        """Test code search using agentic RAG"""
        with (
            patch.object(rag_service.agentic_strategy, "is_enabled") as mock_enabled,
            patch.object(rag_service.agentic_strategy, "search_code_examples") as mock_agentic,
            patch.object(rag_service, "get_bool_setting") as mock_settings,
        ):
            # Enable agentic RAG
            mock_enabled.return_value = True
            mock_settings.return_value = False  # Disable hybrid search for this test

            # Mock agentic search results
            mock_agentic.return_value = [
                {
                    "content": 'def example_function():\\n    return "Hello"',
                    "summary": "Example function that returns greeting",
                    "url": "example.py",
                    "metadata": {"language": "python"},
                }
            ]

            success, result = await rag_service.search_code_examples_service(
                query="python greeting function", match_count=10
            )

            assert success is True
            assert "results" in result
            assert len(result["results"]) == 1

            code_result = result["results"][0]
            assert "def example_function" in code_result["code"]
            assert code_result["summary"] == "Example function that returns greeting"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
