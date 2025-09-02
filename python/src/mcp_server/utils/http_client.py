"""
HTTP client utilities for MCP Server.

Provides consistent HTTP client configuration.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx

from .timeout_config import get_default_timeout, get_polling_timeout


@asynccontextmanager
async def get_http_client(
    timeout: httpx.Timeout | None = None, for_polling: bool = False
) -> AsyncIterator[httpx.AsyncClient]:
    """
    Create an HTTP client with consistent configuration.

    Args:
        timeout: Optional custom timeout. If not provided, uses defaults.
        for_polling: If True, uses polling-specific timeout configuration.

    Yields:
        Configured httpx.AsyncClient

    Example:
        async with get_http_client() as client:
            response = await client.get(url)
    """
    if timeout is None:
        timeout = get_polling_timeout() if for_polling else get_default_timeout()

    # Future: Could add retry logic, custom headers, etc. here
    async with httpx.AsyncClient(timeout=timeout) as client:
        yield client
