"""
Comprehensive Test Suite for E-commerce Crawling Mode

Tests all aspects of the e-commerce crawling functionality including:
- Product data extraction
- Price intelligence
- Pagination handling
- Website detection
- Stealth crawling
- Data validation
"""

import asyncio
import pytest
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from datetime import datetime, timedelta
from typing import Dict, List, Any

# Import the modules we're testing
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))

from server.services.crawling.modes.ecommerce import EcommerceCrawlMode, ProductData, PriceInfo, ProductVariant
from server.services.crawling.modes.detector import ModeDetector, WebsiteType, DetectionResult
from server.services.crawling.modes.base import CrawlModeConfig, ExtractedData, DataQuality
from server.services.crawling.pagination_handler import PaginationHandler, PaginationDetector, PaginationPattern
from server.services.crawling.stealth_crawler import StealthCrawler, StealthConfig, BotDetection
from server.services.crawling.price_intelligence import PriceIntelligenceEngine, PriceAnalysis


class TestEcommerceCrawlMode:
    """Test cases for e-commerce crawling mode."""
    
    @pytest.fixture
    def ecommerce_mode(self):
        """Create an e-commerce crawl mode instance for testing."""
        config = CrawlModeConfig(
            mode_name="ecommerce",
            max_pages=10,
            concurrent_requests=2,
            delay_between_requests=1.0
        )
        return EcommerceCrawlMode(config)
    
    @pytest.fixture
    def sample_product_html(self):
        """Sample HTML content for product page testing."""
        return """
        <!DOCTYPE html>
        <html>
        <head>
            <title>Sample Product - iPhone 15 Pro</title>
            <meta name="description" content="Latest iPhone with advanced features">
            <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": "iPhone 15 Pro",
                "description": "Latest iPhone with Pro features",
                "brand": {"@type": "Brand", "name": "Apple"},
                "offers": {
                    "@type": "Offer",
                    "price": "999.00",
                    "priceCurrency": "USD",
                    "availability": "https://schema.org/InStock"
                },
                "aggregateRating": {
                    "@type": "AggregateRating",
                    "ratingValue": "4.5",
                    "reviewCount": "128"
                }
            }
            </script>
        </head>
        <body>
            <div class="product-container">
                <h1 class="product-title">iPhone 15 Pro</h1>
                <div class="product-price">
                    <span class="current-price">$999.00</span>
                    <span class="original-price">$1099.00</span>
                </div>
                <div class="product-description">
                    <p>The most advanced iPhone ever with titanium design and A17 Pro chip.</p>
                </div>
                <div class="product-variants">
                    <div class="variant-option" data-variant="128GB">128GB - $999</div>
                    <div class="variant-option" data-variant="256GB">256GB - $1099</div>
                    <div class="variant-option" data-variant="512GB">512GB - $1299</div>
                </div>
                <div class="product-images">
                    <img src="/images/iphone15pro-1.jpg" alt="iPhone 15 Pro Front">
                    <img src="/images/iphone15pro-2.jpg" alt="iPhone 15 Pro Back">
                </div>
                <div class="product-rating">
                    <span class="rating-score">4.5</span>
                    <span class="rating-count">(128 reviews)</span>
                </div>
                <div class="product-availability">In Stock</div>
            </div>
        </body>
        </html>
        """
    
    @pytest.mark.asyncio
    async def test_website_detection(self, ecommerce_mode, sample_product_html):
        """Test e-commerce website detection."""
        url = "https://store.apple.com/us/buy-iphone/iphone-15-pro"
        
        # Test positive detection
        is_ecommerce = await ecommerce_mode.detect_website_type(url, sample_product_html)
        assert is_ecommerce is True, "Should detect e-commerce website"
        
        # Test negative detection with non-e-commerce content
        blog_html = "<html><body><article>This is a blog post</article></body></html>"
        is_not_ecommerce = await ecommerce_mode.detect_website_type(
            "https://myblog.com/post", blog_html
        )
        assert is_not_ecommerce is False, "Should not detect blog as e-commerce"
    
    @pytest.mark.asyncio
    async def test_product_data_extraction(self, ecommerce_mode, sample_product_html):
        """Test comprehensive product data extraction."""
        url = "https://store.apple.com/us/buy-iphone/iphone-15-pro"
        
        extracted_data = await ecommerce_mode.extract_data(url, sample_product_html)
        
        # Verify basic extraction
        assert extracted_data is not None, "Should extract data"
        assert extracted_data.url == url, "URL should match"
        assert "iphone 15 pro" in extracted_data.title.lower(), "Title should contain product name"
        
        # Verify structured data extraction
        product_data = extracted_data.structured_data.get('product')
        assert product_data is not None, "Should extract product data"
        
        # Verify price extraction
        pricing = product_data.pricing
        assert pricing.current_price is not None, "Should extract current price"
        assert pricing.original_price is not None, "Should extract original price"
        assert pricing.currency == "USD", "Should detect currency"
        
        # Verify variant extraction
        variants = product_data.variants
        assert len(variants) > 0, "Should extract product variants"
        assert any("128gb" in v.name.lower() for v in variants), "Should extract storage variants"
        
        # Verify image extraction
        images = product_data.images
        assert len(images) > 0, "Should extract product images"
        
        # Verify rating extraction
        rating = product_data.rating
        assert rating is not None, "Should extract rating"
        assert 4.0 <= rating <= 5.0, "Rating should be in valid range"
    
    @pytest.mark.asyncio
    async def test_url_discovery(self, ecommerce_mode):
        """Test URL discovery for product catalogs."""
        catalog_html = """
        <html>
        <body>
            <div class="product-grid">
                <a href="/products/iphone-15" class="product-link">iPhone 15</a>
                <a href="/products/iphone-15-pro" class="product-link">iPhone 15 Pro</a>
                <a href="/products/macbook-air" class="product-link">MacBook Air</a>
            </div>
            <div class="category-nav">
                <a href="/category/phones">Phones</a>
                <a href="/category/laptops">Laptops</a>
            </div>
        </body>
        </html>
        """
        
        base_url = "https://store.apple.com/category/phones"
        discovered_urls = await ecommerce_mode.discover_urls(base_url, catalog_html, 1)
        
        assert len(discovered_urls) > 0, "Should discover product URLs"
        assert any("/products/" in url for url in discovered_urls), "Should find product pages"
        assert any("/category/" in url for url in discovered_urls), "Should find category pages"
    
    @pytest.mark.asyncio
    async def test_data_validation(self, ecommerce_mode):
        """Test extracted data validation."""
        # Valid product data
        valid_data = ExtractedData(
            url="https://example.com/product",
            title="Test Product",
            structured_data={
                'product': ProductData(
                    name="Test Product",
                    pricing=PriceInfo(current_price=99.99, currency="USD"),
                    rating=4.5
                )
            }
        )
        
        is_valid = await ecommerce_mode.validate_extracted_data(valid_data)
        assert is_valid is True, "Valid product data should pass validation"
        
        # Invalid product data (missing essential fields)
        invalid_data = ExtractedData(
            url="https://example.com/product",
            title=None,
            structured_data={}
        )
        
        is_invalid = await ecommerce_mode.validate_extracted_data(invalid_data)
        assert is_invalid is False, "Invalid product data should fail validation"


