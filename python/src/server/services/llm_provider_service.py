"""
LLM Provider Service

Provides a unified interface for creating OpenAI-compatible clients for different LLM providers.
Supports OpenAI, Ollama, and Google Gemini.
"""

import inspect
import time
from contextlib import asynccontextmanager
from typing import Any

import openai

from ..config.logfire_config import get_logger
from .credential_service import credential_service

logger = get_logger(__name__)


# Basic validation functions to avoid circular imports
def _is_valid_provider(provider: str) -> bool:
    """Basic provider validation."""
    if not provider or not isinstance(provider, str):
        return False
    return provider.lower() in {"openai", "ollama", "google", "openrouter", "anthropic", "grok"}


def _sanitize_for_log(text: str) -> str:
    """Basic text sanitization for logging."""
    if not text:
        return ""
    import re
    sanitized = re.sub(r"sk-[a-zA-Z0-9-_]{20,}", "[REDACTED]", text)
    sanitized = re.sub(r"xai-[a-zA-Z0-9-_]{20,}", "[REDACTED]", sanitized)
    return sanitized[:100]


# Secure settings cache with TTL and validation
_settings_cache: dict[str, tuple[Any, float, str]] = {}  # value, timestamp, checksum
_CACHE_TTL_SECONDS = 300  # 5 minutes
_cache_access_log: list[dict] = []  # Track cache access patterns for security monitoring


def _calculate_cache_checksum(value: Any) -> str:
    """Calculate checksum for cache entry integrity validation."""
    import hashlib
    import json

    # Convert value to JSON string for consistent hashing
    try:
        value_str = json.dumps(value, sort_keys=True, default=str)
        return hashlib.sha256(value_str.encode()).hexdigest()[:16]  # First 16 chars for efficiency
    except Exception:
        # Fallback for non-serializable objects
        return hashlib.sha256(str(value).encode()).hexdigest()[:16]


def _log_cache_access(key: str, action: str, hit: bool = None, security_event: str = None) -> None:
    """Log cache access for security monitoring."""

    access_entry = {
        "timestamp": time.time(),
        "key": _sanitize_for_log(key),
        "action": action,  # "get", "set", "invalidate", "clear"
        "hit": hit,  # For get operations
        "security_event": security_event  # "checksum_mismatch", "expired", etc.
    }

    # Keep only last 100 access entries to prevent memory growth
    _cache_access_log.append(access_entry)
    if len(_cache_access_log) > 100:
        _cache_access_log.pop(0)

    # Log security events at warning level
    if security_event:
        safe_key = _sanitize_for_log(key)
        logger.warning(f"Cache security event: {security_event} for key '{safe_key}'")


def _get_cached_settings(key: str) -> Any | None:
    """Get cached settings if not expired and valid."""

    try:
        if key in _settings_cache:
            value, timestamp, stored_checksum = _settings_cache[key]
            current_time = time.time()

            # Check expiration with strict TTL enforcement
            if current_time - timestamp >= _CACHE_TTL_SECONDS:
                # Expired, remove from cache
                del _settings_cache[key]
                _log_cache_access(key, "get", hit=False, security_event="expired")
                return None

            # Verify cache entry integrity
            current_checksum = _calculate_cache_checksum(value)
            if current_checksum != stored_checksum:
                # Cache tampering detected, remove entry
                del _settings_cache[key]
                _log_cache_access(key, "get", hit=False, security_event="checksum_mismatch")
                logger.error(f"Cache integrity violation detected for key: {_sanitize_for_log(key)}")
                return None

            # Additional validation for provider configurations
            if "provider_config" in key and isinstance(value, dict):
                # Basic validation: check required fields
                if not value.get("provider") or not _is_valid_provider(value.get("provider")):
                    # Invalid configuration in cache, remove it
                    del _settings_cache[key]
                    _log_cache_access(key, "get", hit=False, security_event="invalid_config")
                    return None

            _log_cache_access(key, "get", hit=True)
            return value

        _log_cache_access(key, "get", hit=False)
        return None

    except Exception as e:
        # Cache access error, log and return None for safety
        _log_cache_access(key, "get", hit=False, security_event=f"access_error: {str(e)}")
        return None


