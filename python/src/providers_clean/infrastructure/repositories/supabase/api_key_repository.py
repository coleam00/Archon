"""Supabase implementation of the API key repository."""

from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from supabase import Client
from cryptography.fernet import Fernet
import json
import logging
from ....core.interfaces.repositories import IApiKeyRepository


logger = logging.getLogger(__name__)


class ApiKeyRepositoryError(Exception):
    """Base exception for API key repository operations."""
    pass


class SupabaseApiKeyRepository(IApiKeyRepository):
    """Concrete implementation of API key repository using Supabase."""
    
    def __init__(self, db_client: Client, cipher: Fernet):
        """Initialize repository with Supabase client and cipher.
        
        Args:
            db_client: Supabase client instance
            cipher: Fernet cipher for encryption/decryption
        """
        self.db = db_client
        self.cipher = cipher
        self.table_name = "api_keys"
    
    async def store_key(self, provider: str, encrypted_key: str, metadata: Optional[Dict[str, Any]] = None) -> bool:
        """Store an encrypted API key for a provider.
        
        Args:
            provider: Provider name
            encrypted_key: Already encrypted API key
            metadata: Optional metadata (base_url, etc.)
            
        Returns:
            True if stored successfully
        """
        try:
            data = {
                "provider": provider,
                "encrypted_key": encrypted_key,
                "is_active": True,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "base_url": metadata.get("base_url") if metadata else None,
                # Preserve any additional metadata besides base_url in headers column
                "headers": ({k: v for k, v in metadata.items() if k != "base_url"} if metadata else None),
            }
            
            # Upsert by provider to avoid races and ensure idempotency
            response = (
                self.db.table(self.table_name)
                .upsert(data, on_conflict="provider")
                .execute()
            )
            
            return bool(response.data)
            
        except Exception as e:
            logger.error(f"Error storing API key for provider {provider}", exc_info=True)
            raise ApiKeyRepositoryError(f"Failed to store API key for {provider}") from e
    
    async def get_key(self, provider: str) -> Optional[Dict[str, Any]]:
        """Get encrypted API key and metadata for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            Dictionary with encrypted_key and metadata, or None if not found
        """
        try:
            response = self.db.table(self.table_name).select("*").eq(
                "provider", provider
            ).eq("is_active", True).execute()
            
            if response.data and len(response.data) > 0:
                data: Dict[str, Any] = response.data[0]  # Get first result
                
                # Build metadata from base_url and headers
                metadata = {}
                if data.get("base_url"):
                    metadata["base_url"] = data["base_url"]
                if data.get("headers"):
                    metadata.update(data["headers"] if isinstance(data["headers"], dict) else {})
                
                return {
                    "provider": data["provider"],
                    "encrypted_key": data["encrypted_key"],
                    "metadata": metadata,
                    "created_at": data.get("updated_at"),  # Use updated_at as created_at
                    "last_used": data.get("updated_at")
                }
            return None
            
        except Exception as e:
            logger.error(f"Error getting API key for provider {provider}", exc_info=True)
            raise ApiKeyRepositoryError(f"Failed to get API key for {provider}") from e
    
    async def get_active_providers(self) -> List[str]:
        """Get list of providers with active API keys.
        
        Returns:
            List of provider names
        """
        try:
            response = self.db.table(self.table_name).select("provider").eq(
                "is_active", True
            ).execute()
            
            if response.data:
                return [row["provider"] for row in response.data if isinstance(row, dict)]
            return []
            
        except Exception:
            logger.error("Error getting active providers list", exc_info=True)
            return []
    
    async def deactivate_key(self, provider: str) -> bool:
        """Deactivate (soft delete) an API key.
        
        Args:
            provider: Provider name
            
        Returns:
            True if deactivated, False if not found
        """
        try:
            response = self.db.table(self.table_name).update({
                "is_active": False,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }).eq("provider", provider).eq("is_active", True).execute()
            
            return len(response.data) > 0 if response.data else False
            
        except Exception as e:
            logger.error(f"Error deactivating API key for provider {provider}", exc_info=True)
            raise ApiKeyRepositoryError(f"Failed to deactivate API key for {provider}") from e
    
    async def delete_key(self, provider: str) -> bool:
        """Permanently delete an API key for a provider.
        
        Args:
            provider: Provider name
            
        Returns:
            True if deleted successfully, False if not found
        """
        try:
            response = self.db.table(self.table_name).delete().eq("provider", provider).execute()
            
            return len(response.data) > 0 if response.data else False
            
        except Exception as e:
            logger.error(f"Error deleting API key for provider {provider}", exc_info=True)
            raise ApiKeyRepositoryError(f"Failed to delete API key for {provider}") from e
    
    async def rotate_key(self, provider: str, new_encrypted_key: str) -> bool:
        """Rotate an API key for a provider.
        
        Args:
            provider: Provider name
            new_encrypted_key: New encrypted API key
            
        Returns:
            True if rotated successfully
        """
        try:
            # Get current key to preserve metadata
            current = await self.get_key(provider)
            if not current:
                return False
            
            # Archive the old key (optional - could store in history table)
            # For now, we'll just update the existing record
            
            response = self.db.table(self.table_name).update({
                "encrypted_key": new_encrypted_key,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }).eq("provider", provider).eq("is_active", True).execute()
            
            return bool(response.data)
            
        except Exception as e:
            logger.error(f"Error rotating API key for provider {provider}", exc_info=True)
            raise ApiKeyRepositoryError(f"Failed to rotate API key for {provider}") from e
