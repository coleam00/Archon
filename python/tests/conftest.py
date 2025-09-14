"""
Test Configuration and Utilities

Provides configuration, fixtures, and utilities for comprehensive testing
of the e-commerce crawling system.
"""

import os
import json
import asyncio
from pathlib import Path
from typing import Dict, List, Any, Optional
from unittest.mock import Mock, AsyncMock

import pytest


# Test Configuration
TEST_CONFIG = {
    "timeout": 30,  # Default test timeout in seconds
    "max_concurrent_tests": 5,
    "test_data_dir": "test_data",
    "mock_responses": True,
    "performance_thresholds": {
        "extraction_time_ms": 5000,
        "detection_time_ms": 1000,
        "validation_time_ms": 500
    }
}


# Test Data Samples
SAMPLE_ECOMMERCE_SITES = [
    {
        "url": "https://amazon.com/dp/B123456789",
        "domain": "amazon.com",
        "type": "product_page",
        "expected_extractions": ["title", "price", "rating", "images", "variants"]
    },
    {
        "url": "https://shopify-store.com/products/sample-product",
        "domain": "shopify-store.com", 
        "type": "product_page",
        "expected_extractions": ["title", "price", "description", "variants"]
    },
    {
        "url": "https://ebay.com/itm/123456789",
        "domain": "ebay.com",
        "type": "product_page",
        "expected_extractions": ["title", "price", "seller_info", "shipping"]
    }
]

SAMPLE_HTML_TEMPLATES = {
    "amazon_product": """
    <!DOCTYPE html>
    <html>
    <head>
        <title>{product_name} : Amazon.com</title>
        <meta name="description" content="{description}">
    </head>
    <body>
        <div id="dp-container">
            <div id="centerCol">
                <div id="feature-bullets">
                    <h1 class="a-size-large product-title-word-break" id="productTitle">
                        {product_name}
                    </h1>
                </div>
                <div class="a-section a-spacing-medium">
                    <span class="a-price a-text-price a-size-medium-plus">
                        <span class="a-offscreen">${current_price}</span>
                        <span aria-hidden="true">${current_price}</span>
                    </span>
                </div>
                <div id="averageCustomerReviews">
                    <span class="a-icon-alt">4.5 out of 5 stars</span>
                    <span class="a-size-base">({review_count} customer reviews)</span>
                </div>
                <div id="variation_color_name">
                    <div class="a-row">
                        <span class="selection">Color: {color}</span>
                    </div>
                </div>
            </div>
        </div>
    </body>
    </html>
    """,
    
    "shopify_product": """
    <!DOCTYPE html>
    <html>
    <head>
        <title>{product_name} – Store Name</title>
        <meta property="og:type" content="product">
        <meta property="product:price:amount" content="{current_price}">
        <meta property="product:price:currency" content="USD">
    </head>
    <body>
        <div class="product-single">
            <div class="product-single__media">
                <img src="/products/{product_image}" alt="{product_name}">
            </div>
            <div class="product-single__meta">
                <h1 class="product-single__title">{product_name}</h1>
                <div class="product-single__prices">
                    <span class="product-single__price">${current_price}</span>
                </div>
                <div class="product-single__description">
                    <p>{description}</p>
                </div>
                <div class="product-form">
                    <select name="id" class="product-form__variants">
                        <option value="variant1">Small - ${variant_price_1}</option>
                        <option value="variant2">Medium - ${variant_price_2}</option>
                        <option value="variant3">Large - ${variant_price_3}</option>
                    </select>
                </div>
            </div>
        </div>
    </body>
    </html>
    """,
    
    "pagination_numeric": """
    <!DOCTYPE html>
    <html>
    <body>
        <div class="products-grid">
            {product_items}
        </div>
        <nav class="pagination" role="navigation">
            <span class="prev">
                <a href="?page={prev_page}" rel="prev">‹ Previous</a>
            </span>
            <span class="page-numbers">
                <a href="?page=1">1</a>
                <a href="?page=2">2</a>
                <span class="current">3</span>
                <a href="?page=4">4</a>
                <a href="?page=5">5</a>
            </span>
            <span class="next">
                <a href="?page={next_page}" rel="next">Next ›</a>
            </span>
        </nav>
    </body>
    </html>
    """,
    
    "cloudflare_challenge": """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Just a moment...</title>
    </head>
    <body>
        <div class="cf-browser-verification">
            <h1>Checking your browser before accessing the website.</h1>
            <p>This process is automatic. Your browser will redirect to your requested content shortly.</p>
            <p>Please allow up to 5 seconds...</p>
        </div>
        <script>
            // Cloudflare challenge script
        </script>
    </body>
    </html>
    """
}


