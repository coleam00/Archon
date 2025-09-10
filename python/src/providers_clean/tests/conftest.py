"""Test configuration and shared fixtures for provider services."""

import pytest
import asyncio
from unittest.mock import Mock, AsyncMock
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone
from decimal import Decimal

from ..core.interfaces.repositories import (
    IModelConfigRepository,
    IApiKeyRepository,
    IUsageRepository
)
from ..core.interfaces.unit_of_work import IUnitOfWork
from cryptography.fernet import Fernet


class MockModelConfigRepository(IModelConfigRepository):
    """Mock implementation of model config repository."""

    def __init__(self):
        self._configs: Dict[str, Dict[str, Any]] = {}

    async def get_config(self, service_name: str) -> Optional[Dict[str, Any]]:
        return self._configs.get(service_name)

    async def save_config(self, service_name: str, config: Dict[str, Any]) -> Dict[str, Any]:
        config_with_service = {"service_name": service_name, **config}
        self._configs[service_name] = config_with_service
        return config_with_service

    async def get_all_configs(self) -> Dict[str, str]:
        return {name: config["model_string"] for name, config in self._configs.items()}

    async def delete_config(self, service_name: str) -> bool:
        if service_name in self._configs:
            del self._configs[service_name]
            return True
        return False

    async def bulk_update_provider(self, old_provider: str, new_provider: str, new_models: Dict[str, str]) -> int:
        count = 0
        for service_name, config in self._configs.items():
            if config["model_string"].startswith(f"{old_provider}:"):
                old_model = config["model_string"]
                new_model = new_models.get(
                    old_model, f"{new_provider}:{old_model.split(':', 1)[1]}")
                config["model_string"] = new_model
                count += 1
        return count


class MockApiKeyRepository(IApiKeyRepository):
    """Mock implementation of API key repository."""

    def __init__(self, cipher: Fernet):
        """Initialize mock repository with cipher.

        Args:
            cipher: Fernet cipher for encryption/decryption
        """
        self.cipher = cipher
        self._keys: Dict[str, Dict[str, Any]] = {}

    async def store_key(self, provider: str, encrypted_key: str, metadata: Optional[Dict[str, Any]] = None) -> bool:
        self._keys[provider] = {
            "encrypted_key": encrypted_key,
            "metadata": metadata or {},
            "created_at": datetime.now(timezone.utc),
            "last_used": None
        }
        return True

    async def get_key(self, provider: str) -> Optional[Dict[str, Any]]:
        return self._keys.get(provider)

    async def get_active_providers(self) -> List[str]:
        return list(self._keys.keys())

    async def deactivate_key(self, provider: str) -> bool:
        if provider in self._keys:
            del self._keys[provider]
            return True
        return False

    async def rotate_key(self, provider: str, new_encrypted_key: str) -> bool:
        if provider in self._keys:
            self._keys[provider]["encrypted_key"] = new_encrypted_key
            return True
        return False


class MockUsageRepository(IUsageRepository):
    """Mock implementation of usage repository."""

    def __init__(self):
        self._usage: List[Dict[str, Any]] = []

    async def track_usage(self, usage_data: Dict[str, Any]) -> bool:
        self._usage.append({
            **usage_data,
            "timestamp": datetime.now(timezone.utc)
        })
        return True

    async def get_usage_summary(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        service_name: Optional[str] = None
    ) -> Dict[str, Any]:
        filtered_usage = self._usage

        if service_name:
            filtered_usage = [
                u for u in filtered_usage if u["service_name"] == service_name]

        if start_date:
            filtered_usage = [
                u for u in filtered_usage if u["timestamp"] >= start_date]

        if end_date:
            filtered_usage = [
                u for u in filtered_usage if u["timestamp"] <= end_date]

        total_cost = sum(Decimal(str(u["cost"])) for u in filtered_usage)
        total_tokens = sum(u["input_tokens"] + u["output_tokens"]
                           for u in filtered_usage)

        by_model = {}
        by_service = {}

        for usage in filtered_usage:
            model = usage["model_string"]
            service = usage["service_name"]

            if model not in by_model:
                by_model[model] = {"count": 0,
                                   "tokens": 0, "cost": Decimal("0")}
            by_model[model]["count"] += 1
            by_model[model]["tokens"] += usage["input_tokens"] + \
                usage["output_tokens"]
            by_model[model]["cost"] += Decimal(str(usage["cost"]))

            if service not in by_service:
                by_service[service] = {"count": 0,
                                       "tokens": 0, "cost": Decimal("0")}
            by_service[service]["count"] += 1
            by_service[service]["tokens"] += usage["input_tokens"] + \
                usage["output_tokens"]
            by_service[service]["cost"] += Decimal(str(usage["cost"]))

        return {
            "total_requests": len(filtered_usage),
            "total_tokens": total_tokens,
            "total_cost": total_cost,
            "by_model": by_model,
            "by_service": by_service
        }

    async def get_daily_costs(self, days: int = 7) -> Dict[str, Decimal]:
        # Simplified implementation for testing
        return {f"2024-01-{i:02d}": Decimal("10.0") for i in range(1, days + 1)}

    async def get_service_usage(
        self,
        service_name: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> Dict[str, Any]:
        return await self.get_usage_summary(start_date, end_date, service_name)

    async def estimate_monthly_cost(self, based_on_days: int = 7) -> Decimal:
        daily_costs = await self.get_daily_costs(based_on_days)
        avg_daily = sum(daily_costs.values()) / len(daily_costs)
        return Decimal(str(avg_daily)) * Decimal("30")


class MockUnitOfWork(IUnitOfWork):
    """Mock implementation of Unit of Work."""

    def __init__(self):
        self.cipher = Fernet(Fernet.generate_key())
        self.model_configs: Optional[IModelConfigRepository] = MockModelConfigRepository(
        )
        self.api_keys: Optional[IApiKeyRepository] = MockApiKeyRepository(
            self.cipher)
        self.usage: Optional[IUsageRepository] = MockUsageRepository()
        self._committed = False

    async def __aenter__(self) -> 'IUnitOfWork':
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is None and self._committed:
            pass  # Commit would happen here
        else:
            pass  # Rollback would happen here

    async def commit(self) -> None:
        self._committed = True

    async def rollback(self) -> None:
        self._committed = False


@pytest.fixture
def mock_uow() -> MockUnitOfWork:
    """Fixture providing a mock unit of work."""
    return MockUnitOfWork()


@pytest.fixture
def sample_api_key() -> str:
    """Sample API key for testing."""
    return "sk-test123456789012345678901234567890"


@pytest.fixture
def sample_encrypted_key(mock_uow: MockUnitOfWork, sample_api_key: str) -> str:
    """Sample encrypted API key."""
    return mock_uow.cipher.encrypt(sample_api_key.encode()).decode()


@pytest.fixture
def sample_model_config() -> Dict[str, Any]:
    """Sample model configuration."""
    return {
        "service_name": "test_agent",
        "model_string": "openai:gpt-4o",
        "temperature": 0.7,
        "max_tokens": 1000
    }


@pytest.fixture
def sample_usage_data() -> Dict[str, Any]:
    """Sample usage data for testing."""
    return {
        "service_name": "test_agent",
        "model_string": "openai:gpt-4o",
        "input_tokens": 500,
        "output_tokens": 200,
        "cost": 0.015,
        "metadata": {"request_id": "test-123"}
    }
