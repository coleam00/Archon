"""
Centralized timeout configuration for MCP Server.

Provides consistent timeout values across all tools.
"""

import os

import httpx


def get_default_timeout() -> httpx.Timeout:
    """
    Get default timeout configuration from environment or defaults.

    Environment variables:
    - MCP_REQUEST_TIMEOUT: Total request timeout in seconds (default: 30)
    - MCP_CONNECT_TIMEOUT: Connection timeout in seconds (default: 5)
    - MCP_READ_TIMEOUT: Read timeout in seconds (default: 20)
    - MCP_WRITE_TIMEOUT: Write timeout in seconds (default: 10)

    Returns:
        Configured httpx.Timeout object
    """
    return httpx.Timeout(
        timeout=float(os.getenv("MCP_REQUEST_TIMEOUT", "30.0")),
        connect=float(os.getenv("MCP_CONNECT_TIMEOUT", "5.0")),
        read=float(os.getenv("MCP_READ_TIMEOUT", "20.0")),
        write=float(os.getenv("MCP_WRITE_TIMEOUT", "10.0")),
    )


def get_polling_timeout() -> httpx.Timeout:
    """
    Get timeout configuration for polling operations.

    Polling operations may need longer timeouts.

    Returns:
        Configured httpx.Timeout object for polling
    """
    return httpx.Timeout(
        timeout=float(os.getenv("MCP_POLLING_TIMEOUT", "60.0")),
        connect=float(os.getenv("MCP_CONNECT_TIMEOUT", "5.0")),
        read=float(os.getenv("MCP_POLLING_READ_TIMEOUT", "30.0")),
        write=float(os.getenv("MCP_WRITE_TIMEOUT", "10.0")),
    )


def get_max_polling_attempts() -> int:
    """
    Get maximum number of polling attempts.

    Returns:
        Maximum polling attempts (default: 30)
    """
    try:
        return int(os.getenv("MCP_MAX_POLLING_ATTEMPTS", "30"))
    except ValueError:
        # Fall back to default if env var is not a valid integer
        return 30


def get_polling_interval(attempt: int) -> float:
    """
    Get polling interval with exponential backoff.

    Args:
        attempt: Current attempt number (0-based)

    Returns:
        Sleep interval in seconds
    """
    base_interval = float(os.getenv("MCP_POLLING_BASE_INTERVAL", "1.0"))
    max_interval = float(os.getenv("MCP_POLLING_MAX_INTERVAL", "5.0"))

    # Exponential backoff: 1s, 2s, 4s, 5s, 5s, ...
    interval = min(base_interval * (2**attempt), max_interval)
    return float(interval)
