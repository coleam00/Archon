"""
Smart Crawling API Module

Enhanced crawling API with specialized modes for different types of websites.
Provides automatic website detection and optimized extraction strategies.
"""

import asyncio
import json
import uuid
from datetime import datetime
from typing import Dict, List, Optional, Any

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

from ..services.crawling.smart_orchestrator import SmartCrawlingOrchestrator
from ..services.crawling.modes import (
    ModeDetector, WebsiteType, list_available_modes, 
    get_config_manager, CrawlModeConfig, CrawlPriority
)
from ..services.crawler_manager import get_crawler
from ..utils import get_supabase_client
from ..config.logfire_config import get_logger, safe_logfire_info, safe_logfire_error

# Import socket handlers for real-time updates
from .socketio_handlers import (
    update_crawl_progress,
    complete_crawl_progress,
    error_crawl_progress
)

logger = get_logger(__name__)
router = APIRouter(prefix="/api/smart-crawl", tags=["smart-crawling"])

# Active crawling sessions for progress tracking
active_smart_crawls: Dict[str, asyncio.Task] = {}


# Request Models
class SmartCrawlRequest(BaseModel):
    """Request model for smart crawling."""
    urls: List[str] = Field(..., min_items=1, max_items=100)
    source_id: str = Field(..., min_length=1)
    force_mode: Optional[str] = Field(None, description="Force specific crawling mode")
    custom_config: Optional[Dict[str, Any]] = Field(None, description="Custom configuration overrides")
    
    class Config:
        schema_extra = {
            "example": {
                "urls": ["https://amazon.com/dp/B08N5WRWNW", "https://example-store.com/products"],
                "source_id": "ecommerce-crawl-001",
                "force_mode": None,
                "custom_config": {
                    "max_pages": 200,
                    "extract_reviews": True
                }
            }
        }


class WebsiteDetectionRequest(BaseModel):
    """Request model for website type detection."""
    url: str = Field(..., description="URL to analyze")
    
    class Config:
        schema_extra = {
            "example": {
                "url": "https://amazon.com"
            }
        }


class ModeConfigRequest(BaseModel):
    """Request model for crawling mode configuration."""
    mode_name: str
    enabled: bool = True
    priority: str = "normal"  # low, normal, high, urgent
    max_pages: int = Field(100, ge=1, le=1000)
    max_depth: int = Field(3, ge=1, le=10)
    concurrent_requests: int = Field(5, ge=1, le=20)
    delay_between_requests: float = Field(1.0, ge=0.1, le=10.0)
    custom_settings: Dict[str, Any] = Field(default_factory=dict)


class EcommerceSearchRequest(BaseModel):
    """Request model for e-commerce product search."""
    query: str = Field(..., min_length=1)
    source_id: Optional[str] = None
    brand: Optional[str] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    limit: int = Field(20, ge=1, le=100)


