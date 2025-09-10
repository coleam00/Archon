"""Refactored API key management service using repository pattern."""

import os
from typing import Dict, List, Optional, Any
from cryptography.fernet import Fernet
from pydantic import SecretStr

from ..core.interfaces.unit_of_work import IUnitOfWork


class APIKeyService:
    """Service for managing API keys using repository pattern."""

    ENV_MAPPINGS = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
        "groq": "GROQ_API_KEY",
        "mistral": "MISTRAL_API_KEY",
        "cohere": "COHERE_API_KEY",
        "ai21": "AI21_API_KEY",
        "replicate": "REPLICATE_API_KEY",
        "together": "TOGETHER_API_KEY",
        "fireworks": "FIREWORKS_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "xai": "XAI_API_KEY"
    }

    BASE_URL_MAPPINGS = {
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com/v1",
        "google": "https://generativelanguage.googleapis.com/v1",
        "openrouter": "https://openrouter.ai/api/v1"
    }

    def __init__(self, unit_of_work: IUnitOfWork):
        """Initialize service with Unit of Work.

        Args:
            unit_of_work: Unit of Work for managing repository operations
        """
        self.uow = unit_of_work

    async def set_api_key(
        self,
        provider: str,
        api_key: str,
        base_url: Optional[str] = None
    ) -> bool:
        """Store an API key for a provider.

        Args:
            provider: Provider name
            api_key: API key to store
            base_url: Optional custom base URL

        Returns:
            True if stored successfully
        """
        # Encrypt the API key
        encrypted_key = self.uow.cipher.encrypt(api_key.encode()).decode()

        # Prepare metadata
        metadata = {}
        if base_url:
            metadata["base_url"] = base_url
        elif provider in self.BASE_URL_MAPPINGS:
            metadata["base_url"] = self.BASE_URL_MAPPINGS[provider]

        async with self.uow:
            result = await self.uow.api_keys.store_key(provider, encrypted_key, metadata)
            await self.uow.commit()

            # SECURITY: Removed plaintext storage in environment variables
            # API keys are now only stored encrypted in the database

            return result

    async def get_api_key(self, provider: str) -> Optional[str]:
        """Get decrypted API key for a provider.

        Args:
            provider: Provider name

        Returns:
            Decrypted API key or None if not found
        """
        # Check environment variable first (takes priority)
        if provider in self.ENV_MAPPINGS:
            env_key = os.environ.get(self.ENV_MAPPINGS[provider])
            if env_key:
                return env_key

        # Then check stored keys
        async with self.uow:
            key_data = await self.uow.api_keys.get_key(provider)

            if key_data:
                # Decrypt the key
                try:
                    decrypted = self.uow.cipher.decrypt(
                        key_data["encrypted_key"].encode()
                    ).decode()
                    return decrypted
                except Exception:
                    # Key might be corrupted or cipher changed
                    return None

            return None

    async def get_active_providers(self) -> List[str]:
        """Get list of providers with active API keys.

        Returns:
            List of provider names
        """
        async with self.uow:
            providers = await self.uow.api_keys.get_active_providers()

            # Also check environment variables
            for provider, env_var in self.ENV_MAPPINGS.items():
                if os.environ.get(env_var) and provider not in providers:
                    providers.append(provider)

            # Ollama doesn't require an API key
            if "ollama" not in providers:
                providers.append("ollama")

            return sorted(providers)

    async def deactivate_api_key(self, provider: str) -> bool:
        """Deactivate an API key for a provider.

        Args:
            provider: Provider name

        Returns:
            True if deactivated successfully
        """
        async with self.uow:
            result = await self.uow.api_keys.deactivate_key(provider)
            await self.uow.commit()

            # SECURITY: Removed environment variable cleanup since we no longer store keys there

            return result

    async def rotate_api_key(self, provider: str, new_api_key: str) -> bool:
        """Rotate an API key for a provider.

        Args:
            provider: Provider name
            new_api_key: New API key

        Returns:
            True if rotated successfully
        """
        # Encrypt the new key
        encrypted_key = self.uow.cipher.encrypt(new_api_key.encode()).decode()

        async with self.uow:
            result = await self.uow.api_keys.rotate_key(provider, encrypted_key)
            await self.uow.commit()

            # SECURITY: Removed plaintext storage in environment variables
            # API keys are now only stored encrypted in the database

            return result

    async def delete_api_key(self, provider: str) -> bool:
        """Permanently delete an API key for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            True if deleted successfully
        """
        async with self.uow:
            result = await self.uow.api_keys.delete_key(provider)
            await self.uow.commit()
            
            # Remove from environment variables if present
            if provider in self.ENV_MAPPINGS:
                env_var = self.ENV_MAPPINGS[provider]
                if env_var in os.environ:
                    del os.environ[env_var]
            
            return result

    async def setup_environment(self) -> Dict[str, bool]:
        """Set up environment variables from stored API keys.

        SECURITY NOTE: This method no longer stores plaintext API keys in environment variables.
        It only sets base URLs for providers that have them configured.

        Returns:
            Dictionary mapping providers to success status
        """
        status = {}

        async with self.uow:
            providers = await self.uow.api_keys.get_active_providers()

            for provider in providers:
                key_data = await self.uow.api_keys.get_key(provider)
                if key_data:
                    try:
                        # SECURITY: Removed plaintext API key storage in environment variables
                        # Only set base URL if available (this is not sensitive)
                        if key_data.get("metadata", {}).get("base_url"):
                            os.environ[f"{provider}_BASE_URL"] = key_data["metadata"]["base_url"]

                        status[provider] = True
                    except Exception:
                        status[provider] = False
                else:
                    status[provider] = False

        return status

    async def get_provider_config(self, provider: str) -> Dict[str, Any]:
        """Get full configuration for a provider.

        Args:
            provider: Provider name

        Returns:
            Configuration dictionary with api_key and metadata
        """
        async with self.uow:
            key_data = await self.uow.api_keys.get_key(provider)

            if key_data:
                try:
                    decrypted = self.uow.cipher.decrypt(
                        key_data["encrypted_key"].encode()
                    ).decode()

                    return {
                        "provider": provider,
                        "has_api_key": True,
                        "api_key": SecretStr(decrypted),
                        "base_url": key_data.get("metadata", {}).get("base_url"),
                        "created_at": key_data.get("created_at"),
                        "last_used": key_data.get("last_used")
                    }
                except Exception:
                    pass

        # Check environment as fallback
        if provider in self.ENV_MAPPINGS:
            env_key = os.environ.get(self.ENV_MAPPINGS[provider])
            if env_key:
                return {
                    "provider": provider,
                    "has_api_key": True,
                    "api_key": SecretStr(env_key),
                    "base_url": os.environ.get(f"{provider.upper()}_BASE_URL"),
                    "from_env": True
                }

        return {
            "provider": provider,
            "has_api_key": False,
            "api_key": None,
            "base_url": None
        }
