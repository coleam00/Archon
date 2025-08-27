"""
LLM Provider Service

Provides a unified interface for creating OpenAI-compatible clients for different LLM providers.
Supports OpenAI, Ollama, and Google Gemini.
"""

import time
from contextlib import asynccontextmanager
from typing import Any

import openai

from ..config.logfire_config import get_logger
from .credential_service import credential_service

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

            provider_name = provider_config["provider"]
            api_key = provider_config["api_key"]
            base_url = provider_config["base_url"]

        if provider_name == "openai":
            if not api_key:
                raise ValueError("OpenAI API key not found")
            client = openai.AsyncOpenAI(api_key=api_key)

        elif provider_name == "ollama":
            # Ollama uses OpenAI-compatible API but doesn't require API key
            if not base_url:
                base_url = "http://host.docker.internal:11434/v1"
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

        # Return model based on provider - no defaults
        if not custom_model:
            raise ValueError(f"No embedding model configured for provider '{provider_name}'. Please configure in Settings.")
        
        return custom_model

    except Exception as e:
        logger.error(f"Error getting embedding model: {e}")
        raise


async def get_llm_model(provider: str | None = None, service: str = "rag_agent") -> str:
    """
    Get the configured LLM model based on the provider.

    Args:
        provider: Override provider selection
        service: Service requesting the model (for future use)

    Returns:
        str: The LLM model to use
    """
    try:
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

        # Return model - no defaults
        if not custom_model:
            raise ValueError(f"No LLM model configured for provider '{provider_name}' and service '{service}'. Please configure in Settings.")
        
        return custom_model

    except Exception as e:
        logger.error(f"Error getting LLM model: {e}")
        raise