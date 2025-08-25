"""
Main Server Integration with Clean Provider System

This module integrates the clean provider system with the main FastAPI server,
replacing the old credential_service model lookups.
"""

import os
import logging
from typing import Optional, Dict, Any
from supabase import Client

from ..services import ModelConfigService, APIKeyManager

logger = logging.getLogger(__name__)


class MainServerProviderIntegration:
    """Integration layer for main server to use clean provider system"""
    
    def __init__(self, supabase_client: Client):
        """
        Initialize with existing Supabase client.
        
        Args:
            supabase_client: Existing Supabase client from the main server
        """
        self.supabase = supabase_client
        self.model_service = ModelConfigService(supabase_client)
        self.key_manager = APIKeyManager(supabase_client)
        self._model_cache: Dict[str, str] = {}
        self._initialized = False
    
    async def initialize(self) -> bool:
        """
        Initialize the provider system for main server.
        
        Returns:
            True if initialization successful
        """
        try:
            # Load API keys into environment
            logger.info("Loading API keys for main server...")
            key_status = await self.key_manager.setup_environment()
            
            for provider, success in key_status.items():
                if success:
                    logger.debug(f"✓ {provider} API key loaded")
            
            # Cache model configurations
            self._model_cache = await self.model_service.get_all_configs()
            logger.info(f"Loaded {len(self._model_cache)} model configurations")
            
            self._initialized = True
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize provider system: {e}")
            return False
    
    async def get_embedding_model(self, provider: Optional[str] = None) -> str:
        """
        Get the embedding model configuration.
        
        Args:
            provider: Optional provider override
            
        Returns:
            Model string for embeddings (e.g., 'text-embedding-3-small')
        """
        if not self._initialized:
            await self.initialize()
        
        # Get from database or cache
        if 'embeddings' not in self._model_cache:
            config = await self.model_service.get_model_config('embeddings')
            if config:
                self._model_cache['embeddings'] = config.model_string
            else:
                # Default fallback
                return 'text-embedding-3-small'
        
        model_string = self._model_cache.get('embeddings', 'openai:text-embedding-3-small')
        
        # Extract just the model name (remove provider prefix)
        if ':' in model_string:
            return model_string.split(':', 1)[1]
        return model_string
    
    async def get_llm_model(self, service: str = 'rag_agent') -> str:
        """
        Get the LLM model for a service.
        
        Args:
            service: Service name (rag_agent, document_agent, etc.)
            
        Returns:
            Model string (e.g., 'gpt-4o-mini')
        """
        if not self._initialized:
            await self.initialize()
        
        # Get from cache or fetch
        if service not in self._model_cache:
            config = await self.model_service.get_model_config(service)
            if config:
                self._model_cache[service] = config.model_string
            else:
                # Default fallback
                return 'gpt-4o-mini'
        
        model_string = self._model_cache.get(service, 'openai:gpt-4o-mini')
        
        # Extract just the model name (remove provider prefix)
        if ':' in model_string:
            return model_string.split(':', 1)[1]
        return model_string
    
    async def get_provider_for_service(self, service: str) -> str:
        """
        Get the provider for a specific service.
        
        Args:
            service: Service name
            
        Returns:
            Provider name (e.g., 'openai', 'anthropic')
        """
        if not self._initialized:
            await self.initialize()
        
        model_string = self._model_cache.get(service, 'openai:gpt-4o-mini')
        
        if ':' in model_string:
            return model_string.split(':', 1)[0]
        return 'openai'
    
    async def get_api_key(self, provider: str) -> Optional[str]:
        """
        Get API key for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            API key or None
        """
        # First check environment (where keys are loaded)
        env_key = f"{provider.upper()}_API_KEY"
        api_key = os.environ.get(env_key)
        
        if not api_key:
            # Try to fetch from database
            key_data = await self.key_manager.get_api_key(provider)
            if key_data:
                return key_data
        
        return api_key
    
    async def refresh_config(self) -> None:
        """Refresh cached configurations from database."""
        try:
            self._model_cache = await self.model_service.get_all_configs()
            logger.info("Refreshed model configurations")
        except Exception as e:
            logger.error(f"Failed to refresh configurations: {e}")
    
    def get_provider_base_url(self, provider: str) -> Optional[str]:
        """
        Get base URL for a provider (mainly for Ollama).
        
        Args:
            provider: Provider name
            
        Returns:
            Base URL or None
        """
        if provider == 'ollama':
            return os.environ.get('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1')
        return None


# Singleton instance that will be initialized by main server
_integration_instance: Optional[MainServerProviderIntegration] = None


def get_provider_integration() -> Optional[MainServerProviderIntegration]:
    """Get the singleton provider integration instance."""
    return _integration_instance


def init_provider_integration(supabase_client: Client) -> MainServerProviderIntegration:
    """
    Initialize the provider integration singleton.
    
    Args:
        supabase_client: Supabase client from main server
        
    Returns:
        Initialized integration instance
    """
    global _integration_instance
    _integration_instance = MainServerProviderIntegration(supabase_client)
    return _integration_instance