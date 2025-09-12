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
            logger.info("OpenAI client created successfully")

        elif provider_name == "ollama":
            # Ollama requires an API key in the client but doesn't actually use it
            client = openai.AsyncOpenAI(
                api_key="ollama",  # Required but unused by Ollama
                base_url=base_url or "http://localhost:11434/v1",
            )
            logger.info(f"Ollama client created successfully with base URL: {base_url}")

        elif provider_name == "google":
            if not api_key:
                raise ValueError("Google API key not found")

            client = openai.AsyncOpenAI(
                api_key=api_key,
                base_url=base_url or "https://generativelanguage.googleapis.com/v1beta/openai/",
            )
            logger.info("Google Gemini client created successfully")

        elif provider_name == "azure-openai":
            if not api_key:
                raise ValueError("Azure OpenAI API key not found")
            
            if not base_url:
                raise ValueError("Azure OpenAI endpoint URL not found")

            # Get Azure API version from settings, default to stable version
            if provider:
                # Explicit provider requested - get from rag_settings
                api_version = credential_service._get_azure_api_version(rag_settings)
            else:
                # Get from cached provider config
                cache_key = "rag_strategy_settings"
                rag_settings_for_version = _get_cached_settings(cache_key)
                if rag_settings_for_version is None:
                    rag_settings_for_version = await credential_service.get_credentials_by_category("rag_strategy")
                    _set_cached_settings(cache_key, rag_settings_for_version)
                api_version = credential_service._get_azure_api_version(rag_settings_for_version)

            client = openai.AsyncOpenAI(
                api_key=api_key,
                azure_endpoint=base_url,
                api_version=api_version
            )
            logger.info(f"Azure OpenAI client created successfully with endpoint: {base_url}, API version: {api_version}")

        else:
            raise ValueError(f"Unsupported LLM provider: {provider_name}")

        yield client

    except Exception as e:
        logger.error(
            f"Error creating LLM client for provider {provider_name if 'provider_name' in locals() else 'unknown'}: {e}"
        )
        raise
    finally:
        # Cleanup if needed
        pass


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
            custom_model = rag_settings.get("EMBEDDING_MODEL", "")
        else:
            # Get configured provider from database
            cache_key = "provider_config_embedding"
            provider_config = _get_cached_settings(cache_key)
            if provider_config is None:
                provider_config = await credential_service.get_active_provider("embedding")
                _set_cached_settings(cache_key, provider_config)
            provider_name = provider_config["provider"]
            custom_model = provider_config["embedding_model"]

        # Use custom model if specified
        if custom_model:
            return custom_model

        # Return provider-specific defaults
        if provider_name == "openai":
            return "text-embedding-3-small"
        elif provider_name == "ollama":
            # Ollama default embedding model
            return "nomic-embed-text"
        elif provider_name == "google":
            # Google's embedding model
            return "text-embedding-004"
        elif provider_name == "azure-openai":
            # Azure OpenAI uses same embedding models as OpenAI
            return "text-embedding-3-small"
        else:
            # Fallback to OpenAI's model
            return "text-embedding-3-small"

    except Exception as e:
        logger.error(f"Error getting embedding model: {e}")
        # Fallback to OpenAI default
        return "text-embedding-3-small"
