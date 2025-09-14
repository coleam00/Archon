"""
E-commerce MCP Tools Module

Provides MCP tools for accessing and managing e-commerce data crawled by smart crawling modes.
Enables AI assistants to query product information, price data, and perform competitive analysis.
"""

import json
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import httpx
from mcp.server.fastmcp import Context, FastMCP

# Import service discovery for HTTP communication
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def register_ecommerce_tools(mcp: FastMCP):
    """Register e-commerce and smart crawling MCP tools."""

    @mcp.tool()
    async def smart_crawl_website(
        ctx: Context,
        urls: str,
        source_id: str,
        crawling_mode: str = "auto",
        extract_products: bool = True,
        extract_prices: bool = True
    ) -> str:
        """
        Perform smart crawling of websites with automatic mode detection.
        
        This tool uses advanced crawling strategies to extract structured data from different
        types of websites including e-commerce stores, blogs, documentation sites, and more.
        
        Args:
            urls: Comma-separated list of URLs to crawl
            source_id: Unique identifier for this crawling session
            crawling_mode: Crawling mode - "auto" (automatic detection), "ecommerce", "blog", "documentation", "analytics"
            extract_products: Whether to extract product information (for e-commerce sites)
            extract_prices: Whether to extract pricing data (for e-commerce sites)
            
        Returns:
            JSON string with crawling results and extracted data
        """
        
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(300.0, connect=10.0)  # Longer timeout for crawling
            
            # Parse URLs
            url_list = [url.strip() for url in urls.split(',') if url.strip()]
            
            if not url_list:
                return json.dumps({"success": False, "error": "No valid URLs provided"})
            
            # Prepare request
            request_data = {
                "urls": url_list,
                "source_id": source_id,
                "force_mode": None if crawling_mode == "auto" else crawling_mode,
                "custom_config": {
                    "extract_products": extract_products,
                    "extract_prices": extract_prices,
                    "extract_reviews": extract_products,  # Extract reviews if extracting products
                    "extract_variants": extract_products   # Extract variants if extracting products
                }
            }
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/smart-crawl/crawl"),
                    json=request_data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "progress_id": result.get("progress_id"),
                        "message": result.get("message"),
                        "urls_count": result.get("urls_count"),
                        "estimated_time_minutes": result.get("estimated_time_minutes"),
                        "note": "Use get_crawl_progress tool to monitor crawling status"
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)
                    
        except Exception as e:
            logger.error(f"Smart crawl failed: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    @mcp.tool()
    async def detect_website_type(ctx: Context, url: str) -> str:
        """
        Detect the type of a website and get crawling recommendations.
        
        Analyzes a website to determine its type (e-commerce, blog, documentation, etc.)
        and recommends the most appropriate crawling strategy.
        
        Args:
            url: The website URL to analyze
            
        Returns:
            JSON string with website type detection results and recommendations
        """
        
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=10.0)
            
            request_data = {"url": url}
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/smart-crawl/detect-website-type"),
                    json=request_data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    return json.dumps({
                        "success": True,
                        "url": result.get("url"),
                        "website_type": result.get("website_type"),
                        "confidence_score": result.get("confidence_score"),
                        "recommended_mode": result.get("recommended_mode"),
                        "fallback_modes": result.get("fallback_modes"),
                        "description": result.get("description"),
                        "indicators_found": result.get("indicators_found", [])
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)
                    
        except Exception as e:
            logger.error(f"Website detection failed: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    @mcp.tool()
    async def search_ecommerce_products(
        ctx: Context,
        query: str,
        source_id: str = None,
        brand: str = None,
        min_price: float = None,
        max_price: float = None,
        limit: int = 20
    ) -> str:
        """
        Search for e-commerce products in the crawled data.
        
        Search through products that have been extracted from e-commerce websites
        using various filters like brand, price range, and text search.
        
        Args:
            query: Search query to match product names and descriptions
            source_id: Optional source ID to filter by specific crawling session
            brand: Optional brand name to filter by
            min_price: Minimum price filter
            max_price: Maximum price filter  
            limit: Maximum number of results to return (1-100)
            
        Returns:
            JSON string with matching products and their details
        """
        
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)
            
            request_data = {
                "query": query,
                "source_id": source_id,
                "brand": brand,
                "min_price": min_price,
                "max_price": max_price,
                "limit": min(limit, 100)  # Cap at 100
            }
            
            # Remove None values
            request_data = {k: v for k, v in request_data.items() if v is not None}
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/smart-crawl/ecommerce/search"),
                    json=request_data
                )
                
                if response.status_code == 200:
                    result = response.json()
                    
                    # Format products for better readability
                    products = result.get("products", [])
                    formatted_products = []
                    
                    for product in products:
                        formatted_product = {
                            "id": product.get("id"),
                            "name": product.get("name"),
                            "brand": product.get("brand"),
                            "current_price": product.get("current_price"),
                            "original_price": product.get("original_price"),
                            "currency": product.get("currency"),
                            "discount_percent": product.get("discount_percent"),
                            "rating": product.get("rating"),
                            "review_count": product.get("review_count"),
                            "in_stock": product.get("in_stock"),
                            "url": product.get("url"),
                            "description": product.get("description", "")[:200] + "..." if product.get("description") and len(product.get("description", "")) > 200 else product.get("description"),
                        }
                        formatted_products.append(formatted_product)
                    
                    return json.dumps({
                        "success": True,
                        "query": result.get("query"),
                        "total_found": result.get("total_found"),
                        "products": formatted_products
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)
                    
        except Exception as e:
            logger.error(f"E-commerce search failed: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    @mcp.tool()
    async def get_product_details(ctx: Context, product_id: str) -> str:
        """
        Get detailed information for a specific e-commerce product.
        
        Retrieves comprehensive product data including variants, price history,
        customer reviews, and specifications for a specific product.
        
        Args:
            product_id: The unique ID of the product to retrieve
            
        Returns:
            JSON string with detailed product information
        """
        
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, f"/api/smart-crawl/ecommerce/products/{product_id}")
                )
                
                if response.status_code == 200:
                    result = response.json()
                    
                    product = result.get("product", {})
                    variants = result.get("variants", [])
                    price_history = result.get("price_history", [])
                    reviews = result.get("reviews", [])
                    
                    return json.dumps({
                        "success": True,
                        "product": {
                            "id": product.get("id"),
                            "name": product.get("name"),
                            "brand": product.get("brand"),
                            "description": product.get("description"),
                            "current_price": product.get("current_price"),
                            "original_price": product.get("original_price"),
                            "currency": product.get("currency"),
                            "discount_percent": product.get("discount_percent"),
                            "rating": product.get("rating"),
                            "review_count": product.get("review_count"),
                            "in_stock": product.get("in_stock"),
                            "availability_status": product.get("availability_status"),
                            "url": product.get("url"),
                            "images": json.loads(product.get("images", "[]")) if product.get("images") else [],
                            "specifications": json.loads(product.get("specifications", "{}")) if product.get("specifications") else {},
                            "features": json.loads(product.get("features", "[]")) if product.get("features") else []
                        },
                        "variants": variants,
                        "price_history": price_history[:10],  # Last 10 price changes
                        "recent_reviews": reviews[:5],  # Last 5 reviews
                        "variant_count": len(variants),
                        "price_changes": len(price_history)
                    }, indent=2)
                elif response.status_code == 404:
                    return json.dumps({
                        "success": False,
                        "error": "Product not found"
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)
                    
        except Exception as e:
            logger.error(f"Get product details failed: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    @mcp.tool()
    async def get_price_intelligence(
        ctx: Context,
        product_name: str = None,
        brand: str = None,
        days: int = 30
    ) -> str:
        """
        Get price intelligence and competitive analysis for products.
        
        Analyzes pricing trends, discounts, and competitive positioning
        for products in the database over a specified time period.
        
        Args:
            product_name: Optional product name filter
            brand: Optional brand filter
            days: Number of days to analyze (default: 30)
            
        Returns:
            JSON string with price intelligence insights
        """
        
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)
            
            # Build query parameters
            params = {"days": days}
            if brand:
                params["brand"] = brand
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, "/api/smart-crawl/ecommerce/products"),
                    params=params
                )
                
                if response.status_code == 200:
                    result = response.json()
                    products = result.get("products", [])
                    
                    # Filter by product name if provided
                    if product_name:
                        products = [p for p in products if product_name.lower() in p.get("name", "").lower()]
                    
                    # Analyze pricing data
                    price_analysis = {
                        "total_products": len(products),
                        "price_ranges": {},
                        "discount_analysis": {},
                        "brand_comparison": {},
                        "top_discounts": [],
                        "price_trends": []
                    }
                    
                    if products:
                        # Price range analysis
                        prices = [p.get("current_price") for p in products if p.get("current_price")]
                        if prices:
                            price_analysis["price_ranges"] = {
                                "min_price": min(prices),
                                "max_price": max(prices),
                                "avg_price": sum(prices) / len(prices),
                                "median_price": sorted(prices)[len(prices) // 2]
                            }
                        
                        # Discount analysis
                        discounted_products = [p for p in products if p.get("discount_percent") and p.get("discount_percent") > 0]
                        if discounted_products:
                            discounts = [p.get("discount_percent") for p in discounted_products]
                            price_analysis["discount_analysis"] = {
                                "products_on_sale": len(discounted_products),
                                "avg_discount": sum(discounts) / len(discounts),
                                "max_discount": max(discounts),
                                "total_products_with_discount": len(discounted_products)
                            }
                        
                        # Top discounts
                        top_discounts = sorted(discounted_products, key=lambda x: x.get("discount_percent", 0), reverse=True)[:5]
                        price_analysis["top_discounts"] = [
                            {
                                "name": p.get("name"),
                                "brand": p.get("brand"),
                                "original_price": p.get("original_price"),
                                "current_price": p.get("current_price"),
                                "discount_percent": p.get("discount_percent"),
                                "url": p.get("url")
                            }
                            for p in top_discounts
                        ]
                        
                        # Brand comparison
                        from collections import defaultdict
                        brand_data = defaultdict(list)
                        for p in products:
                            if p.get("brand") and p.get("current_price"):
                                brand_data[p.get("brand")].append(p.get("current_price"))
                        
                        price_analysis["brand_comparison"] = {
                            brand: {
                                "product_count": len(prices),
                                "avg_price": sum(prices) / len(prices),
                                "min_price": min(prices),
                                "max_price": max(prices)
                            }
                            for brand, prices in brand_data.items()
                        }
                    
                    return json.dumps({
                        "success": True,
                        "filters_applied": {
                            "product_name": product_name,
                            "brand": brand,
                            "days": days
                        },
                        "analysis": price_analysis
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)
                    
        except Exception as e:
            logger.error(f"Price intelligence failed: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    @mcp.tool()
    async def get_crawling_modes(ctx: Context) -> str:
        """
        Get available crawling modes and their configurations.
        
        Lists all available smart crawling modes with their descriptions,
        supported website types, and current configuration settings.
        
        Returns:
            JSON string with available crawling modes and their details
        """
        
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)
            
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(
                    urljoin(api_url, "/api/smart-crawl/modes")
                )
                
                if response.status_code == 200:
                    result = response.json()
                    
                    return json.dumps({
                        "success": True,
                        "total_modes": result.get("total_modes"),
                        "available_modes": result.get("modes", [])
                    }, indent=2)
                else:
                    error_detail = response.text
                    return json.dumps({
                        "success": False,
                        "error": f"HTTP {response.status_code}: {error_detail}"
                    }, indent=2)
                    
        except Exception as e:
            logger.error(f"Get crawling modes failed: {e}")
            return json.dumps({"success": False, "error": str(e)}, indent=2)

    # Log successful registration
    logger.info("✓ E-commerce MCP tools registered (HTTP-based version)")