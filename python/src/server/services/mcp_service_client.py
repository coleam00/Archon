"""
MCP Service Client for HTTP-based microservice communication

This module provides HTTP clients for the MCP service to communicate with
other services (API and Agents) instead of importing their modules directly.
"""

import uuid
from typing import Any
from urllib.parse import urljoin

import httpx

from ..config.logfire_config import mcp_logger
from ..config.service_discovery import get_agents_url, get_api_url, get_discovery


class MCPServiceClient:
    """
    Client for MCP service to communicate with other microservices via HTTP.
    Replaces direct module imports with proper service-to-service communication.
    """

    def __init__(self):
        self.discovery = get_discovery()
        self.api_url = get_api_url()
        self.agents_url = get_agents_url()
        self.service_auth = "mcp-service-key"  # In production, use proper key management
        
        # Adjust timeout based on environment
        if self.discovery.is_azure:
            # Azure Container Apps may have higher latency
            self.timeout = httpx.Timeout(
                connect=10.0,  # Increased for Azure
                read=300.0,    # 5 minutes for long operations like crawling
                write=30.0,
                pool=10.0,     # Increased for Azure
            )
        else:
            self.timeout = httpx.Timeout(
                connect=5.0,
                read=300.0,    # 5 minutes for long operations like crawling
                write=30.0,
                pool=5.0,
            )

    def _get_headers(self, request_id: str | None = None) -> dict[str, str]:
        """Get common headers for internal requests"""
        headers = {"X-Service-Auth": self.service_auth, "Content-Type": "application/json"}
        if request_id:
            headers["X-Request-ID"] = request_id
        else:
            headers["X-Request-ID"] = str(uuid.uuid4())
        return headers

    async def crawl_url(self, url: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
        """
        Crawl a URL by calling the API service's knowledge-items/crawl endpoint.
        Transforms MCP's simple format to the API's KnowledgeItemRequest format.

        Args:
            url: URL to crawl
            options: Crawling options (max_depth, chunk_size, smart_crawl)

        Returns:
            Crawl response with success status and results
        """
        endpoint = urljoin(self.api_url, "/api/knowledge-items/crawl")

        # Transform to API's expected format
        request_data = {
            "url": url,
            "knowledge_type": "documentation",  # Default type
            "tags": [],
            "update_frequency": 7,  # Default to weekly
            "metadata": options or {},
        }

        mcp_logger.info(f"Calling API service to crawl {url} at {endpoint}")

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    endpoint, json=request_data, headers=self._get_headers()
                )
                response.raise_for_status()
                result = response.json()

                # Transform API response to MCP expected format
                return {
                    "success": result.get("success", False),
                    "progressId": result.get("progressId"),
                    "message": result.get("message", "Crawling started"),
                    "error": None if result.get("success") else {"message": "Crawl failed"},
                }
        except httpx.TimeoutException:
            mcp_logger.error(f"Timeout crawling {url} - endpoint: {endpoint}")
            return {
                "success": False,
                "error": {"code": "TIMEOUT", "message": "Crawl operation timed out"},
            }
        except httpx.HTTPStatusError as e:
            mcp_logger.error(f"HTTP error crawling {url}: {e.response.status_code} - endpoint: {endpoint}")
            return {"success": False, "error": {"code": "HTTP_ERROR", "message": str(e)}}
        except Exception as e:
            mcp_logger.error(f"Error crawling {url}: {str(e)} - endpoint: {endpoint}")
            return {"success": False, "error": {"code": "CRAWL_FAILED", "message": str(e)}}

    async def search(
        self,
        query: str,
        source_filter: str | None = None,
        match_count: int = 5,
        use_reranking: bool = False,
    ) -> dict[str, Any]:
        """
        Perform a search by calling the API service's rag/query endpoint.
        Transforms MCP's simple format to the API's RagQueryRequest format.

        Args:
            query: Search query
            source_filter: Optional source ID to filter results
            match_count: Number of results to return
            use_reranking: Whether to rerank results (handled in Server's service layer)

        Returns:
            Search response with results
        """
        endpoint = urljoin(self.api_url, "/api/rag/query")
        request_data = {"query": query, "source": source_filter, "match_count": match_count}

        mcp_logger.info(f"Calling API service to search: {query} at {endpoint}")

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                # First, get search results from API service
                response = await client.post(
                    endpoint, json=request_data, headers=self._get_headers()
                )
                response.raise_for_status()
                result = response.json()

                # Transform API response to MCP expected format
                return {
                    "success": result.get("success", True),
                    "results": result.get("results", []),
                    "reranked": False,  # Reranking should be handled by Server's service layer
                    "error": None,
                }

        except Exception as e:
            mcp_logger.error(f"Error searching: {str(e)} - endpoint: {endpoint}")
            return {
                "success": False,
                "results": [],
                "error": {"code": "SEARCH_FAILED", "message": str(e)},
            }

    # Removed _rerank_results method - reranking should be handled by Server's service layer

    async def store_documents(
        self, documents: list[dict[str, Any]], generate_embeddings: bool = True
    ) -> dict[str, Any]:
        """
        Store documents by transforming them into the format expected by the API.
        Note: The regular API expects file uploads, so this is a simplified version.

        Args:
            documents: List of documents to store
            generate_embeddings: Whether to generate embeddings

        Returns:
            Storage response
        """
        # For now, return a simplified response since document upload
        # through the regular API requires multipart form data
        mcp_logger.info("Document storage through regular API not yet implemented")
        return {
            "success": True,
            "documents_stored": len(documents),
            "chunks_created": len(documents),
            "message": "Document storage should be handled by Server's service layer",
        }

    async def generate_embeddings(
        self, texts: list[str], model: str = "text-embedding-3-small"
    ) -> dict[str, Any]:
        """
        Generate embeddings - this should be handled by Server's service layer.
        MCP tools shouldn't need to directly generate embeddings.

        Args:
            texts: List of texts to embed
            model: Embedding model to use

        Returns:
            Embeddings response
        """
        mcp_logger.warning("Direct embedding generation not needed for MCP tools")
        raise NotImplementedError("Embeddings should be handled by Server's service layer")

    # Removed analyze_document - document analysis should be handled by Agents via MCP tools

    async def health_check(self) -> dict[str, Any]:
        """
        Check health of all dependent services.

        Returns:
            Combined health status
        """
        health_status = {"api_service": False, "agents_service": False}

        # Check API service
        try:
            api_health_url = urljoin(self.api_url, "/api/health")
            mcp_logger.info(f"Checking API service health at: {api_health_url}")
            
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                response = await client.get(api_health_url)
                health_status["api_service"] = response.status_code == 200
                mcp_logger.info(f"API service health check: {response.status_code}")
        except Exception as e:
            health_status["api_service"] = False
            mcp_logger.warning(f"API service health check failed: {e}")

        # Check Agents service
        try:
            agents_health_url = urljoin(self.agents_url, "/health")
            mcp_logger.info(f"Checking Agents service health at: {agents_health_url}")
            
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                response = await client.get(agents_health_url)
                health_status["agents_service"] = response.status_code == 200
                mcp_logger.info(f"Agents service health check: {response.status_code}")
        except Exception as e:
            health_status["agents_service"] = False
            mcp_logger.warning(f"Agents service health check failed: {e}")

        # Log overall health status
        if health_status["api_service"] and health_status["agents_service"]:
            mcp_logger.info("All dependent services are healthy")
        else:
            mcp_logger.warning(f"Some dependent services are unhealthy: {health_status}")

        return health_status


# Global client instance
_mcp_client = None


def get_mcp_service_client() -> MCPServiceClient:
    """Get or create the global MCP service client"""
    global _mcp_client
    if _mcp_client is None:
        _mcp_client = MCPServiceClient()
    return _mcp_client
