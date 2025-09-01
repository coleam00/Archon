"""
Comprehensive Tests for Ollama Embedding Router

Tests dimension-aware routing, optimal instance selection, fallback mechanisms,
performance scoring, and multi-instance load balancing for embedding operations.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.ollama.embedding_router import (
    EmbeddingRouter,
    RoutingDecision,
    EmbeddingRoute
)


class TestEmbeddingRouter:
    """Test suite for EmbeddingRouter"""

    @pytest.fixture
    def mock_client_manager(self):
        """Mock Supabase client manager"""
        mock_client = MagicMock()
        mock_table = MagicMock()
        mock_select = MagicMock()
        mock_insert = MagicMock()
        
        # Setup method chaining
        mock_select.execute.return_value.data = []
        mock_select.eq.return_value = mock_select
        mock_select.order.return_value = mock_select
        mock_select.limit.return_value = mock_select
        mock_table.select.return_value = mock_select
        
        mock_insert.execute.return_value.data = [{"id": "test-route"}]
        mock_table.insert.return_value = mock_insert
        
        mock_client.table.return_value = mock_table
        return mock_client

    @pytest.fixture
    def embedding_router(self, mock_client_manager):
        """Create EmbeddingRouter instance for testing"""
        with patch('src.server.services.ollama.embedding_router.get_supabase_client', return_value=mock_client_manager):
            return EmbeddingRouter()

    @pytest.fixture
    def sample_instances(self):
        """Sample Ollama instances for testing"""
        return [
            {
                "id": "instance-1",
                "name": "Primary Chat Instance",
                "baseUrl": "http://localhost:11434",
                "instanceType": "chat",
                "isEnabled": True,
                "isPrimary": True,
                "loadBalancingWeight": 100,
                "responseTimeMs": 150,
                "modelsAvailable": 5
            },
            {
                "id": "instance-2", 
                "name": "Embedding Specialist",
                "baseUrl": "http://localhost:11435",
                "instanceType": "embedding",
                "isEnabled": True,
                "isPrimary": False,
                "loadBalancingWeight": 80,
                "responseTimeMs": 200,
                "modelsAvailable": 3
            },
            {
                "id": "instance-3",
                "name": "Universal Instance",
                "baseUrl": "http://localhost:11436",
                "instanceType": "both",
                "isEnabled": True,
                "isPrimary": False,
                "loadBalancingWeight": 60,
                "responseTimeMs": 300,
                "modelsAvailable": 8
            }
        ]

    @pytest.fixture
    def sample_embedding_test_response(self):
        """Sample embedding response for testing"""
        return {
            "embedding": [0.1] * 768  # 768-dimensional embedding
        }

    @pytest.mark.asyncio
    async def test_route_embedding_optimal_selection(self, embedding_router, sample_instances, sample_embedding_test_response):
        """Test optimal instance selection for embedding routing"""
        model_name = "nomic-embed-text:latest"
        instance_url = "http://localhost:11435"  # Embedding specialist
        
        # Mock embedding test to determine dimensions
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_embedding_test_response)
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                decision = await embedding_router.route_embedding(model_name, instance_url)
        
        assert decision.model_name == model_name
        assert decision.target_column == "embedding_768"  # Should map to 768-dimension column
        assert decision.dimensions == 768
        assert decision.fallback_applied is False
        assert decision.routing_strategy == RoutingStrategy.OPTIMAL

    @pytest.mark.asyncio
    async def test_route_embedding_fallback_instance(self, embedding_router, sample_instances, sample_embedding_test_response):
        """Test fallback to alternative instance when primary fails"""
        model_name = "embed-model:latest"
        failed_instance_url = "http://unreachable:11434"
        
        # Mock failed request to primary instance
        mock_session = AsyncMock()
        failed_response = AsyncMock()
        failed_response.status = 500
        
        # Mock successful fallback response
        success_response = AsyncMock()
        success_response.status = 200
        success_response.json = AsyncMock(return_value=sample_embedding_test_response)
        
        def mock_post_side_effect(*args, **kwargs):
            url = args[0] if args else kwargs.get('url', '')
            if 'unreachable' in url:
                return failed_response.__aenter__()
            else:
                return success_response.__aenter__()
        
        mock_session.post.return_value.__aenter__ = AsyncMock(side_effect=mock_post_side_effect)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                decision = await embedding_router.route_embedding(model_name, failed_instance_url)
        
        assert decision.fallback_applied is True
        assert decision.routing_strategy == RoutingStrategy.FALLBACK
        assert decision.instance_url != failed_instance_url  # Should use different instance

    @pytest.mark.asyncio
    async def test_route_embedding_dimension_detection(self, embedding_router, sample_instances):
        """Test detection of different embedding dimensions"""
        model_name = "custom-embed:latest"
        instance_url = "http://localhost:11435"
        
        test_cases = [
            (768, "embedding_768"),
            (1024, "embedding_1024"),
            (1536, "embedding_1536"),
            (3072, "embedding_3072")
        ]
        
        for dimensions, expected_column in test_cases:
            # Mock response with specific dimensions
            embedding_response = {
                "embedding": [0.1] * dimensions
            }
            
            mock_session = AsyncMock()
            mock_response = AsyncMock()
            mock_response.status = 200
            mock_response.json = AsyncMock(return_value=embedding_response)
            mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
            
            with patch('aiohttp.ClientSession', return_value=mock_session):
                with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                    decision = await embedding_router.route_embedding(model_name, instance_url)
            
            assert decision.dimensions == dimensions
            assert decision.target_column == expected_column

    @pytest.mark.asyncio
    async def test_route_embedding_unsupported_dimensions(self, embedding_router, sample_instances):
        """Test handling of unsupported embedding dimensions"""
        model_name = "weird-embed:latest"
        instance_url = "http://localhost:11435"
        
        # Mock response with unsupported dimensions (e.g., 512)
        embedding_response = {
            "embedding": [0.1] * 512
        }
        
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=embedding_response)
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                with pytest.raises(ValueError, match="Unsupported embedding dimension"):
                    await embedding_router.route_embedding(model_name, instance_url)

    @pytest.mark.asyncio
    async def test_performance_scoring_calculation(self, embedding_router, sample_instances):
        """Test performance scoring algorithm"""
        # Test performance scoring for different instance configurations
        scores = []
        for instance in sample_instances:
            score = embedding_router._calculate_performance_score(instance)
            scores.append((instance["name"], score))
        
        # Instance 1: Primary, fast (150ms), high weight (100), chat type
        # Instance 2: Embedding specialist, medium speed (200ms), medium weight (80)
        # Instance 3: Universal, slower (300ms), lower weight (60), both types
        
        # Embedding specialist should score highest for embedding tasks
        embedding_scores = [
            embedding_router._calculate_performance_score(inst) 
            for inst in sample_instances 
            if inst["instanceType"] in ["embedding", "both"]
        ]
        
        # Embedding specialist (instance 2) should have competitive score
        specialist_score = embedding_router._calculate_performance_score(sample_instances[1])
        universal_score = embedding_router._calculate_performance_score(sample_instances[2])
        
        # Specialist should score better than universal due to specialization bonus
        assert specialist_score >= universal_score

    @pytest.mark.asyncio
    async def test_instance_filtering_by_type(self, embedding_router, sample_instances):
        """Test filtering instances by type for embedding operations"""
        embedding_capable = embedding_router._filter_embedding_capable_instances(sample_instances)
        
        # Should include embedding specialist and universal instance, exclude chat-only
        expected_instances = [
            inst for inst in sample_instances 
            if inst["instanceType"] in ["embedding", "both"]
        ]
        
        assert len(embedding_capable) == len(expected_instances)
        
        # Should not include chat-only instance
        chat_only_names = [inst["name"] for inst in embedding_capable if inst["instanceType"] == "chat"]
        assert len(chat_only_names) == 0

    @pytest.mark.asyncio
    async def test_load_balancing_weight_consideration(self, embedding_router):
        """Test that load balancing weights influence routing decisions"""
        instances_different_weights = [
            {
                "id": "high-weight",
                "baseUrl": "http://localhost:11434",
                "instanceType": "embedding",
                "isEnabled": True,
                "loadBalancingWeight": 100,
                "responseTimeMs": 200,
                "modelsAvailable": 3
            },
            {
                "id": "low-weight",
                "baseUrl": "http://localhost:11435", 
                "instanceType": "embedding",
                "isEnabled": True,
                "loadBalancingWeight": 20,
                "responseTimeMs": 150,  # Faster but lower weight
                "modelsAvailable": 3
            }
        ]
        
        high_weight_score = embedding_router._calculate_performance_score(instances_different_weights[0])
        low_weight_score = embedding_router._calculate_performance_score(instances_different_weights[1])
        
        # Higher weight should compensate for slightly slower response time
        assert high_weight_score >= low_weight_score

    @pytest.mark.asyncio
    async def test_get_embedding_routes_summary(self, embedding_router, mock_client_manager):
        """Test retrieval of embedding routes summary"""
        # Mock database response with route data
        mock_routes_data = [
            {
                "model_name": "nomic-embed-text:latest",
                "instance_url": "http://localhost:11435",
                "dimensions": 768,
                "target_column": "embedding_768",
                "performance_score": 85.5,
                "created_at": "2024-01-15T10:00:00Z"
            },
            {
                "model_name": "text-embedding-ada-002",
                "instance_url": "http://localhost:11436",
                "dimensions": 1536,
                "target_column": "embedding_1536", 
                "performance_score": 92.3,
                "created_at": "2024-01-15T11:00:00Z"
            }
        ]
        
        mock_client_manager.table.return_value.select.return_value.execute.return_value.data = mock_routes_data
        
        routes_summary = await embedding_router.get_embedding_routes_summary()
        
        assert routes_summary["total_routes"] == 2
        assert len(routes_summary["routes"]) == 2
        assert routes_summary["dimension_analysis"]["768"]["count"] == 1
        assert routes_summary["dimension_analysis"]["1536"]["count"] == 1

    @pytest.mark.asyncio
    async def test_store_routing_decision(self, embedding_router, mock_client_manager):
        """Test storing routing decisions in database"""
        decision = RoutingDecision(
            model_name="test-embed:latest",
            instance_url="http://localhost:11435",
            dimensions=768,
            target_column="embedding_768",
            confidence=0.95,
            fallback_applied=False,
            routing_strategy=RoutingStrategy.OPTIMAL,
            performance_score=88.5
        )
        
        await embedding_router._store_routing_decision(decision)
        
        # Verify database insert was called
        mock_client_manager.table.assert_called_with("embedding_routes")
        mock_client_manager.table().insert.assert_called_once()

    @pytest.mark.asyncio
    async def test_routing_with_text_sample_optimization(self, embedding_router, sample_instances, sample_embedding_test_response):
        """Test routing optimization using text sample"""
        model_name = "adaptive-embed:latest"
        instance_url = "http://localhost:11435"
        text_sample = "This is a sample text for testing embedding optimization"
        
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_embedding_test_response)
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                decision = await embedding_router.route_embedding(
                    model_name, 
                    instance_url, 
                    text_content=text_sample
                )
        
        assert decision.model_name == model_name
        assert decision.confidence > 0.0  # Should have confidence score
        
        # Verify that text sample was used in the embedding request
        call_args = mock_session.post.call_args
        request_data = call_args[1]['json']
        assert request_data['prompt'] == text_sample

    @pytest.mark.asyncio
    async def test_concurrent_routing_requests(self, embedding_router, sample_instances, sample_embedding_test_response):
        """Test handling of concurrent routing requests"""
        import asyncio
        
        model_names = ["embed-1:latest", "embed-2:latest", "embed-3:latest"]
        instance_url = "http://localhost:11435"
        
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value=sample_embedding_test_response)
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                # Run multiple routing requests concurrently
                tasks = [
                    embedding_router.route_embedding(model_name, instance_url)
                    for model_name in model_names
                ]
                
                decisions = await asyncio.gather(*tasks)
        
        assert len(decisions) == 3
        for i, decision in enumerate(decisions):
            assert decision.model_name == model_names[i]
            assert decision.dimensions == 768
            assert decision.target_column == "embedding_768"

    @pytest.mark.asyncio
    async def test_error_handling_all_instances_fail(self, embedding_router, sample_instances):
        """Test error handling when all available instances fail"""
        model_name = "problematic-embed:latest"
        instance_url = "http://localhost:11435"
        
        # Mock failed responses from all instances
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.status = 500
        mock_response.text = AsyncMock(return_value="Internal Server Error")
        mock_session.post.return_value.__aenter__ = AsyncMock(return_value=mock_response)
        
        with patch('aiohttp.ClientSession', return_value=mock_session):
            with patch.object(embedding_router, '_get_available_instances', return_value=sample_instances):
                with pytest.raises(RuntimeError, match="No available instances"):
                    await embedding_router.route_embedding(model_name, instance_url)

    @pytest.mark.asyncio
    async def test_dimension_column_mapping(self, embedding_router):
        """Test correct mapping of dimensions to database columns"""
        assert embedding_router._get_target_column(768) == "embedding_768"
        assert embedding_router._get_target_column(1024) == "embedding_1024" 
        assert embedding_router._get_target_column(1536) == "embedding_1536"
        assert embedding_router._get_target_column(3072) == "embedding_3072"
        
        # Test unsupported dimension
        with pytest.raises(ValueError, match="Unsupported embedding dimension"):
            embedding_router._get_target_column(512)

    @pytest.mark.asyncio
    async def test_routing_strategy_selection(self, embedding_router, sample_instances):
        """Test selection of appropriate routing strategy"""
        # Test various scenarios that should trigger different strategies
        
        # 1. Optimal routing - instance available and working
        strategy = embedding_router._determine_routing_strategy(
            requested_instance="http://localhost:11435",
            available_instances=sample_instances,
            primary_instance_failed=False
        )
        assert strategy == RoutingStrategy.OPTIMAL
        
        # 2. Fallback routing - primary instance failed
        strategy = embedding_router._determine_routing_strategy(
            requested_instance="http://localhost:11435",
            available_instances=sample_instances[1:],  # Remove primary
            primary_instance_failed=True
        )
        assert strategy == RoutingStrategy.FALLBACK
        
        # 3. Load balancing - multiple equivalent instances
        equal_instances = [inst.copy() for inst in sample_instances]
        for inst in equal_instances:
            inst["loadBalancingWeight"] = 100  # Make them equal
            inst["responseTimeMs"] = 200
        
        strategy = embedding_router._determine_routing_strategy(
            requested_instance=None,
            available_instances=equal_instances,
            primary_instance_failed=False
        )
        assert strategy == RoutingStrategy.LOAD_BALANCED

    def test_performance_metrics_calculation(self, embedding_router):
        """Test performance metrics calculation"""
        instance = {
            "responseTimeMs": 150,
            "loadBalancingWeight": 80,
            "modelsAvailable": 5,
            "instanceType": "embedding"
        }
        
        metrics = embedding_router._calculate_performance_metrics(instance)
        
        assert isinstance(metrics, PerformanceMetrics)
        assert metrics.response_time_score > 0
        assert metrics.weight_score > 0
        assert metrics.model_availability_score > 0
        assert metrics.specialization_score > 0
        assert metrics.total_score > 0

    @pytest.mark.asyncio
    async def test_instance_health_consideration(self, embedding_router, sample_instances):
        """Test that instance health is considered in routing decisions"""
        # Add health information to instances
        healthy_instances = []
        for inst in sample_instances:
            inst_copy = inst.copy()
            inst_copy["isHealthy"] = True
            healthy_instances.append(inst_copy)
        
        unhealthy_instance = sample_instances[0].copy()
        unhealthy_instance["isHealthy"] = False
        unhealthy_instance["id"] = "unhealthy-instance"
        
        all_instances = healthy_instances + [unhealthy_instance]
        
        filtered_instances = embedding_router._filter_healthy_instances(all_instances)
        
        # Should only return healthy instances
        assert len(filtered_instances) == len(healthy_instances)
        assert all(inst["isHealthy"] for inst in filtered_instances)
        assert not any(inst["id"] == "unhealthy-instance" for inst in filtered_instances)