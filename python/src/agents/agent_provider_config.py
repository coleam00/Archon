"""
Agent Provider Configuration

Handles OpenAI provider configuration for PydanticAI agents.
Enables custom base_url configuration for OpenAI-compatible endpoints.
"""

import logging
import os

from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

logger = logging.getLogger(__name__)


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

        if base_url:
            # Get API key
            api_key = await _get_openai_api_key()
            if not api_key:
                logger.warning("OPENAI_BASE_URL is configured but no API key found, falling back to default")
                return f"openai:{model_name}"

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
