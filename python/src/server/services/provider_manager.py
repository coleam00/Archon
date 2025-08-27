"""
Simplified Provider Manager

A single, simple service for managing LLM providers and models.
No singletons, no complex initialization, just straightforward provider management.
"""

import os
import time
import logging
from typing import Dict, Any, Optional
from contextlib import asynccontextmanager

import openai
from cryptography.fernet import Fernet
from supabase import Client

logger = logging.getLogger(__name__)


class ProviderManager:
    """Manages LLM providers and models for all services."""
    
    # No default configurations - user must configure each service
    DEFAULT_CONFIGS = {}
    
    # Provider base URLs
    PROVIDER_BASE_URLS = {
        'ollama': 'http://host.docker.internal:11434/v1',
        'google': 'https://generativelanguage.googleapis.com/v1beta/openai/',
        'gemini': 'https://generativelanguage.googleapis.com/v1beta/openai/'
    }
    
    def __init__(self, supabase_client: Client):
        """
        Initialize with Supabase client.
        
        Args:
            supabase_client: Supabase client for database access
        """
        self.db = supabase_client
        self._config_cache: Dict[str, tuple[Dict[str, Any], float]] = {}
        self._cache_ttl = 300  # 5 minutes
        
        # Initialize cipher for API key decryption
        key = os.environ.get('ARCHON_ENCRYPTION_KEY')
        if key:
            try:
                self.cipher = Fernet(key.encode())
            except Exception as e:
                logger.warning(f"Invalid encryption key, will try plain API keys: {e}")
                self.cipher = None
        else:
            self.cipher = None
        
    async def get_service_config(self, service: str) -> Dict[str, Any]:
        """
        Get configuration for a service.
        
        Args:
            service: Service name (e.g., 'embeddings', 'rag_agent')
            
        Returns:
            Configuration dict with provider, model, and other settings
        """
        # Check cache first
        if service in self._config_cache:
            config, timestamp = self._config_cache[service]
            if time.time() - timestamp < self._cache_ttl:
                logger.debug(f"Using cached config for {service}")
                return config
        
        try:
            # Try to get from database (model_config table)
            result = self.db.table('model_config').select('*').eq('service_name', service).single().execute()
            if result.data:
                # Parse the model_string format (e.g., "google:text-embedding-004")
                model_string = result.data['model_string']
                if ':' in model_string:
                    provider, model = model_string.split(':', 1)
                else:
                    provider = 'openai'
                    model = model_string
                
                config = {
                    'provider': provider,
                    'model': model,
                    'temperature': result.data.get('temperature', 0.7),
                    'max_tokens': result.data.get('max_tokens')
                }
                
                # Add service-specific settings from database if available
                
                logger.info(f"Loaded config for {service}: provider={provider}, model={model}")
                
            else:
                # No configuration found - raise error
                raise ValueError(f"No model configuration found for service '{service}'. Please configure the model in the Agents page.")
        
        except Exception as e:
            logger.error(f"Error loading config for {service}: {e}")
            raise ValueError(f"Failed to load model configuration for service '{service}': {e}")
        
        # Cache the configuration
        self._config_cache[service] = (config, time.time())
        return config
    
    async def get_api_key(self, provider: str) -> Optional[str]:
        """
        Get API key for a provider.
        
        Args:
            provider: Provider name (e.g., 'openai', 'google')
            
        Returns:
            API key or None
        """
        # First check environment variables
        env_key_map = {
            'openai': 'OPENAI_API_KEY',
            'google': 'GOOGLE_API_KEY',
            'gemini': 'GOOGLE_API_KEY',
            'anthropic': 'ANTHROPIC_API_KEY',
            'mistral': 'MISTRAL_API_KEY',
            'groq': 'GROQ_API_KEY',
            'deepseek': 'DEEPSEEK_API_KEY',
            'openrouter': 'OPENROUTER_API_KEY'
        }
        
        env_var = env_key_map.get(provider)
        if env_var:
            api_key = os.getenv(env_var)
            if api_key:
                return api_key
        
        # Try to get from database
        try:
            result = self.db.table('api_keys').select('encrypted_key').eq('provider', provider).eq('is_active', True).single().execute()
            if result.data and result.data.get('encrypted_key'):
                encrypted_key = result.data['encrypted_key']
                logger.debug(f"Found encrypted key for {provider}, length: {len(encrypted_key)}")
                
                # Try to decrypt if cipher is available
                if self.cipher:
                    try:
                        decrypted = self.cipher.decrypt(encrypted_key.encode()).decode()
                        # Log preview of decrypted key for debugging
                        key_preview = f"{decrypted[:4]}...{decrypted[-4:]}" if len(decrypted) > 8 else "****"
                        logger.info(f"Successfully decrypted API key for {provider}: {key_preview}")
                        return decrypted
                    except Exception as e:
                        logger.warning(f"Could not decrypt API key for {provider}, trying as plain text: {e}")
                
                # Fall back to using as-is (might be plain text in dev)
                # Check if it looks like a test/placeholder key
                if encrypted_key in ['asdasdsad', 'test', 'placeholder', 'your-api-key-here']:
                    logger.warning(f"⚠️ Found placeholder API key for {provider}: '{encrypted_key}' - Please update in Settings")
                else:
                    key_preview = f"{encrypted_key[:4]}...{encrypted_key[-4:]}" if len(encrypted_key) > 8 else "****"
                    logger.info(f"Using API key as-is for {provider} (no encryption): {key_preview}")
                return encrypted_key
                
        except Exception as e:
            logger.warning(f"Could not get API key from database for {provider}: {e}")
        
        return None
    
    @asynccontextmanager
    async def get_client(self, service: str = 'rag_agent'):
        """
        Get an OpenAI-compatible client for a service.
        
        Args:
            service: Service name (e.g., 'embeddings', 'rag_agent')
            
        Yields:
            openai.AsyncOpenAI client configured for the service
        """
        config = await self.get_service_config(service)
        provider = config['provider']
        
        # Get API key
        api_key = await self.get_api_key(provider)
        if not api_key and provider != 'ollama':
            # For non-Ollama providers, we need an API key
            logger.error(f"No API key found for provider {provider}")
            raise ValueError(f"API key not configured for provider: {provider}")
        
        if api_key:
            # Log API key info (first/last few chars only for security)
            key_preview = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "****"
            logger.debug(f"Using API key for {provider}: {key_preview}")
        
        # Determine base URL
        base_url = self.PROVIDER_BASE_URLS.get(provider)
        
        # Create client based on provider
        client = None
        try:
            if provider == 'ollama':
                # Ollama doesn't need an API key
                client = openai.AsyncOpenAI(
                    base_url=base_url or 'http://host.docker.internal:11434/v1',
                    api_key='not-needed'
                )
            elif provider in ['google', 'gemini']:
                client = openai.AsyncOpenAI(
                    base_url=self.PROVIDER_BASE_URLS['google'],
                    api_key=api_key
                )
            else:
                # Default OpenAI-compatible client
                client = openai.AsyncOpenAI(
                    api_key=api_key,
                    base_url=base_url  # None for OpenAI
                )
            
            logger.info(f"Created {provider} client for service {service}")
            yield client
            
        finally:
            if client:
                await client.close()
    
    async def get_model(self, service: str) -> str:
        """
        Get the model name for a service.
        
        Args:
            service: Service name
            
        Returns:
            Model name (e.g., 'gpt-4o-mini')
        """
        config = await self.get_service_config(service)
        return config['model']
    
    async def get_embedding_dimensions(self, service: str = 'embeddings') -> int:
        """
        Get embedding dimensions for a service.
        
        Args:
            service: Service name (default: 'embeddings')
            
        Returns:
            Embedding dimensions
        """
        config = await self.get_service_config(service)
        dimensions = config.get('dimensions')
        if not dimensions:
            # Try to infer from provider/model
            provider = config.get('provider')
            model = config.get('model')
            
            # Known dimensions for specific models
            if provider == 'openai' and 'text-embedding-3-small' in str(model):
                return 1536
            elif provider == 'openai' and 'text-embedding-3-large' in str(model):
                return 3072
            elif provider in ['google', 'gemini'] and 'text-embedding-004' in str(model):
                return 768
            else:
                raise ValueError(f"Cannot determine embedding dimensions for provider '{provider}' and model '{model}'. Please configure dimensions.")
        
        return dimensions
    
    def should_skip_dimensions(self, provider: str) -> bool:
        """
        Check if dimensions parameter should be skipped for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            True if dimensions should be skipped
        """
        # Google doesn't support the dimensions parameter
        return provider in ['google', 'gemini']
    
    async def clear_cache(self):
        """Clear the configuration cache."""
        self._config_cache.clear()
        logger.info("Provider configuration cache cleared")