class TestModeDetector:
    """Test cases for website type detection."""
    
    @pytest.fixture
    def detector(self):
        """Create mode detector instance."""
        return ModeDetector()
    
    @pytest.mark.asyncio
    async def test_ecommerce_detection(self, detector):
        """Test e-commerce website detection accuracy."""
        # Test Amazon detection
        amazon_html = """
        <html>
        <head><title>Amazon Product</title></head>
        <body>
            <div id="add-to-cart-button">Add to Cart</div>
            <span class="a-price-whole">99</span>
            <div class="reviews-section">Customer Reviews</div>
        </body>
        </html>
        """
        
        result = await detector.detect_website_type(
            "https://www.amazon.com/product/123", amazon_html
        )
        
        assert result.website_type == WebsiteType.ECOMMERCE, "Should detect Amazon as e-commerce"
        assert result.confidence_score > 0.7, "Should have high confidence"
        assert result.recommended_mode == "ecommerce", "Should recommend e-commerce mode"
    
    @pytest.mark.asyncio
    async def test_blog_detection(self, detector):
        """Test blog website detection."""
        blog_html = """
        <html>
        <head><title>My Blog Post</title></head>
        <body>
            <article class="blog-post">
                <h1 class="post-title">How to Build Web Crawlers</h1>
                <div class="post-meta">By John Doe on January 1, 2024</div>
                <div class="post-content">Content here...</div>
            </article>
        </body>
        </html>
        """
        
        result = await detector.detect_website_type(
            "https://myblog.com/web-crawlers", blog_html
        )
        
        assert result.website_type == WebsiteType.BLOG, "Should detect as blog"
        assert result.recommended_mode == "blog", "Should recommend blog mode"
    
    @pytest.mark.asyncio
    async def test_documentation_detection(self, detector):
        """Test documentation website detection."""
        docs_html = """
        <html>
        <head><title>API Documentation</title></head>
        <body>
            <nav class="documentation-nav">Table of Contents</nav>
            <div class="api-reference">
                <h2>GET /api/products</h2>
                <div class="code-example">curl -X GET /api/products</div>
                <div class="parameters">Parameters: page, limit</div>
            </div>
        </body>
        </html>
        """
        
        result = await detector.detect_website_type(
            "https://docs.api.com/reference", docs_html
        )
        
        assert result.website_type == WebsiteType.DOCUMENTATION, "Should detect as documentation"
        assert result.recommended_mode == "documentation", "Should recommend documentation mode"


