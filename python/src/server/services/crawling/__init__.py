"""
Crawling Services Package

This package contains services for web crawling, document processing, 
and related orchestration operations.
"""

from .code_extraction_service import CodeExtractionService
from .crawling_service import (
    CrawlingService,
    CrawlOrchestrationService,
    get_active_orchestration,
    register_orchestration,
    unregister_orchestration,
)
from .document_storage_operations import DocumentStorageOperations
from .helpers.site_config import SiteConfig

# Export helpers
from .helpers.url_handler import URLHandler
from .progress_mapper import ProgressMapper

# Export strategies
from .strategies.batch import BatchCrawlStrategy
from .strategies.recursive import RecursiveCrawlStrategy
from .strategies.single_page import SinglePageCrawlStrategy
from .strategies.sitemap import SitemapCrawlStrategy

__all__ = [
    "CrawlingService",
    "CrawlOrchestrationService",
    "CodeExtractionService",
    "DocumentStorageOperations",
    "ProgressMapper",
    "BatchCrawlStrategy",
    "RecursiveCrawlStrategy",
    "SinglePageCrawlStrategy",
    "SitemapCrawlStrategy",
    "URLHandler",
    "SiteConfig",
    "get_active_orchestration",
    "register_orchestration",
    "unregister_orchestration"
]
