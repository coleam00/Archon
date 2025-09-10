"""Repository interfaces for the provider system.

These interfaces define the contract for data access operations,
enabling dependency inversion and improving testability.
"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any
from datetime import datetime
from decimal import Decimal
from cryptography.fernet import Fernet


class IModelConfigRepository(ABC):
    """Repository interface for model configuration operations."""

    @abstractmethod
    async def get_config(self, service_name: str) -> Optional[Dict[str, Any]]:
        """Get model configuration for a service.

        Args:
            service_name: Name of the service (e.g., 'rag_agent')

        Returns:
            Configuration dict or None if not found
        """
        pass

    @abstractmethod
    async def save_config(self, service_name: str, config: Dict[str, Any]) -> Dict[str, Any]:
        """Save or update model configuration for a service.

        Args:
            service_name: Name of the service
            config: Configuration dictionary containing model_string, temperature, etc.

        Returns:
            Saved configuration dictionary
        """
        pass

    @abstractmethod
    async def get_all_configs(self) -> Dict[str, str]:
        """Get all service configurations.

        Returns:
            Dictionary mapping service names to model strings
        """
        pass

    @abstractmethod
    async def delete_config(self, service_name: str) -> bool:
        """Delete configuration for a service.

        Args:
            service_name: Name of the service

        Returns:
            True if deleted, False if not found
        """
        pass

    @abstractmethod
    async def bulk_update_provider(self, old_provider: str, new_provider: str, new_models: Dict[str, str]) -> int:
        """Update all configurations using a specific provider.

        Args:
            old_provider: Current provider name
            new_provider: New provider name
            new_models: Mapping of old model strings to new ones

        Returns:
            Number of configurations updated
        """
        pass


class IApiKeyRepository(ABC):
    """Repository interface for API key management."""

    @abstractmethod
    def __init__(self, cipher: Fernet):
        """Initialize repository with encryption cipher.

        Args:
            cipher: Fernet cipher for API key encryption/decryption
        """
        pass

    @abstractmethod
    async def store_key(self, provider: str, encrypted_key: str, metadata: Optional[Dict[str, Any]] = None) -> bool:
        """Store an encrypted API key for a provider.

        Args:
            provider: Provider name (e.g., 'openai')
            encrypted_key: Encrypted API key
            metadata: Optional metadata (base_url, etc.)

        Returns:
            True if stored successfully
        """
        pass

    @abstractmethod
    async def get_key(self, provider: str) -> Optional[Dict[str, Any]]:
        """Get encrypted API key and metadata for a provider.

        Args:
            provider: Provider name

        Returns:
            Dictionary with encrypted_key and metadata, or None if not found
        """
        pass

    @abstractmethod
    async def get_active_providers(self) -> List[str]:
        """Get list of providers with active API keys.

        Returns:
            List of provider names
        """
        pass

    @abstractmethod
    async def deactivate_key(self, provider: str) -> bool:
        """Deactivate (soft delete) an API key.

        Args:
            provider: Provider name

        Returns:
            True if deactivated, False if not found
        """
        pass

    @abstractmethod
    async def rotate_key(self, provider: str, new_encrypted_key: str) -> bool:
        """Rotate an API key for a provider.

        Args:
            provider: Provider name
            new_encrypted_key: New encrypted API key

        Returns:
            True if rotated successfully
        """
        pass

    @abstractmethod
    async def delete_key(self, provider: str) -> bool:
        """Permanently delete an API key for a provider.

        Args:
            provider: Provider name

        Returns:
            True if deleted successfully, False if not found
        """
        pass


class IUsageRepository(ABC):
    """Repository interface for usage tracking."""

    @abstractmethod
    async def track_usage(self, usage_data: Dict[str, Any]) -> bool:
        """Track usage for a service.

        Args:
            usage_data: Dictionary containing:
                - service_name: Service identifier
                - model_string: Model used
                - input_tokens: Number of input tokens
                - output_tokens: Number of output tokens
                - cost: Calculated cost
                - metadata: Optional additional data

        Returns:
            True if tracked successfully
        """
        pass

    @abstractmethod
    async def get_usage_summary(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        service_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get usage summary for a time period.

        Args:
            start_date: Start of period (default: 30 days ago)
            end_date: End of period (default: now)
            service_name: Optional filter by service

        Returns:
            Summary dictionary with total_cost, total_tokens, by_model, etc.
        """
        pass

    @abstractmethod
    async def get_daily_costs(self, days: int = 7) -> Dict[str, Decimal]:
        """Get daily costs for the last N days.

        Args:
            days: Number of days to retrieve

        Returns:
            Dictionary mapping dates to costs
        """
        pass

    @abstractmethod
    async def get_service_usage(
        self,
        service_name: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """Get detailed usage for a specific service.

        Args:
            service_name: Service identifier
            start_date: Start of period
            end_date: End of period

        Returns:
            Detailed usage statistics for the service
        """
        pass

    @abstractmethod
    async def estimate_monthly_cost(self, based_on_days: int = 7) -> Decimal:
        """Estimate monthly cost based on recent usage.

        Args:
            based_on_days: Number of recent days to base estimate on

        Returns:
            Estimated monthly cost
        """
        pass


class IAvailableModelsRepository(ABC):
    """Repository interface for managing available AI models."""

    @abstractmethod
    async def get_all_models(self, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get all available models.

        Args:
            active_only: If True, only return active models

        Returns:
            List of model dictionaries
        """
        pass

    @abstractmethod
    async def get_models_by_provider(self, provider: str, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get models for a specific provider.

        Args:
            provider: Provider name (e.g., 'openai')
            active_only: If True, only return active models

        Returns:
            List of model dictionaries for the provider
        """
        pass

    @abstractmethod
    async def get_models_by_type(self, is_embedding: bool = False, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get models filtered by type.

        Args:
            is_embedding: If True, get embedding models; if False, get LLM models
            active_only: If True, only return active models

        Returns:
            List of filtered model dictionaries
        """
        pass

    @abstractmethod
    async def get_model_by_string(self, model_string: str) -> Optional[Dict[str, Any]]:
        """Get a specific model by its model string.

        Args:
            model_string: Model string (e.g., 'openai:gpt-4o')

        Returns:
            Model dictionary or None if not found
        """
        pass

    @abstractmethod
    async def sync_model(self, model_data: Dict[str, Any]) -> str:
        """Sync (upsert) a model to the database.

        Args:
            model_data: Dictionary containing all model information

        Returns:
            Model ID (UUID) of the synced model
        """
        pass

    @abstractmethod
    async def bulk_sync_models(self, models_data: List[Dict[str, Any]], source: str = 'openrouter') -> int:
        """Sync multiple models in a batch operation.

        Args:
            models_data: List of model dictionaries to sync
            source: Source of the models (e.g., 'openrouter', 'manual')

        Returns:
            Number of models successfully synced
        """
        pass

    @abstractmethod
    async def deactivate_stale_models(self, source: str = 'openrouter', sync_time: Optional[datetime] = None) -> int:
        """Mark models as inactive if they weren't updated in the latest sync.

        Args:
            source: Source to check (e.g., 'openrouter')
            sync_time: Time of the sync (default: now)

        Returns:
            Number of models marked as inactive
        """
        pass

    @abstractmethod
    async def set_model_active(self, model_string: str, is_active: bool = True) -> bool:
        """Manually activate or deactivate a model.

        Args:
            model_string: Model string (e.g., 'openai:gpt-4o')
            is_active: Whether to activate or deactivate

        Returns:
            True if updated, False if model not found
        """
        pass

    @abstractmethod
    async def get_provider_statistics(self) -> Dict[str, Dict[str, Any]]:
        """Get aggregated statistics for each provider.

        Returns:
            Dictionary mapping provider names to their statistics
        """
        pass

    @abstractmethod
    async def get_providers_with_api_keys(self, api_key_providers: List[str]) -> List[Dict[str, Any]]:
        """Get models from providers that have API keys configured.

        Args:
            api_key_providers: List of provider names with configured API keys

        Returns:
            List of model dictionaries from providers with API keys
        """
        pass


class IServiceRegistryRepository(ABC):
    """Repository interface for managing service registry."""

    @abstractmethod
    async def get_all_services(self, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get all services from the registry.

        Args:
            active_only: If True, only return active services

        Returns:
            List of service dictionaries
        """
        pass

    @abstractmethod
    async def get_service(self, service_name: str) -> Optional[Dict[str, Any]]:
        """Get a specific service by name.

        Args:
            service_name: Name of the service

        Returns:
            Service dictionary or None if not found
        """
        pass

    @abstractmethod
    async def register_service(self, service_data: Dict[str, Any]) -> str:
        """Register or update a service in the registry.

        Args:
            service_data: Dictionary containing service information

        Returns:
            Service ID (UUID) of the registered service
        """
        pass

    @abstractmethod
    async def update_service_metadata(self, service_name: str, metadata: Dict[str, Any]) -> bool:
        """Update metadata for a service.

        Args:
            service_name: Name of the service
            metadata: Dictionary with metadata to update

        Returns:
            True if updated successfully
        """
        pass

    @abstractmethod
    async def deprecate_service(self, service_name: str, reason: str, replacement: Optional[str] = None) -> bool:
        """Mark a service as deprecated.

        Args:
            service_name: Name of service to deprecate
            reason: Reason for deprecation
            replacement: Optional replacement service

        Returns:
            True if deprecated successfully
        """
        pass

    @abstractmethod
    async def get_services_by_category(self, category: str, active_only: bool = True) -> List[Dict[str, Any]]:
        """Get services filtered by category.

        Args:
            category: Category ('agent' or 'service')
            active_only: If True, only return active services

        Returns:
            List of service dictionaries
        """
        pass

    @abstractmethod
    async def get_unregistered_services(self) -> List[Dict[str, Any]]:
        """Get services that have configurations but no registry entries.

        Returns:
            List of unregistered service information
        """
        pass