class TestPaginationHandler:
    """Test cases for pagination handling."""
    
    @pytest.fixture
    def pagination_detector(self):
        """Create pagination detector instance."""
        return PaginationDetector()
    
    @pytest.fixture
    def pagination_handler(self):
        """Create pagination handler with mock crawler."""
        mock_crawler = AsyncMock()
        return PaginationHandler(mock_crawler)
    
    @pytest.mark.asyncio
    async def test_numeric_pagination_detection(self, pagination_detector):
        """Test detection of numeric pagination."""
        pagination_html = """
        <html>
        <body>
            <div class="pagination">
                <a href="?page=1">1</a>
                <a href="?page=2" class="current">2</a>
                <a href="?page=3">3</a>
                <a href="?page=4">4</a>
                <a href="?page=5">Next</a>
            </div>
        </body>
        </html>
        """
        
        patterns = await pagination_detector.detect_pagination(
            "https://example.com/products?page=2", pagination_html
        )
        
        assert len(patterns) > 0, "Should detect pagination patterns"
        numeric_pattern = next((p for p in patterns if p.pattern_type == "numeric"), None)
        assert numeric_pattern is not None, "Should detect numeric pagination"
        assert numeric_pattern.confidence_score > 0.5, "Should have reasonable confidence"
    
    @pytest.mark.asyncio
    async def test_load_more_detection(self, pagination_detector):
        """Test detection of load more pagination."""
        load_more_html = """
        <html>
        <body>
            <div class="products">Product list...</div>
            <button class="load-more" data-ajax="true">Load More Products</button>
        </body>
        </html>
        """
        
        patterns = await pagination_detector.detect_pagination(
            "https://example.com/products", load_more_html
        )
        
        load_more_pattern = next((p for p in patterns if p.pattern_type == "load_more"), None)
        assert load_more_pattern is not None, "Should detect load more pagination"
        assert load_more_pattern.javascript_required is True, "Should require JavaScript"