def _set_cached_settings(key: str, value: Any) -> None:
    """Cache settings with current timestamp and integrity checksum."""

    try:
        # Validate provider configurations before caching
        if "provider_config" in key and isinstance(value, dict):
            # Basic validation: check required fields
            if not value.get("provider") or not _is_valid_provider(value.get("provider")):
                _log_cache_access(key, "set", security_event="invalid_config_rejected")
                logger.warning(f"Rejected caching of invalid provider config for key: {_sanitize_for_log(key)}")
                return

        # Calculate integrity checksum
        checksum = _calculate_cache_checksum(value)

        # Store with timestamp and checksum
        _settings_cache[key] = (value, time.time(), checksum)
        _log_cache_access(key, "set")

    except Exception as e:
        _log_cache_access(key, "set", security_event=f"set_error: {str(e)}")
        logger.error(f"Failed to cache settings for key {_sanitize_for_log(key)}: {e}")


def clear_provider_cache() -> None:
    """Clear the provider configuration cache to force refresh on next request."""
    global _settings_cache

    cache_size_before = len(_settings_cache)
    _settings_cache.clear()
    _log_cache_access("*", "clear")
    logger.debug(f"Provider configuration cache cleared ({cache_size_before} entries removed)")


def invalidate_provider_cache(provider: str = None) -> None:
    """
    Invalidate specific provider cache entries or all cache entries.

    Args:
        provider: Optional provider name to invalidate. If None, clears all cache.
    """
    global _settings_cache

    if provider is None:
        # Clear entire cache
        cache_size_before = len(_settings_cache)
        _settings_cache.clear()
        _log_cache_access("*", "invalidate")
        logger.debug(f"All provider cache entries invalidated ({cache_size_before} entries)")
    else:
        # Validate provider name before processing
        if not _is_valid_provider(provider):
            _log_cache_access(provider, "invalidate", security_event="invalid_provider_name")
            logger.warning(f"Rejected cache invalidation for invalid provider: {_sanitize_for_log(provider)}")
            return

        # Clear specific provider entries
        keys_to_remove = []
        for key in _settings_cache.keys():
            if provider in key:
                keys_to_remove.append(key)

        for key in keys_to_remove:
            del _settings_cache[key]
            _log_cache_access(key, "invalidate")

        safe_provider = _sanitize_for_log(provider)
        logger.debug(f"Cache entries for provider '{safe_provider}' invalidated: {len(keys_to_remove)} entries removed")


def get_cache_stats() -> dict[str, Any]:
    """
    Get cache statistics with security metrics for monitoring and debugging.

    Returns:
        Dictionary containing cache statistics and security metrics
    """
    global _settings_cache, _cache_access_log
    current_time = time.time()

    stats = {
        "total_entries": len(_settings_cache),
        "fresh_entries": 0,
        "stale_entries": 0,
        "cache_hit_potential": 0.0,
        "security_metrics": {
            "integrity_violations": 0,
            "expired_access_attempts": 0,
            "invalid_config_rejections": 0,
            "access_errors": 0,
            "total_security_events": 0
        },
        "access_patterns": {
            "recent_cache_hits": 0,
            "recent_cache_misses": 0,
            "hit_rate": 0.0
        }
    }

    # Analyze cache entries
    for _key, (_value, timestamp, _checksum) in _settings_cache.items():
        age = current_time - timestamp
        if age < _CACHE_TTL_SECONDS:
            stats["fresh_entries"] += 1
        else:
            stats["stale_entries"] += 1

    if stats["total_entries"] > 0:
        stats["cache_hit_potential"] = stats["fresh_entries"] / stats["total_entries"]

    # Analyze security events from access log
    recent_threshold = current_time - 3600  # Last hour
    recent_hits = 0
    recent_misses = 0

    for access in _cache_access_log:
        if access["timestamp"] >= recent_threshold:
            if access["action"] == "get":
                if access["hit"]:
                    recent_hits += 1
                else:
                    recent_misses += 1

            # Count security events
            if access["security_event"]:
                stats["security_metrics"]["total_security_events"] += 1

                if "checksum_mismatch" in access["security_event"]:
                    stats["security_metrics"]["integrity_violations"] += 1
                elif "expired" in access["security_event"]:
                    stats["security_metrics"]["expired_access_attempts"] += 1
                elif "invalid_config" in access["security_event"]:
                    stats["security_metrics"]["invalid_config_rejections"] += 1
                elif "error" in access["security_event"]:
                    stats["security_metrics"]["access_errors"] += 1

    # Calculate hit rate
    total_recent_access = recent_hits + recent_misses
    if total_recent_access > 0:
        stats["access_patterns"]["hit_rate"] = recent_hits / total_recent_access

    stats["access_patterns"]["recent_cache_hits"] = recent_hits
    stats["access_patterns"]["recent_cache_misses"] = recent_misses

    return stats


