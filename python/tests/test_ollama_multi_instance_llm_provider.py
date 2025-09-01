"""
Comprehensive Tests for Enhanced LLM Provider Service - Multi-Instance Support

Tests the enhanced multi-instance Ollama support, optimal instance selection,
load balancing, fallback mechanisms, and dual-host configuration for LLM operations.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.llm_provider_service import (
    get_llm_client,
    get_embedding_model,
    _get_optimal_ollama_instance,
    _calculate_instance_priority_score,
    _validate_ollama_instances,
)


class TestMultiInstanceLLMProvider:
    """Test suite for multi-instance LLM provider enhancements"""

    @pytest.fixture
    def mock_credential_service(self):
        """Mock credential service for testing"""
        mock_service = MagicMock()
        mock_service.get_active_provider = AsyncMock()
        mock_service.get_credentials_by_category = AsyncMock()
        mock_service._get_provider_api_key = AsyncMock()
        mock_service._get_provider_base_url = MagicMock()
        mock_service.get_ollama_instances = AsyncMock()
        return mock_service

    @pytest.fixture
    def sample_ollama_instances(self):
        """Sample Ollama instances for testing"""
        return [
            {
                "id": "primary-chat",
                "name": "Primary Chat Instance",
                "baseUrl": "http://localhost:11434",
                "instanceType": "chat",
                "isEnabled": True,
                "isPrimary": True,
                "isHealthy": True,
                "loadBalancingWeight": 100,
                "responseTimeMs": 150,
                "modelsAvailable": 8
            },
            {
                "id": "embedding-specialist",
                "name": "Embedding Specialist",
                "baseUrl": "http://localhost:11435",
                "instanceType": "embedding",
                "isEnabled": True,
                "isPrimary": False,
                "isHealthy": True,
                "loadBalancingWeight": 90,
                "responseTimeMs": 200,
                "modelsAvailable": 4
            },
            {
                "id": "universal-backup",
                "name": "Universal Backup",
                "baseUrl": "http://localhost:11436",
                "instanceType": "both",
                "isEnabled": True,
                "isPrimary": False,
                "isHealthy": True,
                "loadBalancingWeight": 70,
                "responseTimeMs": 300,
                "modelsAvailable": 12
            },
            {
                "id": "disabled-instance",
                "name": "Disabled Instance", 
                "baseUrl": "http://localhost:11437",
                "instanceType": "chat",
                "isEnabled": False,
                "isPrimary": False,
                "isHealthy": False,
                "loadBalancingWeight": 100,
                "responseTimeMs": 100,
                "modelsAvailable": 6
            }
        ]

    @pytest.fixture
    def ollama_multi_instance_config(self):
        """Multi-instance Ollama provider config"""
        return {
            "provider": "ollama",
            "api_key": "ollama",
            "base_url": None,  # Will be determined by instance selection
            "chat_model": "llama2:7b",
            "embedding_model": "nomic-embed-text:latest",
        }

    @pytest.mark.asyncio
    async def test_get_optimal_ollama_instance_chat(self, sample_ollama_instances):
        """Test optimal instance selection for chat operations"""
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = sample_ollama_instances
            
            optimal_instance = await _get_optimal_ollama_instance(
                instance_type="chat",
                base_url=None
            )
        
        # Should select primary chat instance
        assert optimal_instance["id"] == "primary-chat"
        assert optimal_instance["instanceType"] == "chat"
        assert optimal_instance["isPrimary"] is True

    @pytest.mark.asyncio
    async def test_get_optimal_ollama_instance_embedding(self, sample_ollama_instances):
        """Test optimal instance selection for embedding operations"""
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = sample_ollama_instances
            
            optimal_instance = await _get_optimal_ollama_instance(
                instance_type="embedding", 
                base_url=None
            )
        
        # Should select embedding specialist
        assert optimal_instance["id"] == "embedding-specialist"
        assert optimal_instance["instanceType"] == "embedding"

    @pytest.mark.asyncio
    async def test_get_optimal_ollama_instance_both(self, sample_ollama_instances):
        """Test optimal instance selection for dual-purpose operations"""
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = sample_ollama_instances
            
            optimal_instance = await _get_optimal_ollama_instance(
                instance_type="both",
                base_url=None
            )
        
        # Should select universal instance or best available
        assert optimal_instance["instanceType"] in ["both", "chat", "embedding"]
        assert optimal_instance["isEnabled"] is True
        assert optimal_instance["isHealthy"] is True

    @pytest.mark.asyncio
    async def test_get_optimal_ollama_instance_specific_url(self, sample_ollama_instances):
        """Test instance selection with specific base URL"""
        target_url = "http://localhost:11435"
        
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = sample_ollama_instances
            
            optimal_instance = await _get_optimal_ollama_instance(
                instance_type="embedding",
                base_url=target_url
            )
        
        # Should return the specific instance
        assert optimal_instance["baseUrl"] == target_url
        assert optimal_instance["id"] == "embedding-specialist"

    @pytest.mark.asyncio
    async def test_get_optimal_ollama_instance_fallback(self, sample_ollama_instances):
        """Test fallback when preferred instance is unavailable"""
        # Mark primary instance as unhealthy
        unhealthy_instances = [inst.copy() for inst in sample_ollama_instances]
        unhealthy_instances[0]["isHealthy"] = False
        
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = unhealthy_instances
            
            optimal_instance = await _get_optimal_ollama_instance(
                instance_type="chat",
                base_url=None
            )
        
        # Should fallback to universal instance that supports chat
        assert optimal_instance["id"] == "universal-backup"
        assert optimal_instance["instanceType"] == "both"
        assert optimal_instance["isHealthy"] is True

    @pytest.mark.asyncio
    async def test_get_llm_client_multi_instance_chat(self, mock_credential_service, ollama_multi_instance_config, sample_ollama_instances):
        """Test LLM client creation with multi-instance chat selection"""
        mock_credential_service.get_active_provider.return_value = ollama_multi_instance_config
        mock_credential_service.get_ollama_instances.return_value = sample_ollama_instances
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            with patch('src.server.services.llm_provider_service.openai.AsyncOpenAI') as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client
                
                async with get_llm_client(instance_type="chat") as client:
                    assert client == mock_client
                    
                    # Should use primary chat instance URL
                    mock_openai.assert_called_once_with(
                        api_key="ollama",
                        base_url="http://localhost:11434/v1"
                    )

    @pytest.mark.asyncio
    async def test_get_llm_client_multi_instance_embedding(self, mock_credential_service, ollama_multi_instance_config, sample_ollama_instances):
        """Test LLM client creation with multi-instance embedding selection"""
        mock_credential_service.get_active_provider.return_value = ollama_multi_instance_config
        mock_credential_service.get_ollama_instances.return_value = sample_ollama_instances
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            with patch('src.server.services.llm_provider_service.openai.AsyncOpenAI') as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client
                
                async with get_llm_client(use_embedding_provider=True, instance_type="embedding") as client:
                    assert client == mock_client
                    
                    # Should use embedding specialist instance URL
                    mock_openai.assert_called_once_with(
                        api_key="ollama", 
                        base_url="http://localhost:11435/v1"
                    )

    @pytest.mark.asyncio
    async def test_get_llm_client_specific_base_url_override(self, mock_credential_service, ollama_multi_instance_config, sample_ollama_instances):
        """Test LLM client creation with specific base URL override"""
        mock_credential_service.get_active_provider.return_value = ollama_multi_instance_config
        mock_credential_service.get_ollama_instances.return_value = sample_ollama_instances
        
        override_url = "http://custom:11434"
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            with patch('src.server.services.llm_provider_service.openai.AsyncOpenAI') as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client
                
                async with get_llm_client(base_url=override_url) as client:
                    assert client == mock_client
                    
                    # Should use the override URL
                    mock_openai.assert_called_once_with(
                        api_key="ollama",
                        base_url=override_url
                    )

    @pytest.mark.asyncio
    async def test_calculate_instance_priority_score(self):
        """Test instance priority scoring algorithm"""
        instances = [
            # High-performance primary instance
            {
                "isPrimary": True,
                "isHealthy": True,
                "isEnabled": True,
                "responseTimeMs": 100,
                "loadBalancingWeight": 100,
                "modelsAvailable": 10,
                "instanceType": "chat"
            },
            # Specialized but slower instance
            {
                "isPrimary": False,
                "isHealthy": True,
                "isEnabled": True,
                "responseTimeMs": 300,
                "loadBalancingWeight": 80,
                "modelsAvailable": 5,
                "instanceType": "embedding"
            },
            # Fast but low weight instance
            {
                "isPrimary": False,
                "isHealthy": True,
                "isEnabled": True,
                "responseTimeMs": 50,
                "loadBalancingWeight": 30,
                "modelsAvailable": 8,
                "instanceType": "both"
            }
        ]
        
        scores = [
            _calculate_instance_priority_score(inst, "chat")
            for inst in instances
        ]
        
        # Primary instance should score highest for chat
        assert scores[0] >= max(scores[1:])
        
        # Test embedding-specific scoring
        embedding_scores = [
            _calculate_instance_priority_score(inst, "embedding")
            for inst in instances
        ]
        
        # Embedding specialist should get specialization bonus
        assert embedding_scores[1] > embedding_scores[2]  # Specialist > both

    @pytest.mark.asyncio
    async def test_validate_ollama_instances(self, sample_ollama_instances):
        """Test Ollama instances validation"""
        # Test with valid instances
        valid_instances = [inst for inst in sample_ollama_instances if inst["isEnabled"]]
        validated = await _validate_ollama_instances(valid_instances, "chat")
        
        # Should return enabled, healthy instances that support chat
        assert len(validated) >= 1
        assert all(inst["isEnabled"] for inst in validated)
        assert all(inst["instanceType"] in ["chat", "both"] for inst in validated)
        
        # Test with no valid instances
        invalid_instances = [inst for inst in sample_ollama_instances if not inst["isEnabled"]]
        with pytest.raises(ValueError, match="No valid Ollama instances"):
            await _validate_ollama_instances(invalid_instances, "chat")

    @pytest.mark.asyncio
    async def test_load_balancing_across_instances(self, mock_credential_service, ollama_multi_instance_config):
        """Test load balancing behavior across multiple equal instances"""
        # Create multiple equivalent instances for load balancing
        balanced_instances = [
            {
                "id": f"instance-{i}",
                "name": f"Instance {i}",
                "baseUrl": f"http://localhost:1143{i}",
                "instanceType": "chat",
                "isEnabled": True,
                "isPrimary": False,
                "isHealthy": True,
                "loadBalancingWeight": 100,
                "responseTimeMs": 150,
                "modelsAvailable": 8
            }
            for i in range(3)
        ]
        # Make first instance primary
        balanced_instances[0]["isPrimary"] = True
        
        mock_credential_service.get_active_provider.return_value = ollama_multi_instance_config
        mock_credential_service.get_ollama_instances.return_value = balanced_instances
        
        selected_urls = []
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            with patch('src.server.services.llm_provider_service.openai.AsyncOpenAI') as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client
                
                # Make multiple requests to see load balancing
                for _ in range(5):
                    async with get_llm_client(instance_type="chat") as client:
                        call_args = mock_openai.call_args
                        base_url = call_args[1]['base_url']
                        selected_urls.append(base_url)
        
        # Should consistently use primary instance (deterministic selection)
        assert all(url == "http://localhost:11430/v1" for url in selected_urls)

    @pytest.mark.asyncio
    async def test_embedding_model_multi_instance_selection(self, mock_credential_service, sample_ollama_instances):
        """Test embedding model retrieval with multi-instance selection"""
        embedding_config = {
            "provider": "ollama",
            "api_key": "ollama",
            "base_url": None,
            "chat_model": "llama2:7b",
            "embedding_model": "nomic-embed-text:latest",
        }
        
        mock_credential_service.get_active_provider.return_value = embedding_config
        mock_credential_service.get_ollama_instances.return_value = sample_ollama_instances
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            model = await get_embedding_model(provider="ollama")
            
            # Should return the configured embedding model
            assert model == "nomic-embed-text:latest"

    @pytest.mark.asyncio
    async def test_error_handling_no_healthy_instances(self, mock_credential_service, ollama_multi_instance_config):
        """Test error handling when no healthy instances are available"""
        unhealthy_instances = [
            {
                "id": "unhealthy-1",
                "name": "Unhealthy Instance",
                "baseUrl": "http://localhost:11434",
                "instanceType": "chat",
                "isEnabled": True,
                "isPrimary": True,
                "isHealthy": False,
                "loadBalancingWeight": 100,
                "responseTimeMs": 1000,
                "modelsAvailable": 0
            }
        ]
        
        mock_credential_service.get_active_provider.return_value = ollama_multi_instance_config
        mock_credential_service.get_ollama_instances.return_value = unhealthy_instances
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            with pytest.raises(ValueError, match="No healthy Ollama instances"):
                await _get_optimal_ollama_instance(instance_type="chat", base_url=None)

    @pytest.mark.asyncio
    async def test_instance_type_compatibility_filtering(self, sample_ollama_instances):
        """Test filtering instances by type compatibility"""
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = sample_ollama_instances
            
            # Test chat instance selection
            chat_instance = await _get_optimal_ollama_instance(
                instance_type="chat",
                base_url=None
            )
            assert chat_instance["instanceType"] in ["chat", "both"]
            
            # Test embedding instance selection
            embedding_instance = await _get_optimal_ollama_instance(
                instance_type="embedding",
                base_url=None
            )
            assert embedding_instance["instanceType"] in ["embedding", "both"]

    @pytest.mark.asyncio
    async def test_dual_host_configuration_support(self, mock_credential_service, sample_ollama_instances):
        """Test support for dual-host configuration (separate chat and embedding)"""
        dual_config = {
            "provider": "ollama",
            "api_key": "ollama", 
            "base_url": None,
            "chat_model": "llama2:7b",
            "embedding_model": "nomic-embed-text:latest",
            "dual_host_mode": True
        }
        
        mock_credential_service.get_active_provider.return_value = dual_config
        mock_credential_service.get_ollama_instances.return_value = sample_ollama_instances
        
        with patch('src.server.services.llm_provider_service.credential_service', mock_credential_service):
            with patch('src.server.services.llm_provider_service.openai.AsyncOpenAI') as mock_openai:
                mock_client = MagicMock()
                mock_openai.return_value = mock_client
                
                # Test chat client creation
                async with get_llm_client(instance_type="chat") as chat_client:
                    pass
                
                chat_call = mock_openai.call_args
                
                # Reset mock for embedding test
                mock_openai.reset_mock()
                
                # Test embedding client creation
                async with get_llm_client(use_embedding_provider=True, instance_type="embedding") as embed_client:
                    pass
                
                embed_call = mock_openai.call_args
                
                # Should use different instances
                assert chat_call[1]['base_url'] != embed_call[1]['base_url']
                assert "11434" in chat_call[1]['base_url']  # Primary chat
                assert "11435" in embed_call[1]['base_url']  # Embedding specialist

    @pytest.mark.asyncio
    async def test_performance_monitoring_integration(self, sample_ollama_instances):
        """Test integration with performance monitoring"""
        with patch('src.server.services.llm_provider_service.credential_service') as mock_cred:
            mock_cred.get_ollama_instances.return_value = sample_ollama_instances
            
            # Mock performance tracking
            with patch('src.server.services.llm_provider_service.track_instance_performance') as mock_track:
                optimal_instance = await _get_optimal_ollama_instance(
                    instance_type="chat",
                    base_url=None
                )
                
                # Performance should be considered in selection
                assert optimal_instance["responseTimeMs"] is not None
                assert optimal_instance["loadBalancingWeight"] is not None

    def test_instance_url_formatting(self):
        """Test proper URL formatting for Ollama instances"""
        from src.server.services.llm_provider_service import _format_ollama_url
        
        test_cases = [
            ("http://localhost:11434", "http://localhost:11434/v1"),
            ("http://localhost:11434/", "http://localhost:11434/v1"),
            ("http://localhost:11434/v1", "http://localhost:11434/v1"),
            ("http://localhost:11434/v1/", "http://localhost:11434/v1"),
            ("https://ollama.example.com", "https://ollama.example.com/v1"),
        ]
        
        for input_url, expected_url in test_cases:
            formatted_url = _format_ollama_url(input_url)
            assert formatted_url == expected_url