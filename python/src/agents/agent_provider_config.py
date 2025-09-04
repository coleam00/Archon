"""
Agent Provider Configuration

Handles OpenAI provider configuration for PydanticAI agents.
Enables custom base_url configuration for OpenAI-compatible endpoints.
"""

import logging
import os
from urllib.parse import urlparse

from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

logger = logging.getLogger(__name__)


def _validate_base_url(base_url: str) -> str:
    """
    Validate and normalize a base URL.
    
    Args:
        base_url: The base URL to validate
        
    Returns:
        The validated and normalized base URL
        
    Raises:
        ValueError: If the URL is invalid or unsafe
    """
    if not base_url or not base_url.strip():
        raise ValueError("Base URL cannot be empty")

    # Normalize the URL (trim whitespace)
    url = base_url.strip()

    # Parse the URL to validate its structure
    try:
        parsed = urlparse(url)
    except Exception as e:
        raise ValueError(f"Invalid URL format: {e}")

    # Ensure it has a valid scheme
    if not parsed.scheme:
        raise ValueError("Base URL must include a scheme (http:// or https://)")

    if parsed.scheme not in ['http', 'https']:
        raise ValueError("Base URL must use http:// or https:// scheme")

    # Ensure it has a valid hostname
    if not parsed.hostname:
        raise ValueError("Base URL must include a valid hostname")

    # Log security consideration for non-HTTPS URLs
    if parsed.scheme == 'http' and not parsed.hostname.startswith(('localhost', '127.0.0.1', '0.0.0.0')):
        logger.warning(f"Using non-HTTPS URL for OpenAI base URL: {url}. Consider using HTTPS for production.")

    return url


async def get_configured_openai_model(model_name: str) -> OpenAIChatModel | str:
    """
    Get a configured OpenAI model for PydanticAI agents.
    
    If OPENAI_BASE_URL is configured in the system, returns an OpenAIChatModel
    with a custom OpenAIProvider. Otherwise, returns the standard model string
    format that PydanticAI handles automatically.
    
    Args:
        model_name: The model name (e.g., "gpt-4o", "gpt-4o-mini")
        
    Returns:
        Either an OpenAIChatModel with custom provider or a model string
    """
    try:
        # Try to get base URL from credential service
        base_url = await _get_openai_base_url()

        # Validate and normalize base URL
        if base_url:
            try:
                base_url = _validate_base_url(base_url)
            except ValueError as e:
                logger.error(f"Invalid OPENAI_BASE_URL configuration: {e}")
                # Don't fall back silently - re-raise the error to fail fast
                raise ValueError(f"Invalid OPENAI_BASE_URL configuration: {e}")

        if base_url:
            # Get API key
            api_key = await _get_openai_api_key()
            if not api_key:
                # Fail fast when base URL is configured but API key is missing
                # This prevents traffic from leaking to public endpoints when a proxy was explicitly configured
                raise ValueError(
                    f"OPENAI_BASE_URL is configured ({base_url}) but no OpenAI API key is available. "
                    "When using a custom base URL, an API key must be provided for security reasons."
                )

            # Create custom provider with base_url
            provider = OpenAIProvider(
                base_url=base_url,
                api_key=api_key
            )

            logger.info(f"Creating OpenAI model {model_name} with custom base URL: {base_url}")
            return OpenAIChatModel(model_name, provider=provider)
        else:
            # No custom base URL, use standard string format
            logger.debug(f"Using default OpenAI configuration for model: {model_name}")
            return f"openai:{model_name}"

    except Exception as e:
        logger.error(f"Error configuring OpenAI model: {e}")
        # Fallback to standard string format
        return f"openai:{model_name}"


async def _get_openai_base_url() -> str | None:
    """Get OpenAI base URL from credential service."""
    try:
        # Import here to avoid circular imports
        from ..server.services.credential_service import credential_service

        # Get RAG settings which contain OPENAI_BASE_URL
        rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
        base_url = rag_settings.get("OPENAI_BASE_URL")

        if base_url:
            logger.debug(f"Found OPENAI_BASE_URL in settings: {base_url}")
            return base_url
        else:
            # Check environment variable as fallback
            env_base_url = os.getenv("OPENAI_BASE_URL")
            if env_base_url:
                logger.debug(f"Found OPENAI_BASE_URL in environment: {env_base_url}")
                return env_base_url

        return None

    except Exception as e:
        logger.debug(f"Could not get OPENAI_BASE_URL from settings: {e}")
        # Try environment variable as fallback
        return os.getenv("OPENAI_BASE_URL")


async def _get_openai_api_key() -> str | None:
    """Get OpenAI API key from credential service."""
    try:
        # Import here to avoid circular imports
        from ..server.services.credential_service import credential_service

        # Try to get from credential service first
        api_key = await credential_service.get_credential("OPENAI_API_KEY", decrypt=True)
        if api_key:
            logger.debug("Found OPENAI_API_KEY in credential service")
            return api_key

        # Fallback to environment variable
        env_api_key = os.getenv("OPENAI_API_KEY")
        if env_api_key:
            logger.debug("Found OPENAI_API_KEY in environment")
            return env_api_key

        return None

    except Exception as e:
        logger.debug(f"Could not get OPENAI_API_KEY from settings: {e}")
        # Try environment variable as fallback
        return os.getenv("OPENAI_API_KEY")


def get_configured_openai_model_sync(model_name: str) -> str:
    """
    Synchronous version that returns model string format.
    
    Since we can't easily call async functions from sync contexts,
    this returns the standard model string format and relies on
    PydanticAI's automatic configuration.
    
    Args:
        model_name: The model name (e.g., "gpt-4o", "gpt-4o-mini")
        
    Returns:
        Model string in "openai:model" format
    """
    # For synchronous contexts, we use the standard format
    # PydanticAI will handle OpenAI configuration automatically
    return f"openai:{model_name}"
