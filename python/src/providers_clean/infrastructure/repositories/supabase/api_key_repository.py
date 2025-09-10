"""Supabase implementation of the API key repository."""

from typing import Optional, List, Dict, Any
from datetime import datetime
from supabase import Client
from cryptography.fernet import Fernet
import json
from ....core.interfaces.repositories import IApiKeyRepository


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
                "updated_at": datetime.utcnow().isoformat(),
                "base_url": metadata.get("base_url") if metadata else None,
                # Preserve any additional metadata besides base_url in headers column
                "headers": ({k: v for k, v in metadata.items() if k != "base_url"} if metadata else None),
            }
            
            # Check if ANY record exists for provider (active or inactive)
            existing_check = self.db.table(self.table_name).select("provider").eq("provider", provider).execute()
            
            if existing_check.data:
                # Update existing key (reactivate if needed)
                response = self.db.table(self.table_name).update({
                    "encrypted_key": encrypted_key,
                    "is_active": True,
                    "updated_at": datetime.utcnow().isoformat(),
                    "base_url": metadata.get("base_url") if metadata else None,
                    "headers": ({k: v for k, v in metadata.items() if k != "base_url"} if metadata else None),
                }).eq("provider", provider).execute()
            else:
                # Insert new key
                response = self.db.table(self.table_name).insert(data).execute()
            
            return bool(response.data)
            
        except Exception as e:
            print(f"Error storing API key for {provider}: {e}")
            return False
    
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
            print(f"Error getting key for {provider}: {e}")
            return None
    
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
                "updated_at": datetime.utcnow().isoformat()
            }).eq("provider", provider).eq("is_active", True).execute()
            
            return len(response.data) > 0 if response.data else False
            
        except Exception as e:
            print(f"Error deactivating key for {provider}: {e}")
            return False
    
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
            print(f"Error deleting key for {provider}: {e}")
            return False
    
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
                "updated_at": datetime.utcnow().isoformat()
            }).eq("provider", provider).eq("is_active", True).execute()
            
            return bool(response.data)
            
        except Exception as e:
            print(f"Error rotating key for {provider}: {e}")
            return False
