"""
Website Type Detection and Classification

Automatically detects website types and recommends appropriate crawling modes.
Uses multiple detection strategies including domain analysis, HTML patterns, and content analysis.
"""

import re
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse
from dataclasses import dataclass

from bs4 import BeautifulSoup


class WebsiteType(Enum):
    """Website type classifications."""
    ECOMMERCE = "ecommerce"
    BLOG = "blog"  
    DOCUMENTATION = "documentation"
    NEWS = "news"
    SOCIAL_MEDIA = "social_media"
    ANALYTICS = "analytics"
    GOVERNMENT = "government"
    ACADEMIC = "academic"
    CORPORATE = "corporate"
    UNKNOWN = "unknown"


@dataclass
class DetectionResult:
    """Result of website type detection."""
    website_type: WebsiteType
    confidence_score: float
    indicators_found: List[str]
    recommended_mode: str
    fallback_modes: List[str]


class ModeDetector:
    """Detects website types and recommends appropriate crawling modes."""
    
    def __init__(self):
        """Initialize the detector with pattern libraries."""
        
        # Domain pattern mappings
        self.domain_patterns = {
            WebsiteType.ECOMMERCE: [
                r'.*amazon\.(com|co\.uk|de|fr|it|es|ca|au|in)',
                r'.*ebay\.(com|co\.uk|de|fr|it|es|ca|au)',
                r'.*shopify\.com',
                r'.*shop\.',
                r'.*store\.',
                r'.*cart\.',
                r'.*buy\.',
                r'.*woocommerce\.com',
                r'.*magento\.',
                r'.*bigcommerce\.com',
                r'.*walmart\.com',
                r'.*target\.com',
                r'.*bestbuy\.com',
                r'.*alibaba\.com',
                r'.*aliexpress\.com',
                r'.*etsy\.com',
                r'.*mercadolibre\.',
                r'.*flipkart\.com',
            ],
            WebsiteType.BLOG: [
                r'.*blog\.',
                r'.*wordpress\.com',
                r'.*blogger\.com',
                r'.*medium\.com',
                r'.*substack\.com',
                r'.*ghost\.',
                r'.*jekyllrb\.com',
                r'.*tumblr\.com',
            ],
            WebsiteType.DOCUMENTATION: [
                r'.*docs?\.',
                r'.*documentation\.',
                r'.*api\.',
                r'.*developer\.',
                r'.*dev\.',
                r'.*readme\.',
                r'.*guide\.',
                r'.*wiki\.',
                r'.*manual\.',
                r'.*reference\.',
                r'.*gitbook\.',
                r'.*notion\.so',
                r'.*confluence\.',
            ],
            WebsiteType.NEWS: [
                r'.*news\.',
                r'.*cnn\.com',
                r'.*bbc\.(com|co\.uk)',
                r'.*reuters\.com', 
                r'.*ap\.org',
                r'.*nytimes\.com',
                r'.*washingtonpost\.com',
                r'.*guardian\.',
                r'.*techcrunch\.com',
                r'.*wired\.com',
            ],
            WebsiteType.SOCIAL_MEDIA: [
                r'.*twitter\.com',
                r'.*facebook\.com',
                r'.*instagram\.com',
                r'.*linkedin\.com',
                r'.*youtube\.com',
                r'.*tiktok\.com',
                r'.*reddit\.com',
                r'.*discord\.',
                r'.*telegram\.',
            ],
            WebsiteType.GOVERNMENT: [
                r'.*\.gov',
                r'.*\.gov\.',
                r'.*government\.',
                r'.*federal\.',
                r'.*state\.',
                r'.*municipal\.',
            ],
            WebsiteType.ACADEMIC: [
                r'.*\.edu',
                r'.*\.ac\.',
                r'.*university\.',
                r'.*college\.',
                r'.*research\.',
                r'.*scholar\.',
                r'.*arxiv\.org',
                r'.*researchgate\.',
                r'.*academia\.edu',
            ],
        }
        
        # HTML content indicators
        self.content_indicators = {
            WebsiteType.ECOMMERCE: [
                'add to cart', 'buy now', 'shopping cart', 'checkout', 'add to basket',
                'product-price', 'price-current', 'product-info', 'product-details',
                'variant-selector', 'size-selector', 'color-picker', 'quantity-selector',
                'wishlist', 'compare', 'product-gallery', 'product-image',
                'rating', 'review', 'in stock', 'out of stock', 'free shipping',
                'promo code', 'coupon', 'discount', 'sale price', 'msrp',
            ],
            WebsiteType.BLOG: [
                'blog-post', 'article-content', 'post-meta', 'post-date',
                'author', 'category', 'tag', 'comment', 'read more',
                'archive', 'recent posts', 'related posts', 'blog-navigation',
                'post-title', 'excerpt', 'permalink', 'trackback',
            ],
            WebsiteType.DOCUMENTATION: [
                'api-reference', 'code-example', 'syntax-highlight', 'method',
                'parameter', 'return-value', 'example-code', 'getting-started',
                'installation', 'configuration', 'tutorial', 'guide',
                'reference', 'changelog', 'version', 'endpoint',
                'documentation-nav', 'table-of-contents', 'breadcrumb',
            ],
            WebsiteType.NEWS: [
                'article-headline', 'news-article', 'byline', 'dateline',
                'breaking news', 'latest news', 'top stories', 'headline',
                'journalist', 'correspondent', 'news-category', 'live-update',
                'news-feed', 'article-meta', 'news-summary', 'trending',
            ],
            WebsiteType.ANALYTICS: [
                'dashboard', 'metrics', 'chart', 'graph', 'analytics',
                'statistics', 'data-viz', 'kpi', 'performance',
                'reporting', 'insights', 'trends', 'conversion',
                'traffic', 'engagement', 'bounce-rate', 'sessions',
            ],
        }
        
        # Meta tag indicators
        self.meta_indicators = {
            WebsiteType.ECOMMERCE: [
                'product', 'price', 'availability', 'brand', 'category',
                'ecommerce', 'shopping', 'retail', 'store', 'cart',
            ],
            WebsiteType.BLOG: [
                'blog', 'article', 'post', 'author', 'publication',
                'wordpress', 'blogger', 'medium', 'personal',
            ],
            WebsiteType.DOCUMENTATION: [
                'documentation', 'api', 'reference', 'guide', 'manual',
                'developer', 'technical', 'tutorial', 'docs',
            ],
            WebsiteType.NEWS: [
                'news', 'journalism', 'media', 'press', 'current-events',
                'breaking', 'headline', 'story', 'report',
            ],
        }
        
        # Schema.org type indicators
        self.schema_indicators = {
            WebsiteType.ECOMMERCE: [
                'Product', 'Offer', 'AggregateOffer', 'Store', 'Organization',
                'Brand', 'Review', 'AggregateRating', 'ItemAvailability',
            ],
            WebsiteType.BLOG: [
                'BlogPosting', 'Blog', 'Article', 'Person', 'Author',
                'Comment', 'CreativeWork',
            ],
            WebsiteType.NEWS: [
                'NewsArticle', 'Article', 'Report', 'MediaObject',
                'Organization', 'Person', 'Place',
            ],
        }
    
    async def detect_website_type(
        self, 
        url: str, 
        html_content: str,
        additional_info: Optional[Dict] = None
    ) -> DetectionResult:
        """
        Detect website type using multiple strategies.
        
        Args:
            url: The website URL
            html_content: HTML content of the page
            additional_info: Additional context (headers, redirects, etc.)
            
        Returns:
            DetectionResult with type classification and confidence
        """
        
        soup = BeautifulSoup(html_content, 'html.parser')
        domain = urlparse(url).netloc.lower()
        
        # Score each website type
        type_scores = {}
        all_indicators = {}
        
        for website_type in WebsiteType:
            if website_type == WebsiteType.UNKNOWN:
                continue
                
            score, indicators = await self._calculate_type_score(
                website_type, domain, soup, html_content
            )
            type_scores[website_type] = score
            all_indicators[website_type] = indicators
        
        # Find the best match
        if not type_scores:
            return DetectionResult(
                website_type=WebsiteType.UNKNOWN,
                confidence_score=0.0,
                indicators_found=[],
                recommended_mode="documentation",  # Default fallback
                fallback_modes=["blog", "analytics"]
            )
        
        best_type = max(type_scores.keys(), key=lambda t: type_scores[t])
        confidence = type_scores[best_type] / 100.0  # Convert to 0-1 scale
        
        # If confidence is too low, mark as unknown
        if confidence < 0.3:
            best_type = WebsiteType.UNKNOWN
            confidence = 0.0
        
        # Get mode recommendations
        recommended_mode, fallback_modes = self._get_mode_recommendations(best_type)
        
        return DetectionResult(
            website_type=best_type,
            confidence_score=confidence,
            indicators_found=all_indicators.get(best_type, []),
            recommended_mode=recommended_mode,
            fallback_modes=fallback_modes
        )
    
    async def _calculate_type_score(
        self, 
        website_type: WebsiteType, 
        domain: str, 
        soup: BeautifulSoup, 
        html_content: str
    ) -> Tuple[float, List[str]]:
        """Calculate score for a specific website type."""
        
        score = 0.0
        indicators_found = []
        
        # Domain pattern matching (40 points max)
        if website_type in self.domain_patterns:
            for pattern in self.domain_patterns[website_type]:
                if re.match(pattern, domain):
                    score += 40
                    indicators_found.append(f"domain_match:{pattern}")
                    break
        
        # Content indicators (30 points max)
        if website_type in self.content_indicators:
            content_lower = html_content.lower()
            content_matches = 0
            
            for indicator in self.content_indicators[website_type]:
                if indicator in content_lower:
                    content_matches += 1
                    indicators_found.append(f"content:{indicator}")
            
            # Score based on percentage of indicators found
            total_indicators = len(self.content_indicators[website_type])
            content_score = (content_matches / total_indicators) * 30
            score += min(content_score, 30)
        
        # Meta tag analysis (15 points max)
        meta_score = await self._analyze_meta_tags(soup, website_type, indicators_found)
        score += meta_score
        
        # Schema.org analysis (15 points max)
        schema_score = await self._analyze_schema_org(soup, website_type, indicators_found)
        score += schema_score
        
        return score, indicators_found
    
    async def _analyze_meta_tags(
        self, 
        soup: BeautifulSoup, 
        website_type: WebsiteType, 
        indicators_found: List[str]
    ) -> float:
        """Analyze meta tags for website type indicators."""
        
        score = 0.0
        
        if website_type not in self.meta_indicators:
            return score
        
        # Check various meta tags
        meta_tags = soup.find_all('meta')
        
        for meta in meta_tags:
            content = (meta.get('content', '') + ' ' + meta.get('name', '') + ' ' + 
                      meta.get('property', '')).lower()
            
            for indicator in self.meta_indicators[website_type]:
                if indicator in content:
                    score += 2  # Max 15 points for meta tags
                    indicators_found.append(f"meta:{indicator}")
                    
                    if score >= 15:
                        break
            
            if score >= 15:
                break
        
        return min(score, 15)
    
    async def _analyze_schema_org(
        self, 
        soup: BeautifulSoup, 
        website_type: WebsiteType, 
        indicators_found: List[str]
    ) -> float:
        """Analyze Schema.org structured data."""
        
        score = 0.0
        
        if website_type not in self.schema_indicators:
            return score
        
        # Check for JSON-LD structured data
        json_scripts = soup.find_all('script', type='application/ld+json')
        
        for script in json_scripts:
            try:
                import json
                data = json.loads(script.string)
                
                # Handle both single objects and arrays
                if isinstance(data, list):
                    schema_types = [item.get('@type', '') for item in data if isinstance(item, dict)]
                else:
                    schema_types = [data.get('@type', '')]
                
                for schema_type in schema_types:
                    if schema_type in self.schema_indicators[website_type]:
                        score += 5  # Max 15 points for schema
                        indicators_found.append(f"schema:{schema_type}")
                        
                        if score >= 15:
                            break
                
                if score >= 15:
                    break
                    
            except (json.JSONDecodeError, AttributeError):
                continue
        
        # Check for microdata attributes
        elements_with_itemtype = soup.find_all(attrs={'itemtype': True})
        
        for element in elements_with_itemtype:
            itemtype = element.get('itemtype', '')
            
            for indicator in self.schema_indicators[website_type]:
                if indicator in itemtype:
                    score += 3
                    indicators_found.append(f"microdata:{indicator}")
                    
                    if score >= 15:
                        break
            
            if score >= 15:
                break
        
        return min(score, 15)
    
    def _get_mode_recommendations(
        self, 
        website_type: WebsiteType
    ) -> Tuple[str, List[str]]:
        """Get crawling mode recommendations for a website type."""
        
        mode_mapping = {
            WebsiteType.ECOMMERCE: ("ecommerce", ["analytics", "documentation"]),
            WebsiteType.BLOG: ("blog", ["documentation", "analytics"]),
            WebsiteType.DOCUMENTATION: ("documentation", ["blog", "analytics"]),
            WebsiteType.NEWS: ("blog", ["analytics", "documentation"]),  # News similar to blog
            WebsiteType.ANALYTICS: ("analytics", ["documentation", "blog"]),
            WebsiteType.SOCIAL_MEDIA: ("blog", ["analytics"]),  # Social media like blog content
            WebsiteType.GOVERNMENT: ("documentation", ["analytics", "blog"]),
            WebsiteType.ACADEMIC: ("documentation", ["analytics", "blog"]),
            WebsiteType.CORPORATE: ("documentation", ["blog", "analytics"]),
            WebsiteType.UNKNOWN: ("documentation", ["blog", "analytics"]),
        }
        
        return mode_mapping.get(website_type, ("documentation", ["blog", "analytics"]))
    
    def get_supported_types(self) -> List[WebsiteType]:
        """Get list of supported website types."""
        return [t for t in WebsiteType if t != WebsiteType.UNKNOWN]
    
    def get_type_description(self, website_type: WebsiteType) -> str:
        """Get human-readable description of website type."""
        
        descriptions = {
            WebsiteType.ECOMMERCE: "E-commerce and online shopping sites",
            WebsiteType.BLOG: "Blogs and personal publishing sites",
            WebsiteType.DOCUMENTATION: "Technical documentation and API references",
            WebsiteType.NEWS: "News and journalism websites",
            WebsiteType.SOCIAL_MEDIA: "Social networking and community sites",
            WebsiteType.ANALYTICS: "Analytics and reporting dashboards",
            WebsiteType.GOVERNMENT: "Government and public sector sites",
            WebsiteType.ACADEMIC: "Academic and research institutions",
            WebsiteType.CORPORATE: "Corporate and business websites",
            WebsiteType.UNKNOWN: "Unknown or unclassified website type",
        }
        
        return descriptions.get(website_type, "Unknown website type")