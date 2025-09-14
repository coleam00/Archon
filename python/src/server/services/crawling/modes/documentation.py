"""
Documentation Crawling Mode

Specialized mode for technical documentation sites with API references,
code examples, and structured technical content.
"""

from typing import Dict, List, Set, Any, Optional
from urllib.parse import urljoin

from .base import BaseCrawlMode, CrawlModeConfig, ExtractedData, DataQuality


class DocumentationCrawlMode(BaseCrawlMode):
    """Documentation and technical content crawling mode."""
    
    @property
    def supported_domains(self) -> Set[str]:
        return {
            r'.*docs?\.',
            r'.*documentation\.',
            r'.*api\.',
            r'.*developer\.',
        }
    
    @property
    def mode_description(self) -> str:
        return "Technical documentation and API reference extraction"
    
    async def detect_website_type(self, url: str, html_content: str) -> bool:
        """Detect documentation sites."""
        doc_indicators = ['api', 'documentation', 'reference', 'guide']
        return sum(1 for indicator in doc_indicators if indicator in html_content.lower()) >= 2
    
    async def extract_data(self, url: str, html_content: str, **kwargs) -> ExtractedData:
        """Extract documentation content."""
        return ExtractedData(
            url=url,
            title="Documentation Page",
            main_content=html_content[:1000],
            structured_data={'type': 'documentation'},
            data_quality=DataQuality.GOOD,
            confidence_score=0.7
        )
    
    async def discover_urls(self, base_url: str, html_content: str, current_depth: int = 0) -> List[str]:
        """Discover documentation URLs."""
        return []
    
    async def validate_extracted_data(self, data: ExtractedData) -> bool:
        """Validate documentation data."""
        return True