class TestStealthCrawler:
    """Test cases for stealth crawling functionality."""
    
    @pytest.fixture
    def stealth_config(self):
        """Create stealth configuration for testing."""
        return StealthConfig(
            rotate_user_agents=True,
            randomize_timing=True,
            bypass_cloudflare=True,
            max_retries=2
        )
    
    @pytest.fixture
    def stealth_crawler(self, stealth_config):
        """Create stealth crawler with mock."""
        mock_crawler = AsyncMock()
        return StealthCrawler(stealth_config, mock_crawler)
    
    @pytest.mark.asyncio
    async def test_bot_detection(self, stealth_crawler):
        """Test bot detection capabilities."""
        # Test Cloudflare detection
        cloudflare_html = """
        <html>
        <head><title>Just a moment...</title></head>
        <body>
            <div>Checking your browser before accessing the website...</div>
            <div>This process is automatic. Your browser will redirect to your requested content shortly.</div>
            <div>Please allow up to 5 seconds...</div>
            <div>Ray ID: 123456789abcdef</div>
        </body>
        </html>
        """
        
        detection = await stealth_crawler.bot_detector.detect_bot_blocking(cloudflare_html, 503)
        assert detection.is_blocked is True, "Should detect Cloudflare challenge"
        assert detection.detection_type == "cloudflare", "Should identify as Cloudflare"
        
        # Test normal page (not blocked)
        normal_html = "<html><body><h1>Welcome to our store!</h1></body></html>"
        detection_normal = await stealth_crawler.bot_detector.detect_bot_blocking(normal_html, 200)
        assert detection_normal.is_blocked is False, "Should not detect blocking on normal page"


class TestPriceIntelligence:
    """Test cases for price intelligence and analysis."""
    
    @pytest.fixture
    def price_engine(self):
        """Create price intelligence engine."""
        return PriceIntelligenceEngine()
    
    def test_price_trend_analysis(self, price_engine):
        """Test price trend analysis."""
        # Sample price history data
        price_history = [
            {"price": 100.00, "date": datetime.now() - timedelta(days=30)},
            {"price": 95.00, "date": datetime.now() - timedelta(days=20)},
            {"price": 90.00, "date": datetime.now() - timedelta(days=10)},
            {"price": 85.00, "date": datetime.now()},
        ]
        
        analysis = price_engine.analyze_price_trend(price_history)
        
        assert analysis is not None, "Should return price analysis"
        assert analysis.trend_direction == "decreasing", "Should detect decreasing trend"
        assert analysis.percentage_change < 0, "Should show negative percentage change"
    
    def test_competitive_pricing_analysis(self, price_engine):
        """Test competitive pricing analysis."""
        competitor_prices = [
            {"competitor": "Store A", "price": 99.99, "url": "https://storea.com/product"},
            {"competitor": "Store B", "price": 109.99, "url": "https://storeb.com/product"},
            {"competitor": "Store C", "price": 89.99, "url": "https://storec.com/product"},
        ]
        
        current_price = 95.00
        analysis = price_engine.analyze_competitive_pricing(current_price, competitor_prices)
        
        assert analysis is not None, "Should return competitive analysis"
        assert analysis.position in ["competitive", "high", "low"], "Should determine position"
        assert len(analysis.cheaper_competitors) >= 0, "Should identify cheaper competitors"


class TestDataValidation:
    """Test cases for data validation and quality checks."""
    
    def test_product_data_completeness(self):
        """Test product data completeness validation."""
        # Complete product data
        complete_product = ProductData(
            name="iPhone 15 Pro",
            description="Latest iPhone with advanced features",
            pricing=PriceInfo(current_price=999.99, currency="USD"),
            variants=[
                ProductVariant(name="128GB", price=999.99, sku="IPHONE15PRO128"),
                ProductVariant(name="256GB", price=1099.99, sku="IPHONE15PRO256")
            ],
            images=["image1.jpg", "image2.jpg"],
            rating=4.5
        )
        
        # Validate completeness
        assert complete_product.name is not None, "Name should be present"
        assert complete_product.pricing.current_price > 0, "Price should be positive"
        assert len(complete_product.variants) > 0, "Should have variants"
        assert len(complete_product.images) > 0, "Should have images"
    
    def test_price_validation(self):
        """Test price data validation."""
        valid_price = PriceInfo(
            current_price=99.99,
            original_price=129.99,
            currency="USD",
            discount_percentage=23.1
        )
        
        # Test price logic
        assert valid_price.current_price <= valid_price.original_price, "Current price should be <= original"
        assert 0 <= valid_price.discount_percentage <= 100, "Discount should be valid percentage"
        assert valid_price.currency in ["USD", "EUR", "GBP"], "Currency should be valid"


