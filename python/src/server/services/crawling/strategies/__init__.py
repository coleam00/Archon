"""
Crawling Strategies

This module contains different crawling strategies for various URL types.
"""

from .batch import BatchCrawlStrategy
from .recursive import RecursiveCrawlStrategy
from .single_page import SinglePageCrawlStrategy
from .sitemap import SitemapCrawlStrategy

__all__ = [
    'BatchCrawlStrategy',
    'RecursiveCrawlStrategy',
    'SinglePageCrawlStrategy',
    'SitemapCrawlStrategy'
]