def get_cache_security_report() -> dict[str, Any]:
    """
    Get detailed security report for cache monitoring.

    Returns:
        Detailed security analysis of cache operations
    """
    global _cache_access_log
    current_time = time.time()

    report = {
        "timestamp": current_time,
        "analysis_period_hours": 1,
        "security_events": [],
        "recommendations": []
    }

    # Extract security events from last hour
    recent_threshold = current_time - 3600
    security_events = [
        access for access in _cache_access_log
        if access["timestamp"] >= recent_threshold and access["security_event"]
    ]

    report["security_events"] = security_events

    # Generate recommendations based on security events
    if len(security_events) > 10:
        report["recommendations"].append("High number of security events detected - investigate potential attacks")

    integrity_violations = sum(1 for event in security_events if "checksum_mismatch" in event.get("security_event", ""))
    if integrity_violations > 0:
        report["recommendations"].append(f"Cache integrity violations detected ({integrity_violations}) - check for memory corruption or attacks")

    invalid_configs = sum(1 for event in security_events if "invalid_config" in event.get("security_event", ""))
    if invalid_configs > 3:
        report["recommendations"].append(f"Multiple invalid configuration attempts ({invalid_configs}) - validate data sources")

    return report
@asynccontextmanager
async def get_llm_client(
    provider: str | None = None,
    use_embedding_provider: bool = False,
    instance_type: str | None = None,
    base_url: str | None = None,
):
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
    provider_name: str | None = None
    api_key = None

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
            base_url = (
                credential_service._get_provider_base_url(provider, rag_settings)
                if provider != "ollama"
                else None
            )
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

        # Comprehensive provider validation with security checks
        if not _is_valid_provider(provider_name):
            raise ValueError(f"Unsupported LLM provider: {provider_name}")

        # Validate API key format for security (prevent injection)
        if api_key:
            if len(api_key.strip()) == 0:
                api_key = None  # Treat empty strings as None
            elif len(api_key) > 500:  # Reasonable API key length limit
                raise ValueError("API key length exceeds security limits")
            # Additional security: check for suspicious patterns
            if any(char in api_key for char in ['\n', '\r', '\t', '\0']):
                raise ValueError("API key contains invalid characters")

        # Sanitize provider name for logging
        safe_provider_name = _sanitize_for_log(provider_name) if provider_name else "unknown"
        logger.info(f"Creating LLM client for provider: {safe_provider_name}")

        if provider_name == "openai":
            if api_key:
                client = openai.AsyncOpenAI(api_key=api_key)
                logger.info("OpenAI client created successfully")
            else:
                logger.warning("OpenAI API key not found, attempting Ollama fallback")
                try:
                    ollama_base_url = await _get_optimal_ollama_instance(
                        instance_type="embedding" if use_embedding_provider else "chat",
                        use_embedding_provider=use_embedding_provider,
                        base_url_override=base_url,
                    )

                    if not ollama_base_url:
                        raise RuntimeError("No Ollama base URL resolved")

                    client = openai.AsyncOpenAI(
                        api_key="ollama",
                        base_url=ollama_base_url,
                    )
                    logger.info(
                        f"Ollama fallback client created successfully with base URL: {ollama_base_url}"
                    )
                    provider_name = "ollama"
                    api_key = "ollama"
                    base_url = ollama_base_url
                except Exception as fallback_error:
                    raise ValueError(
                        "OpenAI API key not found and Ollama fallback failed"
                    ) from fallback_error

        elif provider_name == "ollama":
            # For Ollama, get the optimal instance based on usage
            ollama_base_url = await _get_optimal_ollama_instance(
                instance_type=instance_type,
                use_embedding_provider=use_embedding_provider,
                base_url_override=base_url,
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

        elif provider_name == "openrouter":
            if not api_key:
                raise ValueError("OpenRouter API key not found")

            client = openai.AsyncOpenAI(
                api_key=api_key,
                base_url=base_url or "https://openrouter.ai/api/v1",
            )
            logger.info("OpenRouter client created successfully")

        elif provider_name == "anthropic":
            if not api_key:
                raise ValueError("Anthropic API key not found")

            client = openai.AsyncOpenAI(
                api_key=api_key,
                base_url=base_url or "https://api.anthropic.com/v1",
            )
            logger.info("Anthropic client created successfully")

        elif provider_name == "grok":
            if not api_key:
                raise ValueError("Grok API key not found - set GROK_API_KEY environment variable")

            # Enhanced Grok API key validation (secure - no key fragments logged)
            key_format_valid = api_key.startswith("xai-")
            key_length_valid = len(api_key) >= 20

            if not key_format_valid:
                logger.warning("Grok API key format validation failed - should start with 'xai-'")

            if not key_length_valid:
                logger.warning("Grok API key validation failed - insufficient length")

            logger.debug(
                f"Grok API key validation: format_valid={key_format_valid}, length_valid={key_length_valid}"
            )

            client = openai.AsyncOpenAI(
                api_key=api_key,
                base_url=base_url or "https://api.x.ai/v1",
            )
            logger.info("Grok client created successfully")

        else:
            raise ValueError(f"Unsupported LLM provider: {provider_name}")

    except Exception as e:
        logger.error(
            f"Error creating LLM client for provider {provider_name if provider_name else 'unknown'}: {e}"
        )
        raise

    try:
        yield client
    finally:
        if client is not None:
            safe_provider = _sanitize_for_log(provider_name) if provider_name else "unknown"

            try:
                close_method = getattr(client, "aclose", None)
                if callable(close_method):
                    if inspect.iscoroutinefunction(close_method):
                        await close_method()
                    else:
                        maybe_coro = close_method()
                        if inspect.isawaitable(maybe_coro):
                            await maybe_coro
                else:
                    close_method = getattr(client, "close", None)
                    if callable(close_method):
                        if inspect.iscoroutinefunction(close_method):
                            await close_method()
                        else:
                            close_result = close_method()
                            if inspect.isawaitable(close_result):
                                await close_result
                logger.debug(f"Closed LLM client for provider: {safe_provider}")
            except RuntimeError as close_error:
                if "Event loop is closed" in str(close_error):
                    logger.error(
                        f"Failed to close LLM client cleanly for provider {safe_provider}: event loop already closed",
                        exc_info=True,
                    )
                else:
                    logger.error(
                        f"Runtime error closing LLM client for provider {safe_provider}: {close_error}",
                        exc_info=True,
                    )
            except Exception as close_error:
                logger.error(
                    f"Unexpected error while closing LLM client for provider {safe_provider}: {close_error}",
                    exc_info=True,
                )



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

        # Comprehensive provider validation for embeddings
        if not _is_valid_provider(provider_name):
            safe_provider = _sanitize_for_log(provider_name)
            logger.warning(f"Invalid embedding provider: {safe_provider}, falling back to OpenAI")
            provider_name = "openai"
        # Use custom model if specified (with validation)
        if custom_model and len(custom_model.strip()) > 0:
            custom_model = custom_model.strip()
            # Basic model name validation (check length and basic characters)
            if len(custom_model) <= 100 and not any(char in custom_model for char in ['\n', '\r', '\t', '\0']):
                return custom_model
            else:
                safe_model = _sanitize_for_log(custom_model)
                logger.warning(f"Invalid custom embedding model '{safe_model}' for provider '{provider_name}', using default")

        # Return provider-specific defaults
        if provider_name == "openai":
            return "text-embedding-3-small"
        elif provider_name == "ollama":
            # Ollama default embedding model
            return "nomic-embed-text"
        elif provider_name == "google":
            # Google's latest embedding model
            return "text-embedding-004"
        elif provider_name == "openrouter":
            # OpenRouter supports both OpenAI and Google embedding models
            # Default to OpenAI's latest for compatibility
            return "text-embedding-3-small"
        elif provider_name == "anthropic":
            # Anthropic supports OpenAI and Google embedding models through their API
            # Default to OpenAI's latest for compatibility
            return "text-embedding-3-small"
        elif provider_name == "grok":
            # Grok supports OpenAI and Google embedding models through their API
            # Default to OpenAI's latest for compatibility
            return "text-embedding-3-small"
        else:
            # Fallback to OpenAI's model
            return "text-embedding-3-small"

    except Exception as e:
        logger.error(f"Error getting embedding model: {e}")
        # Fallback to OpenAI default
        return "text-embedding-3-small"


def is_openai_embedding_model(model: str) -> bool:
    """Check if a model is an OpenAI embedding model."""
    if not model:
        return False

    model_lower = model.strip().lower()

    # Known OpenAI embeddings
    base_models = {
        "text-embedding-ada-002",
        "text-embedding-3-small",
        "text-embedding-3-large",
    }

    if model_lower in base_models:
        return True

    # Strip common vendor prefixes like "openai/" or "openrouter/"
    for separator in ("/", ":"):
        if separator in model_lower:
            candidate = model_lower.split(separator)[-1]
            if candidate in base_models:
                return True

    # Fallback substring detection for custom naming conventions
    return any(base in model_lower for base in base_models)


def is_google_embedding_model(model: str) -> bool:
    """Check if a model is a Google embedding model."""
    if not model:
        return False

    model_lower = model.lower()
    google_patterns = [
        "text-embedding-004",
        "text-embedding-005",
        "text-multilingual-embedding-002",
        "gemini-embedding-001",
        "multimodalembedding@001"
    ]

    return any(pattern in model_lower for pattern in google_patterns)


def is_valid_embedding_model_for_provider(model: str, provider: str) -> bool:
    """
    Validate if an embedding model is compatible with a provider.

    Args:
        model: The embedding model name
        provider: The provider name

    Returns:
        bool: True if the model is compatible with the provider
    """
    if not model or not provider:
        return False

    provider_lower = provider.lower()

    if provider_lower == "openai":
        return is_openai_embedding_model(model)
    elif provider_lower == "google":
        return is_google_embedding_model(model)
    elif provider_lower in ["openrouter", "anthropic", "grok"]:
        # These providers support both OpenAI and Google models
        return is_openai_embedding_model(model) or is_google_embedding_model(model)
    elif provider_lower == "ollama":
        # Ollama has its own models, check common ones
        model_lower = model.lower()
        ollama_patterns = ["nomic-embed", "all-minilm", "mxbai-embed", "embed"]
        return any(pattern in model_lower for pattern in ollama_patterns)
    else:
        # For unknown providers, assume OpenAI compatibility
        return is_openai_embedding_model(model)


def get_supported_embedding_models(provider: str) -> list[str]:
    """
    Get list of supported embedding models for a provider.

    Args:
        provider: The provider name

    Returns:
        List of supported embedding model names
    """
    if not provider:
        return []

    provider_lower = provider.lower()

    openai_models = [
        "text-embedding-ada-002",
        "text-embedding-3-small",
        "text-embedding-3-large"
    ]

    google_models = [
        "text-embedding-004",
        "text-embedding-005",
        "text-multilingual-embedding-002",
        "gemini-embedding-001",
        "multimodalembedding@001"
    ]

    if provider_lower == "openai":
        return openai_models
    elif provider_lower == "google":
        return google_models
    elif provider_lower in ["openrouter", "anthropic", "grok"]:
        # These providers support both OpenAI and Google models
        return openai_models + google_models
    elif provider_lower == "ollama":
        return ["nomic-embed-text", "all-minilm", "mxbai-embed-large"]
    else:
        # For unknown providers, assume OpenAI compatibility
        return openai_models


def is_reasoning_model(model_name: str) -> bool:
    """
    Unified check for reasoning models across providers.

    Normalizes vendor prefixes (openai/, openrouter/, x-ai/, deepseek/) before checking
    known reasoning families (OpenAI GPT-5, o1, o3; xAI Grok; DeepSeek-R; etc.).
    """
    if not model_name:
        return False

    model_lower = model_name.lower()

    # Normalize vendor prefixes (e.g., openai/gpt-5-nano, openrouter/x-ai/grok-4)
    if "/" in model_lower:
        parts = model_lower.split("/")
        # Drop known vendor prefixes while keeping the final model identifier
        known_prefixes = {"openai", "openrouter", "x-ai", "deepseek", "anthropic"}
        filtered_parts = [part for part in parts if part not in known_prefixes]
        if filtered_parts:
            model_lower = filtered_parts[-1]
        else:
            model_lower = parts[-1]

    if ":" in model_lower:
        model_lower = model_lower.split(":", 1)[-1]

    reasoning_prefixes = (
        "gpt-5",
        "o1",
        "o3",
        "o4",
        "grok",
        "deepseek-r",
        "deepseek-reasoner",
        "deepseek-chat-r",
    )

    return model_lower.startswith(reasoning_prefixes)


def _extract_reasoning_strings(value: Any) -> list[str]:
    """Convert reasoning payload fragments into plain-text strings."""

    if value is None:
        return []

    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []

    if isinstance(value, (list, tuple, set)):
        collected: list[str] = []
        for item in value:
            collected.extend(_extract_reasoning_strings(item))
        return collected

    if isinstance(value, dict):
        candidates = []
        for key in ("text", "summary", "content", "message", "value"):
            if value.get(key):
                candidates.extend(_extract_reasoning_strings(value[key]))
        # Some providers nest reasoning parts under "parts"
        if value.get("parts"):
            candidates.extend(_extract_reasoning_strings(value["parts"]))
        return candidates

    # Handle pydantic-style objects with attributes
    for attr in ("text", "summary", "content", "value"):
        if hasattr(value, attr):
            attr_value = getattr(value, attr)
            if attr_value:
                return _extract_reasoning_strings(attr_value)

    return []


def _get_message_attr(message: Any, attribute: str) -> Any:
    """Safely access message attributes that may be dict keys or properties."""

    if hasattr(message, attribute):
        return getattr(message, attribute)
    if isinstance(message, dict):
        return message.get(attribute)
    return None


def extract_message_text(choice: Any) -> tuple[str, str, bool]:
    """Extract primary content and reasoning text from a chat completion choice."""

    if not choice:
        return "", "", False

    message = _get_message_attr(choice, "message")
    if message is None:
        return "", "", False

    raw_content = _get_message_attr(message, "content")
    content_text = raw_content.strip() if isinstance(raw_content, str) else ""

    reasoning_fragments: list[str] = []
    for attr in ("reasoning", "reasoning_details", "reasoning_content"):
        reasoning_value = _get_message_attr(message, attr)
        if reasoning_value:
            reasoning_fragments.extend(_extract_reasoning_strings(reasoning_value))

    reasoning_text = "\n".join(fragment for fragment in reasoning_fragments if fragment)
    reasoning_text = reasoning_text.strip()

    # If content looks like reasoning text but no reasoning field, detect it
    if content_text and not reasoning_text and _is_reasoning_text(content_text):
        reasoning_text = content_text
        # Try to extract structured data from reasoning text
        extracted_json = extract_json_from_reasoning(content_text)
        if extracted_json:
            content_text = extracted_json
        else:
            content_text = ""

    if not content_text and reasoning_text:
        content_text = reasoning_text

    has_reasoning = bool(reasoning_text)

    return content_text, reasoning_text, has_reasoning


def _is_reasoning_text(text: str) -> bool:
    """Detect if text appears to be reasoning/thinking output rather than structured content."""
    if not text or len(text) < 10:
        return False

    text_lower = text.lower().strip()

    # Common reasoning text patterns
    reasoning_indicators = [
        "okay, let's see", "let me think", "first, i need to", "looking at this",
        "step by step", "analyzing", "breaking this down", "considering",
        "let me work through", "i should", "thinking about", "examining"
    ]

    return any(indicator in text_lower for indicator in reasoning_indicators)


def extract_json_from_reasoning(reasoning_text: str, context_code: str = "", language: str = "") -> str:
    """Extract JSON content from reasoning text, with synthesis fallback."""
    if not reasoning_text:
        return ""

    import json
    import re

    # Try to find JSON blocks in markdown
    json_block_pattern = r'```(?:json)?\s*(\{.*?\})\s*```'
    json_matches = re.findall(json_block_pattern, reasoning_text, re.DOTALL | re.IGNORECASE)

    for match in json_matches:
        try:
            # Validate it's proper JSON
            json.loads(match.strip())
            return match.strip()
        except json.JSONDecodeError:
            continue

    # Try to find standalone JSON objects
    json_pattern = r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}'
    json_matches = re.findall(json_pattern, reasoning_text, re.DOTALL)

    for match in json_matches:
        try:
            parsed = json.loads(match.strip())
            # Ensure it has expected structure
            if isinstance(parsed, dict) and any(key in parsed for key in ["example_name", "summary", "name", "title"]):
                return match.strip()
        except json.JSONDecodeError:
            continue

    # If no JSON found, synthesize from reasoning content
    return synthesize_json_from_reasoning(reasoning_text, context_code, language)


