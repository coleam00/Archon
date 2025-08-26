"""
Simple Tests for Ollama Embedding Router

Basic functionality tests to verify the router initializes and basic methods work.
"""

import pytest
from src.server.services.ollama.embedding_router import (
    EmbeddingRouter,
    RoutingDecision,
    EmbeddingRoute
)


class TestEmbeddingRouterSimple:
    """Simple test suite for EmbeddingRouter"""
    
    @pytest.fixture
    def embedding_router(self):
        """Create an embedding router instance for testing."""
        return EmbeddingRouter()
    
    def test_router_initialization(self, embedding_router):
        """Test that router initializes correctly."""
        assert embedding_router is not None
        assert hasattr(embedding_router, 'routing_cache')
        assert hasattr(embedding_router, 'cache_ttl')
        assert embedding_router.cache_ttl == 300
    
    def test_routing_decision_creation(self):
        """Test that RoutingDecision can be created."""
        decision = RoutingDecision(
            target_column="embedding_1536",
            model_name="nomic-embed-text",
            instance_url="http://localhost:11434",
            dimensions=1536,
            confidence=0.9,
            fallback_applied=False,
            routing_strategy="auto-detect"
        )
        assert decision.target_column == "embedding_1536"
        assert decision.model_name == "nomic-embed-text"
        assert decision.dimensions == 1536
        assert decision.confidence == 0.9
        assert decision.fallback_applied is False
    
    def test_embedding_route_creation(self):
        """Test that EmbeddingRoute can be created."""
        route = EmbeddingRoute(
            model_name="nomic-embed-text",
            instance_url="http://localhost:11434",
            dimensions=1536,
            column_name="embedding_1536",
            performance_score=0.95
        )
        assert route.model_name == "nomic-embed-text"
        assert route.instance_url == "http://localhost:11434"
        assert route.dimensions == 1536
        assert route.performance_score == 0.95
    
    def test_dimension_columns_mapping(self, embedding_router):
        """Test that dimension columns mapping exists."""
        assert hasattr(embedding_router, 'DIMENSION_COLUMNS')
        assert 768 in embedding_router.DIMENSION_COLUMNS
        assert 1024 in embedding_router.DIMENSION_COLUMNS
        assert 1536 in embedding_router.DIMENSION_COLUMNS
        assert 3072 in embedding_router.DIMENSION_COLUMNS
    
    def test_get_target_column(self, embedding_router):
        """Test the target column selection."""
        # Test exact matches
        assert embedding_router._get_target_column(768) == "embedding_768"
        assert embedding_router._get_target_column(1536) == "embedding_1536"
        
        # Test fallback logic
        assert embedding_router._get_target_column(500) == "embedding_768"  # <= 768
        assert embedding_router._get_target_column(900) == "embedding_1024"  # <= 1024
        assert embedding_router._get_target_column(4000) == "embedding_3072"  # > 1536
    
    def test_get_optimal_index_type(self, embedding_router):
        """Test optimal index type selection."""
        assert embedding_router.get_optimal_index_type(768) == "ivfflat"
        assert embedding_router.get_optimal_index_type(1536) == "ivfflat"
        assert embedding_router.get_optimal_index_type(3072) == "hnsw"
        assert embedding_router.get_optimal_index_type(4096) == "hnsw"  # fallback
    
    def test_routing_statistics_structure(self, embedding_router):
        """Test that routing statistics returns correct structure."""
        stats = embedding_router.get_routing_statistics()
        assert isinstance(stats, dict)
        assert "total_cached_routes" in stats
        assert "auto_detect_routes" in stats
        assert "model_mapping_routes" in stats
        assert "fallback_routes" in stats
        assert "dimension_distribution" in stats
        assert "confidence_distribution" in stats
        
        # Check confidence distribution structure
        confidence_dist = stats["confidence_distribution"]
        assert "high" in confidence_dist
        assert "medium" in confidence_dist
        assert "low" in confidence_dist
    
    def test_cache_management(self, embedding_router):
        """Test cache management methods."""
        assert hasattr(embedding_router, 'clear_routing_cache')
        
        # Test clearing empty cache
        embedding_router.clear_routing_cache()
        stats = embedding_router.get_routing_statistics()
        assert stats["total_cached_routes"] == 0