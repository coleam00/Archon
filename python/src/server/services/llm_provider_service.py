"""
LLM Provider Service

Provides a unified interface for creating OpenAI-compatible clients for different LLM providers.
Supports OpenAI, Ollama, and Google Gemini.

Now integrated with the clean provider system when available.
"""

import time
from contextlib import asynccontextmanager
from typing import Any

import openai

from ..config.logfire_config import get_logger
from .credential_service import credential_service

# Try to import provider integration
try:
    from ...providers_clean.integration.main_server_integration import get_provider_integration
    PROVIDER_INTEGRATION_AVAILABLE = True
except ImportError:
    PROVIDER_INTEGRATION_AVAILABLE = False
    get_provider_integration = lambda: None

logger = get_logger(__name__)

# Settings cache with TTL
_settings_cache: dict[str, tuple[Any, float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes


def _get_cached_settings(key: str) -> Any | None:
    """Get cached settings if not expired."""
    if key in _settings_cache:
        value, timestamp = _settings_cache[key]
        if time.time() - timestamp < _CACHE_TTL_SECONDS:
            return value
        else:
            # Expired, remove from cache
            del _settings_cache[key]
    return None


def _set_cached_settings(key: str, value: Any) -> None:
    """Cache settings with current timestamp."""
    _settings_cache[key] = (value, time.time())


@asynccontextmanager
async def get_llm_client(provider: str | None = None, use_embedding_provider: bool = False):
    """
    Create an async OpenAI-compatible client based on the configured provider.

    This context manager handles client creation for different LLM providers
    that support the OpenAI API format.

    Args:
        provider: Override provider selection
        use_embedding_provider: Use the embedding-specific provider if different

    Yields:
        openai.AsyncOpenAI: An OpenAI-compatible client configured for the selected provider
    """
    client = None

    try:
        # Try to use provider integration first
        integration = get_provider_integration() if PROVIDER_INTEGRATION_AVAILABLE else None
        
        if integration and integration._initialized:
            # Use clean provider system
            logger.debug("Using clean provider integration for LLM client")
            
            if provider:
                provider_name = provider
            else:
                service = 'embeddings' if use_embedding_provider else 'rag_agent'
                provider_name = await integration.get_provider_for_service(service)
            
            api_key = await integration.get_api_key(provider_name)
            base_url = integration.get_provider_base_url(provider_name)
            
        else:
            # Fall back to legacy credential service
            logger.debug("Using legacy credential service for LLM client")
            
            # Get provider configuration from database settings
            if provider:
                # Explicit provider requested - get minimal config
                provider_name = provider
                api_key = await credential_service._get_provider_api_key(provider)

                # Check cache for rag_settings
                cache_key = "rag_strategy_settings"
                rag_settings = _get_cached_settings(cache_key)
                if rag_settings is None:
                    rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
                    _set_cached_settings(cache_key, rag_settings)
                    logger.debug("Fetched and cached rag_strategy settings")
                else:
                    logger.debug("Using cached rag_strategy settings")

                base_url = credential_service._get_provider_base_url(provider, rag_settings)
            else:
                # Get configured provider from database
                service_type = "embedding" if use_embedding_provider else "llm"

                # Check cache for provider config
                cache_key = f"provider_config_{service_type}"
                provider_config = _get_cached_settings(cache_key)
                if provider_config is None:
                    provider_config = await credential_service.get_active_provider(service_type)
                    _set_cached_settings(cache_key, provider_config)
                    logger.debug(f"Fetched and cached {service_type} provider config")
                else:
                    logger.debug(f"Using cached {service_type} provider config")

                provider_name = provider_config["provider"]
                api_key = provider_config["api_key"]
                base_url = provider_config["base_url"]

        logger.info(f"Creating LLM client for provider: {provider_name}")

        if provider_name == "openai":
            if not api_key:
                raise ValueError("OpenAI API key not found")

            client = openai.AsyncOpenAI(api_key=api_key)

        elif provider_name == "ollama":
            # Ollama uses OpenAI-compatible API but doesn't require API key
            if not base_url:
                base_url = "http://host.docker.internal:11434/v1"
                logger.info(f"Using default Ollama base URL: {base_url}")

            client = openai.AsyncOpenAI(base_url=base_url, api_key="not-needed")

        elif provider_name == "google" or provider_name == "gemini":
            if not api_key:
                raise ValueError("Google API key not found")

            # Google requires a specific base URL for their OpenAI-compatible endpoint
            base_url = "https://generativelanguage.googleapis.com/v1beta/openai/"
            client = openai.AsyncOpenAI(base_url=base_url, api_key=api_key)

        else:
            raise ValueError(f"Unsupported provider: {provider_name}")

        yield client

    except Exception as e:
        logger.error(f"Error creating LLM client: {e}")
        raise

    finally:
        # Cleanup if needed
        if client:
            await client.close()


async def get_embedding_model(provider: str | None = None) -> str:
    """
    Get the configured embedding model based on the provider.

    Args:
        provider: Override provider selection

    Returns:
        str: The embedding model to use
    """
    try:
        # Try to use provider integration first
        integration = get_provider_integration() if PROVIDER_INTEGRATION_AVAILABLE else None
        
        if integration and integration._initialized:
            logger.debug("Using clean provider integration for embedding model")
            return await integration.get_embedding_model(provider)
        
        # Fall back to legacy system
        logger.debug("Using legacy system for embedding model")
        
        # Get provider configuration
        if provider:
            # Explicit provider requested
            provider_name = provider
            # Get custom model from settings if any
            cache_key = "rag_strategy_settings"
            rag_settings = _get_cached_settings(cache_key)
            if rag_settings is None:
                rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
                _set_cached_settings(cache_key, rag_settings)

            custom_model = rag_settings.get("embedding_model") if rag_settings else None
        else:
            # Get configured provider from database
            cache_key = "provider_config_embedding"
            provider_config = _get_cached_settings(cache_key)
            if provider_config is None:
                provider_config = await credential_service.get_active_provider("embedding")
                _set_cached_settings(cache_key, provider_config)

            provider_name = provider_config["provider"]
            custom_model = provider_config.get("custom_model")

        # Return model based on provider
        if provider_name == "openai":
            # Use custom model if specified, otherwise default
            return custom_model or "text-embedding-3-small"
        elif provider_name == "ollama":
            # Ollama embedding models
            return custom_model or "nomic-embed-text"
        elif provider_name == "google" or provider_name == "gemini":
            # Google embedding models
            return custom_model or "text-embedding-004"
        else:
            # Default to OpenAI model
            return "text-embedding-3-small"

    except Exception as e:
        logger.error(f"Error getting embedding model: {e}")
        # Return default model on error
        return "text-embedding-3-small"


async def get_llm_model(provider: str | None = None, service: str = "rag_agent") -> str:
    """
    Get the configured LLM model based on the provider.

    Args:
        provider: Override provider selection
        service: Service requesting the model (for provider integration)

    Returns:
        str: The LLM model to use
    """
    try:
        # Try to use provider integration first
        integration = get_provider_integration() if PROVIDER_INTEGRATION_AVAILABLE else None
        
        if integration and integration._initialized:
            logger.debug(f"Using clean provider integration for LLM model (service: {service})")
            return await integration.get_llm_model(service)
        
        # Fall back to legacy system
        logger.debug("Using legacy system for LLM model")
        
        # Get provider configuration
        if provider:
            # Explicit provider requested
            provider_name = provider
            # Get custom model from settings if any
            cache_key = "rag_strategy_settings"
            rag_settings = _get_cached_settings(cache_key)
            if rag_settings is None:
                rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
                _set_cached_settings(cache_key, rag_settings)

            custom_model = rag_settings.get("llm_model") if rag_settings else None
        else:
            # Get configured provider from database
            cache_key = "provider_config_llm"
            provider_config = _get_cached_settings(cache_key)
            if provider_config is None:
                provider_config = await credential_service.get_active_provider("llm")
                _set_cached_settings(cache_key, provider_config)

            provider_name = provider_config["provider"]
            custom_model = provider_config.get("custom_model")

        # Return model based on provider
        if provider_name == "openai":
            # Use custom model if specified, otherwise default
            return custom_model or "gpt-4o-mini"
        elif provider_name == "ollama":
            # Ollama models
            return custom_model or "llama3.2"
        elif provider_name == "google" or provider_name == "gemini":
            # Google models
            return custom_model or "gemini-1.5-flash"
        else:
            # Default to OpenAI model
            return "gpt-4o-mini"

    except Exception as e:
        logger.error(f"Error getting LLM model: {e}")
        # Return default model on error
        return "gpt-4o-mini"