def synthesize_json_from_reasoning(reasoning_text: str, context_code: str = "", language: str = "") -> str:
    """Generate JSON structure from reasoning text when no JSON is found."""
    if not reasoning_text and not context_code:
        return ""

    import json
    import re

    # Extract key concepts and actions from reasoning text and code context
    text_lower = reasoning_text.lower() if reasoning_text else ""
    code_lower = context_code.lower() if context_code else ""
    combined_text = f"{text_lower} {code_lower}"

    # Common action patterns in reasoning text and code
    action_patterns = [
        (r'\b(?:parse|parsing|parsed)\b', 'Parse'),
        (r'\b(?:create|creating|created)\b', 'Create'),
        (r'\b(?:analyze|analyzing|analyzed)\b', 'Analyze'),
        (r'\b(?:extract|extracting|extracted)\b', 'Extract'),
        (r'\b(?:generate|generating|generated)\b', 'Generate'),
        (r'\b(?:process|processing|processed)\b', 'Process'),
        (r'\b(?:load|loading|loaded)\b', 'Load'),
        (r'\b(?:handle|handling|handled)\b', 'Handle'),
        (r'\b(?:manage|managing|managed)\b', 'Manage'),
        (r'\b(?:build|building|built)\b', 'Build'),
        (r'\b(?:define|defining|defined)\b', 'Define'),
        (r'\b(?:implement|implementing|implemented)\b', 'Implement'),
        (r'\b(?:fetch|fetching|fetched)\b', 'Fetch'),
        (r'\b(?:connect|connecting|connected)\b', 'Connect'),
        (r'\b(?:validate|validating|validated)\b', 'Validate'),
    ]

    # Technology/concept patterns
    tech_patterns = [
        (r'\bjson\b', 'JSON'),
        (r'\bapi\b', 'API'),
        (r'\bfile\b', 'File'),
        (r'\bdata\b', 'Data'),
        (r'\bcode\b', 'Code'),
        (r'\btext\b', 'Text'),
        (r'\bcontent\b', 'Content'),
        (r'\bresponse\b', 'Response'),
        (r'\brequest\b', 'Request'),
        (r'\bconfig\b', 'Config'),
        (r'\bllm\b', 'LLM'),
        (r'\bmodel\b', 'Model'),
        (r'\bexample\b', 'Example'),
        (r'\bcontext\b', 'Context'),
        (r'\basync\b', 'Async'),
        (r'\bfunction\b', 'Function'),
        (r'\bclass\b', 'Class'),
        (r'\bprint\b', 'Output'),
        (r'\breturn\b', 'Return'),
    ]

    # Extract actions and technologies from combined text
    detected_actions = []
    detected_techs = []

    for pattern, action in action_patterns:
        if re.search(pattern, combined_text):
            detected_actions.append(action)

    for pattern, tech in tech_patterns:
        if re.search(pattern, combined_text):
            detected_techs.append(tech)

    # Generate example name
    if detected_actions and detected_techs:
        example_name = f"{detected_actions[0]} {detected_techs[0]}"
    elif detected_actions:
        example_name = f"{detected_actions[0]} Code"
    elif detected_techs:
        example_name = f"Handle {detected_techs[0]}"
    elif language:
        example_name = f"Process {language.title()}"
    else:
        example_name = "Code Processing"

    # Limit to 4 words as per requirements
    example_name_words = example_name.split()
    if len(example_name_words) > 4:
        example_name = " ".join(example_name_words[:4])

    # Generate summary from reasoning content
    reasoning_lines = reasoning_text.split('\n')
    meaningful_lines = [line.strip() for line in reasoning_lines if line.strip() and len(line.strip()) > 10]

    if meaningful_lines:
        # Take first meaningful sentence for summary base
        first_line = meaningful_lines[0]
        if len(first_line) > 100:
            first_line = first_line[:100] + "..."

        # Create contextual summary
        if context_code and any(tech in text_lower for tech, _ in tech_patterns):
            summary = f"This code demonstrates {detected_techs[0].lower() if detected_techs else 'data'} processing functionality. {first_line}"
        else:
            summary = f"Code example showing {detected_actions[0].lower() if detected_actions else 'processing'} operations. {first_line}"
    else:
        # Fallback summary
        summary = f"Code example demonstrating {example_name.lower()} functionality for {language or 'general'} development."

    # Ensure summary is not too long
    if len(summary) > 300:
        summary = summary[:297] + "..."

    # Create JSON structure
    result = {
        "example_name": example_name,
        "summary": summary
    }

    return json.dumps(result)