# Smart Crawling Endpoints
@router.post("/crawl")
async def smart_crawl(
    request: SmartCrawlRequest,
    background_tasks: BackgroundTasks
):
    """
    Perform smart crawling with automatic mode detection and specialized extraction.
    
    This endpoint:
    1. Analyzes URLs to detect website types
    2. Selects appropriate crawling modes
    3. Executes optimized data extraction
    4. Stores results in specialized tables
    5. Provides real-time progress updates
    """
    
    try:
        # Generate progress ID for tracking
        progress_id = str(uuid.uuid4())
        
        safe_logfire_info(f"Starting smart crawl | progress_id={progress_id} | urls={len(request.urls)}")
        
        # Initialize crawler and orchestrator
        crawler = await get_crawler()
        if not crawler:
            raise HTTPException(status_code=500, detail="Crawler not available")
        
        orchestrator = SmartCrawlingOrchestrator(
            crawler=crawler,
            supabase_client=get_supabase_client()
        )
        
        # Create progress callback
        async def progress_callback(status: str, percentage: int, message: str, **kwargs):
            progress_data = {
                "progressId": progress_id,
                "status": status,
                "percentage": percentage,
                "message": message,
                "timestamp": datetime.now().isoformat(),
                **kwargs
            }
            await update_crawl_progress(progress_id, progress_data)
        
        # Start background crawling task
        async def crawl_task():
            try:
                result = await orchestrator.smart_crawl(
                    urls=request.urls,
                    source_id=request.source_id,
                    progress_callback=progress_callback,
                    force_mode=request.force_mode,
                    custom_config=request.custom_config
                )
                
                # Complete progress tracking
                await complete_crawl_progress(progress_id, {
                    "progressId": progress_id,
                    "status": "completed",
                    "percentage": 100,
                    "message": f"Smart crawl completed successfully! Extracted {result.successful_extractions} items.",
                    "result": {
                        "crawl_id": result.crawl_id,
                        "successful_extractions": result.successful_extractions,
                        "failed_extractions": result.failed_extractions,
                        "pages_per_second": result.pages_per_second
                    }
                })
                
            except Exception as e:
                safe_logfire_error(f"Smart crawl failed | progress_id={progress_id} | error={str(e)}")
                await error_crawl_progress(progress_id, {
                    "progressId": progress_id,
                    "status": "error", 
                    "message": f"Smart crawl failed: {str(e)}",
                    "error": str(e)
                })
            finally:
                # Clean up
                if progress_id in active_smart_crawls:
                    del active_smart_crawls[progress_id]
        
        # Start background task
        task = asyncio.create_task(crawl_task())
        active_smart_crawls[progress_id] = task
        background_tasks.add_task(lambda: None)  # Keep task reference
        
        return {
            "success": True,
            "progress_id": progress_id,
            "message": "Smart crawling started successfully",
            "urls_count": len(request.urls),
            "estimated_time_minutes": len(request.urls) * 0.1  # Rough estimate
        }
        
    except Exception as e:
        safe_logfire_error(f"Failed to start smart crawl | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/detect-website-type")
