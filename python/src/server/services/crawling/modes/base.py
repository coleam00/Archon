"""
Base Crawling Mode

Defines the abstract base class and interfaces for all specialized crawling modes.
Each mode implements domain-specific strategies for data extraction and processing.
"""

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Union, Callable, Awaitable

from pydantic import BaseModel, Field


class CrawlPriority(Enum):
    """Priority levels for crawl operations."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class DataQuality(Enum):
    """Data quality indicators."""
    EXCELLENT = "excellent"
    GOOD = "good"
    FAIR = "fair"
    POOR = "poor"


@dataclass
class CrawlModeConfig:
    """Configuration for crawling modes."""
    
    # Basic settings
    mode_name: str
    enabled: bool = True
    priority: CrawlPriority = CrawlPriority.NORMAL
    
    # Crawling behavior
    max_pages: int = 100
    max_depth: int = 3
    concurrent_requests: int = 5
    delay_between_requests: float = 1.0
    
    # Retry settings
    max_retries: int = 3
    retry_delay: float = 2.0
    backoff_factor: float = 2.0
    
    # Stealth settings
    use_random_user_agents: bool = True
    rotate_proxies: bool = False
    bypass_cloudflare: bool = False
    respect_robots_txt: bool = True
    
    # Content filtering
    min_content_length: int = 100
    max_content_length: int = 1000000
    content_filters: List[str] = field(default_factory=list)
    
    # Custom settings (mode-specific)
    custom_settings: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractedData:
    """Container for extracted data from a webpage."""
    
    # Basic metadata
    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    language: Optional[str] = None
    
    # Content
    main_content: Optional[str] = None
    structured_data: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    # Quality metrics
    data_quality: DataQuality = DataQuality.FAIR
    confidence_score: float = 0.5
    
    # Processing info
    extraction_time: datetime = field(default_factory=datetime.now)
    processing_duration: float = 0.0


@dataclass
class CrawlResult:
    """Result of a crawling operation."""
    
    # Operation metadata
    crawl_id: str
    mode: str
    start_time: datetime
    end_time: Optional[datetime] = None
    
    # Results
    extracted_data: List[ExtractedData] = field(default_factory=list)
    failed_urls: List[str] = field(default_factory=list)
    
    # Statistics
    total_urls: int = 0
    successful_extractions: int = 0
    failed_extractions: int = 0
    
    # Performance metrics
    pages_per_second: float = 0.0
    average_response_time: float = 0.0
    
    # Errors and warnings
    errors: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class BaseCrawlMode(ABC):
    """
    Abstract base class for all specialized crawling modes.
    
    Each crawling mode implements domain-specific strategies for:
    - Website detection and classification
    - Data extraction patterns
    - Content processing and validation
    - Performance optimization
    - Anti-bot detection evasion
    """
    
    def __init__(self, config: CrawlModeConfig):
        """Initialize the crawling mode with configuration."""
        self.config = config
        self.name = config.mode_name
        self.session_id = None
        self._cancelled = False
    
    @property
    @abstractmethod
    def supported_domains(self) -> Set[str]:
        """Return set of supported domain patterns (regex patterns allowed)."""
        pass
    
    @property
    @abstractmethod
    def mode_description(self) -> str:
        """Return human-readable description of this crawling mode."""
        pass
    
    @abstractmethod
    async def detect_website_type(self, url: str, html_content: str) -> bool:
        """
        Detect if a website is suitable for this crawling mode.
        
        Args:
            url: The website URL
            html_content: The HTML content of the page
            
        Returns:
            True if this mode can handle the website, False otherwise
        """
        pass
    
    @abstractmethod
    async def extract_data(
        self, 
        url: str, 
        html_content: str, 
        **kwargs
    ) -> ExtractedData:
        """
        Extract data from a webpage using mode-specific strategies.
        
        Args:
            url: The webpage URL
            html_content: The HTML content
            **kwargs: Additional mode-specific parameters
            
        Returns:
            ExtractedData object containing extracted information
        """
        pass
    
    @abstractmethod
    async def discover_urls(
        self, 
        base_url: str, 
        html_content: str,
        current_depth: int = 0
    ) -> List[str]:
        """
        Discover additional URLs to crawl from the current page.
        
        Args:
            base_url: The base URL of the current page
            html_content: The HTML content
            current_depth: Current crawling depth
            
        Returns:
            List of URLs to crawl next
        """
        pass
    
    @abstractmethod
    async def validate_extracted_data(self, data: ExtractedData) -> bool:
        """
        Validate extracted data for quality and completeness.
        
        Args:
            data: The extracted data to validate
            
        Returns:
            True if data is valid, False otherwise
        """
        pass
    
    async def preprocess_html(self, html_content: str, url: str) -> str:
        """
        Preprocess HTML content before extraction (optional override).
        
        Args:
            html_content: Raw HTML content
            url: The source URL
            
        Returns:
            Processed HTML content
        """
        return html_content
    
    async def postprocess_data(self, data: ExtractedData) -> ExtractedData:
        """
        Post-process extracted data (optional override).
        
        Args:
            data: The extracted data
            
        Returns:
            Post-processed data
        """
        return data
    
    def get_custom_headers(self, url: str) -> Dict[str, str]:
        """
        Get custom HTTP headers for the request (optional override).
        
        Args:
            url: The target URL
            
        Returns:
            Dictionary of custom headers
        """
        return {}
    
    def get_wait_strategy(self, url: str) -> Dict[str, Any]:
        """
        Get wait strategy for page loading (optional override).
        
        Args:
            url: The target URL
            
        Returns:
            Wait strategy configuration
        """
        return {
            "wait_for": "domcontentloaded",
            "timeout": 30000,
            "delay": 0.5
        }
    
    def should_crawl_url(self, url: str, parent_url: str = None) -> bool:
        """
        Determine if a URL should be crawled (optional override).
        
        Args:
            url: The URL to check
            parent_url: The parent URL (optional)
            
        Returns:
            True if URL should be crawled, False otherwise
        """
        return True
    
    def estimate_crawl_time(self, urls: List[str]) -> float:
        """
        Estimate total crawl time for a list of URLs (optional override).
        
        Args:
            urls: List of URLs to crawl
            
        Returns:
            Estimated time in seconds
        """
        base_time = len(urls) * (self.config.delay_between_requests + 2.0)  # 2s avg page load
        return base_time * (1 + (self.config.max_retries * 0.1))  # Add retry overhead
    
    def cancel(self):
        """Cancel the crawling operation."""
        self._cancelled = True
    
    def is_cancelled(self) -> bool:
        """Check if crawling has been cancelled."""
        return self._cancelled
    
    def _check_cancellation(self):
        """Check cancellation status and raise exception if cancelled."""
        if self._cancelled:
            raise asyncio.CancelledError("Crawling operation was cancelled")


class ProgressCallback:
    """Helper class for progress reporting."""
    
    def __init__(self, callback: Optional[Callable[[str, int, str], Awaitable[None]]] = None):
        self.callback = callback
    
    async def update(self, status: str, percentage: int, message: str, **kwargs):
        """Update progress with status, percentage, and message."""
        if self.callback:
            await self.callback(status, percentage, message, **kwargs)