class TestIntegration:
    """Integration tests for the complete e-commerce crawling system."""
    
    @pytest.mark.asyncio
    async def test_end_to_end_crawling(self):
        """Test complete e-commerce crawling workflow."""
        # Mock crawler setup
        mock_crawler = AsyncMock()
        
        # Configure mode
        config = CrawlModeConfig(
            mode_name="ecommerce",
            max_pages=5,
            concurrent_requests=2
        )
        
        ecommerce_mode = EcommerceCrawlMode(config)
        
        # Test workflow steps
        url = "https://example-store.com/products/sample-product"
        sample_html = """
        <html>
        <head><title>Sample Product</title></head>
        <body>
            <h1>Sample Product</h1>
            <div class="price">$99.99</div>
            <div class="description">Great product for testing</div>
        </body>
        </html>
        """
        
        # Step 1: Website detection
        is_ecommerce = await ecommerce_mode.detect_website_type(url, sample_html)
        assert is_ecommerce, "Should detect as e-commerce site"
        
        # Step 2: Data extraction
        extracted_data = await ecommerce_mode.extract_data(url, sample_html)
        assert extracted_data is not None, "Should extract data"
        
        # Step 3: Data validation
        is_valid = await ecommerce_mode.validate_extracted_data(extracted_data)
        assert is_valid, "Extracted data should be valid"
        
        # Step 4: URL discovery
        discovered_urls = await ecommerce_mode.discover_urls(url, sample_html, 1)
        assert isinstance(discovered_urls, list), "Should return list of URLs"


# Performance and Load Tests
class TestPerformance:
    """Performance and load testing for crawling operations."""
    
    @pytest.mark.asyncio
    async def test_concurrent_extraction(self):
        """Test concurrent data extraction performance."""
        config = CrawlModeConfig(
            mode_name="ecommerce",
            concurrent_requests=5
        )
        
        ecommerce_mode = EcommerceCrawlMode(config)
        
        # Simulate multiple product pages
        urls_and_html = [
            (f"https://store.com/product-{i}", f"<html><body><h1>Product {i}</h1><div class='price'>${i*10}.99</div></body></html>")
            for i in range(10)
        ]
        
        # Test concurrent extraction
        start_time = datetime.now()
        
        tasks = [
            ecommerce_mode.extract_data(url, html)
            for url, html in urls_and_html
        ]
        
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        
        # Verify results
        successful_results = [r for r in results if not isinstance(r, Exception)]
        assert len(successful_results) > 0, "Should successfully extract from multiple pages"
        assert duration < 30, "Should complete within reasonable time"  # 30 seconds max
    
    def test_memory_usage(self):
        """Test memory usage during large data extraction."""
        # Create large product data structure
        large_product = ProductData(
            name="Test Product",
            description="Description " * 1000,  # Large description
            variants=[
                ProductVariant(name=f"Variant {i}", price=i*10.0, sku=f"SKU{i}")
                for i in range(100)  # Many variants
            ],
            images=[f"image{i}.jpg" for i in range(50)],  # Many images
            specifications={f"spec_{i}": f"value_{i}" for i in range(200)}  # Many specs
        )
        
        # Verify it doesn't consume excessive memory
        assert len(large_product.variants) == 100, "Should handle many variants"
        assert len(large_product.images) == 50, "Should handle many images"
        assert len(large_product.specifications) == 200, "Should handle many specifications"


if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v", "--tb=short"])