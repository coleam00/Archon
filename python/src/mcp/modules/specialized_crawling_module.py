"""
Specialized Crawling Module for Archon MCP Server

This module provides MCP tools for:
- Specialized crawling mode management
- E-commerce product data extraction and search
- Crawling mode performance monitoring
- Structured data queries

All operations use HTTP calls to maintain microservices architecture.
"""

import json
import logging
from urllib.parse import urljoin
from typing import Any, Dict, List, Optional

import httpx

from mcp.server.fastmcp import Context, FastMCP

# Import service discovery for HTTP communication
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def register_specialized_crawling_tools(mcp: FastMCP):
    """Register all specialized crawling tools with the MCP server."""

    @mcp.tool()
    async def crawl_ecommerce_site(
        ctx: Context, 
        url: str, 
        extract_pricing: bool = True,
        extract_variants: bool = True,
        anti_bot_mode: bool = False
    ) -> str:
        """
        Crawl an e-commerce website with specialized product data extraction.

        This tool uses advanced e-commerce crawling mode to extract:
        - Product information (name, brand, description)
        - Pricing data (current price, original price, discounts)
        - Product variants (size, color, style options)
        - Customer reviews and ratings
        - Technical specifications
        - Inventory status

        Args:
            url: E-commerce product page URL
            extract_pricing: Whether to extract pricing information
            extract_variants: Whether to extract product variants
            anti_bot_mode: Enable enhanced stealth crawling for bot detection

        Returns:
            JSON string with extracted product data and crawling results
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(120.0, connect=10.0)  # E-commerce crawling can be slow

            async with httpx.AsyncClient(timeout=timeout) as client:
                request_data = {
                    "url": url,
                    "mode": "ecommerce",
                    "knowledge_type": "product",
                    "extract_structured_data": True,
                    "extract_product_data": True,
                    "extract_pricing": extract_pricing,
                    "anti_bot_mode": anti_bot_mode
                }

                response = await client.post(
                    urljoin(api_url, "/api/crawling/specialized"), 
                    json=request_data
                )

                if response.status_code == 200:
                    result = response.json()
                    
                    # Extract product data if available
                    product_data = {}
                    if result.get("structured_data", {}).get("product"):
                        product_data = result["structured_data"]["product"]
                    
                    return json.dumps({
                        "success": True,
                        "url": url,
                        "mode_used": result.get("mode_used", "ecommerce"),
                        "product_data": product_data,
                        "extraction_stats": result.get("extraction_stats", {}),
                        "progress_id": result.get("progress_id"),
                        "message": "E-commerce crawling completed successfully"
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}",
                        "url": url
                    }, indent=2)

        except Exception as e:
            logger.error(f"Error crawling e-commerce site {url}: {e}")
            return json.dumps({
                "success": False,
                "error": str(e),
                "url": url
            }, indent=2)

    @mcp.tool()
    async def get_crawling_modes(ctx: Context) -> str:
        """
        Get information about available crawling modes and their capabilities.

        Returns detailed information about all supported crawling modes including:
        - Mode names and descriptions
        - Capabilities and features
        - Performance statistics
        - Configuration options

        Returns:
            JSON string with available crawling modes and their details
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(urljoin(api_url, "/api/crawling/modes"))

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "modes": result.get("modes", []),
                        "total_modes": len(result.get("modes", []))
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)

        except Exception as e:
            logger.error(f"Error getting crawling modes: {e}")
            return json.dumps({
                "success": False,
                "error": str(e)
            }, indent=2)

    @mcp.tool()
    async def get_mode_performance(ctx: Context, mode: str) -> str:
        """
        Get performance statistics for a specific crawling mode.

        Provides detailed performance metrics including:
        - Success rate and error rate
        - Average response time
        - Total crawls performed
        - Data extraction success rate

        Args:
            mode: Crawling mode name (e.g., 'ecommerce', 'blog', 'standard')

        Returns:
            JSON string with performance statistics for the specified mode
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/crawling/modes/{mode}/performance")
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "mode": mode,
                        "performance": result
                    }, indent=2)
                elif response.status_code == 400:
                    return json.dumps({
                        "success": False,
                        "error": f"Invalid mode: {mode}",
                        "available_modes": ["standard", "ecommerce", "blog", "documentation"]
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)

        except Exception as e:
            logger.error(f"Error getting mode performance for {mode}: {e}")
            return json.dumps({
                "success": False,
                "error": str(e),
                "mode": mode
            }, indent=2)

    @mcp.tool()
    async def search_ecommerce_products(
        ctx: Context, 
        query: str, 
        price_min: Optional[float] = None,
        price_max: Optional[float] = None,
        brand: Optional[str] = None,
        availability: Optional[str] = None,
        match_count: int = 10
    ) -> str:
        """
        Search for e-commerce products in the knowledge base.

        Searches through previously crawled e-commerce product data with filters for:
        - Price range filtering
        - Brand filtering
        - Availability status filtering
        - Semantic search across product descriptions

        Args:
            query: Search query for product names, descriptions, or features
            price_min: Minimum price filter (optional)
            price_max: Maximum price filter (optional) 
            brand: Brand name filter (optional)
            availability: Availability status filter (in_stock, out_of_stock, limited)
            match_count: Maximum number of results to return (default: 10)

        Returns:
            JSON string with matching e-commerce products and their details
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(60.0, connect=10.0)

            # Build search parameters
            search_params = {
                "query": query,
                "match_count": match_count,
                "data_type": "product",
                "extraction_mode": "ecommerce"
            }

            # Add filters if provided
            filters = {}
            if price_min is not None:
                filters["price_min"] = price_min
            if price_max is not None:
                filters["price_max"] = price_max
            if brand:
                filters["brand"] = brand
            if availability:
                filters["availability"] = availability

            if filters:
                search_params["filters"] = filters

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/ecommerce/search"), 
                    json=search_params
                )

                if response.status_code == 200:
                    result = response.json()
                    products = result.get("products", [])
                    
                    return json.dumps({
                        "success": True,
                        "query": query,
                        "filters_applied": filters,
                        "total_results": len(products),
                        "products": products,
                        "search_metadata": {
                            "response_time": result.get("response_time"),
                            "total_indexed": result.get("total_indexed", 0)
                        }
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}",
                        "query": query
                    }, indent=2)

        except Exception as e:
            logger.error(f"Error searching e-commerce products: {e}")
            return json.dumps({
                "success": False,
                "error": str(e),
                "query": query
            }, indent=2)

    @mcp.tool()
    async def crawl_with_mode(
        ctx: Context,
        url: str,
        mode: str,
        extract_structured_data: bool = True,
        stealth_mode: bool = False
    ) -> str:
        """
        Crawl a URL using a specific crawling mode.

        Allows explicit control over which crawling mode to use rather than 
        relying on automatic detection. Useful for:
        - Testing different modes on the same URL
        - Forcing a specific extraction strategy
        - Overriding automatic mode detection

        Args:
            url: URL to crawl
            mode: Specific crawling mode to use (standard, ecommerce, blog, documentation)
            extract_structured_data: Whether to extract structured data
            stealth_mode: Enable stealth crawling features

        Returns:
            JSON string with crawling results using the specified mode
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(120.0, connect=10.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                request_data = {
                    "url": url,
                    "mode": mode,
                    "extract_structured_data": extract_structured_data,
                    "anti_bot_mode": stealth_mode
                }

                response = await client.post(
                    urljoin(api_url, "/api/crawling/specialized"), 
                    json=request_data
                )

                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "url": url,
                        "requested_mode": mode,
                        "actual_mode_used": result.get("mode_used"),
                        "structured_data": result.get("structured_data", {}),
                        "extraction_stats": result.get("extraction_stats", {}),
                        "progress_id": result.get("progress_id")
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}",
                        "url": url,
                        "requested_mode": mode
                    }, indent=2)

        except Exception as e:
            logger.error(f"Error crawling {url} with mode {mode}: {e}")
            return json.dumps({
                "success": False,
                "error": str(e),
                "url": url,
                "requested_mode": mode
            }, indent=2)

    @mcp.tool()
    async def get_product_by_url(ctx: Context, url: str) -> str:
        """
        Get previously extracted product data for a specific URL.

        Retrieves cached product information from the e-commerce database
        without re-crawling the URL. Useful for:
        - Checking if a product has been crawled before
        - Getting the latest extracted data
        - Comparing data over time

        Args:
            url: Product page URL to look up

        Returns:
            JSON string with cached product data if available
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/ecommerce/products"),
                    params={"url": url}
                )

                if response.status_code == 200:
                    result = response.json()
                    if result.get("products"):
                        product = result["products"][0]  # Should be only one for exact URL match
                        return json.dumps({
                            "success": True,
                            "url": url,
                            "product_found": True,
                            "product_data": product,
                            "last_updated": product.get("last_updated_at"),
                            "extraction_metadata": {
                                "platform": product.get("platform_detected"),
                                "confidence": product.get("extraction_confidence")
                            }
                        }, indent=2)
                    else:
                        return json.dumps({
                            "success": True,
                            "url": url,
                            "product_found": False,
                            "message": "No product data found for this URL. Consider crawling it first."
                        }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}",
                        "url": url
                    }, indent=2)

        except Exception as e:
            logger.error(f"Error getting product data for {url}: {e}")
            return json.dumps({
                "success": False,
                "error": str(e),
                "url": url
            }, indent=2)

    # Log successful registration
    logger.info("✓ Specialized crawling tools registered (HTTP-based version)")