def prepare_chat_completion_params(model: str, params: dict) -> dict:
    """
    Convert parameters for compatibility with reasoning models (GPT-5, o1, o3 series).

    OpenAI made several API changes for reasoning models:
    1. max_tokens → max_completion_tokens
    2. temperature must be 1.0 (default) - custom values not supported

    This ensures compatibility with OpenAI's API changes for newer models
    while maintaining backward compatibility for existing models.

    Args:
        model: The model name being used
        params: Dictionary of API parameters

    Returns:
        Dictionary with converted parameters for the model
    """
    if not model or not params:
        return params

    # Make a copy to avoid modifying the original
    updated_params = params.copy()

    reasoning_model = is_reasoning_model(model)

    # Convert max_tokens to max_completion_tokens for reasoning models
    if reasoning_model and "max_tokens" in updated_params:
        max_tokens_value = updated_params.pop("max_tokens")
        updated_params["max_completion_tokens"] = max_tokens_value
        logger.debug(f"Converted max_tokens to max_completion_tokens for model {model}")

    # Remove custom temperature for reasoning models (they only support default temperature=1.0)
    if reasoning_model and "temperature" in updated_params:
        original_temp = updated_params.pop("temperature")
        logger.debug(f"Removed custom temperature {original_temp} for reasoning model {model} (only supports default temperature=1.0)")

    return updated_params


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



def requires_max_completion_tokens(model_name: str) -> bool:
    """Backward compatible alias for previous API."""
    return is_reasoning_model(model_name)
