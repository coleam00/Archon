"""
Agent Provider Configuration

Handles OpenAI provider configuration for PydanticAI agents.
Enables custom base_url configuration for OpenAI-compatible endpoints.
"""

import ipaddress
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
        raise ValueError(f"Invalid URL format: {e}") from e

    # Ensure it has a valid scheme
    if not parsed.scheme:
        raise ValueError("Base URL must include a scheme (http:// or https://)")

    if parsed.scheme not in ['http', 'https']:
        raise ValueError("Base URL must use http:// or https:// scheme")

    # Ensure it has a valid hostname
    if not parsed.hostname:
        raise ValueError("Base URL must include a valid hostname")

    # Disallow embedding credentials in the URL
    if parsed.username or parsed.password:
        raise ValueError("Base URL must not embed credentials (userinfo)")

    # Log security consideration for non-HTTPS URLs
    is_private = False
    try:
        host_ip = ipaddress.ip_address(parsed.hostname)
        is_private = host_ip.is_loopback or host_ip.is_private
    except ValueError:
        # Not an IP literal; accept common local hostnames
        is_private = parsed.hostname in ('localhost', 'host.docker.internal')
    if parsed.scheme == 'http' and not is_private:
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
                logger.error("Invalid OPENAI_BASE_URL configuration", exc_info=True)
                # Don't fall back silently - re-raise the error to fail fast
                raise ValueError(f"Invalid OPENAI_BASE_URL configuration: {e}") from e

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

    except Exception:
        logger.error("Error configuring OpenAI model", exc_info=True)
        # If a custom base URL was configured, fail fast to avoid leaking traffic.
        if "base_url" in locals() and base_url:
            raise
        # Otherwise, fall back to the default OpenAI configuration.
        return f"openai:{model_name}"

async def _get_openai_base_url() -> str | None:
    """Get OpenAI base URL from credential service."""
    try:
        # Import here to avoid circular imports
        from ..server.services.credential_service import credential_service

        # Prefer direct credential lookup (handles decryption and consistent typing)
        base_url = await credential_service.get_credential("OPENAI_BASE_URL", decrypt=True)
        if base_url:
            logger.debug("Found OPENAI_BASE_URL in credential service")
            return str(base_url)
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


async def get_openai_client_config() -> dict[str, str | None]:
    """
    Get OpenAI client configuration for creating openai.AsyncOpenAI instances.

    This provides centralized configuration that honors OPENAI_BASE_URL settings
    and applies the same validation and security checks as the PydanticAI agents.

    Returns:
        Dict with 'api_key' and 'base_url' keys. Both may be None if not configured.

    Raises:
        ValueError: If OPENAI_BASE_URL is configured but invalid or missing API key
    """
    try:
        # Get base URL using same logic as get_configured_openai_model
        base_url = await _get_openai_base_url()

        # Validate and normalize base URL
        if base_url:
            try:
                base_url = _validate_base_url(base_url)
            except ValueError as e:
                logger.error("Invalid OPENAI_BASE_URL configuration", exc_info=True)
                # Don't fall back silently - re-raise the error to fail fast
                raise ValueError(f"Invalid OPENAI_BASE_URL configuration: {e}") from e

        # Get API key
        api_key = await _get_openai_api_key()

        # Apply same security check as in get_configured_openai_model
        if base_url and not api_key:
            # Fail fast when base URL is configured but API key is missing
            # This prevents traffic from leaking to public endpoints when a proxy was explicitly configured
            raise ValueError(
                f"OPENAI_BASE_URL is configured ({base_url}) but no OpenAI API key is available. "
                "When using a custom base URL, an API key must be provided for security reasons."
            )

        logger.debug(f"OpenAI client config: base_url={base_url}, has_api_key={bool(api_key)}")

        return {
            "api_key": api_key,
            "base_url": base_url,
        }

    except Exception:
        logger.error("Error getting OpenAI client configuration", exc_info=True)
        # If a custom base URL was configured, fail fast to avoid leaking traffic.
        base_url = None
        try:
            base_url = await _get_openai_base_url()
        except Exception:
            pass

        if base_url:
            raise

        # Otherwise, return default configuration
        return {
            "api_key": None,
            "base_url": None,
        }


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
