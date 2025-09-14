"""
Crawling Mode Registry

Manages all available crawling modes and provides automatic mode selection
based on URL analysis and website features.
"""

import asyncio
import re
from typing import Dict, List, Optional, Type, Any
from urllib.parse import urlparse

from .base_mode import BaseCrawlingMode, CrawlingMode, ModeConfiguration, CrawlingResult
from ....config.logfire_config import get_logger
from ..detection import detect_website_type, get_detector

logger = get_logger(__name__)


class ModeRegistry:
    """
    Registry for managing all available crawling modes.
    
    Provides functionality for:
    - Registering and managing crawling modes
    - Automatic mode detection based on URL patterns
    - Fallback to standard mode when specialized modes fail
    - Mode performance tracking and optimization
    """
    
    def __init__(self):
        """Initialize the mode registry."""
        self._modes: Dict[CrawlingMode, Type[BaseCrawlingMode]] = {}
        self._mode_instances: Dict[CrawlingMode, BaseCrawlingMode] = {}
        self._mode_configs: Dict[CrawlingMode, ModeConfiguration] = {}
        self._url_patterns: Dict[CrawlingMode, List[str]] = {}
        self._performance_stats: Dict[CrawlingMode, Dict[str, Any]] = {}
        
        # Initialize performance tracking
        for mode in CrawlingMode:
            self._performance_stats[mode] = {
                "total_crawls": 0,
                "successful_crawls": 0,
                "average_response_time": 0.0,
                "error_rate": 0.0,
                "last_updated": None
            }
    
    def register_mode(
        self, 
        mode: CrawlingMode, 
        mode_class: Type[BaseCrawlingMode],
        config: ModeConfiguration,
        url_patterns: List[str] = None
    ):
        """
        Register a new crawling mode.
        
        Args:
            mode: The crawling mode enum value
            mode_class: The class implementing the mode
            config: Configuration for the mode
            url_patterns: Optional URL patterns that this mode can handle
        """
        self._modes[mode] = mode_class
        self._mode_configs[mode] = config
        self._url_patterns[mode] = url_patterns or []
        
        logger.info(f"Registered crawling mode: {mode.value}")
    
    def get_mode_instance(
        self, 
        mode: CrawlingMode, 
        crawler, 
        markdown_generator
    ) -> Optional[BaseCrawlingMode]:
        """
        Get or create an instance of the specified mode.
        
        Args:
            mode: The crawling mode to instantiate
            crawler: The Crawl4AI crawler instance
            markdown_generator: Markdown generator instance
            
        Returns:
            Instance of the requested mode, or None if not registered
        """
        if mode not in self._modes:
            logger.warning(f"Mode {mode.value} not registered")
            return None
        
        # Return cached instance if available
        if mode in self._mode_instances:
            return self._mode_instances[mode]
        
        # Create new instance
        try:
            mode_class = self._modes[mode]
            config = self._mode_configs[mode]
            instance = mode_class(crawler, markdown_generator, config)
            self._mode_instances[mode] = instance
            return instance
        except Exception as e:
            logger.error(f"Failed to create instance of mode {mode.value}: {e}")
            return None
    
    async def detect_best_mode(self, url: str, html_content: str = None) -> CrawlingMode:
        """
        Automatically detect the best crawling mode for a given URL using intelligent analysis.
        
        Args:
            url: The URL to analyze
            html_content: Optional HTML content for analysis
            
        Returns:
            The best crawling mode for the URL
        """
        try:
            # Use the intelligent detection system
            detection_result = await detect_website_type(
                url=url,
                html_content=html_content,
                fetch_content=(html_content is None)
            )
            
            # Check if confidence is high enough to trust the detection
            if detection_result.confidence >= 0.7:
                logger.info(
                    f"Intelligent detection: {url} -> {detection_result.detected_mode.value} "
                    f"(confidence: {detection_result.confidence:.2f}, platform: {detection_result.platform})"
                )
                return detection_result.detected_mode
            
            # Medium confidence - fall back to pattern matching for verification
            elif detection_result.confidence >= 0.5:
                # Verify with URL pattern matching
                pattern_mode = self._detect_by_url_patterns(url)
                if pattern_mode == detection_result.detected_mode:
                    logger.info(
                        f"Detection verified by patterns: {url} -> {detection_result.detected_mode.value} "
                        f"(confidence: {detection_result.confidence:.2f})"
                    )
                    return detection_result.detected_mode
                
                # If patterns disagree, use the higher confidence method
                logger.info(
                    f"Detection disagreement for {url}: intelligent={detection_result.detected_mode.value}, "
                    f"patterns={pattern_mode.value}, using intelligent (confidence: {detection_result.confidence:.2f})"
                )
                return detection_result.detected_mode
            
            # Low confidence - fall back to legacy methods
            else:
                logger.info(
                    f"Low confidence detection for {url} (confidence: {detection_result.confidence:.2f}), "
                    f"falling back to pattern matching"
                )
                return self._detect_by_url_patterns(url)
                
        except Exception as e:
            logger.warning(f"Intelligent detection failed for {url}: {e}, falling back to pattern matching")
            return self._detect_by_url_patterns(url)
    
    def _detect_by_url_patterns(self, url: str) -> CrawlingMode:
        """Legacy URL pattern-based detection for fallback."""
        # First, try URL pattern matching
        for mode, patterns in self._url_patterns.items():
            if any(self._matches_pattern(url, pattern) for pattern in patterns):
                logger.info(f"URL pattern match: {url} -> {mode.value}")
                return mode
        
        # Fallback to domain-based heuristics
        heuristic_mode = self._detect_by_domain_heuristics(url)
        if heuristic_mode != CrawlingMode.STANDARD:
            logger.info(f"Domain heuristic: {url} -> {heuristic_mode.value}")
            return heuristic_mode
        
        # Default to standard mode
        logger.info(f"Using standard mode for: {url}")
        return CrawlingMode.STANDARD
    
    def _matches_pattern(self, url: str, pattern: str) -> bool:
        """Check if URL matches a given pattern."""
        try:
            # Support both regex and simple wildcard patterns
            if pattern.startswith('regex:'):
                regex_pattern = pattern[6:]  # Remove 'regex:' prefix
                return bool(re.search(regex_pattern, url, re.IGNORECASE))
            else:
                # Simple wildcard pattern matching
                import fnmatch
                return fnmatch.fnmatch(url.lower(), pattern.lower())
        except Exception as e:
            logger.warning(f"Error matching pattern {pattern} against {url}: {e}")
            return False
    
    def _detect_by_domain_heuristics(self, url: str) -> CrawlingMode:
        """Detect mode based on domain and URL heuristics."""
        url_lower = url.lower()
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        path = parsed.path.lower()
        
        # E-commerce patterns
        ecommerce_domains = [
            'amazon.', 'ebay.', 'shopify.', 'etsy.', 'walmart.', 'target.', 
            'bestbuy.', 'homedepot.', 'lowes.', 'wayfair.', 'overstock.',
            'alibaba.', 'aliexpress.', 'wish.', 'newegg.', 'zappos.',
            'nordstrom.', 'macys.', 'kohls.', 'jcpenney.', 'sears.'
        ]
        
        ecommerce_paths = [
            '/product/', '/item/', '/p/', '/shop/', '/store/', '/cart/',
            '/products/', '/catalog/', '/buy/', '/purchase/'
        ]
        
        if any(pattern in domain for pattern in ecommerce_domains) or \
           any(pattern in path for pattern in ecommerce_paths):
            return CrawlingMode.ECOMMERCE
        
        # Blog patterns
        blog_domains = [
            'wordpress.', 'blogspot.', 'medium.', 'substack.', 'ghost.',
            'tumblr.', 'blogger.', 'typepad.', 'squarespace.'
        ]
        
        blog_paths = [
            '/blog/', '/post/', '/article/', '/news/', '/stories/'
        ]
        
        if any(pattern in domain for pattern in blog_domains) or \
           any(pattern in path for pattern in blog_paths):
            return CrawlingMode.BLOG
        
        # Documentation patterns
        doc_domains = [
            'docs.', 'documentation.', 'api.', 'developer.', 'devdocs.',
            'readthedocs.', 'gitbook.', 'notion.', 'confluence.'
        ]
        
        doc_paths = [
            '/docs/', '/documentation/', '/api/', '/guide/', '/tutorial/',
            '/manual/', '/reference/', '/help/'
        ]
        
        if any(pattern in domain for pattern in doc_domains) or \
           any(pattern in path for pattern in doc_paths):
            return CrawlingMode.DOCUMENTATION
        
        # News patterns
        news_domains = [
            'cnn.', 'bbc.', 'reuters.', 'ap.', 'npr.', 'nytimes.',
            'washingtonpost.', 'guardian.', 'bloomberg.', 'wsj.',
            'techcrunch.', 'wired.', 'arstechnica.', 'verge.'
        ]
        
        if any(pattern in domain for pattern in news_domains):
            return CrawlingMode.NEWS
        
        return CrawlingMode.STANDARD
    
    async def crawl_with_best_mode(
        self,
        url: str,
        crawler,
        markdown_generator,
        progress_callback: Optional[callable] = None,
        force_mode: Optional[CrawlingMode] = None,
        **kwargs
    ) -> CrawlingResult:
        """
        Crawl a URL using the best available mode.
        
        Args:
            url: URL to crawl
            crawler: Crawl4AI crawler instance
            markdown_generator: Markdown generator instance
            progress_callback: Optional progress callback
            force_mode: Optional mode to force (skip detection)
            **kwargs: Additional crawling parameters
            
        Returns:
            CrawlingResult from the best available mode
        """
        start_time = asyncio.get_event_loop().time()
        
        try:
            # Determine the mode to use
            if force_mode:
                selected_mode = force_mode
                logger.info(f"Using forced mode {selected_mode.value} for {url}")
            else:
                selected_mode = await self.detect_best_mode(url)
            
            # Get mode instance
            mode_instance = self.get_mode_instance(selected_mode, crawler, markdown_generator)
            
            if not mode_instance:
                # Fallback to standard mode
                logger.warning(f"Failed to get instance for {selected_mode.value}, falling back to standard")
                selected_mode = CrawlingMode.STANDARD
                mode_instance = self.get_mode_instance(selected_mode, crawler, markdown_generator)
            
            if not mode_instance:
                raise Exception("No crawling mode available")
            
            # Perform crawling
            result = await mode_instance.crawl(url, progress_callback, **kwargs)
            
            # Update performance stats
            end_time = asyncio.get_event_loop().time()
            self._update_performance_stats(selected_mode, True, end_time - start_time)
            
            return result
            
        except Exception as e:
            # Update performance stats for failure
            end_time = asyncio.get_event_loop().time()
            selected_mode = force_mode or CrawlingMode.STANDARD
            self._update_performance_stats(selected_mode, False, end_time - start_time)
            
            logger.error(f"Error crawling {url} with mode {selected_mode.value}: {e}")
            return CrawlingResult(
                success=False,
                url=url,
                mode=selected_mode.value,
                error=str(e)
            )
    
    def _update_performance_stats(self, mode: CrawlingMode, success: bool, response_time: float):
        """Update performance statistics for a mode."""
        stats = self._performance_stats[mode]
        stats["total_crawls"] += 1
        
        if success:
            stats["successful_crawls"] += 1
        
        # Update average response time
        total = stats["total_crawls"]
        current_avg = stats["average_response_time"]
        stats["average_response_time"] = ((current_avg * (total - 1)) + response_time) / total
        
        # Update error rate
        stats["error_rate"] = 1.0 - (stats["successful_crawls"] / stats["total_crawls"])
        
        stats["last_updated"] = asyncio.get_event_loop().time()
    
    async def get_detection_analysis(self, url: str, html_content: str = None) -> Dict[str, Any]:
        """
        Get detailed analysis of website type detection for a URL.
        
        Args:
            url: URL to analyze
            html_content: Optional HTML content
            
        Returns:
            Detailed detection analysis including features and reasoning
        """
        try:
            detection_result = await detect_website_type(
                url=url,
                html_content=html_content,
                fetch_content=(html_content is None)
            )
            
            detector = get_detector()
            summary = detector.get_detection_summary(detection_result)
            
            return {
                "url": url,
                "detection_result": summary,
                "features_detected": len(detection_result.features),
                "analysis_time_ms": summary["analysis_time_ms"],
                "confidence_level": summary["confidence_level"],
                "platform_detected": detection_result.platform,
                "reasoning": detection_result.reasoning
            }
            
        except Exception as e:
            logger.error(f"Error in detection analysis for {url}: {e}")
            return {
                "url": url,
                "error": str(e),
                "fallback_mode": "standard"
            }
    
    def get_available_modes(self) -> List[Dict[str, Any]]:
        
        for mode in self._modes.keys():
            config = self._mode_configs.get(mode)
            stats = self._performance_stats.get(mode, {})
            
            modes_info.append({
                "mode": mode.value,
                "enabled": config.enabled if config else False,
                "url_patterns": self._url_patterns.get(mode, []),
                "performance": {
                    "total_crawls": stats.get("total_crawls", 0),
                    "success_rate": 1.0 - stats.get("error_rate", 0.0),
                    "average_response_time": stats.get("average_response_time", 0.0)
                }
            })
        
        return modes_info
    
    def get_mode_performance(self, mode: CrawlingMode) -> Dict[str, Any]:
        """Get performance statistics for a specific mode."""
        return self._performance_stats.get(mode, {})


# Global registry instance
_mode_registry = ModeRegistry()


def get_mode_registry() -> ModeRegistry:
    """Get the global mode registry instance."""
    return _mode_registry