"""Dependency injection configuration for the provider system."""

import os
from typing import Optional
from functools import lru_cache
from fastapi import Depends, HTTPException, status
from supabase import create_client, Client
from cryptography.fernet import Fernet

from ..core.interfaces.unit_of_work import IUnitOfWork
from ..core.interfaces.repositories import (
    IModelConfigRepository,
    IApiKeyRepository,
    IUsageRepository,
    IAvailableModelsRepository
)
from .unit_of_work import SupabaseUnitOfWork
from .repositories.supabase import (
    SupabaseModelConfigRepository,
    SupabaseApiKeyRepository,
    SupabaseUsageRepository,
    SupabaseAvailableModelsRepository
)


@lru_cache()
def get_supabase_client() -> Client:
    """Get or create Supabase client instance.

    Returns:
        Supabase client

    Raises:
        HTTPException: If database configuration is missing
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database configuration missing. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables."
        )

    return create_client(url, key)


@lru_cache()
def get_encryption_cipher() -> Fernet:
    """Get encryption cipher for API keys using a required environment key.

    Alpha policy: fail fast on missing/invalid configuration. Do not generate
    ad-hoc keys that would make previously stored secrets undecipherable.

    Returns:
        Fernet cipher instance

    Raises:
        HTTPException: If the `ENCRYPTION_KEY` env var is missing or invalid
    """
    encryption_key = os.environ.get("ENCRYPTION_KEY")
    if not encryption_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "ENCRYPTION_KEY environment variable is required for API key encryption/decryption."
            ),
        )
    try:
        return Fernet(encryption_key.encode())
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Invalid ENCRYPTION_KEY format. Provide a valid base64-encoded 32-byte key."
            ),
        )


def get_unit_of_work(
    db: Client = Depends(get_supabase_client),
    cipher: Fernet = Depends(get_encryption_cipher)
) -> IUnitOfWork:
    """Get Unit of Work instance for coordinating repository operations.

    Args:
        db: Supabase client
        cipher: Encryption cipher

    Returns:
        Unit of Work instance
    """
    return SupabaseUnitOfWork(db, cipher)


def get_model_config_repository(
    db: Client = Depends(get_supabase_client)
) -> IModelConfigRepository:
    """Get model configuration repository.

    Args:
        db: Supabase client

    Returns:
        Model configuration repository instance
    """
    return SupabaseModelConfigRepository(db)


def get_api_key_repository(
    db: Client = Depends(get_supabase_client),
    cipher: Fernet = Depends(get_encryption_cipher)
) -> IApiKeyRepository:
    """Get API key repository.

    Args:
        db: Supabase client
        cipher: Encryption cipher

    Returns:
        API key repository instance
    """
    return SupabaseApiKeyRepository(db, cipher)


def get_usage_repository(
    db: Client = Depends(get_supabase_client)
) -> IUsageRepository:
    """Get usage tracking repository.

    Args:
        db: Supabase client

    Returns:
        Usage repository instance
    """
    return SupabaseUsageRepository(db)


class DependencyContainer:
    """Container for managing dependencies across the application."""

    _instance: Optional['DependencyContainer'] = None

    def __init__(self):
        """Initialize dependency container."""
        self._supabase_client: Optional[Client] = None
        self._cipher: Optional[Fernet] = None
        self._uow: Optional[IUnitOfWork] = None

    @classmethod
    def get_instance(cls) -> 'DependencyContainer':
        """Get singleton instance of dependency container.

        Returns:
            DependencyContainer instance
        """
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def supabase(self) -> Client:
        """Get Supabase client."""
        if self._supabase_client is None:
            self._supabase_client = get_supabase_client()
        return self._supabase_client

    @property
    def cipher(self) -> Fernet:
        """Get encryption cipher."""
        if self._cipher is None:
            self._cipher = get_encryption_cipher()
        return self._cipher

    @property
    def unit_of_work(self) -> IUnitOfWork:
        """Get Unit of Work instance."""
        if self._uow is None:
            self._uow = SupabaseUnitOfWork(self.supabase, self.cipher)
        return self._uow

    def reset(self):
        """Reset all cached dependencies."""
        self._supabase_client = None
        self._cipher = None
        self._uow = None


def get_model_sync_service(uow: IUnitOfWork = Depends(get_unit_of_work)):
    """Get model sync service for managing available models.

    Args:
        uow: Unit of Work instance

    Returns:
        ModelSyncService instance
    """
    from ..services.model_sync_service import ModelSyncService
    return ModelSyncService(uow)


def get_service_registry_service(uow: IUnitOfWork = Depends(get_unit_of_work)):
    """Get service registry service for managing service/agent registry.

    Args:
        uow: Unit of Work instance

    Returns:
        ServiceRegistryService instance
    """
    from ..services.service_registry_service import ServiceRegistryService
    return ServiceRegistryService(uow)
