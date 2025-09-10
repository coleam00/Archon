"""
LLM Provider Service - Database Only

Provides a unified interface for creating OpenAI-compatible clients for different LLM providers.
Uses the provider_clean system for all configuration management - DATABASE ONLY.
Supports OpenAI, Ollama, and Google Gemini.
"""

import os
import time
import httpx
from contextlib import asynccontextmanager
from typing import Any

import openai

from ..config.logfire_config import get_logger

logger = get_logger(__name__)

# Import credential service for tests
from .credential_service import credential_service

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


async def _get_api_key_from_database(provider: str) -> str:
    """
    Get API key directly from database using the working provider_clean services.
    
    Uses the exact same pattern as the successful API endpoints.
    """
    try:
        # Use the working pattern: call the internal FastAPI app services
        # The app.state services are initialized in main.py with working cipher
        from starlette.applications import Starlette
        from fastapi import FastAPI
        
        # Access the app context to get initialized services
        # This is a bit of a hack, but it uses the working services
        import asyncio
        
        # Get the current running app instance that has working services
        current_task = asyncio.current_task()
        if hasattr(current_task, '_context') and current_task._context:
            # Try to access FastAPI app state if available
            pass
            
        # Alternative: Direct database access using the same exact pattern as working code
        from ...providers_clean.infrastructure.dependencies import get_supabase_client, get_encryption_cipher  
        from ...providers_clean.infrastructure.repositories.supabase.api_key_repository import SupabaseApiKeyRepository
        
        # Use exact same initialization as working endpoints
        db = get_supabase_client()
        cipher = get_encryption_cipher()
        
        # Create repository directly (skip Unit of Work complexity)
        api_key_repo = SupabaseApiKeyRepository(db, cipher)
        
        # Get the key data directly
        key_data = await api_key_repo.get_key(provider)
        if not key_data:
            raise ValueError(f"API key for provider '{provider}' not found in database")
            
        # Decrypt the key directly
        encrypted_key = key_data.get("encrypted_key")
        if not encrypted_key:
            raise ValueError(f"No encrypted key data for provider '{provider}'")
            
        try:
            decrypted_key = cipher.decrypt(encrypted_key.encode()).decode()
            logger.info(f"Successfully decrypted API key for provider '{provider}'")
            return decrypted_key
        except Exception as decrypt_error:
            raise ValueError(f"Failed to decrypt API key for provider '{provider}': {decrypt_error}")
            
    except Exception as e:
        logger.error(f"Database API key access failed for {provider}: {e}")
        raise


async def _get_provider_config(service_name: str) -> dict[str, Any]:
    """Get provider configuration from database only."""
    cache_key = f"provider_config_{service_name}"
    config = _get_cached_settings(cache_key)
    
    if config is not None:
        return config
    
    try:
        server_port = os.getenv("ARCHON_SERVER_PORT", "8181")
        
        async with httpx.AsyncClient() as client:
            # Get service configuration via API
            service_response = await client.get(
                f"http://localhost:{server_port}/api/providers/services/{service_name}"
            )
            if service_response.status_code != 200:
                raise ValueError(f"Service '{service_name}' not found")
                
            service_config = service_response.json()
            
            # Extract provider and model  
            default_model = service_config.get("default_model")
            if not default_model or ":" not in default_model:
                raise ValueError(f"Invalid default_model '{default_model}' for service '{service_name}'")
                
            provider, model = default_model.split(":", 1)
            
            # Get API key from database only
            api_key = await _get_api_key_from_database(provider)
            
            # Base URL mapping
            base_urls = {
                "google": "https://generativelanguage.googleapis.com/v1beta/openai/",
                "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/", 
                "ollama": "http://host.docker.internal:11434/v1"
            }
            
            config = {
                "provider": provider,
                "model": model,
                "api_key": api_key,
                "base_url": base_urls.get(provider),
                "service_config": service_config
            }
            
            _set_cached_settings(cache_key, config)
            return config
            
    except Exception as e:
        logger.error(f"Provider config failed for {service_name}: {e}")
        raise ValueError(f"Cannot get provider config for {service_name}: {str(e)}")


@asynccontextmanager
async def get_llm_client(provider: str | None = None, use_embedding_provider: bool = False):
    """
    Create an async OpenAI-compatible client - DATABASE ONLY for API keys.

    Args:
        provider: Override provider selection
        use_embedding_provider: Use the embedding-specific provider if different

    Yields:
        openai.AsyncOpenAI: An OpenAI-compatible client configured for the selected provider
    """
    client = None

    try:
        if provider:
            # Explicit provider requested - get API key from database
            provider_name = provider
            api_key = await _get_api_key_from_database(provider)
            
            # Base URL mapping
            base_urls = {
                "google": "https://generativelanguage.googleapis.com/v1beta/openai/",
                "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
                "ollama": "http://host.docker.internal:11434/v1"
            }
            base_url = base_urls.get(provider)
                
        else:
            # Get configured provider from provider_clean system
            service_name = "embedding" if use_embedding_provider else "llm_primary"
            config = await _get_provider_config(service_name)
            
            provider_name = config["provider"]
            api_key = config["api_key"]
            base_url = config["base_url"]

        # Create OpenAI-compatible client with strict validation
        if provider_name == "openai":
            if not api_key:
                raise ValueError(f"OpenAI API key not found in database")
            client = openai.AsyncOpenAI(api_key=api_key)

        elif provider_name == "ollama":
            # Ollama uses OpenAI-compatible API but doesn't require API key
            if not base_url:
                base_url = "http://host.docker.internal:11434/v1"
            client = openai.AsyncOpenAI(base_url=base_url, api_key="not-needed")

        elif provider_name == "google" or provider_name == "gemini":
            if not api_key:
                raise ValueError(f"Google API key not found in database")
            if not base_url:
                base_url = "https://generativelanguage.googleapis.com/v1beta/openai/"
            client = openai.AsyncOpenAI(base_url=base_url, api_key=api_key)

        else:
            raise ValueError(f"Unsupported provider '{provider_name}'. Supported: openai, google, gemini, ollama")

        yield client

    except Exception as e:
        logger.error(f"Error creating LLM client: {e}")
        raise

    finally:
        # Cleanup if needed
        if client:
            await client.close()


async def get_embedding_model(provider: str | None = None) -> str:
    """Get the configured embedding model from database only."""
    try:
        if provider:
            # For explicit provider, get from service registry
            config = await _get_provider_config("embedding")
            if config["provider"] == provider:
                return config["model"]
            else:
                raise ValueError(f"Provider mismatch: service uses '{config['provider']}', requested '{provider}'")
        else:
            # Get configured embedding service
            config = await _get_provider_config("embedding")
            return config["model"]

    except Exception as e:
        logger.error(f"Error getting embedding model: {e}")
        raise


async def get_llm_model(provider: str | None = None, service: str = "llm_primary") -> str:
    """Get the configured LLM model from database only."""
    try:
        if provider:
            # For explicit provider, get from service registry
            config = await _get_provider_config(service)
            if config["provider"] == provider:
                return config["model"]
            else:
                raise ValueError(f"Provider mismatch: service uses '{config['provider']}', requested '{provider}'")
        else:
            # Get configured LLM service
            config = await _get_provider_config(service)
            return config["model"]

    except Exception as e:
        logger.error(f"Error getting LLM model: {e}")
        raise