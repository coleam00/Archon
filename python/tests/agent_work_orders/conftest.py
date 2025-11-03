"""Pytest configuration for agent_work_orders tests"""

import os
from unittest.mock import MagicMock, patch

import pytest

# Set ENABLE_AGENT_WORK_ORDERS=true for all tests so health endpoint populates dependencies
os.environ.setdefault("ENABLE_AGENT_WORK_ORDERS", "true")

# Mock get_supabase_client before any modules import it
# This prevents Supabase credential validation during test collection
mock_client = MagicMock()
mock_get_client = patch(
    "src.agent_work_orders.state_manager.repository_config_repository.get_supabase_client",
    return_value=mock_client
)
mock_get_client.start()


@pytest.fixture(autouse=True)
def reset_structlog():
    """Reset structlog configuration for each test"""
    import structlog

    structlog.reset_defaults()
