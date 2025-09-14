"""
Base Crawling Mode Interface

Defines the interface that all specialized crawling modes must implement.
This enables extensible crawling with different strategies for different website types.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Callable, Awaitable

from crawl4ai import CrawlerRunConfig


class CrawlingMode(str, Enum):
    """Enumeration of available crawling modes."""
    
    STANDARD = "standard"
    ECOMMERCE = "ecommerce"
    BLOG = "blog"
    DOCUMENTATION = "documentation"
    NEWS = "news"
    SOCIAL_MEDIA = "social_media"
    ANALYTICS = "analytics"
    API_DOCS = "api_docs"


@dataclass
class CrawlingResult:
    """Standard result structure returned by all crawling modes."""
    
    success: bool
    url: str
    mode: str
    content: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    structured_data: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    extraction_stats: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ModeConfiguration:
    """Configuration parameters for crawling modes."""
    
    # Core settings
    mode: CrawlingMode
    enabled: bool = True
    
    # Crawler behavior
    wait_strategy: str = "domcontentloaded"
    page_timeout: int = 30000
    delay_before_html: float = 0.5
    max_retries: int = 3
    
    # Content extraction
    extract_structured_data: bool = True
    extract_images: bool = True
    extract_links: bool = True
    
    # Anti-detection
    stealth_mode: bool = False
    random_delays: bool = False
    rotate_user_agents: bool = False
    
    # Custom selectors and patterns
    custom_selectors: Dict[str, str] = field(default_factory=dict)
    extraction_patterns: Dict[str, str] = field(default_factory=dict)
    
    # Mode-specific configuration
    mode_config: Dict[str, Any] = field(default_factory=dict)


class BaseCrawlingMode(ABC):
    """
    Abstract base class for all crawling modes.
    
    Each mode implements specialized crawling logic for specific website types
    while maintaining a consistent interface for the crawling service.
    """
    
    def __init__(self, crawler, markdown_generator, config: ModeConfiguration):
        """
        Initialize the crawling mode.
        
        Args:
            crawler: The Crawl4AI crawler instance
            markdown_generator: Markdown generator for content conversion
            config: Mode-specific configuration
        """
        self.crawler = crawler
        self.markdown_generator = markdown_generator
        self.config = config
        self._initialize_mode()
    
    @abstractmethod
    def _initialize_mode(self):
        """Initialize mode-specific settings and configurations."""
        pass
    
    @abstractmethod
    async def can_handle_url(self, url: str) -> bool:
        """
        Determine if this mode can handle the given URL.
        
        Args:
            url: The URL to analyze
            
        Returns:
            True if this mode can handle the URL, False otherwise
        """
        pass
    
    @abstractmethod
    async def detect_website_features(self, url: str, html_content: str = None) -> Dict[str, Any]:
        """
        Analyze the website to detect features relevant to this mode.
        
        Args:
            url: The URL being analyzed
            html_content: Optional HTML content for analysis
            
        Returns:
            Dictionary containing detected features and confidence scores
        """
        pass
    
    @abstractmethod
    async def create_crawler_config(self, url: str, **kwargs) -> CrawlerRunConfig:
        """
        Create a specialized crawler configuration for this mode.
        
        Args:
            url: The URL to be crawled
            **kwargs: Additional configuration parameters
            
        Returns:
            Configured CrawlerRunConfig instance
        """
        pass
    
    @abstractmethod
    async def extract_structured_data(self, url: str, html: str, markdown: str) -> Dict[str, Any]:
        """
        Extract structured data specific to this crawling mode.
        
        Args:
            url: The crawled URL
            html: Raw HTML content
            markdown: Converted markdown content
            
        Returns:
            Dictionary containing extracted structured data
        """
        pass
    
    @abstractmethod
    async def post_process_content(self, raw_result: Dict[str, Any]) -> CrawlingResult:
        """
        Post-process the crawled content and create the final result.
        
        Args:
            raw_result: Raw crawling result from Crawl4AI
            
        Returns:
            Processed CrawlingResult instance
        """
        pass
    
    async def crawl(
        self, 
        url: str, 
        progress_callback: Optional[Callable] = None,
        **kwargs
    ) -> CrawlingResult:
        """
        Main crawling method that orchestrates the entire process.
        
        Args:
            url: URL to crawl
            progress_callback: Optional callback for progress updates
            **kwargs: Additional crawling parameters
            
        Returns:
            CrawlingResult containing all extracted data
        """
        try:
            # Report progress
            if progress_callback:
                await progress_callback("analyzing", 10, f"Analyzing URL: {url}")
            
            # Create specialized crawler configuration
            config = await self.create_crawler_config(url, **kwargs)
            
            # Report progress
            if progress_callback:
                await progress_callback("crawling", 30, f"Crawling with {self.config.mode.value} mode")
            
            # Perform crawling
            result = await self.crawler.arun(url=url, config=config)
            
            if not result.success:
                return CrawlingResult(
                    success=False,
                    url=url,
                    mode=self.config.mode.value,
                    error=result.error_message or "Crawling failed"
                )
            
            # Report progress
            if progress_callback:
                await progress_callback("extracting", 60, "Extracting structured data")
            
            # Extract structured data
            structured_data = {}
            if self.config.extract_structured_data:
                structured_data = await self.extract_structured_data(
                    url, result.html, result.markdown
                )
            
            # Report progress
            if progress_callback:
                await progress_callback("processing", 80, "Post-processing content")
            
            # Create raw result dict
            raw_result = {
                "success": True,
                "url": url,
                "html": result.html,
                "markdown": result.markdown,
                "title": result.title,
                "links": result.links,
                "structured_data": structured_data,
                "metadata": {
                    "mode": self.config.mode.value,
                    "extraction_timestamp": result.success_time,
                    "content_length": len(result.markdown or ""),
                    "links_count": len(result.links or [])
                }
            }
            
            # Post-process and finalize
            final_result = await self.post_process_content(raw_result)
            
            # Report completion
            if progress_callback:
                await progress_callback("complete", 100, "Crawling completed successfully")
            
            return final_result
            
        except Exception as e:
            return CrawlingResult(
                success=False,
                url=url,
                mode=self.config.mode.value,
                error=f"Crawling error: {str(e)}"
            )
    
    def get_mode_info(self) -> Dict[str, Any]:
        """
        Get information about this crawling mode.
        
        Returns:
            Dictionary containing mode information and capabilities
        """
        return {
            "mode": self.config.mode.value,
            "enabled": self.config.enabled,
            "capabilities": self._get_capabilities(),
            "supported_features": self._get_supported_features(),
            "configuration": {
                "stealth_mode": self.config.stealth_mode,
                "extract_structured_data": self.config.extract_structured_data,
                "page_timeout": self.config.page_timeout
            }
        }
    
    @abstractmethod
    def _get_capabilities(self) -> List[str]:
        """Return a list of capabilities this mode provides."""
        pass
    
    @abstractmethod
    def _get_supported_features(self) -> List[str]:
        """Return a list of features this mode supports."""
        pass