async def detect_website_type(request: WebsiteDetectionRequest):
    """
    Detect website type and get crawling mode recommendations.
    
    Analyzes the given URL to determine its type (e-commerce, blog, documentation, etc.)
    and recommends the most appropriate crawling mode.
    """
    
    try:
        detector = ModeDetector()
        
        # Fetch initial content for detection
        crawler = await get_crawler()
        if not crawler:
            raise HTTPException(status_code=500, detail="Crawler not available")
        
        result = await crawler.arun(url=request.url, timeout=15000)
        
        if not result.success:
            raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {result.error_message}")
        
        html_content = result.cleaned_html or result.html
        
        # Perform detection
        detection_result = await detector.detect_website_type(request.url, html_content)
        
        return {
            "success": True,
            "url": request.url,
            "website_type": detection_result.website_type.value,
            "confidence_score": detection_result.confidence_score,
            "indicators_found": detection_result.indicators_found,
            "recommended_mode": detection_result.recommended_mode,
            "fallback_modes": detection_result.fallback_modes,
            "description": detector.get_type_description(detection_result.website_type)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        safe_logfire_error(f"Website detection failed | url={request.url} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/modes")
async def list_crawling_modes():
    """List all available crawling modes with their descriptions."""
    
    try:
        available_modes = list_available_modes()
        mode_details = []
        
        detector = ModeDetector()
        
        for mode_name in available_modes:
            # Get mode configuration
            config_manager = get_config_manager()
            config = await config_manager.get_configuration(mode_name)
            
            mode_info = {
                "name": mode_name,
                "enabled": config.enabled if config else False,
                "description": _get_mode_description(mode_name),
                "supported_websites": _get_mode_supported_sites(mode_name),
                "configuration": {
                    "max_pages": config.max_pages if config else 100,
                    "max_depth": config.max_depth if config else 3,
                    "concurrent_requests": config.concurrent_requests if config else 5,
                    "custom_settings": config.custom_settings if config else {}
                }
            }
            mode_details.append(mode_info)
        
        return {
            "success": True,
            "modes": mode_details,
            "total_modes": len(mode_details)
        }
        
    except Exception as e:
        safe_logfire_error(f"Failed to list crawling modes | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/modes/{mode_name}/config")
async def get_mode_configuration(mode_name: str):
    """Get configuration for a specific crawling mode."""
    
    try:
        config_manager = get_config_manager()
        config = await config_manager.get_configuration(mode_name)
        
        if not config:
            raise HTTPException(status_code=404, detail=f"Mode '{mode_name}' not found")
        
        return {
            "success": True,
            "mode_name": mode_name,
            "configuration": {
                "enabled": config.enabled,
                "priority": config.priority.value,
                "max_pages": config.max_pages,
                "max_depth": config.max_depth,
                "concurrent_requests": config.concurrent_requests,
                "delay_between_requests": config.delay_between_requests,
                "max_retries": config.max_retries,
                "use_random_user_agents": config.use_random_user_agents,
                "bypass_cloudflare": config.bypass_cloudflare,
                "custom_settings": config.custom_settings
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        safe_logfire_error(f"Failed to get mode configuration | mode={mode_name} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.put("/modes/{mode_name}/config")
async def update_mode_configuration(mode_name: str, request: ModeConfigRequest):
    """Update configuration for a specific crawling mode."""
    
    try:
        config_manager = get_config_manager()
        
        # Convert priority string to enum
        try:
            priority = CrawlPriority(request.priority.lower())
        except ValueError:
            priority = CrawlPriority.NORMAL
        
        # Create new configuration
        new_config = CrawlModeConfig(
            mode_name=mode_name,
            enabled=request.enabled,
            priority=priority,
            max_pages=request.max_pages,
            max_depth=request.max_depth,
            concurrent_requests=request.concurrent_requests,
            delay_between_requests=request.delay_between_requests,
            custom_settings=request.custom_settings
        )
        
        # Save configuration
        success = await config_manager.save_configuration(mode_name, new_config)
        
        if not success:
            raise HTTPException(status_code=500, detail="Failed to save configuration")
        
        return {
            "success": True,
            "mode_name": mode_name,
            "message": "Configuration updated successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        safe_logfire_error(f"Failed to update mode configuration | mode={mode_name} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


# E-commerce Specific Endpoints
@router.get("/ecommerce/products")
async def get_ecommerce_products(
    source_id: Optional[str] = None,
    brand: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    page: int = 1,
    limit: int = 20
):
    """Get e-commerce products with filtering options."""
    
    try:
        supabase = get_supabase_client()
        
        # Build query
        query = supabase.table("archon_ecommerce_products").select("*")
        
        # Apply filters
        if source_id:
            query = query.eq("source_id", source_id)
        if brand:
            query = query.ilike("brand", f"%{brand}%")
        if min_price is not None:
            query = query.gte("current_price", min_price)
        if max_price is not None:
            query = query.lte("current_price", max_price)
        
        # Apply pagination
        offset = (page - 1) * limit
        query = query.range(offset, offset + limit - 1)
        
        # Order by creation date
        query = query.order("created_at", desc=True)
        
        result = query.execute()
        
        return {
            "success": True,
            "products": result.data,
            "page": page,
            "limit": limit,
            "total": len(result.data)
        }
        
    except Exception as e:
        safe_logfire_error(f"Failed to get e-commerce products | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/ecommerce/products/{product_id}")
async def get_ecommerce_product(product_id: str):
    """Get detailed information for a specific e-commerce product."""
    
    try:
        supabase = get_supabase_client()
        
        # Get product details
        product_result = supabase.table("archon_ecommerce_products").select("*").eq("id", product_id).execute()
        
        if not product_result.data:
            raise HTTPException(status_code=404, detail="Product not found")
        
        product = product_result.data[0]
        
        # Get variants
        variants_result = supabase.table("archon_product_variants").select("*").eq("product_id", product_id).execute()
        
        # Get price history
        price_history_result = supabase.table("archon_price_history").select("*").eq("product_id", product_id).order("recorded_at", desc=True).limit(10).execute()
        
        # Get reviews
        reviews_result = supabase.table("archon_product_reviews").select("*").eq("product_id", product_id).order("review_date", desc=True).limit(10).execute()
        
        return {
            "success": True,
            "product": product,
            "variants": variants_result.data,
            "price_history": price_history_result.data,
            "reviews": reviews_result.data
        }
        
    except HTTPException:
        raise
    except Exception as e:
        safe_logfire_error(f"Failed to get product details | product_id={product_id} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/ecommerce/search")
async def search_ecommerce_products(request: EcommerceSearchRequest):
    """Search e-commerce products using text search and filters."""
    
    try:
        supabase = get_supabase_client()
        
        # Build search query
        query = supabase.table("archon_ecommerce_products").select("*")
        
        # Text search across name and description
        if request.query:
            query = query.or_(f"name.ilike.%{request.query}%,description.ilike.%{request.query}%")
        
        # Apply filters
        if request.source_id:
            query = query.eq("source_id", request.source_id)
        if request.brand:
            query = query.ilike("brand", f"%{request.brand}%")
        if request.min_price is not None:
            query = query.gte("current_price", request.min_price)
        if request.max_price is not None:
            query = query.lte("current_price", request.max_price)
        
        # Apply limit and ordering
        query = query.order("created_at", desc=True).limit(request.limit)
        
        result = query.execute()
        
        return {
            "success": True,
            "query": request.query,
            "products": result.data,
            "total_found": len(result.data)
        }
        
    except Exception as e:
        safe_logfire_error(f"E-commerce search failed | query={request.query} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


# Analytics and Performance Endpoints
@router.get("/analytics/sessions")
async def get_crawl_sessions(
    mode: Optional[str] = None,
    days: int = 7,
    limit: int = 50
):
    """Get crawling session analytics and performance metrics."""
    
    try:
        supabase = get_supabase_client()
        
        # Calculate date range
        from datetime import timedelta
        start_date = (datetime.now() - timedelta(days=days)).isoformat()
        
        # Build query
        query = supabase.table("archon_crawl_sessions").select("*").gte("session_start", start_date)
        
        if mode:
            query = query.eq("crawl_mode", mode)
        
        query = query.order("session_start", desc=True).limit(limit)
        
        result = query.execute()
        
        # Calculate summary statistics
        sessions = result.data
        total_sessions = len(sessions)
        avg_pages_per_second = sum(s.get("pages_per_second", 0) for s in sessions) / max(total_sessions, 1)
        avg_success_rate = sum(s.get("successful_extractions", 0) for s in sessions) / max(total_sessions, 1)
        
        return {
            "success": True,
            "sessions": sessions,
            "summary": {
                "total_sessions": total_sessions,
                "avg_pages_per_second": avg_pages_per_second,
                "avg_success_rate": avg_success_rate,
                "date_range_days": days
            }
        }
        
    except Exception as e:
        safe_logfire_error(f"Failed to get crawl sessions | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/cancel/{progress_id}")
async def cancel_crawl(progress_id: str):
    """Cancel an active smart crawling operation."""
    
    try:
        if progress_id in active_smart_crawls:
            task = active_smart_crawls[progress_id]
            task.cancel()
            del active_smart_crawls[progress_id]
            
            # Send cancellation notification
            await update_crawl_progress(progress_id, {
                "progressId": progress_id,
                "status": "cancelled",
                "percentage": 0,
                "message": "Crawling operation cancelled by user"
            })
            
            return {
                "success": True,
                "message": "Crawl operation cancelled successfully"
            }
        else:
            raise HTTPException(status_code=404, detail="Crawl session not found")
            
    except HTTPException:
        raise
    except Exception as e:
        safe_logfire_error(f"Failed to cancel crawl | progress_id={progress_id} | error={str(e)}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


# Helper functions
def _get_mode_description(mode_name: str) -> str:
    """Get description for a crawling mode."""
    descriptions = {
        "ecommerce": "Advanced e-commerce product and pricing data extraction",
        "blog": "Blog and article content extraction with metadata",
        "documentation": "Technical documentation and API reference extraction",
        "analytics": "Analytics dashboards and metrics data extraction"
    }
    return descriptions.get(mode_name, f"{mode_name.title()} crawling mode")


def _get_mode_supported_sites(mode_name: str) -> List[str]:
    """Get examples of supported sites for a mode."""
    examples = {
        "ecommerce": ["Amazon", "eBay", "Shopify stores", "WooCommerce sites"],
        "blog": ["WordPress blogs", "Medium", "Substack", "Personal blogs"],
        "documentation": ["API docs", "GitHub wikis", "GitBook", "Confluence"],
        "analytics": ["Dashboards", "Reporting tools", "Metrics platforms"]
    }
    return examples.get(mode_name, ["General websites"])