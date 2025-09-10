"""Supabase implementation of the available models repository."""

from typing import List, Dict, Any, Optional
from datetime import datetime
from supabase import Client
from ....core.interfaces.repositories import IAvailableModelsRepository


class SupabaseAvailableModelsRepository(IAvailableModelsRepository):
    """Concrete implementation of available models repository using Supabase."""
    
    def __init__(self, db_client: Client):
        """Initialize repository with Supabase client.
        
        Args:
            db_client: Supabase client instance
        """
        self.db = db_client
        self.table_name = "available_models"
    
    async def get_all_models(self, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get all available models.
        
        Args:
            active_only: If True, only return active models
            
        Returns:
            List of model dictionaries
        """
        try:
            query = self.db.table(self.table_name).select(
                "id, provider, model_id, model_string, display_name, description, "
                "context_length, input_cost, output_cost, supports_vision, supports_tools, "
                "supports_reasoning, is_embedding, is_free, cost_tier, source, last_updated"
            )
            
            if active_only:
                query = query.eq("is_active", True)
            
            # Order by provider, then by cost tier (free first), then by name
            query = query.order("provider").order("cost_tier").order("display_name")
            
            response = query.execute()
            return response.data or []
            
        except Exception as e:
            print(f"Error getting all models: {e}")
            return []
    
    async def get_models_by_provider(self, provider: str, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get models for a specific provider.
        
        Args:
            provider: Provider name (e.g., 'openai')
            active_only: If True, only return active models
            
        Returns:
            List of model dictionaries for the provider
        """
        try:
            query = self.db.table(self.table_name).select(
                "id, provider, model_id, model_string, display_name, description, "
                "context_length, input_cost, output_cost, supports_vision, supports_tools, "
                "supports_reasoning, is_embedding, is_free, cost_tier, source, last_updated"
            ).eq("provider", provider)
            
            if active_only:
                query = query.eq("is_active", True)
            
            # Order by cost tier (free first), then by name
            query = query.order("cost_tier").order("display_name")
            
            response = query.execute()
            return response.data or []
            
        except Exception as e:
            print(f"Error getting models for provider {provider}: {e}")
            return []
    
    async def get_models_by_type(self, is_embedding: bool = False, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get models filtered by type.
        
        Args:
            is_embedding: If True, get embedding models; if False, get LLM models
            active_only: If True, only return active models
            
        Returns:
            List of filtered model dictionaries
        """
        try:
            query = self.db.table(self.table_name).select(
                "id, provider, model_id, model_string, display_name, description, "
                "context_length, input_cost, output_cost, supports_vision, supports_tools, "
                "supports_reasoning, is_embedding, is_free, cost_tier, source, last_updated"
            ).eq("is_embedding", is_embedding)
            
            if active_only:
                query = query.eq("is_active", True)
            
            # Order by provider, then by cost tier (free first), then by name
            query = query.order("provider").order("cost_tier").order("display_name")
            
            response = query.execute()
            return response.data or []
            
        except Exception as e:
            print(f"Error getting models by type (embedding={is_embedding}): {e}")
            return []
    
    async def get_model_by_string(self, model_string: str) -> Optional[Dict[str, Any]]:
        """Get a specific model by its model string.
        
        Args:
            model_string: Model string (e.g., 'openai:gpt-4o')
            
        Returns:
            Model dictionary or None if not found
        """
        try:
            response = self.db.table(self.table_name).select(
                "id, provider, model_id, model_string, display_name, description, "
                "context_length, input_cost, output_cost, supports_vision, supports_tools, "
                "supports_reasoning, is_embedding, is_free, cost_tier, source, last_updated, is_active"
            ).eq("model_string", model_string).execute()
            
            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
            
        except Exception as e:
            print(f"Error getting model {model_string}: {e}")
            return None
    
    async def sync_model(self, model_data: Dict[str, Any]) -> str:
        """Sync (upsert) a model to the database.
        
        Args:
            model_data: Dictionary containing all model information
            
        Returns:
            Model ID (UUID) of the synced model
        """
        try:
            # Use the sync_model database function for atomic upsert
            response = self.db.rpc('sync_model', {
                'p_provider': model_data['provider'],
                'p_model_id': model_data['model_id'],
                'p_display_name': model_data['display_name'],
                'p_description': model_data.get('description'),
                'p_context_length': model_data.get('context_length'),
                'p_input_cost': model_data.get('input_cost'),
                'p_output_cost': model_data.get('output_cost'),
                'p_supports_vision': model_data.get('supports_vision', False),
                'p_supports_tools': model_data.get('supports_tools', False),
                'p_supports_reasoning': model_data.get('supports_reasoning', False),
                'p_is_embedding': model_data.get('is_embedding', False),
                'p_is_free': model_data.get('is_free', False),
                'p_cost_tier': model_data.get('cost_tier'),
                'p_source': model_data.get('source', 'openrouter')
            }).execute()
            
            if response.data:
                return str(response.data)
            else:
                raise Exception("No ID returned from sync_model function")
                
        except Exception as e:
            print(f"Error syncing model {model_data.get('model_string', 'unknown')}: {e}")
            raise e
    
    async def bulk_sync_models(self, models_data: List[Dict[str, Any]], source: str = 'openrouter') -> int:
        """Sync multiple models in a batch operation using efficient bulk upsert.
        
        Args:
            models_data: List of model dictionaries to sync
            source: Source of the models (e.g., 'openrouter', 'manual')
            
        Returns:
            Number of models successfully synced
        """
        if not models_data:
            return 0
            
        try:
            # Prepare data for bulk upsert and deduplicate by (provider, model_id)
            formatted_models = []
            seen_models = set()
            duplicates_count = 0
            
            for model_data in models_data:
                provider_model_key = (model_data['provider'], model_data['model_id'])
                
                if provider_model_key in seen_models:
                    duplicates_count += 1
                    continue
                    
                seen_models.add(provider_model_key)
                
                formatted_model = {
                    'provider': model_data['provider'],
                    'model_id': model_data['model_id'],
                    'model_string': model_data['model_string'],
                    'display_name': model_data['display_name'],
                    'description': model_data.get('description'),
                    'context_length': model_data.get('context_length'),
                    'input_cost': model_data.get('input_cost'),
                    'output_cost': model_data.get('output_cost'),
                    'supports_vision': model_data.get('supports_vision', False),
                    'supports_tools': model_data.get('supports_tools', False),
                    'supports_reasoning': model_data.get('supports_reasoning', False),
                    'is_embedding': model_data.get('is_embedding', False),
                    'is_free': model_data.get('is_free', False),
                    'cost_tier': model_data.get('cost_tier'),
                    'source': source,
                    'is_active': True,
                    'last_updated': datetime.now().isoformat(),
                    'created_at': datetime.now().isoformat()
                }
                formatted_models.append(formatted_model)
            
            if duplicates_count > 0:
                print(f"Removed {duplicates_count} duplicate models before sync")
            
            # Use bulk upsert instead of individual RPC calls
            response = self.db.table(self.table_name).upsert(
                formatted_models,
                on_conflict='provider,model_id'
            ).execute()
            
            synced_count = len(response.data) if response.data else len(formatted_models)
            print(f"Bulk sync completed: {synced_count}/{len(models_data)} models synced")
            
            return synced_count
            
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"Bulk sync failed: {e}", exc_info=True)
            print(f"Bulk sync failed: {e}")
            # Re-raise the exception so the sync service can handle it properly
            raise
    
    async def deactivate_stale_models(self, source: str = 'openrouter', sync_time: Optional[datetime] = None) -> int:
        """Mark models as inactive if they weren't updated in the latest sync.
        
        Args:
            source: Source to check (e.g., 'openrouter')
            sync_time: Time of the sync (default: now)
            
        Returns:
            Number of models marked as inactive
        """
        try:
            if sync_time is None:
                sync_time = datetime.now()
            
            # Use the deactivate_models_not_in_sync database function
            response = self.db.rpc('deactivate_models_not_in_sync', {
                'p_source': source,
                'p_sync_time': sync_time.isoformat()
            }).execute()
            
            return response.data or 0
            
        except Exception as e:
            print(f"Error deactivating stale models for source {source}: {e}")
            return 0
    
    async def set_model_active(self, model_string: str, is_active: bool = True) -> bool:
        """Manually activate or deactivate a model.
        
        Args:
            model_string: Model string (e.g., 'openai:gpt-4o')
            is_active: Whether to activate or deactivate
            
        Returns:
            True if updated, False if model not found
        """
        try:
            response = self.db.table(self.table_name).update({
                'is_active': is_active,
                'last_updated': datetime.now().isoformat()
            }).eq('model_string', model_string).execute()
            
            # Check if any rows were affected
            return len(response.data) > 0 if response.data else False
            
        except Exception as e:
            print(f"Error setting model {model_string} active status to {is_active}: {e}")
            return False
    
    async def get_provider_statistics(self) -> Dict[str, Dict[str, Any]]:
        """Get aggregated statistics for each provider.
        
        Returns:
            Dictionary mapping provider names to their statistics
        """
        try:
            # Use the model_usage view
            response = self.db.from_('model_usage').select('*').execute()
            
            if not response.data:
                return {}
            
            # Convert list to dictionary keyed by provider
            stats = {}
            for row in response.data:
                provider = row['provider']
                stats[provider] = {
                    'total_models': row['total_models'],
                    'active_models': row['active_models'],
                    'embedding_models': row['embedding_models'],
                    'llm_models': row['llm_models'],
                    'free_models': row['free_models'],
                    'vision_models': row['vision_models'],
                    'tool_models': row['tool_models'],
                    'max_context_length': row['max_context_length'],
                    'min_cost': float(row['min_cost']) if row['min_cost'] else 0,
                    'max_cost': float(row['max_cost']) if row['max_cost'] else 0,
                    'last_sync': row['last_sync']
                }
            
            return stats
            
        except Exception as e:
            print(f"Error getting provider statistics: {e}")
            return {}
    
    async def get_providers_with_api_keys(self, api_key_providers: List[str]) -> List[Dict[str, Any]]:
        """Get models from providers that have API keys configured.
        
        Args:
            api_key_providers: List of provider names with configured API keys
            
        Returns:
            List of model dictionaries from providers with API keys
        """
        if not api_key_providers:
            return []
        
        try:
            query = self.db.table(self.table_name).select(
                "id, provider, model_id, model_string, display_name, description, "
                "context_length, input_cost, output_cost, supports_vision, supports_tools, "
                "supports_reasoning, is_embedding, is_free, cost_tier, source, last_updated"
            ).in_('provider', api_key_providers).eq('is_active', True)
            
            # Order by provider, then by cost tier (free first), then by name
            query = query.order("provider").order("cost_tier").order("display_name")
            
            response = query.execute()
            return response.data or []
            
        except Exception as e:
            print(f"Error getting models for providers with API keys: {e}")
            return []