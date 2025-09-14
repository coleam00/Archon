"""
Intelligent Website Type Detection System

This module provides advanced website classification and mode detection
capabilities for automatic crawling mode selection. It uses multiple
analysis techniques including URL patterns, content analysis, and
machine learning-based classification.
"""

import re
import asyncio
import json
from typing import Dict, List, Tuple, Optional, Any
from urllib.parse import urlparse, parse_qs
from dataclasses import dataclass, field
from enum import Enum

import httpx
from bs4 import BeautifulSoup

from ..modes.base_mode import CrawlingMode
from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class ConfidenceLevel(Enum):
    """Confidence levels for website type detection."""
    VERY_HIGH = 0.9
    HIGH = 0.7
    MEDIUM = 0.5
    LOW = 0.3
    VERY_LOW = 0.1


@dataclass
class DetectionFeature:
    """Represents a feature detected in website analysis."""
    name: str
    value: Any
    confidence: float
    source: str  # 'url', 'html', 'meta', 'structure'


@dataclass
class DetectionResult:
    """Result of website type detection."""
    detected_mode: CrawlingMode
    confidence: float
    features: List[DetectionFeature] = field(default_factory=list)
    platform: Optional[str] = None
    reasoning: List[str] = field(default_factory=list)
    analysis_time: float = 0.0