class MockCrawler:
    """Mock crawler for testing without actual web requests."""
    
    def __init__(self, responses: Optional[Dict[str, Any]] = None):
        self.responses = responses or {}
        self.request_history = []
    
    async def arun(self, url: str, **kwargs) -> Mock:
        """Mock the crawler.arun method."""
        self.request_history.append({
            "url": url,
            "kwargs": kwargs
        })
        
        # Return predefined response or generate one
        if url in self.responses:
            response_data = self.responses[url]
        else:
            response_data = self._generate_default_response(url)
        
        result = Mock()
        result.success = response_data.get("success", True)
        result.html = response_data.get("html", "<html><body>Mock content</body></html>")
        result.cleaned_html = response_data.get("cleaned_html", result.html)
        result.error_message = response_data.get("error_message")
        result.js_execution_result = response_data.get("js_result")
        
        return result
    
    def _generate_default_response(self, url: str) -> Dict[str, Any]:
        """Generate a default response based on URL patterns."""
        if "amazon.com" in url:
            html = SAMPLE_HTML_TEMPLATES["amazon_product"].format(
                product_name="Mock Amazon Product",
                description="Mock description for testing",
                current_price="99.99",
                review_count="150",
                color="Black"
            )
        elif "shopify" in url:
            html = SAMPLE_HTML_TEMPLATES["shopify_product"].format(
                product_name="Mock Shopify Product",
                description="Mock Shopify product description",
                current_price="79.99",
                product_image="mock-product.jpg",
                variant_price_1="79.99",
                variant_price_2="84.99", 
                variant_price_3="89.99"
            )
        elif "cloudflare" in url or "challenge" in url:
            html = SAMPLE_HTML_TEMPLATES["cloudflare_challenge"]
        else:
            html = "<html><body><h1>Mock Product Page</h1><div class='price'>$50.00</div></body></html>"
        
        return {
            "success": True,
            "html": html,
            "cleaned_html": html
        }
    
    def set_response(self, url: str, response: Dict[str, Any]):
        """Set a specific response for a URL."""
        self.responses[url] = response
    
    def get_request_history(self) -> List[Dict[str, Any]]:
        """Get history of requests made to the mock crawler."""
        return self.request_history


class ValidationHelper:
    """Helper class for data validation in tests."""
    
    @staticmethod
    def validate_product_data(product_data: Dict[str, Any]) -> Dict[str, bool]:
        """Validate extracted product data completeness."""
        validation_results = {}
        
        # Required fields validation
        validation_results["has_name"] = bool(product_data.get("name"))
        validation_results["has_price"] = bool(product_data.get("pricing", {}).get("current_price"))
        validation_results["has_currency"] = bool(product_data.get("pricing", {}).get("currency"))
        
        # Optional but recommended fields
        validation_results["has_description"] = bool(product_data.get("description"))
        validation_results["has_images"] = bool(product_data.get("images"))
        validation_results["has_rating"] = bool(product_data.get("rating"))
        validation_results["has_variants"] = bool(product_data.get("variants"))
        
        # Data quality checks
        pricing = product_data.get("pricing", {})
        current_price = pricing.get("current_price", 0)
        original_price = pricing.get("original_price", 0)
        
        validation_results["price_is_positive"] = current_price > 0
        validation_results["price_logic_valid"] = (
            original_price == 0 or current_price <= original_price
        )
        
        # Calculate overall completeness score
        required_fields = ["has_name", "has_price", "has_currency", "price_is_positive"]
        validation_results["completeness_score"] = sum(
            validation_results[field] for field in required_fields
        ) / len(required_fields)
        
        return validation_results
    
    @staticmethod
    def validate_extraction_performance(start_time: float, end_time: float) -> Dict[str, Any]:
        """Validate extraction performance metrics."""
        duration_ms = (end_time - start_time) * 1000
        
        return {
            "duration_ms": duration_ms,
            "within_threshold": duration_ms < TEST_CONFIG["performance_thresholds"]["extraction_time_ms"],
            "performance_grade": (
                "excellent" if duration_ms < 1000 else
                "good" if duration_ms < 3000 else
                "acceptable" if duration_ms < 5000 else
                "poor"
            )
        }
    
    @staticmethod
    def generate_test_report(test_results: Dict[str, Any]) -> str:
        """Generate a formatted test report."""
        report_lines = [
            "E-commerce Crawling Test Report",
            "=" * 40,
            ""
        ]
        
        # Summary statistics
        total_tests = len(test_results)
        passed_tests = sum(1 for result in test_results.values() if result.get("passed", False))
        
        report_lines.extend([
            f"Total Tests: {total_tests}",
            f"Passed: {passed_tests}",
            f"Failed: {total_tests - passed_tests}",
            f"Success Rate: {(passed_tests / total_tests * 100):.1f}%",
            ""
        ])
        
        # Individual test results
        for test_name, result in test_results.items():
            status = "PASS" if result.get("passed", False) else "FAIL"
            duration = result.get("duration", 0)
            
            report_lines.append(f"{test_name}: {status} ({duration:.3f}s)")
            
            if "errors" in result and result["errors"]:
                for error in result["errors"]:
                    report_lines.append(f"  Error: {error}")
        
        return "\n".join(report_lines)


# Pytest Fixtures
@pytest.fixture(scope="session")
def test_config():
    """Provide test configuration."""
    return TEST_CONFIG


@pytest.fixture
def mock_crawler():
    """Provide mock crawler for testing."""
    return MockCrawler()


