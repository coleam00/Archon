"""
E-commerce Crawling Mode

Advanced e-commerce website crawling with specialized extraction for:
- Product information (name, description, specifications)
- Pricing data (current, original, discounts, currency)
- Product variants (size, color, style options)
- Inventory status and availability
- Reviews and ratings
- Images and media
- Category and brand information
- Competitor price intelligence
"""

import re
import json
from typing import Dict, List, Set, Any, Optional
from datetime import datetime
from urllib.parse import urljoin, urlparse
from dataclasses import dataclass, field

from .base import BaseCrawlMode, CrawlModeConfig, ExtractedData, DataQuality


@dataclass
class ProductVariant:
    """Product variant information."""
    sku: Optional[str] = None
    name: Optional[str] = None
    attributes: Dict[str, str] = field(default_factory=dict)  # color, size, etc.
    price: Optional[float] = None
    original_price: Optional[float] = None
    availability: Optional[str] = None
    inventory_count: Optional[int] = None


@dataclass
class PriceInfo:
    """Pricing information."""
    current_price: Optional[float] = None
    original_price: Optional[float] = None
    currency: str = "USD"
    discount_percent: Optional[float] = None
    discount_amount: Optional[float] = None
    price_per_unit: Optional[str] = None
    bulk_pricing: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class ProductData:
    """Comprehensive product data."""
    
    # Basic info
    name: Optional[str] = None
    description: Optional[str] = None
    short_description: Optional[str] = None
    sku: Optional[str] = None
    brand: Optional[str] = None
    category: List[str] = field(default_factory=list)
    
    # Pricing
    pricing: PriceInfo = field(default_factory=PriceInfo)
    
    # Variants
    variants: List[ProductVariant] = field(default_factory=list)
    
    # Media
    images: List[str] = field(default_factory=list)
    videos: List[str] = field(default_factory=list)
    
    # Reviews & ratings
    rating: Optional[float] = None
    review_count: Optional[int] = None
    reviews: List[Dict[str, Any]] = field(default_factory=list)
    
    # Availability
    in_stock: Optional[bool] = None
    stock_count: Optional[int] = None
    availability_status: Optional[str] = None
    
    # Specifications
    specifications: Dict[str, str] = field(default_factory=dict)
    features: List[str] = field(default_factory=list)
    
    # SEO & metadata
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None
    tags: List[str] = field(default_factory=list)


