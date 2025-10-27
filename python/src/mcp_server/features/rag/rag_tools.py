"""
RAG Module for Archon MCP Server (HTTP-based version)

This module provides tools for:
- RAG query and search
- Source management
- Code example extraction and search

This version uses HTTP calls to the server service instead of importing
service modules directly, enabling true microservices architecture.
"""

import json
import logging
import os
from urllib.parse import urljoin

import httpx
from mcp.server.fastmcp import Context, FastMCP

# Import service discovery for HTTP communication
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def get_setting(key: str, default: str = "false") -> str:
    """Get a setting from environment variable."""
    return os.getenv(key, default)


def get_bool_setting(key: str, default: bool = False) -> bool:
    """Get a boolean setting from environment variable."""
    value = get_setting(key, "false" if not default else "true")
    return value.lower() in ("true", "1", "yes", "on")


def register_rag_tools(mcp: FastMCP):
    """Register all RAG tools with the MCP server."""

    @mcp.tool()
    async def rag_get_available_sources(ctx: Context) -> str:
        """
        Get list of available sources in the knowledge base.

        Returns:
            JSON string with structure:
            - success: bool - Operation success status
            - sources: list[dict] - Array of source objects
            - count: int - Number of sources
            - error: str - Error description if success=false
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(urljoin(api_url, "/api/rag/sources"))

                if response.status_code == 200:
                    result = response.json()
                    sources = result.get("sources", [])

                    return json.dumps(
                        {"success": True, "sources": sources, "count": len(sources)}, indent=2
                    )
                else:
                    error_detail = response.text
                    return json.dumps(
                        {"success": False, "error": f"HTTP {response.status_code}: {error_detail}"},
                        indent=2,
                    )

        except Exception as e:
            logger.error(f"Error getting sources: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    @mcp.tool()
    async def rag_search_knowledge_base(
        ctx: Context,
        query: str,
        source_id: str | None = None,
        match_count: int = 5,
        return_mode: str = "pages"
    ) -> str:
        """
        Search knowledge base for relevant content using RAG.

        Args:
            query: Search query - Keep it SHORT and FOCUSED (2-5 keywords).
                   Good: "vector search", "authentication JWT", "React hooks"
                   Bad: "how to implement user authentication with JWT tokens in React with TypeScript and handle refresh tokens"
            source_id: Optional source ID filter from rag_get_available_sources().
                      This is the 'id' field from available sources, NOT a URL or domain name.
                      Example: "src_1234abcd" not "docs.anthropic.com"
            match_count: Max results (default: 5)
            return_mode: "pages" (default, full pages with metadata) or "chunks" (raw text chunks)

        Returns:
            JSON string with structure:
            - success: bool - Operation success status
            - results: list[dict] - Array of pages/chunks with content and metadata
                      Pages include: page_id, url, title, preview, word_count, chunk_matches
                      Chunks include: content, metadata, similarity
            - return_mode: str - Mode used ("pages" or "chunks")
            - reranked: bool - Whether results were reranked
            - error: str|null - Error description if success=false

        Note: Use "pages" mode for better context (recommended), or "chunks" for raw granular results.
        After getting pages, use rag_read_full_page() to retrieve complete page content.
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                request_data = {
                    "query": query,
                    "match_count": match_count,
                    "return_mode": return_mode
                }
                if source_id:
                    request_data["source"] = source_id

                response = await client.post(urljoin(api_url, "/api/rag/query"), json=request_data)

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps(
                        {
                            "success": True,
                            "results": result.get("results", []),
                            "return_mode": result.get("return_mode", return_mode),
                            "reranked": result.get("reranked", False),
                            "error": None,
                        },
                        indent=2,
                    )
                else:
                    error_detail = response.text
                    return json.dumps(
                        {
                            "success": False,
                            "results": [],
                            "error": f"HTTP {response.status_code}: {error_detail}",
                        },
                        indent=2,
                    )

        except Exception as e:
            logger.error(f"Error performing RAG query: {e}")
            return json.dumps({"success": False, "results": [], "error": str(e)}, indent=2)

    @mcp.tool()
    async def rag_search_code_examples(
        ctx: Context, query: str, source_id: str | None = None, match_count: int = 5
    ) -> str:
        """
        Search for relevant code examples in the knowledge base.

        Args:
            query: Search query - Keep it SHORT and FOCUSED (2-5 keywords).
                   Good: "React useState", "FastAPI middleware", "vector pgvector"
                   Bad: "React hooks useState useEffect useContext useReducer useMemo useCallback"
            source_id: Optional source ID filter from rag_get_available_sources().
                      This is the 'id' field from available sources, NOT a URL or domain name.
                      Example: "src_1234abcd" not "docs.anthropic.com"
            match_count: Max results (default: 5)

        Returns:
            JSON string with structure:
            - success: bool - Operation success status
            - results: list[dict] - Array of code examples with content and summaries
            - reranked: bool - Whether results were reranked
            - error: str|null - Error description if success=false
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                request_data = {"query": query, "match_count": match_count}
                if source_id:
                    request_data["source"] = source_id

                # Call the dedicated code examples endpoint
                response = await client.post(
                    urljoin(api_url, "/api/rag/code-examples"), json=request_data
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps(
                        {
                            "success": True,
                            "results": result.get("results", []),
                            "reranked": result.get("reranked", False),
                            "error": None,
                        },
                        indent=2,
                    )
                else:
                    error_detail = response.text
                    return json.dumps(
                        {
                            "success": False,
                            "results": [],
                            "error": f"HTTP {response.status_code}: {error_detail}",
                        },
                        indent=2,
                    )

        except Exception as e:
            logger.error(f"Error searching code examples: {e}")
            return json.dumps({"success": False, "results": [], "error": str(e)}, indent=2)

    @mcp.tool()
    async def rag_list_pages_for_source(
        ctx: Context, source_id: str, section: str | None = None
    ) -> str:
        """
        List all pages for a given knowledge source.

        Use this after rag_get_available_sources() to see all pages in a source.
        Useful for browsing documentation structure or finding specific pages.

        Args:
            source_id: Source ID from rag_get_available_sources() (e.g., "src_1234abcd")
            section: Optional filter for llms-full.txt section title (e.g., "# Core Concepts")

        Returns:
            JSON string with structure:
            - success: bool - Operation success status
            - pages: list[dict] - Array of page objects with id, url, section_title, word_count
            - total: int - Total number of pages
            - source_id: str - The source ID that was queried
            - error: str|null - Error description if success=false

        Example workflow:
            1. Call rag_get_available_sources() to get source_id
            2. Call rag_list_pages_for_source(source_id) to see all pages
            3. Call rag_read_full_page(page_id) to read specific pages
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                params = {"source_id": source_id}
                if section:
                    params["section"] = section

                response = await client.get(
                    urljoin(api_url, "/api/pages"),
                    params=params
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps(
                        {
                            "success": True,
                            "pages": result.get("pages", []),
                            "total": result.get("total", 0),
                            "source_id": result.get("source_id", source_id),
                            "error": None,
                        },
                        indent=2,
                    )
                else:
                    error_detail = response.text
                    return json.dumps(
                        {
                            "success": False,
                            "pages": [],
                            "total": 0,
                            "source_id": source_id,
                            "error": f"HTTP {response.status_code}: {error_detail}",
                        },
                        indent=2,
                    )

        except Exception as e:
            logger.error(f"Error listing pages for source {source_id}: {e}")
            return json.dumps(
                {
                    "success": False,
                    "pages": [],
                    "total": 0,
                    "source_id": source_id,
                    "error": str(e)
                },
                indent=2
            )

    @mcp.tool()
    async def rag_read_full_page(
        ctx: Context, page_id: str | None = None, url: str | None = None
    ) -> str:
        """
        Retrieve full page content from knowledge base.
        Use this to get complete page content after RAG search.

        Args:
            page_id: Page UUID from search results (e.g., "550e8400-e29b-41d4-a716-446655440000")
            url: Page URL (e.g., "https://docs.example.com/getting-started")

        Note: Provide EITHER page_id OR url, not both.

        Returns:
            JSON string with structure:
            - success: bool
            - page: dict with full_content, title, url, metadata
            - error: str|null
        """
        try:
            if not page_id and not url:
                return json.dumps(
                    {"success": False, "error": "Must provide either page_id or url"},
                    indent=2
                )

            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                if page_id:
                    response = await client.get(urljoin(api_url, f"/api/pages/{page_id}"))
                else:
                    response = await client.get(
                        urljoin(api_url, "/api/pages/by-url"),
                        params={"url": url}
                    )

                if response.status_code == 200:
                    page_data = response.json()
                    return json.dumps(
                        {
                            "success": True,
                            "page": page_data,
                            "error": None,
                        },
                        indent=2,
                    )
                else:
                    error_detail = response.text
                    return json.dumps(
                        {
                            "success": False,
                            "page": None,
                            "error": f"HTTP {response.status_code}: {error_detail}",
                        },
                        indent=2,
                    )

        except Exception as e:
            logger.error(f"Error reading page: {e}")
            return json.dumps({"success": False, "page": None, "error": str(e)}, indent=2)

    # Log successful registration
    logger.info("✓ RAG tools registered (HTTP-based version)")
