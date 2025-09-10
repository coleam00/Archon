"""
Credential Service

Handles credential storage, retrieval, encryption/decryption, and caching.
Provides async functions for managing application credentials.
"""

import os
import logging
from typing import Dict, Any, Optional
from contextlib import asynccontextmanager

from cryptography.fernet import Fernet
from supabase import Client

logger = logging.getLogger(__name__)


class CredentialService:
    """Service for managing application credentials with encryption and caching."""

    def __init__(self):
        """Initialize the credential service."""
        self._cache: Dict[str, Any] = {}
        self._cache_initialized = False
        self._cipher: Optional[Fernet] = None

        # Initialize cipher for encryption/decryption
        key = os.environ.get('ARCHON_ENCRYPTION_KEY')
        if key:
            try:
                self._cipher = Fernet(key.encode())
            except Exception as e:
                logger.warning(f"Failed to initialize encryption cipher: {e}")

    def _get_supabase_client(self) -> Client:
        """Get Supabase client from environment."""
        # This would typically be injected or retrieved from a service locator
        # For now, return None to indicate no client available
        return None

    async def _decrypt_value(self, encrypted_value: str) -> str:
        """Decrypt an encrypted value."""
        if not self._cipher:
            raise ValueError("Encryption key not configured")
        try:
            return self._cipher.decrypt(encrypted_value.encode()).decode()
        except Exception as e:
            logger.error(f"Failed to decrypt value: {e}")
            raise

    async def _encrypt_value(self, value: str) -> str:
        """Encrypt a value."""
        if not self._cipher:
            raise ValueError("Encryption key not configured")
        try:
            return self._cipher.encrypt(value.encode()).decode()
        except Exception as e:
            logger.error(f"Failed to encrypt value: {e}")
            raise

    async def _load_all_credentials(self) -> Dict[str, Any]:
        """Load all credentials from database."""
        client = self._get_supabase_client()
        if not client:
            return {}

        try:
            response = client.table('settings').select('*').execute()
            credentials = {}

            for item in response.data:
                key = item['key']
                if item.get('is_encrypted') and item.get('encrypted_value'):
                    # Store encrypted data for later decryption
                    credentials[key] = {
                        'encrypted_value': item['encrypted_value'],
                        'is_encrypted': True
                    }
                else:
                    credentials[key] = item.get('value')

            return credentials
        except Exception as e:
            logger.error(f"Failed to load credentials from database: {e}")
            return {}

    async def initialize_credentials(self):
        """Initialize the credential cache."""
        if self._cache_initialized:
            return

        self._cache = await self._load_all_credentials()
        self._cache_initialized = True

    async def get_credential(self, key: str, default: Any = None) -> Any:
        """Get a credential value."""
        if not self._cache_initialized:
            await self.initialize_credentials()

        if key in self._cache:
            value = self._cache[key]
            if isinstance(value, dict) and value.get('is_encrypted'):
                # Decrypt the value
                try:
                    return await self._decrypt_value(value['encrypted_value'])
                except Exception as e:
                    logger.warning(f"Failed to decrypt value for {key}: {e}")
                    return default
            return value

        return default

    async def set_credential(self, key: str, value: Any, category: str = "general", description: str = "", is_encrypted: Optional[bool] = None):
        """Set a credential value."""
        client = self._get_supabase_client()
        if not client:
            # Store in cache only
            self._cache[key] = value
            return True

        try:
            # Determine if value should be encrypted
            if is_encrypted is None:
                is_encrypted = key.lower() in ['api_key', 'secret', 'password', 'token'] or 'key' in key.lower()

            if is_encrypted:
                encrypted_value = await self._encrypt_value(str(value))
                data = {
                    'key': key,
                    'encrypted_value': encrypted_value,
                    'value': None,
                    'is_encrypted': True,
                    'category': category,
                    'description': description
                }
                self._cache[key] = {
                    'encrypted_value': encrypted_value,
                    'is_encrypted': True
                }
            else:
                data = {
                    'key': key,
                    'value': str(value),
                    'encrypted_value': None,
                    'is_encrypted': False,
                    'category': category,
                    'description': description
                }
                self._cache[key] = value

            # Insert to database
            client.table('settings').insert(data).execute()
            return True

        except Exception as e:
            logger.error(f"Failed to set credential {key}: {e}")
            raise

    async def load_all_credentials(self) -> Dict[str, Any]:
        """Load all credentials from database (public method)."""
        result = await self._load_all_credentials()
        self._cache = result
        self._cache_initialized = True
        return result

    async def get_active_provider(self, provider_type: str) -> Optional[Dict[str, Any]]:
        """Get the active provider configuration for a given type."""
        # This is a simplified implementation
        # In a real implementation, this would check configuration
        if provider_type == "llm":
            return {
                "provider": "openai",
                "api_key": await self.get_credential("OPENAI_API_KEY"),
                "chat_model": await self.get_credential("MODEL_CHOICE", "gpt-4")
            }
        return None

    async def get_credentials_by_category(self, category: str) -> Dict[str, Any]:
        """Get all credentials for a specific category."""
        client = self._get_supabase_client()
        if not client:
            return {}

        try:
            response = client.table('settings').select('*').eq('category', category).execute()
            result = {}

            for item in response.data:
                key = item['key']
                if item.get('is_encrypted') and item.get('encrypted_value'):
                    # Decrypt the value
                    try:
                        result[key] = await self._decrypt_value(item['encrypted_value'])
                    except:
                        result[key] = None
                else:
                    result[key] = item.get('value')

            return result
        except Exception as e:
            logger.error(f"Failed to get credentials by category {category}: {e}")
            return {}


# Global instance
credential_service = CredentialService()


# Convenience functions
async def get_credential(key: str, default: Any = None) -> Any:
    """Get a credential value."""
    return await credential_service.get_credential(key, default)


async def set_credential(key: str, value: Any, category: str = "general", description: str = "", is_encrypted: Optional[bool] = None):
    """Set a credential value."""
    return await credential_service.set_credential(key, value, category, description, is_encrypted)


async def initialize_credentials():
    """Initialize the credential cache."""
    return await credential_service.initialize_credentials()


async def get_credentials_by_category(category: str) -> Dict[str, Any]:
    """Get all credentials for a specific category."""
    return await credential_service.get_credentials_by_category(category)
