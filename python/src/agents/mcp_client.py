"""
MCP Client for Agents

This lightweight client allows PydanticAI agents to call MCP tools via HTTP.
Agents use this client to access all data operations through the MCP protocol
instead of direct database access or service imports.
"""

import json
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class MCPClient:
    """Client for calling MCP tools via HTTP."""

    def __init__(self, mcp_url: Optional[str] = None):
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

        self.client = httpx.AsyncClient(timeout=30.0)
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

    async def call_tool(self, tool_name: str, **kwargs) -> dict[str, Any]:
        """
        Call an MCP tool via HTTP.

        Args:
            tool_name: Name of the MCP tool to call
            **kwargs: Tool arguments

        Returns:
            Dict with the tool response
        """
        try:
            # MCP tools are called via JSON-RPC protocol
            request_data = {"jsonrpc": "2.0", "method": tool_name, "params": kwargs, "id": 1}

            # Make HTTP request to MCP server
            response = await self.client.post(
                f"{self.mcp_url}/rpc",
                json=request_data,
                headers={"Content-Type": "application/json"},
            )

            response.raise_for_status()
            result = response.json()

            if "error" in result:
                error = result["error"]
                raise Exception(f"MCP tool error: {error.get('message', 'Unknown error')}")

            return result.get("result", {})

        except httpx.HTTPError as e:
            logger.error(f"HTTP error calling MCP tool {tool_name}: {e}")
            raise Exception(f"Failed to call MCP tool: {str(e)}")
        except Exception as e:
            logger.error(f"Error calling MCP tool {tool_name}: {e}")
            raise

    # Convenience methods for common MCP tools

    async def perform_rag_query(self, query: str, source: Optional[str] = None, match_count: int = 5) -> str:
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
        self, query: str, source_id: Optional[str] = None, match_count: int = 5
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


async def get_mcp_client() -> MCPClient:
    """
    Get or create the global MCP client instance.

    Returns:
        MCPClient instance
    """
    global _mcp_client

    if _mcp_client is None:
        _mcp_client = MCPClient()

    return _mcp_client
