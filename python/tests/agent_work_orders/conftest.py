"""Pytest configuration for agent_work_orders tests"""

import pytest


@pytest.fixture(autouse=True)
def reset_structlog():
    """Reset structlog configuration for each test"""
    import structlog

    structlog.reset_defaults()