@pytest.fixture
def validation_helper():
    """Provide validation helper instance."""
    return ValidationHelper()


@pytest.fixture
def sample_product_data():
    """Provide sample product data for testing."""
    return {
        "name": "Test Product",
        "description": "This is a test product for validation",
        "pricing": {
            "current_price": 99.99,
            "original_price": 129.99,
            "currency": "USD",
            "discount_percentage": 23.1
        },
        "variants": [
            {"name": "Small", "price": 99.99, "sku": "TEST-S"},
            {"name": "Medium", "price": 109.99, "sku": "TEST-M"},
            {"name": "Large", "price": 119.99, "sku": "TEST-L"}
        ],
        "images": [
            "https://example.com/image1.jpg",
            "https://example.com/image2.jpg"
        ],
        "rating": 4.5,
        "review_count": 150,
        "specifications": {
            "Material": "Cotton",
            "Color": "Blue",
            "Brand": "TestBrand"
        }
    }


@pytest.fixture(scope="session") 
def test_urls():
    """Provide test URLs for different scenarios."""
    return {
        "amazon_product": "https://amazon.com/dp/B123456789",
        "shopify_store": "https://test-store.myshopify.com/products/test-product",
        "ebay_listing": "https://ebay.com/itm/123456789",
        "blocked_site": "https://cloudflare-protected.com/product",
        "pagination_site": "https://example-store.com/category/products?page=1"
    }


# Test Data Generation Functions
def generate_product_html(product_data: Dict[str, Any], template: str = "shopify_product") -> str:
    """Generate HTML for testing with given product data."""
    if template not in SAMPLE_HTML_TEMPLATES:
        raise ValueError(f"Unknown template: {template}")
    
    template_html = SAMPLE_HTML_TEMPLATES[template]
    
    # Format the template with product data
    try:
        return template_html.format(**product_data)
    except KeyError as e:
        # Fill in missing keys with defaults
        defaults = {
            "product_name": "Test Product",
            "description": "Test description",
            "current_price": "99.99",
            "review_count": "50",
            "color": "Blue",
            "product_image": "test.jpg",
            "variant_price_1": "99.99",
            "variant_price_2": "109.99",
            "variant_price_3": "119.99"
        }
        
        merged_data = {**defaults, **product_data}
        return template_html.format(**merged_data)


def create_test_scenarios() -> List[Dict[str, Any]]:
    """Create comprehensive test scenarios for different e-commerce sites."""
    return [
        {
            "name": "Amazon Product Page",
            "url": "https://amazon.com/dp/B123456789", 
            "html_template": "amazon_product",
            "expected_extractions": ["title", "price", "rating", "variants"],
            "expected_mode": "ecommerce"
        },
        {
            "name": "Shopify Store Product",
            "url": "https://store.myshopify.com/products/test",
            "html_template": "shopify_product", 
            "expected_extractions": ["title", "price", "description", "variants"],
            "expected_mode": "ecommerce"
        },
        {
            "name": "Pagination Test",
            "url": "https://store.com/category/products?page=1",
            "html_template": "pagination_numeric",
            "expected_extractions": ["pagination_links", "products"],
            "expected_mode": "ecommerce"
        },
        {
            "name": "Cloudflare Challenge",
            "url": "https://protected-store.com/product",
            "html_template": "cloudflare_challenge",
            "expected_extractions": [],
            "expected_mode": "blocked"
        }
    ]


# Performance Testing Utilities
class PerformanceMonitor:
    """Monitor performance during tests."""
    
    def __init__(self):
        self.metrics = {}
    
    def start_timer(self, operation: str):
        """Start timing an operation."""
        import time
        self.metrics[operation] = {"start": time.time()}
    
    def end_timer(self, operation: str):
        """End timing an operation."""
        import time
        if operation in self.metrics:
            self.metrics[operation]["end"] = time.time()
            self.metrics[operation]["duration"] = (
                self.metrics[operation]["end"] - self.metrics[operation]["start"]
            )
    
    def get_metrics(self) -> Dict[str, float]:
        """Get performance metrics."""
        return {
            op: data.get("duration", 0)
            for op, data in self.metrics.items()
        }
    
    def check_thresholds(self) -> Dict[str, bool]:
        """Check if operations meet performance thresholds."""
        thresholds = TEST_CONFIG["performance_thresholds"]
        results = {}
        
        for operation, duration in self.get_metrics().items():
            duration_ms = duration * 1000
            
            if "extraction" in operation.lower():
                threshold = thresholds["extraction_time_ms"]
            elif "detection" in operation.lower():
                threshold = thresholds["detection_time_ms"] 
            elif "validation" in operation.lower():
                threshold = thresholds["validation_time_ms"]
            else:
                threshold = 5000  # Default 5 second threshold
            
            results[operation] = duration_ms <= threshold
        
        return results


if __name__ == "__main__":
    # Example usage
    mock_crawler = MockCrawler()
    validator = ValidationHelper()
    
    # Test the mock crawler
    print("Testing mock crawler...")
    print("Test scenarios:", len(create_test_scenarios()))
    print("Available templates:", list(SAMPLE_HTML_TEMPLATES.keys()))