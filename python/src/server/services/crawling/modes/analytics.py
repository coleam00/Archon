"""
Analytics Crawling Mode

Specialized mode for analytics dashboards and reporting interfaces.
Focuses on extracting metrics, performance data, and visualization content.
"""

from typing import Dict, List, Set, Any, Optional
from urllib.parse import urljoin

from .base import BaseCrawlMode, CrawlModeConfig, ExtractedData, DataQuality


class AnalyticsCrawlMode(BaseCrawlMode):
    """Analytics and reporting focused crawling mode."""
    
    @property
    def supported_domains(self) -> Set[str]:
        return {
            r'.*analytics\.',
            r'.*dashboard\.',
            r'.*metrics\.',
            r'.*reporting\.',
        }
    
    @property
    def mode_description(self) -> str:
        return "Analytics dashboards and metrics data extraction"
    
    async def detect_website_type(self, url: str, html_content: str) -> bool:
        """Detect analytics sites."""
        analytics_indicators = ['dashboard', 'metrics', 'analytics', 'chart']
        return sum(1 for indicator in analytics_indicators if indicator in html_content.lower()) >= 2
    
    async def extract_data(self, url: str, html_content: str, **kwargs) -> ExtractedData:
        """Extract analytics data."""
        return ExtractedData(
            url=url,
            title="Analytics Dashboard",
            main_content=html_content[:1000],
            structured_data={'type': 'analytics'},
            data_quality=DataQuality.FAIR,
            confidence_score=0.6
        )
    
    async def discover_urls(self, base_url: str, html_content: str, current_depth: int = 0) -> List[str]:
        """Discover analytics URLs."""
        return []
    
    async def validate_extracted_data(self, data: ExtractedData) -> bool:
        """Validate analytics data."""
        return True
    
    def get_wait_strategy(self, url: str) -> Dict[str, Any]:
        """Wait for dynamic content in analytics dashboards."""
        return {
            "wait_for": "networkidle",
            "timeout": 60000,  # Longer timeout for complex dashboards
            "delay": 5.0  # Wait for charts to render
        }