class WebsiteTypeDetector:
    """
    Advanced website type detection system using multiple analysis techniques.
    
    Detection Methods:
    1. URL Pattern Analysis - Domain and path pattern matching
    2. Content Structure Analysis - HTML element and class detection
    3. Meta Information Analysis - Schema.org, OpenGraph, meta tags
    4. Platform Detection - Technology stack identification
    5. Behavioral Analysis - JavaScript patterns and API calls
    """
    
    def __init__(self):
        """Initialize the website type detector."""
        self.url_patterns = self._initialize_url_patterns()
        self.content_indicators = self._initialize_content_indicators()
        self.platform_signatures = self._initialize_platform_signatures()
        self.schema_types = self._initialize_schema_types()
        
    def _initialize_url_patterns(self) -> Dict[CrawlingMode, List[Tuple[str, float]]]:
        """Initialize URL patterns for different website types."""
        return {
            CrawlingMode.ECOMMERCE: [
                # E-commerce domains (high confidence)
                (r'amazon\.(com|co\.uk|de|fr|it|es|ca|au)', 0.95),
                (r'ebay\.(com|co\.uk|de|fr|it|es|ca|au)', 0.95),
                (r'etsy\.com', 0.95),
                (r'shopify\.com', 0.95),
                (r'walmart\.com', 0.95),
                (r'target\.com', 0.95),
                (r'bestbuy\.com', 0.95),
                (r'alibaba\.com', 0.95),
                (r'aliexpress\.com', 0.95),
                
                # E-commerce URL patterns (medium-high confidence)
                (r'/product[s]?/', 0.8),
                (r'/item[s]?/', 0.8),
                (r'/p/', 0.7),
                (r'/dp/', 0.8),  # Amazon product pages
                (r'/products/', 0.8),
                (r'/shop/', 0.7),
                (r'/store/', 0.6),
                (r'/buy/', 0.7),
                (r'/cart', 0.6),
                (r'/checkout', 0.6),
                
                # E-commerce subdomains (medium confidence)
                (r'shop\.', 0.6),
                (r'store\.', 0.6),
                (r'market\.', 0.5),
                
                # Query parameters (low-medium confidence)
                (r'[\?&]product', 0.4),
                (r'[\?&]sku=', 0.5),
                (r'[\?&]item', 0.4),
            ],
            
            CrawlingMode.BLOG: [
                # Blog platforms (high confidence)
                (r'wordpress\.(com|org)', 0.9),
                (r'blogspot\.com', 0.9),
                (r'medium\.com', 0.9),
                (r'substack\.com', 0.9),
                (r'ghost\.(io|org)', 0.9),
                (r'tumblr\.com', 0.9),
                (r'wix\.com', 0.7),
                (r'squarespace\.com', 0.7),
                
                # Blog URL patterns (medium-high confidence)
                (r'/blog/', 0.8),
                (r'/post[s]?/', 0.8),
                (r'/article[s]?/', 0.8),
                (r'/news/', 0.7),
                (r'/stories/', 0.6),
                (r'/updates/', 0.5),
                
                # Blog subdomains (medium confidence)
                (r'blog\.', 0.7),
                (r'news\.', 0.6),
                (r'articles\.', 0.6),
            ],
            
            CrawlingMode.DOCUMENTATION: [
                # Documentation platforms (high confidence)
                (r'readthedocs\.(io|org)', 0.95),
                (r'gitbook\.(io|com)', 0.95),
                (r'notion\.(so|site)', 0.8),
                (r'confluence\.', 0.8),
                (r'github\.io', 0.7),
                
                # Documentation URL patterns (high confidence)
                (r'/docs?/', 0.9),
                (r'/documentation/', 0.9),
                (r'/api/', 0.8),
                (r'/reference/', 0.8),
                (r'/guide[s]?/', 0.8),
                (r'/tutorial[s]?/', 0.7),
                (r'/manual/', 0.7),
                (r'/help/', 0.6),
                (r'/wiki/', 0.6),
                
                # Documentation subdomains (high confidence)
                (r'docs?\.', 0.9),
                (r'api\.', 0.8),
                (r'developer\.', 0.8),
                (r'support\.', 0.5),
            ],
            
            CrawlingMode.NEWS: [
                # News domains (high confidence)
                (r'cnn\.com', 0.95),
                (r'bbc\.(com|co\.uk)', 0.95),
                (r'reuters\.com', 0.95),
                (r'ap\.org', 0.95),
                (r'npr\.org', 0.95),
                (r'nytimes\.com', 0.95),
                (r'washingtonpost\.com', 0.95),
                (r'guardian\.(com|co\.uk)', 0.95),
                (r'bloomberg\.com', 0.95),
                (r'wsj\.com', 0.95),
                (r'techcrunch\.com', 0.9),
                (r'wired\.com', 0.9),
                (r'arstechnica\.com', 0.9),
                (r'theverge\.com', 0.9),
                
                # News URL patterns (medium confidence)
                (r'/news/', 0.7),
                (r'/breaking/', 0.8),
                (r'/headlines/', 0.7),
                (r'/latest/', 0.5),
            ]
        }
    
    def _initialize_content_indicators(self) -> Dict[CrawlingMode, Dict[str, List[Tuple[str, float]]]]:
        """Initialize content-based indicators for different website types."""
        return {
            CrawlingMode.ECOMMERCE: {
                'css_classes': [
                    ('product', 0.8),
                    ('price', 0.9),
                    ('cart', 0.8),
                    ('buy', 0.7),
                    ('checkout', 0.8),
                    ('add-to-cart', 0.9),
                    ('product-title', 0.8),
                    ('product-price', 0.9),
                    ('product-image', 0.7),
                    ('rating', 0.6),
                    ('review', 0.6),
                    ('inventory', 0.7),
                    ('stock', 0.7),
                    ('variant', 0.6),
                    ('specification', 0.5),
                ],
                'html_elements': [
                    ('button[class*="cart"]', 0.8),
                    ('button[class*="buy"]', 0.8),
                    ('form[action*="cart"]', 0.9),
                    ('div[class*="price"]', 0.8),
                    ('span[class*="price"]', 0.8),
                    ('.product-grid', 0.7),
                    ('.product-list', 0.7),
                    ('.rating-stars', 0.6),
                    ('.review-count', 0.6),
                ],
                'text_patterns': [
                    (r'\$[\d,]+\.?\d{0,2}', 0.8),  # Price patterns
                    (r'add to cart', 0.9),
                    (r'buy now', 0.8),
                    (r'in stock', 0.7),
                    (r'out of stock', 0.7),
                    (r'free shipping', 0.6),
                    (r'customer review', 0.6),
                    (r'product detail', 0.7),
                ]
            },
            
            CrawlingMode.BLOG: {
                'css_classes': [
                    ('post', 0.8),
                    ('article', 0.8),
                    ('blog', 0.7),
                    ('author', 0.7),
                    ('published', 0.6),
                    ('content', 0.5),
                    ('entry', 0.6),
                    ('story', 0.6),
                    ('comment', 0.6),
                ],
                'html_elements': [
                    ('article', 0.9),
                    ('time[datetime]', 0.7),
                    ('.author', 0.7),
                    ('.byline', 0.7),
                    ('.post-meta', 0.8),
                    ('.comments', 0.6),
                    ('.tags', 0.5),
                    ('.categories', 0.5),
                ],
                'text_patterns': [
                    (r'by\s+[A-Z][a-z]+\s+[A-Z][a-z]+', 0.6),  # Author byline
                    (r'published on', 0.6),
                    (r'posted on', 0.6),
                    (r'share this', 0.5),
                    (r'leave a comment', 0.6),
                ]
            },
            
            CrawlingMode.DOCUMENTATION: {
                'css_classes': [
                    ('docs', 0.8),
                    ('documentation', 0.9),
                    ('api', 0.7),
                    ('reference', 0.7),
                    ('guide', 0.6),
                    ('tutorial', 0.6),
                    ('code', 0.6),
                    ('example', 0.5),
                    ('syntax', 0.6),
                ],
                'html_elements': [
                    ('pre', 0.7),
                    ('code', 0.7),
                    ('.highlight', 0.6),
                    ('.code-block', 0.8),
                    ('.api-reference', 0.9),
                    ('nav.toc', 0.7),
                    ('.sidebar', 0.5),
                ],
                'text_patterns': [
                    (r'```', 0.8),  # Code blocks
                    (r'function\s+\w+\(', 0.6),
                    (r'class\s+\w+', 0.6),
                    (r'import\s+\w+', 0.6),
                    (r'api endpoint', 0.7),
                    (r'parameters?:', 0.6),
                    (r'returns?:', 0.6),
                ]
            }
        }
    
    def _initialize_platform_signatures(self) -> Dict[str, List[Tuple[str, float]]]:
        """Initialize platform-specific signatures."""
        return {
            'shopify': [
                ('shopify', 0.9),
                ('myshopify', 0.95),
                ('cdn.shopify', 0.8),
                ('shop.app', 0.7),
            ],
            'woocommerce': [
                ('woocommerce', 0.9),
                ('wp-content', 0.6),
                ('wc-', 0.7),
            ],
            'magento': [
                ('magento', 0.9),
                ('mage/', 0.8),
                ('varien', 0.7),
            ],
            'wordpress': [
                ('wp-content', 0.8),
                ('wp-includes', 0.8),
                ('wordpress', 0.9),
            ],
            'drupal': [
                ('drupal', 0.9),
                ('/sites/default', 0.7),
            ]
        }
    
    def _initialize_schema_types(self) -> Dict[str, CrawlingMode]:
        """Initialize Schema.org type mappings."""
        return {
            'Product': CrawlingMode.ECOMMERCE,
            'Offer': CrawlingMode.ECOMMERCE,
            'Store': CrawlingMode.ECOMMERCE,
            'BlogPosting': CrawlingMode.BLOG,
            'Article': CrawlingMode.BLOG,
            'NewsArticle': CrawlingMode.NEWS,
            'TechArticle': CrawlingMode.DOCUMENTATION,
            'Organization': CrawlingMode.STANDARD,
            'WebSite': CrawlingMode.STANDARD,
        }
    
    async def detect_website_type(
        self, 
        url: str, 
        html_content: Optional[str] = None,
        fetch_content: bool = True
    ) -> DetectionResult:
        """
        Detect the website type and recommend appropriate crawling mode.
        
        Args:
            url: URL to analyze
            html_content: Optional HTML content (if None, will fetch)
            fetch_content: Whether to fetch content if not provided
            
        Returns:
            DetectionResult with mode recommendation and analysis
        """
        start_time = asyncio.get_event_loop().time()
        features = []
        reasoning = []
        
        try:
            # Step 1: URL Analysis
            url_result = self._analyze_url(url)
            features.extend(url_result['features'])
            reasoning.extend(url_result['reasoning'])
            
            # Step 2: Content Analysis (if available or fetchable)
            content_result = None
            if html_content:
                content_result = await self._analyze_content(html_content, url)
            elif fetch_content:
                try:
                    html_content = await self._fetch_content_sample(url)
                    if html_content:
                        content_result = await self._analyze_content(html_content, url)
                except Exception as e:
                    logger.warning(f"Failed to fetch content for {url}: {e}")
            
            if content_result:
                features.extend(content_result['features'])
                reasoning.extend(content_result['reasoning'])
            
            # Step 3: Aggregate scores and determine best mode
            mode_scores = self._calculate_mode_scores(features)
            
            # Step 4: Select best mode
            if mode_scores:
                best_mode = max(mode_scores.items(), key=lambda x: x[1])
                detected_mode, confidence = best_mode
            else:
                detected_mode = CrawlingMode.STANDARD
                confidence = 0.5
                reasoning.append("No specific indicators found, defaulting to standard mode")
            
            # Step 5: Platform detection
            platform = self._detect_platform(html_content or "", url)
            
            analysis_time = asyncio.get_event_loop().time() - start_time
            
            return DetectionResult(
                detected_mode=detected_mode,
                confidence=confidence,
                features=features,
                platform=platform,
                reasoning=reasoning,
                analysis_time=analysis_time
            )
            
        except Exception as e:
            logger.error(f"Error in website type detection for {url}: {e}")
            return DetectionResult(
                detected_mode=CrawlingMode.STANDARD,
                confidence=0.3,
                features=[],
                platform=None,
                reasoning=[f"Detection failed: {str(e)}"],
                analysis_time=asyncio.get_event_loop().time() - start_time
            )
    
    def _analyze_url(self, url: str) -> Dict[str, Any]:
        """Analyze URL patterns to determine website type."""
        features = []
        reasoning = []
        
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        path = parsed.path.lower()
        query = parsed.query.lower()
        full_url = url.lower()
        
        # Check each mode's URL patterns
        for mode, patterns in self.url_patterns.items():
            for pattern, confidence in patterns:
                if re.search(pattern, full_url):
                    features.append(DetectionFeature(
                        name=f"url_pattern_{mode.value}",
                        value=pattern,
                        confidence=confidence,
                        source='url'
                    ))
                    reasoning.append(f"URL matches {mode.value} pattern: {pattern}")
        
        # Domain analysis
        if any(ecom in domain for ecom in ['shop', 'store', 'market', 'buy']):
            features.append(DetectionFeature(
                name="ecommerce_domain_keyword",
                value=domain,
                confidence=0.6,
                source='url'
            ))
            reasoning.append(f"Domain contains e-commerce keywords: {domain}")
        
        # Path analysis
        if '/api/' in path:
            features.append(DetectionFeature(
                name="api_path",
                value=path,
                confidence=0.7,
                source='url'
            ))
            reasoning.append("URL contains API path, suggesting documentation")
        
        return {'features': features, 'reasoning': reasoning}
    
    async def _fetch_content_sample(self, url: str, max_size: int = 50000) -> Optional[str]:
        """Fetch a sample of the page content for analysis."""
        try:
            timeout = httpx.Timeout(10.0, connect=5.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(url, follow_redirects=True)
                if response.status_code == 200:
                    # Get first portion of content for analysis
                    content = response.text[:max_size]
                    return content
        except Exception as e:
            logger.debug(f"Failed to fetch content sample from {url}: {e}")
        return None
    
    async def _analyze_content(self, html_content: str, url: str) -> Dict[str, Any]:
        """Analyze HTML content to determine website type."""
        features = []
        reasoning = []
        
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # Analyze each mode's content indicators
        for mode, indicators in self.content_indicators.items():
            mode_score = 0
            mode_matches = []
            
            # CSS class analysis
            for class_pattern, confidence in indicators.get('css_classes', []):
                elements = soup.find_all(attrs={'class': re.compile(class_pattern, re.I)})
                if elements:
                    feature_confidence = min(confidence * len(elements) * 0.1, confidence)
                    features.append(DetectionFeature(
                        name=f"css_class_{mode.value}_{class_pattern}",
                        value=len(elements),
                        confidence=feature_confidence,
                        source='html'
                    ))
                    mode_matches.append(f"CSS class '{class_pattern}' ({len(elements)} matches)")
            
            # HTML element analysis
            for selector, confidence in indicators.get('html_elements', []):
                elements = soup.select(selector)
                if elements:
                    feature_confidence = min(confidence * len(elements) * 0.1, confidence)
                    features.append(DetectionFeature(
                        name=f"html_element_{mode.value}_{selector}",
                        value=len(elements),
                        confidence=feature_confidence,
                        source='html'
                    ))
                    mode_matches.append(f"HTML selector '{selector}' ({len(elements)} matches)")
            
            # Text pattern analysis
            text_content = soup.get_text().lower()
            for pattern, confidence in indicators.get('text_patterns', []):
                matches = re.findall(pattern, text_content, re.I)
                if matches:
                    feature_confidence = min(confidence * len(matches) * 0.05, confidence)
                    features.append(DetectionFeature(
                        name=f"text_pattern_{mode.value}_{pattern}",
                        value=len(matches),
                        confidence=feature_confidence,
                        source='html'
                    ))
                    mode_matches.append(f"Text pattern '{pattern}' ({len(matches)} matches)")
            
            if mode_matches:
                reasoning.append(f"{mode.value.title()} indicators: {', '.join(mode_matches[:3])}")
        
        # Schema.org analysis
        schema_features = self._analyze_schema_org(soup)
        features.extend(schema_features['features'])
        reasoning.extend(schema_features['reasoning'])
        
        # Meta tag analysis
        meta_features = self._analyze_meta_tags(soup)
        features.extend(meta_features['features'])
        reasoning.extend(meta_features['reasoning'])
        
        return {'features': features, 'reasoning': reasoning}
    
    def _analyze_schema_org(self, soup: BeautifulSoup) -> Dict[str, Any]:
        """Analyze Schema.org structured data."""
        features = []
        reasoning = []
        
        # JSON-LD analysis
        json_ld_scripts = soup.find_all('script', type='application/ld+json')
        for script in json_ld_scripts:
            try:
                data = json.loads(script.string)
                schema_type = None
                
                if isinstance(data, dict):
                    schema_type = data.get('@type')
                elif isinstance(data, list) and data:
                    schema_type = data[0].get('@type') if isinstance(data[0], dict) else None
                
                if schema_type and schema_type in self.schema_types:
                    mode = self.schema_types[schema_type]
                    features.append(DetectionFeature(
                        name=f"schema_type_{mode.value}",
                        value=schema_type,
                        confidence=0.8,
                        source='meta'
                    ))
                    reasoning.append(f"Found Schema.org {schema_type} markup indicating {mode.value}")
                    
            except (json.JSONDecodeError, AttributeError):
                continue
        
        # Microdata analysis
        items_with_type = soup.find_all(attrs={'itemtype': True})
        for item in items_with_type:
            item_type = item.get('itemtype', '')
            for schema_name, mode in self.schema_types.items():
                if schema_name.lower() in item_type.lower():
                    features.append(DetectionFeature(
                        name=f"microdata_{mode.value}",
                        value=item_type,
                        confidence=0.7,
                        source='meta'
                    ))
                    reasoning.append(f"Found microdata {schema_name} indicating {mode.value}")
        
        return {'features': features, 'reasoning': reasoning}
    
    def _analyze_meta_tags(self, soup: BeautifulSoup) -> Dict[str, Any]:
        """Analyze meta tags for website type indicators."""
        features = []
        reasoning = []
        
        # OpenGraph analysis
        og_type = soup.find('meta', property='og:type')
        if og_type and hasattr(og_type, 'get'):
            og_content = og_type.get('content')
            if og_content:
                og_value = str(og_content).lower()
            if 'product' in og_value:
                features.append(DetectionFeature(
                    name="og_type_product",
                    value=og_value,
                    confidence=0.8,
                    source='meta'
                ))
                reasoning.append(f"OpenGraph type indicates product: {og_value}")
            elif 'article' in og_value:
                features.append(DetectionFeature(
                    name="og_type_article",
                    value=og_value,
                    confidence=0.7,
                    source='meta'
                ))
                reasoning.append(f"OpenGraph type indicates article: {og_value}")
        
        # Generator meta tag
        generator = soup.find('meta', attrs={'name': 'generator'})
        if generator and hasattr(generator, 'get'):
            gen_content_raw = generator.get('content')
            if gen_content_raw:
                gen_content = str(gen_content_raw).lower()
            platform = self._detect_platform_from_generator(gen_content)
            if platform:
                features.append(DetectionFeature(
                    name=f"generator_{platform}",
                    value=gen_content,
                    confidence=0.8,
                    source='meta'
                ))
                reasoning.append(f"Generator meta tag indicates {platform}: {gen_content}")
        
        return {'features': features, 'reasoning': reasoning}
    
    def _detect_platform_from_generator(self, generator_content: str) -> Optional[str]:
        """Detect platform from generator meta tag."""
        for platform, signatures in self.platform_signatures.items():
            for signature, confidence in signatures:
                if signature.lower() in generator_content:
                    return platform
        return None
    
    def _calculate_mode_scores(self, features: List[DetectionFeature]) -> Dict[CrawlingMode, float]:
        """Calculate aggregate scores for each crawling mode."""
        mode_scores = {}
        
        for feature in features:
            # Extract mode from feature name
            for mode in CrawlingMode:
                if mode.value in feature.name:
                    if mode not in mode_scores:
                        mode_scores[mode] = 0.0
                    
                    # Weight the confidence by feature source
                    source_weight = {
                        'url': 1.0,
                        'meta': 0.9,
                        'html': 0.8,
                        'structure': 0.7
                    }.get(feature.source, 0.5)
                    
                    weighted_confidence = feature.confidence * source_weight
                    mode_scores[mode] += weighted_confidence
                    break
        
        # Normalize scores
        if mode_scores:
            max_score = max(mode_scores.values())
            if max_score > 0:
                for mode in mode_scores:
                    mode_scores[mode] = min(mode_scores[mode] / max_score, 1.0)
        
        return mode_scores
    
    def _detect_platform(self, html_content: str, url: str) -> Optional[str]:
        """Detect the specific platform/technology stack."""
        if not html_content:
            return None
        
        html_lower = html_content.lower()
        url_lower = url.lower()
        
        # Platform detection based on content signatures
        for platform, signatures in self.platform_signatures.items():
            for signature, confidence in signatures:
                if signature in html_lower or signature in url_lower:
                    return platform
        
        return None
    
    def get_detection_summary(self, result: DetectionResult) -> Dict[str, Any]:
        """Get a human-readable summary of detection results."""
        return {
            "detected_mode": result.detected_mode.value,
            "confidence": result.confidence,
            "confidence_level": self._get_confidence_level(result.confidence).name,
            "platform": result.platform,
            "total_features": len(result.features),
            "analysis_time_ms": round(result.analysis_time * 1000, 2),
            "reasoning": result.reasoning[:5],  # Top 5 reasons
            "feature_summary": self._summarize_features(result.features)
        }
    
    def _get_confidence_level(self, confidence: float) -> ConfidenceLevel:
        """Convert confidence score to confidence level."""
        if confidence >= ConfidenceLevel.VERY_HIGH.value:
            return ConfidenceLevel.VERY_HIGH
        elif confidence >= ConfidenceLevel.HIGH.value:
            return ConfidenceLevel.HIGH
        elif confidence >= ConfidenceLevel.MEDIUM.value:
            return ConfidenceLevel.MEDIUM
        elif confidence >= ConfidenceLevel.LOW.value:
            return ConfidenceLevel.LOW
        else:
            return ConfidenceLevel.VERY_LOW
    
    def _summarize_features(self, features: List[DetectionFeature]) -> Dict[str, int]:
        """Create a summary of detected features by source."""
        summary = {'url': 0, 'html': 0, 'meta': 0, 'structure': 0}
        for feature in features:
            if feature.source in summary:
                summary[feature.source] += 1
        return summary


# Global detector instance
_detector = WebsiteTypeDetector()


async def detect_website_type(
    url: str, 
    html_content: Optional[str] = None,
    fetch_content: bool = True
) -> DetectionResult:
    """
    Detect website type using the global detector instance.
    
    Args:
        url: URL to analyze
        html_content: Optional HTML content
        fetch_content: Whether to fetch content if not provided
        
    Returns:
        DetectionResult with mode recommendation
    """
    return await _detector.detect_website_type(url, html_content, fetch_content)


def get_detector() -> WebsiteTypeDetector:
    """Get the global detector instance."""
    return _detector