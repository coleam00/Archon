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
async def get_llm_client(provider: str | None = None, use_embedding_provider: bool = False,
                        instance_type: str | None = None, base_url: str | None = None):
    """
    Create an async OpenAI-compatible client based on the configured provider.

    This context manager handles client creation for different LLM providers
    that support the OpenAI API format, with enhanced support for multi-instance
    Ollama configurations and intelligent instance routing.

    Args:
        provider: Override provider selection
        use_embedding_provider: Use the embedding-specific provider if different
        instance_type: For Ollama multi-instance: 'chat', 'embedding', or None for auto-select
        base_url: Override base URL for specific instance routing

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

            # For Ollama, don't use the base_url from config - let _get_optimal_ollama_instance decide
            base_url = credential_service._get_provider_base_url(provider, rag_settings) if provider != "ollama" else None
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
            # For Ollama, don't use the base_url from config - let _get_optimal_ollama_instance decide
            base_url = provider_config["base_url"] if provider_name != "ollama" else None

        logger.info(f"Creating LLM client for provider: {provider_name}")

        if provider_name == "openai":
            if not api_key:
                # Check if Ollama instances are available as fallback
                logger.warning("OpenAI API key not found, attempting Ollama fallback")
                try:
                    # Try to get an optimal Ollama instance for fallback
                    ollama_base_url = await _get_optimal_ollama_instance(
                        instance_type="embedding" if use_embedding_provider else "chat",
                        use_embedding_provider=use_embedding_provider
                    )
                    if ollama_base_url:
                        logger.info(f"Falling back to Ollama instance: {ollama_base_url}")
                        provider_name = "ollama"
                        api_key = "ollama"  # Ollama doesn't need a real API key
                        base_url = ollama_base_url
                        # Create Ollama client after fallback
                        client = openai.AsyncOpenAI(
                            api_key="ollama",
                            base_url=ollama_base_url,
                        )
                        logger.info(f"Ollama fallback client created successfully with base URL: {ollama_base_url}")
                    else:
                        raise ValueError("OpenAI API key not found and no Ollama instances available")
                except Exception as ollama_error:
                    logger.error(f"Ollama fallback failed: {ollama_error}")
                    raise ValueError("OpenAI API key not found and Ollama fallback failed") from ollama_error
            else:
                # Only create OpenAI client if we have an API key (didn't fallback to Ollama)
                client = openai.AsyncOpenAI(api_key=api_key)
                logger.info("OpenAI client created successfully")

        elif provider_name == "ollama":
            # Enhanced Ollama client creation with multi-instance support
            ollama_base_url = await _get_optimal_ollama_instance(
                instance_type=instance_type,
                use_embedding_provider=use_embedding_provider,
                base_url_override=base_url
            )

            # Ollama requires an API key in the client but doesn't actually use it
            client = openai.AsyncOpenAI(
                api_key="ollama",  # Required but unused by Ollama
                base_url=ollama_base_url,
            )
            logger.info(f"Ollama client created successfully with base URL: {ollama_base_url}")

        elif provider_name == "google":
            if not api_key:
                raise ValueError("Google API key not found")

            client = openai.AsyncOpenAI(
                api_key=api_key,
                base_url=base_url or "https://generativelanguage.googleapis.com/v1beta/openai/",
            )
            logger.info("Google Gemini client created successfully")

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


async def _get_optimal_ollama_instance(instance_type: str | None = None,
                                       use_embedding_provider: bool = False,
                                       base_url_override: str | None = None) -> str:
    """
    Get the optimal Ollama instance URL based on configuration and health status.
    
    Args:
        instance_type: Preferred instance type ('chat', 'embedding', 'both', or None)
        use_embedding_provider: Whether this is for embedding operations
        base_url_override: Override URL if specified
        
    Returns:
        Best available Ollama instance URL
    """
    # If override URL provided, use it directly
    if base_url_override:
        return base_url_override if base_url_override.endswith('/v1') else f"{base_url_override}/v1"

    try:
        # For now, we don't have multi-instance support, so skip to single instance config
        # TODO: Implement get_ollama_instances() method in CredentialService for multi-instance support
        logger.info("Using single instance Ollama configuration")

        # Get single instance configuration from RAG settings
        rag_settings = await credential_service.get_credentials_by_category("rag_strategy")

        # Check if we need embedding provider and have separate embedding URL
        if use_embedding_provider or instance_type == "embedding":
            embedding_url = rag_settings.get("OLLAMA_EMBEDDING_URL")
            if embedding_url:
                return embedding_url if embedding_url.endswith('/v1') else f"{embedding_url}/v1"

        # Default to LLM base URL for chat operations
        fallback_url = rag_settings.get("LLM_BASE_URL", "http://host.docker.internal:11434")
        return fallback_url if fallback_url.endswith('/v1') else f"{fallback_url}/v1"

    except Exception as e:
        logger.error(f"Error getting Ollama configuration: {e}")
        # Final fallback to localhost only if we can't get RAG settings
        try:
            rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
            fallback_url = rag_settings.get("LLM_BASE_URL", "http://host.docker.internal:11434")
            return fallback_url if fallback_url.endswith('/v1') else f"{fallback_url}/v1"
        except Exception as fallback_error:
            logger.error(f"Could not retrieve fallback configuration: {fallback_error}")
            return "http://host.docker.internal:11434/v1"


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
        else:
            # Fallback to OpenAI's model
            return "text-embedding-3-small"

    except Exception as e:
        logger.error(f"Error getting embedding model: {e}")
        # Fallback to OpenAI default
        return "text-embedding-3-small"


async def get_embedding_model_with_routing(provider: str | None = None, instance_url: str | None = None) -> tuple[str, str]:
    """
    Get the embedding model with intelligent routing for multi-instance setups.
    
    Args:
        provider: Override provider selection
        instance_url: Specific instance URL to use
        
    Returns:
        Tuple of (model_name, instance_url) for embedding operations
    """
    try:
        # Get base embedding model
        model_name = await get_embedding_model(provider)

        # If specific instance URL provided, use it
        if instance_url:
            final_url = instance_url if instance_url.endswith('/v1') else f"{instance_url}/v1"
            return model_name, final_url

        # For Ollama provider, use intelligent instance routing
        if provider == "ollama" or (not provider and (await credential_service.get_credentials_by_category("rag_strategy")).get("LLM_PROVIDER") == "ollama"):
            optimal_url = await _get_optimal_ollama_instance(
                instance_type="embedding",
                use_embedding_provider=True
            )
            return model_name, optimal_url

        # For other providers, return model with None URL (use default)
        return model_name, None

    except Exception as e:
        logger.error(f"Error getting embedding model with routing: {e}")
        return "text-embedding-3-small", None


async def validate_provider_instance(provider: str, instance_url: str | None = None) -> dict[str, any]:
    """
    Validate a provider instance and return health information.
    
    Args:
        provider: Provider name (openai, ollama, google, etc.)
        instance_url: Instance URL for providers that support multiple instances
        
    Returns:
        Dictionary with validation results and health status
    """
    try:
        if provider == "ollama":
            # Use the Ollama model discovery service for health checking
            from .ollama.model_discovery_service import model_discovery_service

            # Use provided URL or get optimal instance
            if not instance_url:
                instance_url = await _get_optimal_ollama_instance()
                # Remove /v1 suffix for health checking
                if instance_url.endswith('/v1'):
                    instance_url = instance_url[:-3]

            health_status = await model_discovery_service.check_instance_health(instance_url)

            return {
                "provider": provider,
                "instance_url": instance_url,
                "is_available": health_status.is_healthy,
                "response_time_ms": health_status.response_time_ms,
                "models_available": health_status.models_available,
                "error_message": health_status.error_message,
                "validation_timestamp": time.time()
            }

        else:
            # For other providers, do basic validation
            async with get_llm_client(provider=provider) as client:
                # Try a simple operation to validate the provider
                start_time = time.time()

                if provider == "openai":
                    # List models to validate API key
                    models = await client.models.list()
                    model_count = len(models.data) if hasattr(models, 'data') else 0
                elif provider == "google":
                    # For Google, we can't easily list models, just validate client creation
                    model_count = 1  # Assume available if client creation succeeded
                else:
                    model_count = 1

                response_time = (time.time() - start_time) * 1000

                return {
                    "provider": provider,
                    "instance_url": instance_url,
                    "is_available": True,
                    "response_time_ms": response_time,
                    "models_available": model_count,
                    "error_message": None,
                    "validation_timestamp": time.time()
                }

    except Exception as e:
        logger.error(f"Error validating provider {provider}: {e}")
        return {
            "provider": provider,
            "instance_url": instance_url,
            "is_available": False,
            "response_time_ms": None,
            "models_available": 0,
            "error_message": str(e),
            "validation_timestamp": time.time()
        }
