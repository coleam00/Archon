"""
Credential Provider Abstraction

Abstract credential provider interface and implementations to eliminate external dependency coupling.
Enables local testing without external Supabase dependencies while maintaining production functionality.
"""

import os
from abc import ABC, abstractmethod
from typing import Any

from ...config.logfire_config import get_logger
from ...exceptions.service_exceptions import CredentialError

logger = get_logger(__name__)


class CredentialProvider(ABC):
    """
    Abstract base class for credential providers.

    Defines the interface for loading credentials from different sources
    (environment variables, Supabase, etc.) without coupling to specific implementations.
    """

    @abstractmethod
    async def get_credentials_by_category(self, category: str) -> dict[str, Any]:
        """
        Get all credentials for a specific category.

        Args:
            category: Credential category (e.g., "qdrant", "supabase", "rag_strategy")

        Returns:
            Dictionary of credentials for the category

        Raises:
            CredentialError: If credential loading fails
        """
        pass

    @abstractmethod
    async def get_credential(self, key: str, default: Any = None, decrypt: bool = True) -> Any:
        """
        Get a single credential by key.

        Args:
            key: Credential key name
            default: Default value if credential not found
            decrypt: Whether to decrypt encrypted values

        Returns:
            Credential value or default
        """
        pass


class LocalCredentialProvider(CredentialProvider):
    """
    Local credential provider that loads credentials from environment variables only.

    No external service dependencies - ideal for local testing and development.
    Supports TESTING_MODE environment flag for provider switching.
    """

    def __init__(self):
        self._cache: dict[str, Any] = {}
        self._cache_initialized = False

    async def get_credentials_by_category(self, category: str) -> dict[str, Any]:
        """
        Load credentials for a category from environment variables.

        Maps category names to environment variable patterns:
        - qdrant: QDRANT_* variables
        - supabase: SUPABASE_* variables
        - rag_strategy: RAG_* and LLM_* variables

        Args:
            category: Credential category

        Returns:
            Dictionary of credentials found in environment
        """
        try:
            credentials = {}

            if category == "qdrant":
                # Load Qdrant configuration from environment
                qdrant_env_mapping = {
                    "QDRANT_HOST": "QDRANT_HOST",
                    "QDRANT_PORT": "QDRANT_PORT",
                    "QDRANT_API_KEY": "QDRANT_API_KEY",
                    "QDRANT_COLLECTION_PREFIX": "QDRANT_COLLECTION_PREFIX",
                }

                for key, env_var in qdrant_env_mapping.items():
                    value = os.getenv(env_var)
                    if value:
                        credentials[key] = value

            elif category == "supabase":
                # Load Supabase configuration from environment
                supabase_env_mapping = {"SUPABASE_URL": "SUPABASE_URL", "SUPABASE_SERVICE_KEY": "SUPABASE_SERVICE_KEY"}

                for key, env_var in supabase_env_mapping.items():
                    value = os.getenv(env_var)
                    if value:
                        credentials[key] = value

            elif category == "rag_strategy":
                # Load RAG strategy configuration from environment
                rag_env_mapping = {
                    "LLM_PROVIDER": "LLM_PROVIDER",
                    "MODEL_CHOICE": "MODEL_CHOICE",
                    "EMBEDDING_MODEL": "EMBEDDING_MODEL",
                    "LLM_BASE_URL": "LLM_BASE_URL",
                    "USE_CONTEXTUAL_EMBEDDINGS": "USE_CONTEXTUAL_EMBEDDINGS",
                    "USE_HYBRID_SEARCH": "USE_HYBRID_SEARCH",
                    "USE_AGENTIC_RAG": "USE_AGENTIC_RAG",
                    "USE_RERANKING": "USE_RERANKING",
                }

                for key, env_var in rag_env_mapping.items():
                    value = os.getenv(env_var)
                    if value:
                        credentials[key] = value

            else:
                # Generic category - try to load any env vars with category prefix
                prefix = category.upper() + "_"
                for env_var, value in os.environ.items():
                    if env_var.startswith(prefix):
                        key = env_var[len(prefix) :]
                        credentials[key] = value

            logger.debug(f"Loaded {len(credentials)} credentials for category '{category}' from environment")
            return credentials

        except Exception as e:
            logger.error(f"Error loading credentials for category {category}: {e}")
            raise CredentialError(f"Failed to load credentials for category: {category}") from e

    async def get_credential(self, key: str, default: Any = None, decrypt: bool = True) -> Any:
        """
        Get a single credential from environment variables.

        Args:
            key: Environment variable name
            default: Default value if not found
            decrypt: Ignored for local provider (no encryption)

        Returns:
            Environment variable value or default
        """
        try:
            value = os.getenv(key, default)
            logger.debug(f"Retrieved credential '{key}' from environment")
            return value
        except Exception as e:
            logger.error(f"Error getting credential {key}: {e}")
            return default


class SupabaseCredentialProvider(CredentialProvider):
    """
    Supabase credential provider that wraps the existing credential_service functionality.

    Maintains production behavior unchanged while conforming to the CredentialProvider interface.
    Preserves archon_settings table integration and encryption capabilities.
    """

    def __init__(self):
        # Import here to avoid circular imports
        from ..credential_service import credential_service

        self._credential_service = credential_service

    async def get_credentials_by_category(self, category: str) -> dict[str, Any]:
        """
        Get credentials for a category from Supabase archon_settings table.

        Args:
            category: Credential category

        Returns:
            Dictionary of credentials from Supabase
        """
        try:
            return await self._credential_service.get_credentials_by_category(category)
        except Exception as e:
            logger.error(f"Error getting credentials for category {category} from Supabase: {e}")
            raise CredentialError(f"Failed to load credentials from Supabase for category: {category}") from e

    async def get_credential(self, key: str, default: Any = None, decrypt: bool = True) -> Any:
        """
        Get a single credential from Supabase archon_settings table.

        Args:
            key: Credential key name
            default: Default value if not found
            decrypt: Whether to decrypt encrypted values

        Returns:
            Credential value from Supabase or default
        """
        try:
            return await self._credential_service.get_credential(key, default, decrypt)
        except Exception as e:
            logger.error(f"Error getting credential {key} from Supabase: {e}")
            return default


def create_credential_provider() -> CredentialProvider:
    """
    Factory function to create the appropriate credential provider based on environment.

    Uses TESTING_MODE environment variable to determine provider type:
    - TESTING_MODE=local -> LocalCredentialProvider
    - Otherwise -> SupabaseCredentialProvider

    Returns:
        Configured credential provider instance
    """
    testing_mode = os.getenv("TESTING_MODE", "").lower()

    if testing_mode == "local":
        logger.info("Creating LocalCredentialProvider for testing mode")
        return LocalCredentialProvider()
    else:
        logger.info("Creating SupabaseCredentialProvider for production mode")
        return SupabaseCredentialProvider()


# Convenience function for dependency injection
def get_credential_provider() -> CredentialProvider:
    """
    Get credential provider instance for dependency injection.

    Returns:
        Credential provider instance
    """
    return create_credential_provider()
