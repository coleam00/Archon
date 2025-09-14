"""
Standard Crawling Mode

Default crawling mode that handles general websites without specialized processing.
Serves as the fallback mode when specialized modes cannot handle a URL.
"""

from typing import Dict, List, Any, Optional
from crawl4ai import CrawlerRunConfig, CacheMode
from bs4 import BeautifulSoup

from .base_mode import BaseCrawlingMode, CrawlingResult, ModeConfiguration, CrawlingMode
from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class StandardCrawlingMode(BaseCrawlingMode):
    """Standard crawling mode for general websites."""
    
    def _initialize_mode(self):
        """Initialize standard mode settings."""
        # Standard configuration - optimized for general content
        self.config.wait_strategy = "domcontentloaded"
        self.config.page_timeout = 30000
        self.config.delay_before_html = 0.5
    
    async def can_handle_url(self, url: str) -> bool:
        """Standard mode can handle any URL as fallback."""
        return True
    
    async def detect_website_features(self, url: str, html_content: str = None) -> Dict[str, Any]:
        """Analyze general website features."""
        if not html_content:
            return {"confidence": 0.5, "features": ["general_content"]}
        
        soup = BeautifulSoup(html_content, 'html.parser')
        features = []
        
        # Basic content detection
        if soup.find('article'):
            features.append("article_content")
        if soup.find(['h1', 'h2', 'h3']):
            features.append("structured_headings")
        if soup.find('nav'):
            features.append("navigation")
        if soup.find('main'):
            features.append("main_content")
        
        return {
            "confidence": 0.5,  # Standard baseline confidence
            "features": features,
            "content_type": "general"
        }
    
    async def create_crawler_config(self, url: str, **kwargs) -> CrawlerRunConfig:
        """Create standard crawler configuration."""
        return CrawlerRunConfig(
            cache_mode=CacheMode.ENABLED,
            stream=True,
            markdown_generator=self.markdown_generator,
            wait_until=self.config.wait_strategy,
            page_timeout=self.config.page_timeout,
            delay_before_return_html=self.config.delay_before_html,
            scan_full_page=True,
            exclude_all_images=False,
            remove_overlay_elements=True
        )
    
    async def extract_structured_data(self, url: str, html: str, markdown: str) -> Dict[str, Any]:
        """Extract basic structured data from general websites."""
        soup = BeautifulSoup(html, 'html.parser')
        
        # Extract basic metadata
        metadata = {}
        
        # Page title
        title_elem = soup.find('title')
        if title_elem:
            metadata['title'] = title_elem.get_text(strip=True)
        
        # Meta description
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc:
            metadata['description'] = meta_desc.get('content', '')
        
        # Meta keywords
        meta_keywords = soup.find('meta', attrs={'name': 'keywords'})
        if meta_keywords:
            metadata['keywords'] = meta_keywords.get('content', '').split(',')
        
        # Basic content structure
        structure = {
            "headings": len(soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])),
            "paragraphs": len(soup.find_all('p')),
            "links": len(soup.find_all('a')),
            "images": len(soup.find_all('img'))
        }
        
        return {
            "metadata": metadata,
            "content_structure": structure,
            "extraction_type": "standard"
        }
    
    async def post_process_content(self, raw_result: Dict[str, Any]) -> CrawlingResult:
        """Post-process standard crawled content."""
        return CrawlingResult(
            success=raw_result["success"],
            url=raw_result["url"],
            mode=self.config.mode.value,
            content={
                "markdown": raw_result.get("markdown", ""),
                "html": raw_result.get("html", ""),
                "title": raw_result.get("title", "")
            },
            structured_data=raw_result.get("structured_data", {}),
            metadata=raw_result.get("metadata", {}),
            extraction_stats={
                "content_length": len(raw_result.get("markdown", "")),
                "links_found": len(raw_result.get("links", [])),
                "extraction_method": "standard"
            }
        )
    
    def _get_capabilities(self) -> List[str]:
        """Return capabilities of standard mode."""
        return [
            "general_content_extraction",
            "basic_metadata_parsing",
            "link_extraction",
            "content_structure_analysis"
        ]
    
    def _get_supported_features(self) -> List[str]:
        """Return supported features of standard mode."""
        return [
            "universal_compatibility",
            "basic_content_processing",
            "fallback_crawling",
            "metadata_extraction"
        ]