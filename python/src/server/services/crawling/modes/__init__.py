"""
Crawling Modes Package

Specialized crawling modes for different website types.
Provides extensible architecture for adding new crawling capabilities.
"""

from .base_mode import (
    BaseCrawlingMode, 
    CrawlingMode, 
    CrawlingResult, 
    ModeConfiguration
)
from .mode_registry import ModeRegistry, get_mode_registry
from .standard_mode import StandardCrawlingMode
from .ecommerce_mode import EcommerceCrawlingMode

# Initialize mode registry and register all available modes
def initialize_crawling_modes(crawler, markdown_generator):
    """
    Initialize and register all crawling modes.
    
    Args:
        crawler: The Crawl4AI crawler instance
        markdown_generator: Markdown generator instance
        
    Returns:
        Configured ModeRegistry instance
    """
    registry = get_mode_registry()
    
    # Register standard mode (fallback)
    standard_config = ModeConfiguration(
        mode=CrawlingMode.STANDARD,
        enabled=True,
        extract_structured_data=True,
        extract_images=True,
        extract_links=True
    )
    
    registry.register_mode(
        CrawlingMode.STANDARD,
        StandardCrawlingMode,
        standard_config,
        url_patterns=["*"]  # Matches everything as fallback
    )
    
    # Register e-commerce mode
    ecommerce_config = ModeConfiguration(
        mode=CrawlingMode.ECOMMERCE,
        enabled=True,
        page_timeout=45000,
        delay_before_html=1.0,
        stealth_mode=True,
        extract_structured_data=True,
        extract_images=True,
        mode_config={
            "extract_pricing": True,
            "extract_reviews": True,
            "extract_variants": True,
            "extract_inventory": True
        }
    )
    
    ecommerce_patterns = [
        "regex:amazon\\.",
        "regex:ebay\\.",
        "regex:shopify\\.",
        "regex:etsy\\.",
        "regex:walmart\\.",
        "regex:/product/",
        "regex:/item/",
        "regex:/p/",
        "regex:/shop/"
    ]
    
    registry.register_mode(
        CrawlingMode.ECOMMERCE,
        EcommerceCrawlingMode,
        ecommerce_config,
        url_patterns=ecommerce_patterns
    )
    
    # TODO: Add other modes as they are implemented
    # - Blog mode
    # - Documentation mode  
    # - News mode
    # - Analytics mode
    
    return registry


def get_available_modes() -> list:
    """Get list of all available crawling modes."""
    return [
        {
            "mode": CrawlingMode.STANDARD.value,
            "description": "General purpose crawling for any website",
            "capabilities": ["general_content", "basic_metadata", "fallback_mode"]
        },
        {
            "mode": CrawlingMode.ECOMMERCE.value,
            "description": "Specialized crawling for e-commerce sites with product data extraction",
            "capabilities": ["product_extraction", "price_tracking", "variant_analysis", "review_extraction"]
        },
        {
            "mode": CrawlingMode.BLOG.value,
            "description": "Optimized for blog posts and article content",
            "capabilities": ["article_extraction", "author_detection", "publication_date"],
            "status": "planned"
        },
        {
            "mode": CrawlingMode.DOCUMENTATION.value,
            "description": "Enhanced crawling for documentation sites",
            "capabilities": ["code_extraction", "navigation_mapping", "version_detection"],
            "status": "planned"
        },
        {
            "mode": CrawlingMode.NEWS.value,
            "description": "News article extraction with metadata",
            "capabilities": ["headline_extraction", "byline_detection", "publication_info"],
            "status": "planned"
        }
    ]


__all__ = [
    "BaseCrawlingMode",
    "CrawlingMode", 
    "CrawlingResult",
    "ModeConfiguration",
    "ModeRegistry",
    "StandardCrawlingMode",
    "EcommerceCrawlingMode",
    "get_mode_registry",
    "initialize_crawling_modes",
    "get_available_modes"
]