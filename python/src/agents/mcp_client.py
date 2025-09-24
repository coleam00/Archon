"""
MCP Client for Agents

This lightweight client allows PydanticAI agents to call MCP tools via HTTP.
Agents use this client to access all data operations through the MCP protocol
instead of direct database access or service imports.
"""

import asyncio
import json
import logging
import uuid
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MCPError(Exception):
    """Base MCP client error."""


class MCPTransportError(MCPError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message if status_code is None else f"[HTTP {status_code}] {message}")
        self.status_code = status_code


class MCPToolError(MCPError):
    def __init__(self, message: str, code: int | None = None, data: Any | None = None):
        super().__init__(message if code is None else f"[{code}] {message}")
        self.code = code
        self.data = data


class MCPClient:
    """Client for calling MCP tools via HTTP."""

    def __init__(self, mcp_url: str | None = None):
        """
        Initialize MCP client.

        Args:
            mcp_url: MCP server URL (defaults to service discovery)
        """
        if mcp_url:
            self.mcp_url = mcp_url
        else:
            # Use service discovery to find MCP server
            try:
                from ..server.config.service_discovery import get_mcp_url

                self.mcp_url = get_mcp_url()
            except ImportError:
                # Fallback for when running in agents container
                import os

                mcp_port = os.getenv("ARCHON_MCP_PORT", "8051")
                if os.getenv("DOCKER_CONTAINER"):
                    self.mcp_url = f"http://archon-mcp:{mcp_port}"
                else:
                    self.mcp_url = f"http://localhost:{mcp_port}"

        self.client: httpx.AsyncClient = httpx.AsyncClient(timeout=30.0)
        logger.info(f"MCP Client initialized with URL: {self.mcp_url}")

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()

    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()

    async def call_tool(self, tool_name: str, **kwargs) -> Any:
        """
        Call an MCP tool via HTTP.

        Args:
            tool_name: Name of the MCP tool to call
            **kwargs: Tool arguments

        Returns:
            JSON-RPC result value (any JSON-serializable type)
        """
        try:
            # Use unique JSON-RPC IDs for correlation
            request_id = str(uuid.uuid4())
            request_data = {"jsonrpc": "2.0", "method": tool_name, "params": kwargs, "id": request_id}

            # Make HTTP request to MCP server (httpx sets Content-Type for json=)
            response = await self.client.post(f"{self.mcp_url}/rpc", json=request_data)

            response.raise_for_status()
            result = response.json()

            if "error" in result:
                error = result["error"]
                error_msg = error.get("error") or error.get("message", "Unknown error")
                code = error.get("code")
                data = error.get("data")
                raise MCPToolError(error_msg, code=code, data=data)

            if "result" not in result:
                raise MCPError(f"Malformed JSON-RPC response: missing 'result' field in response: {result}")

            return result["result"]

        except httpx.HTTPError as e:
            # Extract response details for comprehensive logging
            resp = getattr(e, "response", None)
            status_code = resp.status_code if resp is not None else None
            body_snippet = resp.text[:500] if resp is not None else None

            logger.exception(
                f"HTTP error calling MCP tool {tool_name} | url={self.mcp_url}/rpc | "
                f"status={status_code} | request_id={request_id} | body_snippet={body_snippet}"
            )
            raise MCPTransportError(f"HTTP error calling MCP tool {tool_name}", status_code=status_code) from e

        except Exception as e:
            logger.exception(f"Unexpected error calling MCP tool {tool_name} | request_id={request_id}")
            raise MCPError(f"Failed to call MCP tool {tool_name}: {str(e)}") from e

    # Convenience methods for common MCP tools

    async def perform_rag_query(self, query: str, source: str | None = None, match_count: int = 5) -> str:
        """Perform a RAG query through MCP."""
        result = await self.call_tool(
            "perform_rag_query", query=query, source=source, match_count=match_count
        )
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def get_available_sources(self) -> str:
        """Get available sources through MCP."""
        result = await self.call_tool("get_available_sources")
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def search_code_examples(
        self, query: str, source_id: str | None = None, match_count: int = 5
    ) -> str:
        """Search code examples through MCP."""
        result = await self.call_tool(
            "search_code_examples", query=query, source_id=source_id, match_count=match_count
        )
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def manage_project(self, action: str, **kwargs) -> str:
        """Manage projects through MCP."""
        result = await self.call_tool("manage_project", action=action, **kwargs)
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def manage_document(self, action: str, project_id: str, **kwargs) -> str:
        """Manage documents through MCP."""
        result = await self.call_tool(
            "manage_document", action=action, project_id=project_id, **kwargs
        )
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def manage_task(self, action: str, project_id: str, **kwargs) -> str:
        """Manage tasks through MCP."""
        result = await self.call_tool("manage_task", action=action, project_id=project_id, **kwargs)
        return json.dumps(result) if isinstance(result, dict) else str(result)


# Global MCP client instance (created on first use)
_mcp_client: MCPClient | None = None
_mcp_client_lock: asyncio.Lock | None = None


async def get_mcp_client() -> MCPClient:
    """
    Get or create the global MCP client instance.

    Thread-safe implementation using double-checked locking pattern.

    Returns:
        MCPClient instance
    """
    global _mcp_client, _mcp_client_lock

    # First check without lock for performance
    if _mcp_client is not None:
        return _mcp_client

    # Initialize lock if needed
    if _mcp_client_lock is None:
        _mcp_client_lock = asyncio.Lock()

    # Double-checked locking pattern
    async with _mcp_client_lock:
        # Check again in case another coroutine created the client
        if _mcp_client is None:
            _mcp_client = MCPClient()
            logger.info("Created new global MCP client instance")

        return _mcp_client


async def shutdown_mcp_client() -> None:
    """
    Shutdown the global MCP client instance.

    This should be called during application shutdown to properly
    close HTTP connections and clean up resources.
    """
    global _mcp_client

    if _mcp_client is not None:
        await _mcp_client.close()
        _mcp_client = None
        logger.info("Global MCP client shutdown completed")
