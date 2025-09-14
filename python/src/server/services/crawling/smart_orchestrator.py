"""
Smart Crawling Orchestrator

Enhanced crawling service that automatically detects website types and 
applies appropriate specialized crawling modes for optimal data extraction.

Features:
- Automatic website type detection
- Mode-specific extraction strategies
- Performance monitoring and optimization
- Anti-bot detection countermeasures
- Advanced price tracking for e-commerce
"""

import asyncio
import json
import uuid
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Callable, Awaitable
from urllib.parse import urlparse

from .modes import (
    ModeDetector, WebsiteType, get_mode, register_mode, 
    CrawlModeConfig, CrawlResult, ExtractedData,
    ConfigManager, get_config_manager
)
from ..config.logfire_config import safe_logfire_info, safe_logfire_error, get_logger
from ..utils import get_supabase_client

logger = get_logger(__name__)


class SmartCrawlingOrchestrator:
    """
    Orchestrates smart crawling with automatic mode detection and specialized extraction.
    """
    
    def __init__(self, crawler=None, supabase_client=None):
        """Initialize the smart crawling orchestrator."""
        self.crawler = crawler
        self.supabase = supabase_client or get_supabase_client()
        
        # Initialize components
        self.mode_detector = ModeDetector()
        self.config_manager = get_config_manager()
        
        # Performance tracking
        self.session_metrics = {}
        self._active_sessions = {}
        
    async def smart_crawl(
        self,
        urls: List[str],
        source_id: str,
        progress_callback: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
        force_mode: Optional[str] = None,
        custom_config: Optional[Dict[str, Any]] = None
    ) -> CrawlResult:
        """
        Perform smart crawling with automatic mode detection and optimization.
        
        Args:
            urls: List of URLs to crawl
            source_id: Source identifier for data storage
            progress_callback: Progress update callback
            force_mode: Force specific crawling mode (optional)
            custom_config: Custom configuration overrides
            
        Returns:
            CrawlResult with extracted data and performance metrics
        """
        
        crawl_id = str(uuid.uuid4())
        start_time = datetime.now()
        
        safe_logfire_info(f"Starting smart crawl | crawl_id={crawl_id} | urls={len(urls)}")
        
        try:
            # Initialize crawl session
            session_id = await self._initialize_session(crawl_id, source_id, urls)
            
            # Phase 1: Detect website types and select modes
            if progress_callback:
                await progress_callback("detecting", 10, "Analyzing website types...")
            
            mode_assignments = await self._detect_and_assign_modes(
                urls, force_mode, custom_config
            )
            
            # Phase 2: Configure crawling strategies
            if progress_callback:
                await progress_callback("configuring", 20, "Configuring crawling strategies...")
            
            crawl_configs = await self._prepare_crawl_configurations(mode_assignments)
            
            # Phase 3: Execute specialized crawling
            if progress_callback:
                await progress_callback("crawling", 30, "Executing smart crawling...")
            
            crawl_results = await self._execute_smart_crawling(
                crawl_configs, source_id, progress_callback, session_id
            )
            
            # Phase 4: Post-process and store data
            if progress_callback:
                await progress_callback("processing", 80, "Processing extracted data...")
            
            processed_results = await self._post_process_results(
                crawl_results, source_id, session_id
            )
            
            # Phase 5: Finalize session
            if progress_callback:
                await progress_callback("finalizing", 95, "Finalizing crawl session...")
            
            final_result = await self._finalize_session(
                session_id, processed_results, start_time
            )
            
            if progress_callback:
                await progress_callback("complete", 100, "Smart crawling completed successfully!")
            
            safe_logfire_info(f"Smart crawl completed | crawl_id={crawl_id} | extracted={len(final_result.extracted_data)}")
            
            return final_result
            
        except Exception as e:
            safe_logfire_error(f"Smart crawl failed | crawl_id={crawl_id} | error={str(e)}")
            
            if progress_callback:
                await progress_callback("error", 0, f"Crawl failed: {str(e)}")
            
            # Create error result
            return CrawlResult(
                crawl_id=crawl_id,
                mode="smart_mixed",
                start_time=start_time,
                end_time=datetime.now(),
                total_urls=len(urls),
                errors=[{"type": "crawl_error", "message": str(e)}]
            )
    
    async def _detect_and_assign_modes(
        self,
        urls: List[str],
        force_mode: Optional[str],
        custom_config: Optional[Dict[str, Any]]
    ) -> Dict[str, Dict[str, Any]]:
        """Detect website types and assign appropriate crawling modes."""
        
        mode_assignments = {}
        
        for url in urls:
            try:
                if force_mode:
                    # Use forced mode
                    mode_assignments[url] = {
                        "mode": force_mode,
                        "website_type": WebsiteType.UNKNOWN,
                        "confidence": 1.0,
                        "detection_method": "forced"
                    }
                else:
                    # Fetch initial page for detection
                    initial_content = await self._fetch_initial_content(url)
                    
                    if initial_content:
                        # Detect website type
                        detection_result = await self.mode_detector.detect_website_type(
                            url, initial_content
                        )
                        
                        mode_assignments[url] = {
                            "mode": detection_result.recommended_mode,
                            "fallback_modes": detection_result.fallback_modes,
                            "website_type": detection_result.website_type,
                            "confidence": detection_result.confidence_score,
                            "detection_method": "automatic",
                            "indicators": detection_result.indicators_found
                        }
                        
                        # Store classification result
                        await self._store_website_classification(url, detection_result)
                        
                    else:
                        # Fallback to documentation mode
                        mode_assignments[url] = {
                            "mode": "documentation",
                            "website_type": WebsiteType.UNKNOWN,
                            "confidence": 0.0,
                            "detection_method": "fallback"
                        }
                        
            except Exception as e:
                safe_logfire_error(f"Mode detection failed for {url}: {str(e)}")
                mode_assignments[url] = {
                    "mode": "documentation",
                    "website_type": WebsiteType.UNKNOWN,
                    "confidence": 0.0,
                    "detection_method": "error_fallback",
                    "error": str(e)
                }
        
        return mode_assignments
    
    async def _prepare_crawl_configurations(
        self,
        mode_assignments: Dict[str, Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Prepare crawling configurations for each detected mode."""
        
        # Group URLs by mode
        mode_groups = {}
        for url, assignment in mode_assignments.items():
            mode = assignment["mode"]
            if mode not in mode_groups:
                mode_groups[mode] = []
            mode_groups[mode].append((url, assignment))
        
        # Prepare configurations for each mode
        crawl_configs = {}
        
        for mode_name, url_assignments in mode_groups.items():
            try:
                # Get mode configuration
                config = await self.config_manager.get_configuration(mode_name)
                
                if not config:
                    safe_logfire_error(f"No configuration found for mode: {mode_name}")
                    continue
                
                # Create mode instance
                mode_instance = get_mode(mode_name, config)
                
                if not mode_instance:
                    safe_logfire_error(f"Failed to create mode instance: {mode_name}")
                    continue
                
                crawl_configs[mode_name] = {
                    "mode_instance": mode_instance,
                    "config": config,
                    "urls": [url for url, _ in url_assignments],
                    "assignments": dict(url_assignments)
                }
                
            except Exception as e:
                safe_logfire_error(f"Failed to prepare config for mode {mode_name}: {str(e)}")
                continue
        
        return crawl_configs
    
    async def _execute_smart_crawling(
        self,
        crawl_configs: Dict[str, Any],
        source_id: str,
        progress_callback: Optional[Callable],
        session_id: str
    ) -> Dict[str, List[ExtractedData]]:
        """Execute crawling with specialized modes."""
        
        results = {}
        total_modes = len(crawl_configs)
        completed_modes = 0
        
        for mode_name, config in crawl_configs.items():
            try:
                safe_logfire_info(f"Executing {mode_name} mode | urls={len(config['urls'])}")
                
                mode_instance = config["mode_instance"]
                urls = config["urls"]
                
                # Create mode-specific progress callback
                async def mode_progress_callback(status, percentage, message, **kwargs):
                    if progress_callback:
                        # Calculate overall progress (30-80% of total)
                        base_progress = 30 + (completed_modes / total_modes) * 50
                        mode_progress = (percentage / 100) * (50 / total_modes)
                        overall_progress = int(base_progress + mode_progress)
                        
                        await progress_callback(
                            status, 
                            overall_progress, 
                            f"[{mode_name}] {message}",
                            **kwargs
                        )
                
                # Execute mode-specific crawling
                mode_results = await self._crawl_with_mode(
                    mode_instance, urls, source_id, mode_progress_callback
                )
                
                results[mode_name] = mode_results
                completed_modes += 1
                
                safe_logfire_info(f"Completed {mode_name} mode | extracted={len(mode_results)}")
                
            except Exception as e:
                safe_logfire_error(f"Mode {mode_name} failed: {str(e)}")
                results[mode_name] = []
                completed_modes += 1
        
        return results
    
    async def _crawl_with_mode(
        self,
        mode_instance,
        urls: List[str],
        source_id: str,
        progress_callback: Optional[Callable]
    ) -> List[ExtractedData]:
        """Execute crawling with a specific mode instance."""
        
        extracted_data = []
        total_urls = len(urls)
        
        for i, url in enumerate(urls):
            try:
                if progress_callback:
                    progress = int((i / total_urls) * 100)
                    await progress_callback(
                        "crawling", 
                        progress, 
                        f"Processing {url}..."
                    )
                
                # Check if mode should crawl this URL
                if not mode_instance.should_crawl_url(url):
                    safe_logfire_info(f"Skipping URL {url} per mode policy")
                    continue
                
                # Fetch page content with mode-specific settings
                html_content = await self._fetch_with_mode_settings(url, mode_instance)
                
                if not html_content:
                    continue
                
                # Extract data using mode-specific strategy
                extracted = await mode_instance.extract_data(url, html_content)
                
                # Validate extracted data
                if await mode_instance.validate_extracted_data(extracted):
                    # Post-process data
                    processed = await mode_instance.postprocess_data(extracted)
                    extracted_data.append(processed)
                    
                    safe_logfire_info(f"Extracted data from {url} | quality={processed.data_quality}")
                else:
                    safe_logfire_error(f"Data validation failed for {url}")
                
                # Respect delay between requests
                if i < total_urls - 1:  # Don't delay after the last URL
                    await asyncio.sleep(mode_instance.config.delay_between_requests)
                
            except Exception as e:
                safe_logfire_error(f"Failed to process {url}: {str(e)}")
                continue
        
        return extracted_data
    
    async def _fetch_with_mode_settings(self, url: str, mode_instance) -> Optional[str]:
        """Fetch page content with mode-specific browser settings."""
        
        if not self.crawler:
            return None
        
        try:
            # Get mode-specific headers and wait strategy
            custom_headers = mode_instance.get_custom_headers(url)
            wait_strategy = mode_instance.get_wait_strategy(url)
            
            # Crawl with mode settings
            result = await self.crawler.arun(
                url=url,
                headers=custom_headers,
                wait_for=wait_strategy.get("wait_for", "domcontentloaded"),
                timeout=wait_strategy.get("timeout", 30000),
                delay_before_return_html=wait_strategy.get("delay", 1.0)
            )
            
            if result.success:
                return result.cleaned_html or result.html
            else:
                safe_logfire_error(f"Crawler failed for {url}: {result.error_message}")
                return None
                
        except Exception as e:
            safe_logfire_error(f"Fetch failed for {url}: {str(e)}")
            return None
    
    async def _post_process_results(
        self,
        crawl_results: Dict[str, List[ExtractedData]],
        source_id: str,
        session_id: str
    ) -> Dict[str, Any]:
        """Post-process crawling results and store specialized data."""
        
        processed_results = {
            "total_extracted": 0,
            "mode_results": {},
            "ecommerce_products": [],
            "blog_posts": [],
            "documentation_pages": [],
            "analytics_data": []
        }
        
        for mode_name, mode_data in crawl_results.items():
            processed_results["total_extracted"] += len(mode_data)
            processed_results["mode_results"][mode_name] = len(mode_data)
            
            # Store mode-specific data
            if mode_name == "ecommerce":
                ecommerce_products = await self._store_ecommerce_data(mode_data, source_id)
                processed_results["ecommerce_products"] = ecommerce_products
            
            elif mode_name == "blog":
                processed_results["blog_posts"] = [
                    data.structured_data.get("blog", {}) for data in mode_data
                ]
            
            elif mode_name == "documentation":
                processed_results["documentation_pages"] = [
                    data.structured_data.get("documentation", {}) for data in mode_data
                ]
            
            elif mode_name == "analytics":
                processed_results["analytics_data"] = [
                    data.structured_data.get("analytics", {}) for data in mode_data
                ]
        
        return processed_results
    
    async def _store_ecommerce_data(
        self,
        extracted_data: List[ExtractedData],
        source_id: str
    ) -> List[Dict[str, Any]]:
        """Store e-commerce specific data in specialized tables."""
        
        stored_products = []
        
        for data in extracted_data:
            try:
                product_data = data.structured_data.get("product", {})
                if not product_data:
                    continue
                
                # Store main product data
                product_id = str(uuid.uuid4())
                
                product_record = {
                    "id": product_id,
                    "source_id": source_id,
                    "url": data.url,
                    "name": product_data.get("name"),
                    "description": product_data.get("description"),
                    "short_description": product_data.get("short_description"),
                    "sku": product_data.get("sku"),
                    "brand": product_data.get("brand"),
                    "categories": json.dumps(product_data.get("category", [])),
                    "current_price": product_data.get("pricing", {}).get("current_price"),
                    "original_price": product_data.get("pricing", {}).get("original_price"),
                    "currency": product_data.get("pricing", {}).get("currency", "USD"),
                    "discount_percent": product_data.get("pricing", {}).get("discount_percent"),
                    "discount_amount": product_data.get("pricing", {}).get("discount_amount"),
                    "in_stock": product_data.get("in_stock"),
                    "stock_count": product_data.get("stock_count"),
                    "availability_status": product_data.get("availability_status"),
                    "images": json.dumps(product_data.get("images", [])),
                    "videos": json.dumps(product_data.get("videos", [])),
                    "rating": product_data.get("rating"),
                    "review_count": product_data.get("review_count"),
                    "specifications": json.dumps(product_data.get("specifications", {})),
                    "features": json.dumps(product_data.get("features", [])),
                    "data_quality": data.data_quality.value,
                    "confidence_score": data.confidence_score,
                    "extraction_mode": "ecommerce"
                }
                
                # Insert product
                result = self.supabase.table("archon_ecommerce_products").insert(
                    product_record
                ).execute()
                
                if result.data:
                    stored_products.append(result.data[0])
                    
                    # Store variants if present
                    variants = product_data.get("variants", [])
                    for variant in variants:
                        variant_record = {
                            "product_id": product_id,
                            "sku": variant.get("sku"),
                            "name": variant.get("name"),
                            "attributes": json.dumps(variant.get("attributes", {})),
                            "price": variant.get("price"),
                            "original_price": variant.get("original_price"),
                            "availability": variant.get("availability"),
                            "inventory_count": variant.get("inventory_count")
                        }
                        
                        self.supabase.table("archon_product_variants").insert(
                            variant_record
                        ).execute()
                
            except Exception as e:
                safe_logfire_error(f"Failed to store e-commerce data: {str(e)}")
                continue
        
        return stored_products
    
    async def _fetch_initial_content(self, url: str) -> Optional[str]:
        """Fetch initial content for website type detection."""
        
        if not self.crawler:
            return None
        
        try:
            result = await self.crawler.arun(
                url=url,
                timeout=15000,  # Shorter timeout for detection
                delay_before_return_html=0.5
            )
            
            if result.success:
                return result.cleaned_html or result.html
            
        except Exception as e:
            safe_logfire_error(f"Failed to fetch initial content for {url}: {str(e)}")
        
        return None
    
    async def _store_website_classification(
        self,
        url: str,
        detection_result
    ) -> bool:
        """Store website classification result."""
        
        try:
            classification_record = {
                "url": url,
                "detected_type": detection_result.website_type.value,
                "confidence_score": detection_result.confidence_score,
                "indicators_found": json.dumps(detection_result.indicators_found),
                "recommended_mode": detection_result.recommended_mode,
                "fallback_modes": json.dumps(detection_result.fallback_modes),
                "detection_method": "automatic"
            }
            
            result = self.supabase.table("archon_website_classifications").insert(
                classification_record
            ).execute()
            
            return bool(result.data)
            
        except Exception as e:
            safe_logfire_error(f"Failed to store classification for {url}: {str(e)}")
            return False
    
    async def _initialize_session(
        self,
        crawl_id: str,
        source_id: str,
        urls: List[str]
    ) -> str:
        """Initialize crawling session tracking."""
        
        try:
            session_record = {
                "id": crawl_id,
                "source_id": source_id,
                "crawl_mode": "smart_mixed",
                "total_pages": len(urls),
                "config_snapshot": json.dumps({
                    "smart_crawling": True,
                    "auto_detection": True,
                    "total_urls": len(urls)
                })
            }
            
            result = self.supabase.table("archon_crawl_sessions").insert(
                session_record
            ).execute()
            
            return crawl_id
            
        except Exception as e:
            safe_logfire_error(f"Failed to initialize session: {str(e)}")
            return crawl_id
    
    async def _finalize_session(
        self,
        session_id: str,
        processed_results: Dict[str, Any],
        start_time: datetime
    ) -> CrawlResult:
        """Finalize crawling session and create result."""
        
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        
        try:
            # Update session record
            session_update = {
                "session_end": end_time.isoformat(),
                "successful_extractions": processed_results.get("total_extracted", 0),
                "average_confidence": 0.8,  # Calculate from actual data
                "data_quality_distribution": json.dumps(processed_results.get("mode_results", {}))
            }
            
            self.supabase.table("archon_crawl_sessions").update(
                session_update
            ).eq("id", session_id).execute()
            
        except Exception as e:
            safe_logfire_error(f"Failed to finalize session: {str(e)}")
        
        # Create result object
        return CrawlResult(
            crawl_id=session_id,
            mode="smart_mixed",
            start_time=start_time,
            end_time=end_time,
            extracted_data=[],  # Actual data stored in specialized tables
            successful_extractions=processed_results.get("total_extracted", 0),
            pages_per_second=processed_results.get("total_extracted", 0) / duration if duration > 0 else 0.0,
            average_response_time=duration / processed_results.get("total_extracted", 1)
        )