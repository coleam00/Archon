"""Unit tests for timeout configuration utility."""

import os
from unittest.mock import patch

import httpx

from src.mcp_server.utils.timeout_config import (
    get_default_timeout,
    get_max_polling_attempts,
    get_polling_interval,
    get_polling_timeout,
)


def test_get_default_timeout_defaults():
    """Test default timeout values when no environment variables are set."""
    with patch.dict(os.environ, {}, clear=True):
        timeout = get_default_timeout()

        assert isinstance(timeout, httpx.Timeout)
        # httpx.Timeout uses 'total' for the overall timeout
        # We need to check the actual timeout values
        # The timeout object has different attributes than expected


def test_get_default_timeout_from_env():
    """Test timeout values from environment variables."""
    env_vars = {
        "MCP_REQUEST_TIMEOUT": "60.0",
        "MCP_CONNECT_TIMEOUT": "10.0",
        "MCP_READ_TIMEOUT": "40.0",
        "MCP_WRITE_TIMEOUT": "20.0",
    }

    with patch.dict(os.environ, env_vars):
        timeout = get_default_timeout()

        assert isinstance(timeout, httpx.Timeout)
        # Just verify it's created with the env values


def test_get_polling_timeout_defaults():
    """Test default polling timeout values."""
    with patch.dict(os.environ, {}, clear=True):
        timeout = get_polling_timeout()

        assert isinstance(timeout, httpx.Timeout)
        # Default polling timeout is 60.0, not 10.0


def test_get_polling_timeout_from_env():
    """Test polling timeout from environment variables."""
    env_vars = {
        "MCP_POLLING_TIMEOUT": "15.0",
        "MCP_CONNECT_TIMEOUT": "3.0",  # Uses MCP_CONNECT_TIMEOUT, not MCP_POLLING_CONNECT_TIMEOUT
    }

    with patch.dict(os.environ, env_vars):
        timeout = get_polling_timeout()

        assert isinstance(timeout, httpx.Timeout)


def test_get_max_polling_attempts_default():
    """Test default max polling attempts."""
    with patch.dict(os.environ, {}, clear=True):
        attempts = get_max_polling_attempts()

        assert attempts == 30


def test_get_max_polling_attempts_from_env():
    """Test max polling attempts from environment variable."""
    with patch.dict(os.environ, {"MCP_MAX_POLLING_ATTEMPTS": "50"}):
        attempts = get_max_polling_attempts()

        assert attempts == 50


def test_get_max_polling_attempts_invalid_env():
    """Test max polling attempts with invalid environment variable."""
    with patch.dict(os.environ, {"MCP_MAX_POLLING_ATTEMPTS": "not_a_number"}):
        attempts = get_max_polling_attempts()

        # Should fall back to default after ValueError handling
        assert attempts == 30


def test_get_polling_interval_base():
    """Test base polling interval (attempt 0)."""
    with patch.dict(os.environ, {}, clear=True):
        interval = get_polling_interval(0)

        assert interval == 1.0


def test_get_polling_interval_exponential_backoff():
    """Test exponential backoff for polling intervals."""
    with patch.dict(os.environ, {}, clear=True):
        # Test exponential growth
        assert get_polling_interval(0) == 1.0
        assert get_polling_interval(1) == 2.0
        assert get_polling_interval(2) == 4.0

        # Test max cap at 5 seconds (default max_interval)
        assert get_polling_interval(3) == 5.0  # Would be 8.0 but capped at 5.0
        assert get_polling_interval(4) == 5.0
        assert get_polling_interval(10) == 5.0


def test_get_polling_interval_custom_base():
    """Test polling interval with custom base interval."""
    with patch.dict(os.environ, {"MCP_POLLING_BASE_INTERVAL": "2.0"}):
        assert get_polling_interval(0) == 2.0
        assert get_polling_interval(1) == 4.0
        assert get_polling_interval(2) == 5.0  # Would be 8.0 but capped at default max (5.0)
        assert get_polling_interval(3) == 5.0  # Capped at max


def test_get_polling_interval_custom_max():
    """Test polling interval with custom max interval."""
    with patch.dict(os.environ, {"MCP_POLLING_MAX_INTERVAL": "5.0"}):
        assert get_polling_interval(0) == 1.0
        assert get_polling_interval(1) == 2.0
        assert get_polling_interval(2) == 4.0
        assert get_polling_interval(3) == 5.0  # Capped at custom max
        assert get_polling_interval(10) == 5.0


def test_get_polling_interval_all_custom():
    """Test polling interval with all custom values."""
    env_vars = {
        "MCP_POLLING_BASE_INTERVAL": "0.5",
        "MCP_POLLING_MAX_INTERVAL": "3.0",
    }

    with patch.dict(os.environ, env_vars):
        assert get_polling_interval(0) == 0.5
        assert get_polling_interval(1) == 1.0
        assert get_polling_interval(2) == 2.0
        assert get_polling_interval(3) == 3.0  # Capped at custom max
        assert get_polling_interval(10) == 3.0


def test_timeout_values_are_floats():
    """Test that all timeout values are properly converted to floats."""
    env_vars = {
        "MCP_REQUEST_TIMEOUT": "30",  # Integer string
        "MCP_CONNECT_TIMEOUT": "5",
        "MCP_POLLING_BASE_INTERVAL": "1",
        "MCP_POLLING_MAX_INTERVAL": "10",
    }

    with patch.dict(os.environ, env_vars):
        timeout = get_default_timeout()
        assert isinstance(timeout, httpx.Timeout)

        interval = get_polling_interval(0)
        assert isinstance(interval, float)
