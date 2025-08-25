"""
API Key Manager for PydanticAI Providers

Manages encrypted storage and retrieval of API keys for AI providers.
Sets up environment variables for PydanticAI to use.
"""

import os
import asyncio
from typing import Optional, Dict, List
from cryptography.fernet import Fernet
from supabase import Client
from pydantic import BaseModel, Field, SecretStr
import logging

logger = logging.getLogger(__name__)


class APIKeyConfig(BaseModel):
    """Configuration for a provider API key"""
    provider: str = Field(..., description="Provider name (e.g., 'openai')")
    api_key: SecretStr = Field(..., description="API key (will be encrypted)")
    base_url: Optional[str] = Field(None, description="Optional base URL for custom endpoints")
    headers: Optional[Dict[str, str]] = Field(None, description="Optional additional headers")
    is_active: bool = Field(True, description="Whether this key is active")


class APIKeyManager:
    """Manages API keys for PydanticAI providers"""
    
    # Environment variable mappings for PydanticAI
    ENV_MAPPINGS = {
        'openai': 'OPENAI_API_KEY',
        'anthropic': 'ANTHROPIC_API_KEY',
        'google': 'GOOGLE_API_KEY',
        'gemini': 'GOOGLE_API_KEY',  # Gemini uses Google API key
        'groq': 'GROQ_API_KEY',
        'mistral': 'MISTRAL_API_KEY',
        'cohere': 'CO_API_KEY',  # Cohere uses CO_API_KEY
    }
    
    # Base URL environment variables
    BASE_URL_MAPPINGS = {
        'openai': 'OPENAI_BASE_URL',
        'ollama': 'OLLAMA_BASE_URL',
    }
    
    def __init__(self, supabase_client: Client, encryption_key: Optional[str] = None):
        """
        Initialize with Supabase client and encryption key.
        
        Args:
            supabase_client: Supabase client instance
            encryption_key: Fernet encryption key (base64 encoded)
                           If not provided, will look for ARCHON_ENCRYPTION_KEY env var
        """
        self.db = supabase_client
        
        # Get or generate encryption key
        if encryption_key:
            self.cipher = Fernet(encryption_key.encode())
        else:
            key = os.environ.get('ARCHON_ENCRYPTION_KEY')
            if not key:
                # Generate a new key for this session (should be stored securely)
                key = Fernet.generate_key().decode()
                logger.warning(
                    "No encryption key found. Generated temporary key. "
                    "Set ARCHON_ENCRYPTION_KEY environment variable for persistence."
                )
                os.environ['ARCHON_ENCRYPTION_KEY'] = key
            self.cipher = Fernet(key.encode())
    
    async def set_api_key(
        self,
        provider: str,
        api_key: str,
        base_url: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None
    ) -> None:
        """
        Store an API key for a provider.
        
        Args:
            provider: Provider name (e.g., 'openai', 'anthropic')
            api_key: The API key to store (will be encrypted)
            base_url: Optional base URL for custom endpoints
            headers: Optional additional headers
        """
        # Encrypt the API key
        encrypted = self.cipher.encrypt(api_key.encode()).decode()
        
        # Prepare data for upsert
        data = {
            'provider': provider,
            'encrypted_key': encrypted,
            'is_active': True,
            'updated_at': 'now()'
        }
        
        if base_url:
            data['base_url'] = base_url
        if headers:
            data['headers'] = headers
        
        # Upsert the API key (specify on_conflict to handle updates properly)
        await asyncio.to_thread(
            lambda: self.db.table('api_keys')
            .upsert(data, on_conflict='provider')
            .execute()
        )
        
        logger.info(f"Stored API key for provider: {provider}")
        
        # Immediately set in environment
        await self._set_provider_env(provider, api_key, base_url)
    
    async def get_api_key(self, provider: str) -> Optional[str]:
        """
        Retrieve and decrypt an API key for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            Decrypted API key or None if not found
        """
        try:
            result = await asyncio.to_thread(
                lambda: self.db.table('api_keys')
                .select('encrypted_key')
                .eq('provider', provider)
                .eq('is_active', True)
                .single()
                .execute()
            )
            
            if result.data:
                encrypted_key = result.data['encrypted_key']
                decrypted = self.cipher.decrypt(encrypted_key.encode()).decode()
                return decrypted
                
        except Exception as e:
            logger.debug(f"No API key found for {provider}: {e}")
        
        return None
    
    async def setup_environment(self) -> Dict[str, bool]:
        """
        Set up environment variables for all active API keys.
        PydanticAI will read these environment variables.
        
        Returns:
            Dict mapping provider to success status
        """
        status = {}
        
        try:
            # Get all active API keys
            result = await asyncio.to_thread(
                lambda: self.db.table('api_keys')
                .select('*')
                .eq('is_active', True)
                .execute()
            )
            
            for row in result.data:
                provider = row['provider']
                try:
                    # Decrypt the API key
                    decrypted_key = self.cipher.decrypt(row['encrypted_key'].encode()).decode()
                    
                    # Set environment variables
                    await self._set_provider_env(
                        provider, 
                        decrypted_key,
                        row.get('base_url')
                    )
                    
                    status[provider] = True
                    logger.info(f"Set environment for provider: {provider}")
                    
                except Exception as e:
                    logger.error(f"Failed to set environment for {provider}: {e}")
                    status[provider] = False
        
        except Exception as e:
            logger.error(f"Failed to setup environment: {e}")
        
        return status
    
    async def _set_provider_env(
        self, 
        provider: str, 
        api_key: str,
        base_url: Optional[str] = None
    ) -> None:
        """
        Set environment variables for a specific provider.
        
        Args:
            provider: Provider name
            api_key: Decrypted API key
            base_url: Optional base URL
        """
        # Set API key environment variable
        if provider in self.ENV_MAPPINGS:
            env_var = self.ENV_MAPPINGS[provider]
            os.environ[env_var] = api_key
            logger.debug(f"Set {env_var} for {provider}")
        else:
            # For unknown providers, use a generic pattern
            env_var = f"{provider.upper()}_API_KEY"
            os.environ[env_var] = api_key
            logger.warning(f"Using generic env var {env_var} for unknown provider {provider}")
        
        # Set base URL if provided
        if base_url:
            if provider in self.BASE_URL_MAPPINGS:
                url_var = self.BASE_URL_MAPPINGS[provider]
                os.environ[url_var] = base_url
                logger.debug(f"Set {url_var} to {base_url}")
            elif provider == 'ollama':
                # Special case for Ollama
                os.environ['OLLAMA_BASE_URL'] = base_url
                logger.debug(f"Set OLLAMA_BASE_URL to {base_url}")
    
    async def get_active_providers(self) -> List[str]:
        """
        Get list of providers with active API keys.
        
        Returns:
            List of provider names
        """
        try:
            result = await asyncio.to_thread(
                lambda: self.db.table('api_keys')
                .select('provider')
                .eq('is_active', True)
                .execute()
            )
            
            providers = [row['provider'] for row in result.data]
            logger.info(f"Found {len(providers)} active providers: {providers}")
            return providers
            
        except Exception as e:
            logger.error(f"Failed to get active providers: {e}")
            return []
    
    async def deactivate_api_key(self, provider: str) -> bool:
        """
        Deactivate an API key for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            True if deactivated, False otherwise
        """
        try:
            result = await asyncio.to_thread(
                lambda: self.db.table('api_keys')
                .update({'is_active': False, 'updated_at': 'now()'})
                .eq('provider', provider)
                .execute()
            )
            
            if result.data:
                # Remove from environment
                if provider in self.ENV_MAPPINGS:
                    env_var = self.ENV_MAPPINGS[provider]
                    os.environ.pop(env_var, None)
                
                logger.info(f"Deactivated API key for {provider}")
                return True
                
        except Exception as e:
            logger.error(f"Failed to deactivate API key for {provider}: {e}")
        
        return False
    
    async def rotate_api_key(
        self,
        provider: str,
        new_api_key: str
    ) -> bool:
        """
        Rotate an API key for a provider.
        
        Args:
            provider: Provider name
            new_api_key: New API key
            
        Returns:
            True if rotated successfully
        """
        try:
            # Deactivate old key
            await self.deactivate_api_key(provider)
            
            # Set new key
            await self.set_api_key(provider, new_api_key)
            
            logger.info(f"Successfully rotated API key for {provider}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to rotate API key for {provider}: {e}")
            return False
    
    async def test_provider_key(self, provider: str) -> bool:
        """
        Test if a provider's API key is valid by checking if it's set.
        
        Note: This doesn't make an actual API call, just checks if the key exists.
        For actual validation, you would need to make a test request to the provider.
        
        Args:
            provider: Provider name
            
        Returns:
            True if key exists and is set in environment
        """
        # Check if key exists in database
        api_key = await self.get_api_key(provider)
        if not api_key:
            return False
        
        # Check if it's set in environment
        env_var = self.ENV_MAPPINGS.get(provider, f"{provider.upper()}_API_KEY")
        return env_var in os.environ
    
    @staticmethod
    def generate_encryption_key() -> str:
        """
        Generate a new Fernet encryption key.
        
        Returns:
            Base64-encoded encryption key
        """
        return Fernet.generate_key().decode()
    
    async def get_provider_config(self, provider: str) -> Optional[Dict[str, any]]:
        """
        Get full configuration for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            Dict with provider configuration or None
        """
        try:
            result = await asyncio.to_thread(
                lambda: self.db.table('api_keys')
                .select('*')
                .eq('provider', provider)
                .eq('is_active', True)
                .single()
                .execute()
            )
            
            if result.data:
                config = {
                    'provider': provider,
                    'has_api_key': True,
                    'base_url': result.data.get('base_url'),
                    'headers': result.data.get('headers'),
                    'is_active': result.data.get('is_active', True)
                }
                return config
                
        except Exception as e:
            logger.debug(f"No config found for {provider}: {e}")
        
        return None