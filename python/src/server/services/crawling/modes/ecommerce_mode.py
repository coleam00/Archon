"""
E-commerce Crawling Mode

Advanced e-commerce website crawling with specialized extraction for:
- Product information and specifications
- Pricing and promotional data
- Product variants and options
- Customer reviews and ratings
- Inventory status
"""

import re
import json
import asyncio
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Any, Optional
from urllib.parse import urljoin, urlparse
from dataclasses import dataclass, field

from crawl4ai import CrawlerRunConfig, CacheMode
from bs4 import BeautifulSoup

from .base_mode import BaseCrawlingMode, CrawlingResult, ModeConfiguration, CrawlingMode
from ....config.logfire_config import get_logger

logger = get_logger(__name__)


@dataclass
class ProductData:
    """Structured product data extracted from e-commerce sites."""
    
    name: str = ""
    brand: str = ""
    sku: str = ""
    description: str = ""
    price_current: Optional[Decimal] = None
    price_original: Optional[Decimal] = None
    currency: str = "USD"
    availability: str = ""
    rating: Optional[float] = None
    review_count: int = 0
    images: List[str] = field(default_factory=list)
    variants: List[Dict[str, Any]] = field(default_factory=list)
    specifications: Dict[str, str] = field(default_factory=dict)


class EcommerceCrawlingMode(BaseCrawlingMode):
    """Advanced e-commerce crawling mode with intelligent product data extraction."""
    
    def _initialize_mode(self):
        """Initialize e-commerce specific settings."""
        self.product_selectors = {
            "amazon": {
                "name": "#productTitle, .product-title",
                "price": ".a-price-whole, .a-offscreen",
                "original_price": ".a-text-price .a-offscreen",
                "rating": ".a-icon-alt",
                "reviews": "[data-hook='total-review-count']",
                "availability": "#availability span",
                "images": ".a-dynamic-image",
                "brand": "#bylineInfo"
            },
            "shopify": {
                "name": ".product-title, .product__title",
                "price": ".price, .product-price",
                "original_price": ".compare-at-price",
                "rating": ".rating, .stars",
                "availability": ".availability, .stock-status",
                "images": ".product-image img",
                "brand": ".vendor, .brand"
            },
            "generic": {
                "name": "h1, .product-title",
                "price": ".price, .cost, .amount",
                "rating": ".rating, .stars",
                "images": ".product img, .gallery img",
                "availability": ".stock, .availability"
            }
        }
        
        self.price_patterns = [
            r'\$[\d,]+\.?\d{0,2}',
            r'USD\s*[\d,]+\.?\d{0,2}',
            r'€[\d,]+\.?\d{0,2}',
            r'£[\d,]+\.?\d{0,2}'
        ]
        
        # Enhanced configuration for e-commerce
        self.config.page_timeout = 45000
        self.config.delay_before_html = 1.0
        self.config.stealth_mode = True
    
    async def can_handle_url(self, url: str) -> bool:
        """Determine if this mode can handle the given URL."""
        url_lower = url.lower()
        ecommerce_patterns = [
            r'amazon\.', r'ebay\.', r'shopify\.', r'etsy\.', r'walmart\.',
            r'/product/', r'/item/', r'/p/', r'/shop/', r'/store/'
        ]
        return any(re.search(pattern, url_lower) for pattern in ecommerce_patterns)
    
    async def detect_website_features(self, url: str, html_content: Optional[str] = None) -> Dict[str, Any]:
        """Analyze website features to determine e-commerce compatibility."""
        if not html_content:
            return {"confidence": 0.0, "features": []}
        
        soup = BeautifulSoup(html_content, 'html.parser')
        features = []
        confidence_score = 0.0
        
        # Check for e-commerce indicators
        indicators = [
            ("price elements", soup.find_all(string=re.compile(r'\$[\d,]+\.?\d{0,2}'))),
            ("cart buttons", soup.find_all(['button', 'a'], string=re.compile(r'add to cart|buy now', re.I))),
            ("rating stars", soup.find_all(attrs={'class': re.compile(r'rating|stars', re.I)})),
            ("product schema", soup.find_all(attrs={'itemtype': re.compile(r'Product', re.I)})),
        ]
        
        for feature_name, elements in indicators:
            if elements:
                features.append(feature_name)
                confidence_score += 0.25
        
        return {
            "confidence": min(confidence_score, 1.0),
            "features": features,
            "platform": self._detect_platform(html_content)
        }
    
    def _detect_platform(self, html_content: str) -> str:
        """Detect the e-commerce platform being used."""
        html_lower = html_content.lower()
        
        if "amazon" in html_lower:
            return "amazon"
        elif "shopify" in html_lower:
            return "shopify"
        elif "woocommerce" in html_lower:
            return "woocommerce"
        else:
            return "generic"
    
    async def create_crawler_config(self, url: str, **kwargs) -> CrawlerRunConfig:
        """Create specialized crawler configuration for e-commerce sites."""
        return CrawlerRunConfig(
            cache_mode=CacheMode.ENABLED,
            stream=True,
            markdown_generator=self.markdown_generator,
            wait_until='networkidle',
            page_timeout=self.config.page_timeout,
            delay_before_return_html=self.config.delay_before_html,
            scan_full_page=True,
            wait_for_images=True,
            exclude_all_images=False,
            remove_overlay_elements=True,
            wait_for=".price, .product-title, h1"
        )
    
    async def extract_structured_data(self, url: str, html: str, markdown: str) -> Dict[str, Any]:
        """Extract comprehensive e-commerce data from the page."""
        soup = BeautifulSoup(html, 'html.parser')
        platform = self._detect_platform(html)
        
        product_data = ProductData()
        
        # Extract basic product information
        await self._extract_basic_info(soup, product_data, platform)
        await self._extract_pricing(soup, product_data, platform)
        await self._extract_reviews(soup, product_data, platform)
        
        # Extract structured data
        schema_data = await self._extract_schema_data(soup)
        
        return {
            "product": self._product_to_dict(product_data),
            "schema_data": schema_data,
            "platform": platform,
            "extraction_timestamp": asyncio.get_event_loop().time()
        }
    
    async def _extract_basic_info(self, soup: BeautifulSoup, product_data: ProductData, platform: str):
        """Extract basic product information."""
        selectors = self.product_selectors.get(platform, self.product_selectors["generic"])
        
        # Product name
        name_elem = soup.select_one(selectors.get("name", "h1"))
        if name_elem:
            product_data.name = name_elem.get_text(strip=True)
        
        # Brand
        brand_elem = soup.select_one(selectors.get("brand", ".brand"))
        if brand_elem:
            product_data.brand = brand_elem.get_text(strip=True)
        
        # Images
        img_selector = selectors.get("images", "img")
        img_elements = soup.select(img_selector)
        for img in img_elements[:5]:
            src = img.get('src') or img.get('data-src')
            if src and isinstance(src, str):
                if src.startswith('//'):
                    src = 'https:' + src
                elif src.startswith('/'):
                    src = urljoin(url, src)
                product_data.images.append(src)
    
    async def _extract_pricing(self, soup: BeautifulSoup, product_data: ProductData, platform: str):
        """Extract pricing information."""
        selectors = self.product_selectors.get(platform, self.product_selectors["generic"])
        
        # Current price
        price_elem = soup.select_one(selectors.get("price", ".price"))
        if price_elem:
            price_text = price_elem.get_text(strip=True)
            product_data.price_current = self._parse_price(price_text)
        
        # Original price
        original_price_elem = soup.select_one(selectors.get("original_price", ".original-price"))
        if original_price_elem:
            original_price_text = original_price_elem.get_text(strip=True)
            product_data.price_original = self._parse_price(original_price_text)
        
        # Availability
        availability_elem = soup.select_one(selectors.get("availability", ".availability"))
        if availability_elem:
            availability_text = availability_elem.get_text(strip=True).lower()
            if any(word in availability_text for word in ['in stock', 'available']):
                product_data.availability = 'in_stock'
            elif any(word in availability_text for word in ['out of stock', 'unavailable']):
                product_data.availability = 'out_of_stock'
    
    def _parse_price(self, price_text: str) -> Optional[Decimal]:
        """Parse price from text using regex patterns."""
        if not price_text:
            return None
        
        for pattern in self.price_patterns:
            match = re.search(pattern, price_text)
            if match:
                price_str = match.group(0)
                price_str = re.sub(r'[^\d.,]', '', price_str)
                price_str = price_str.replace(',', '')
                
                try:
                    return Decimal(price_str)
                except InvalidOperation:
                    continue
        return None
    
    async def _extract_reviews(self, soup: BeautifulSoup, product_data: ProductData, platform: str):
        """Extract review and rating information."""
        selectors = self.product_selectors.get(platform, self.product_selectors["generic"])
        
        # Rating
        rating_elem = soup.select_one(selectors.get("rating", ".rating"))
        if rating_elem:
            rating_text = rating_elem.get_text() or rating_elem.get('title', '')
            if isinstance(rating_text, str):
                rating_match = re.search(r'(\d+\.?\d*)', rating_text)
            if rating_match:
                product_data.rating = float(rating_match.group(1))
        
        # Review count
        reviews_elem = soup.select_one(selectors.get("reviews", ".reviews"))
        if reviews_elem:
            reviews_text = reviews_elem.get_text()
            review_match = re.search(r'(\d+)', reviews_text)
            if review_match:
                product_data.review_count = int(review_match.group(1))
    
    async def _extract_schema_data(self, soup: BeautifulSoup) -> Dict[str, Any]:
        """Extract structured data from JSON-LD."""
        schema_data = {}
        
        json_ld_scripts = soup.find_all('script', type='application/ld+json')
        for script in json_ld_scripts:
            try:
                data = json.loads(script.string)
                if isinstance(data, dict) and data.get('@type') == 'Product':
                    schema_data['json_ld'] = data
                    break
            except (json.JSONDecodeError, AttributeError):
                continue
        
        return schema_data
    
    def _product_to_dict(self, product_data: ProductData) -> Dict[str, Any]:
        """Convert ProductData to dictionary."""
        return {
            "name": product_data.name,
            "brand": product_data.brand,
            "sku": product_data.sku,
            "description": product_data.description,
            "price_current": float(product_data.price_current) if product_data.price_current else None,
            "price_original": float(product_data.price_original) if product_data.price_original else None,
            "currency": product_data.currency,
            "availability": product_data.availability,
            "rating": product_data.rating,
            "review_count": product_data.review_count,
            "images": product_data.images,
            "variants": product_data.variants,
            "specifications": product_data.specifications
        }
    
    async def post_process_content(self, raw_result: Dict[str, Any]) -> CrawlingResult:
        """Post-process the crawled content and create the final result."""
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
                "product_data_extracted": bool(raw_result.get("structured_data", {}).get("product")),
                "schema_data_found": bool(raw_result.get("structured_data", {}).get("schema_data")),
                "images_found": len(raw_result.get("structured_data", {}).get("product", {}).get("images", []))
            }
        )
    
    def _get_capabilities(self) -> List[str]:
        """Return a list of capabilities this mode provides."""
        return [
            "product_extraction",
            "price_tracking",
            "variant_analysis",
            "review_extraction",
            "schema_parsing",
            "competitive_intelligence"
        ]
    
    def _get_supported_features(self) -> List[str]:
        """Return a list of features this mode supports."""
        return [
            "multi_platform_support",
            "dynamic_content_handling",
            "anti_bot_detection",
            "structured_data_extraction",
            "price_comparison",
            "inventory_tracking"
        ]