class EcommerceCrawlMode(BaseCrawlMode):
    """Advanced e-commerce crawling mode with price intelligence capabilities."""
    
    def __init__(self, config: CrawlModeConfig):
        super().__init__(config)
        
        # E-commerce specific patterns
        self.price_patterns = [
            r'[\$£€¥₹]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)',
            r'(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*[\$£€¥₹]',
            r'price["\']?\s*:\s*["\']?(\d+(?:\.\d{2})?)',
        ]
        
        self.sku_patterns = [
            r'sku["\']?\s*:\s*["\']?([A-Z0-9\-_]+)',
            r'product[_-]?id["\']?\s*:\s*["\']?([A-Z0-9\-_]+)',
            r'item[_-]?number["\']?\s*:\s*["\']?([A-Z0-9\-_]+)',
        ]
    
    @property
    def supported_domains(self) -> Set[str]:
        """E-commerce platform domains."""
        return {
            r'.*amazon\.(com|co\.uk|de|fr|it|es|ca|au|in)',
            r'.*ebay\.(com|co\.uk|de|fr|it|es|ca|au)',
            r'.*shopify\.com',
            r'.*woocommerce\.com',
            r'.*magento\.com',
            r'.*bigcommerce\.com',
            r'.*walmart\.com',
            r'.*target\.com',
            r'.*bestbuy\.com',
            r'.*alibaba\.com',
            r'.*aliexpress\.com',
            # Add more patterns as needed
        }
    
    @property
    def mode_description(self) -> str:
        return "Advanced e-commerce product and pricing data extraction"
    
    async def detect_website_type(self, url: str, html_content: str) -> bool:
        """Detect if website is an e-commerce platform."""
        
        # Check domain patterns
        domain = urlparse(url).netlify
        for pattern in self.supported_domains:
            if re.match(pattern, domain):
                return True
        
        # Check for e-commerce indicators in HTML
        ecommerce_indicators = [
            'add to cart', 'buy now', 'shopping cart', 'checkout',
            'product-price', 'price-current', 'product-info',
            'add-to-basket', 'product-details', 'variant-selector'
        ]
        
        html_lower = html_content.lower()
        indicator_count = sum(1 for indicator in ecommerce_indicators if indicator in html_lower)
        
        return indicator_count >= 3
    
    async def extract_data(self, url: str, html_content: str, **kwargs) -> ExtractedData:
        """Extract comprehensive product data from e-commerce pages."""
        
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, 'html.parser')
        
        product_data = ProductData()
        
        # Extract basic product info
        await self._extract_basic_info(soup, product_data)
        
        # Extract pricing information
        await self._extract_pricing(soup, product_data)
        
        # Extract variants
        await self._extract_variants(soup, product_data)
        
        # Extract media
        await self._extract_media(soup, product_data, url)
        
        # Extract reviews and ratings
        await self._extract_reviews(soup, product_data)
        
        # Extract availability
        await self._extract_availability(soup, product_data)
        
        # Extract specifications
        await self._extract_specifications(soup, product_data)
        
        # Create extracted data object
        extracted = ExtractedData(
            url=url,
            title=product_data.name,
            description=product_data.description,
            main_content=str(soup.get_text()[:1000]),
            structured_data={
                'product': product_data.__dict__,
                'type': 'ecommerce_product'
            },
            metadata={
                'extraction_mode': 'ecommerce',
                'brand': product_data.brand,
                'category': product_data.category,
                'sku': product_data.sku,
            },
            data_quality=self._assess_data_quality(product_data),
            confidence_score=self._calculate_confidence(product_data)
        )
        
        return extracted
    
    async def _extract_basic_info(self, soup, product_data: ProductData):
        """Extract basic product information."""
        
        # Product name selectors (prioritized)
        name_selectors = [
            'h1[itemprop="name"]',
            'h1.product-title',
            'h1.product-name', 
            '.product-title',
            '.product-name',
            'h1',
        ]
        
        for selector in name_selectors:
            element = soup.select_one(selector)
            if element and element.get_text(strip=True):
                product_data.name = element.get_text(strip=True)
                break
        
        # Description selectors
        desc_selectors = [
            '[itemprop="description"]',
            '.product-description',
            '.product-details',
            '#description',
        ]
        
        for selector in desc_selectors:
            element = soup.select_one(selector)
            if element:
                product_data.description = element.get_text(strip=True)
                break
        
        # Brand extraction
        brand_selectors = [
            '[itemprop="brand"]',
            '.product-brand',
            '.brand-name',
        ]
        
        for selector in brand_selectors:
            element = soup.select_one(selector)
            if element:
                product_data.brand = element.get_text(strip=True)
                break
        
        # SKU extraction
        sku_text = str(soup)
        for pattern in self.sku_patterns:
            match = re.search(pattern, sku_text, re.IGNORECASE)
            if match:
                product_data.sku = match.group(1)
                break
    
    async def _extract_pricing(self, soup, product_data: ProductData):
        """Extract pricing information."""
        
        pricing = PriceInfo()
        
        # Price selectors
        price_selectors = [
            '[itemprop="price"]',
            '.price-current',
            '.current-price',
            '.product-price',
            '.price',
        ]
        
        price_text = ""
        for selector in price_selectors:
            element = soup.select_one(selector)
            if element:
                price_text = element.get_text(strip=True)
                break
        
        # Extract prices using regex
        for pattern in self.price_patterns:
            match = re.search(pattern, price_text)
            if match:
                try:
                    pricing.current_price = float(match.group(1).replace(',', ''))
                    break
                except (ValueError, IndexError):
                    continue
        
        # Original price (for discounts)
        original_selectors = [
            '.price-original',
            '.original-price', 
            '.was-price',
            '.msrp',
        ]
        
        for selector in original_selectors:
            element = soup.select_one(selector)
            if element:
                orig_text = element.get_text(strip=True)
                for pattern in self.price_patterns:
                    match = re.search(pattern, orig_text)
                    if match:
                        try:
                            pricing.original_price = float(match.group(1).replace(',', ''))
                            break
                        except (ValueError, IndexError):
                            continue
        
        # Calculate discount
        if pricing.current_price and pricing.original_price:
            if pricing.original_price > pricing.current_price:
                pricing.discount_amount = pricing.original_price - pricing.current_price
                pricing.discount_percent = (pricing.discount_amount / pricing.original_price) * 100
        
        product_data.pricing = pricing
    
    async def _extract_variants(self, soup, product_data: ProductData):
        """Extract product variants (size, color, etc.)."""
        
        # Look for variant selectors
        variant_selectors = soup.select('.variant-option, .size-option, .color-option')
        
        for variant_elem in variant_selectors:
            variant = ProductVariant()
            
            # Extract variant attributes
            if 'data-size' in variant_elem.attrs:
                variant.attributes['size'] = variant_elem['data-size']
            if 'data-color' in variant_elem.attrs:
                variant.attributes['color'] = variant_elem['data-color']
            
            variant.name = variant_elem.get_text(strip=True)
            product_data.variants.append(variant)
    
    async def _extract_media(self, soup, product_data: ProductData, base_url: str):
        """Extract product images and videos."""
        
        # Product images
        img_selectors = [
            '.product-image img',
            '.product-gallery img',
            '[itemprop="image"]',
            '.main-image img',
        ]
        
        for selector in img_selectors:
            images = soup.select(selector)
            for img in images:
                src = img.get('src') or img.get('data-src')
                if src:
                    full_url = urljoin(base_url, src)
                    if full_url not in product_data.images:
                        product_data.images.append(full_url)
        
        # Product videos
        video_selectors = soup.select('video source, [data-video-url]')
        for video in video_selectors:
            src = video.get('src') or video.get('data-video-url')
            if src:
                full_url = urljoin(base_url, src)
                product_data.videos.append(full_url)
    
    async def _extract_reviews(self, soup, product_data: ProductData):
        """Extract reviews and ratings."""
        
        # Rating extraction
        rating_selectors = [
            '[itemprop="ratingValue"]',
            '.rating-value',
            '.star-rating',
        ]
        
        for selector in rating_selectors:
            element = soup.select_one(selector)
            if element:
                rating_text = element.get_text(strip=True)
                try:
                    product_data.rating = float(rating_text)
                    break
                except ValueError:
                    continue
        
        # Review count
        review_count_selectors = [
            '[itemprop="reviewCount"]',
            '.review-count',
            '.reviews-count',
        ]
        
        for selector in review_count_selectors:
            element = soup.select_one(selector)
            if element:
                count_text = element.get_text(strip=True)
                try:
                    product_data.review_count = int(re.search(r'(\d+)', count_text).group(1))
                    break
                except (ValueError, AttributeError):
                    continue
    
    async def _extract_availability(self, soup, product_data: ProductData):
        """Extract availability and stock information."""
        
        # Stock status indicators
        stock_indicators = {
            'in stock': True,
            'available': True,
            'out of stock': False,
            'sold out': False,
            'unavailable': False,
        }
        
        page_text = soup.get_text().lower()
        for indicator, status in stock_indicators.items():
            if indicator in page_text:
                product_data.in_stock = status
                product_data.availability_status = indicator
                break
    
    async def _extract_specifications(self, soup, product_data: ProductData):
        """Extract product specifications and features."""
        
        # Specifications table
        spec_tables = soup.select('.specifications table, .product-specs table, .details table')
        
        for table in spec_tables:
            rows = table.select('tr')
            for row in rows:
                cells = row.select('td, th')
                if len(cells) >= 2:
                    key = cells[0].get_text(strip=True)
                    value = cells[1].get_text(strip=True)
                    if key and value:
                        product_data.specifications[key] = value
        
        # Features list
        feature_lists = soup.select('.features ul, .product-features ul, .highlights ul')
        for feature_list in feature_lists:
            items = feature_list.select('li')
            for item in items:
                feature = item.get_text(strip=True)
                if feature:
                    product_data.features.append(feature)
    
    def _assess_data_quality(self, product_data: ProductData) -> DataQuality:
        """Assess the quality of extracted product data."""
        
        score = 0
        max_score = 10
        
        # Basic info (4 points)
        if product_data.name: score += 2
        if product_data.description: score += 1
        if product_data.brand: score += 1
        
        # Pricing (3 points)
        if product_data.pricing.current_price: score += 2
        if product_data.pricing.original_price: score += 1
        
        # Media (2 points)
        if product_data.images: score += 1
        if len(product_data.images) > 3: score += 1
        
        # Additional data (1 point)
        if product_data.specifications or product_data.features: score += 1
        
        percentage = (score / max_score) * 100
        
        if percentage >= 80:
            return DataQuality.EXCELLENT
        elif percentage >= 60:
            return DataQuality.GOOD
        elif percentage >= 40:
            return DataQuality.FAIR
        else:
            return DataQuality.POOR
    
    def _calculate_confidence(self, product_data: ProductData) -> float:
        """Calculate confidence score for extracted data."""
        
        confidence = 0.0
        
        # Name confidence
        if product_data.name and len(product_data.name) > 5:
            confidence += 0.3
        
        # Price confidence
        if product_data.pricing.current_price and product_data.pricing.current_price > 0:
            confidence += 0.3
        
        # Description confidence
        if product_data.description and len(product_data.description) > 20:
            confidence += 0.2
        
        # Media confidence
        if product_data.images:
            confidence += 0.1
        
        # Specifications confidence
        if product_data.specifications or product_data.features:
            confidence += 0.1
        
        return min(confidence, 1.0)
    
    async def discover_urls(self, base_url: str, html_content: str, current_depth: int = 0) -> List[str]:
        """Discover product and category URLs."""
        
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_content, 'html.parser')
        
        urls = []
        
        # Product page selectors
        product_selectors = [
            'a[href*="/product/"]',
            'a[href*="/item/"]', 
            'a[href*="/p/"]',
            '.product-link',
            '.item-link',
        ]
        
        for selector in product_selectors:
            links = soup.select(selector)
            for link in links:
                href = link.get('href')
                if href:
                    full_url = urljoin(base_url, href)
                    urls.append(full_url)
        
        # Category page selectors (if depth allows)
        if current_depth < self.config.max_depth - 1:
            category_selectors = [
                'a[href*="/category/"]',
                'a[href*="/categories/"]',
                '.category-link',
            ]
            
            for selector in category_selectors:
                links = soup.select(selector)
                for link in links:
                    href = link.get('href')
                    if href:
                        full_url = urljoin(base_url, href)
                        urls.append(full_url)
        
        return list(set(urls))  # Remove duplicates
    
    async def validate_extracted_data(self, data: ExtractedData) -> bool:
        """Validate extracted product data."""
        
        if not data.structured_data.get('product'):
            return False
        
        product = data.structured_data['product']
        
        # Must have basic product info
        if not product.get('name'):
            return False
        
        # Should have pricing or description
        pricing = product.get('pricing', {})
        if not pricing.get('current_price') and not product.get('description'):
            return False
        
        return True
    
    def get_custom_headers(self, url: str) -> Dict[str, str]:
        """Get e-commerce specific headers."""
        
        return {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
        }
    
    def get_wait_strategy(self, url: str) -> Dict[str, Any]:
        """Get wait strategy optimized for e-commerce sites."""
        
        return {
            "wait_for": "networkidle",  # Wait for all network requests
            "timeout": 45000,  # Longer timeout for complex e-commerce pages
            "delay": 2.0  # Allow time for dynamic pricing updates
        }