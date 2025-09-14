"""
Blog Crawling Mode

Specialized crawling mode for blogs and content publishing sites.
Focuses on article extraction, author information, and content metadata.
"""

import re
from typing import Dict, List, Set, Any, Optional
from datetime import datetime
from urllib.parse import urljoin, urlparse
from dataclasses import dataclass

from .base import BaseCrawlMode, CrawlModeConfig, ExtractedData, DataQuality


@dataclass
class BlogData:
    """Blog-specific data structure."""
    title: Optional[str] = None
    content: Optional[str] = None
    excerpt: Optional[str] = None
    author: Optional[str] = None
    publish_date: Optional[datetime] = None
    updated_date: Optional[datetime] = None
    categories: List[str] = None
    tags: List[str] = None
    word_count: Optional[int] = None
    reading_time: Optional[int] = None


class BlogCrawlMode(BaseCrawlMode):
    """Blog and content-focused crawling mode."""
    
    @property
    def supported_domains(self) -> Set[str]:
        return {
            r'.*blog\.',
            r'.*wordpress\.com',
            r'.*medium\.com',
            r'.*substack\.com',
        }
    
    @property
    def mode_description(self) -> str:
        return "Blog and article content extraction with metadata"
    
    async def detect_website_type(self, url: str, html_content: str) -> bool:
        """Detect if website is a blog."""
        blog_indicators = ['blog', 'article', 'post', 'author']
        return sum(1 for indicator in blog_indicators if indicator in html_content.lower()) >= 2
    
    async def extract_data(self, url: str, html_content: str, **kwargs) -> ExtractedData:
        """Extract blog post data."""
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, 'html.parser')
        
        blog_data = BlogData()
        
        # Extract title
        title_selectors = ['h1', '.post-title', '.article-title', '.entry-title']
        for selector in title_selectors:
            element = soup.select_one(selector)
            if element:
                blog_data.title = element.get_text(strip=True)
                break
        
        # Extract content
        content_selectors = ['.post-content', '.article-content', '.entry-content', 'article']
        for selector in content_selectors:
            element = soup.select_one(selector)
            if element:
                blog_data.content = element.get_text(strip=True)
                break
        
        return ExtractedData(
            url=url,
            title=blog_data.title,
            description=blog_data.excerpt,
            main_content=blog_data.content,
            structured_data={'blog': blog_data.__dict__, 'type': 'blog_post'},
            data_quality=DataQuality.GOOD,
            confidence_score=0.8
        )
    
    async def discover_urls(self, base_url: str, html_content: str, current_depth: int = 0) -> List[str]:
        """Discover blog post URLs."""
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, 'html.parser')
        
        urls = []
        selectors = ['a[href*="/post/"]', 'a[href*="/article/"]', '.post-link']
        
        for selector in selectors:
            links = soup.select(selector)
            for link in links:
                href = link.get('href')
                if href:
                    urls.append(urljoin(base_url, href))
        
        return urls
    
    async def validate_extracted_data(self, data: ExtractedData) -> bool:
        """Validate blog data."""
        blog_data = data.structured_data.get('blog', {})
        return bool(blog_data.get('title') and blog_data.get('content'))