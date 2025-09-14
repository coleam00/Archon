"""
Testing Package for Specialized Crawling Modes

This package provides comprehensive testing capabilities for the specialized
crawling system including:
- Automated test suites for all crawling modes
- Performance benchmarking and validation
- Data quality assessment tools
- Error handling and recovery testing
"""

from .crawling_tests import (
    CrawlingTestFramework,
    TestResult,
    PerformanceMetrics,
    run_crawling_tests,
    TestCrawlingModes
)

__all__ = [
    "CrawlingTestFramework",
    "TestResult", 
    "PerformanceMetrics",
    "run_crawling_tests",
    "TestCrawlingModes"
]