"""
Advanced Pagination and Infinite Scroll Handler

Handles complex pagination patterns and infinite scroll mechanisms commonly found
on e-commerce websites to ensure comprehensive product catalog extraction.

Features:
- Multi-pattern pagination detection (numeric, next/prev, load more)
- Infinite scroll automation with JavaScript execution
- Dynamic content loading detection and waiting
- Progressive crawling with depth control
- Anti-detection measures for pagination crawling
- Performance optimization for large catalogs
"""

import asyncio
import json
import re
import time
from typing import Dict, List, Optional, Set, Tuple, Any, Callable, Awaitable
from urllib.parse import urljoin, urlparse, parse_qs, urlencode, urlunparse
from dataclasses import dataclass
import logging

from ...config.logfire_config import get_logger, safe_logfire_info, safe_logfire_error

logger = get_logger(__name__)


@dataclass
class PaginationPattern:
    """Detected pagination pattern configuration."""
    pattern_type: str  # "numeric", "next_prev", "load_more", "infinite_scroll"
    selectors: List[str]
    url_pattern: Optional[str] = None
    max_pages: Optional[int] = None
    confidence_score: float = 0.0
    javascript_required: bool = False


@dataclass
class ScrollConfig:
    """Infinite scroll configuration."""
    trigger_selector: Optional[str] = None
    scroll_delay: float = 2.0
    max_scrolls: int = 50
    scroll_increment: int = 1000  # pixels
    content_selector: str = "body"
    new_content_timeout: float = 10.0


@dataclass
class PaginationResult:
    """Result of pagination crawling."""
    total_pages_found: int
    pages_crawled: int
    urls_discovered: List[str]
    content_extracted: List[Dict[str, Any]]
    pagination_type: str
    errors: List[str]
    performance_metrics: Dict[str, Any]


class PaginationDetector:
    """Detects and analyzes pagination patterns on web pages."""
    
    def __init__(self):
        """Initialize pagination detector with common patterns."""
        
        # Common pagination selectors
        self.pagination_selectors = {
            "numeric": [
                ".pagination a[href*='page']",
                ".pager a[href*='page']",
                ".page-numbers a",
                "a[href*='page=']",
                "a[href*='/page/']",
                ".pagination-item a",
                "[class*='page'] a[href]"
            ],
            "next_prev": [
                "a[rel='next']",
                "a.next",
                ".next-page a",
                "a[href*='next']",
                ".pagination-next a",
                "[aria-label*='next'] a",
                "a:contains('Next')",
                "a:contains('>')"
            ],
            "load_more": [
                ".load-more",
                ".show-more",
                ".view-more",
                "[class*='load'][class*='more']",
                "button:contains('Load More')",
                "button:contains('Show More')",
                ".load-more-products",
                ".ajax-load-more"
            ],
            "infinite_scroll": [
                "[data-infinite-scroll]",
                ".infinite-scroll",
                "[class*='infinite']",
                "[data-scroll='infinite']"
            ]
        }
        
        # URL pattern recognition
        self.url_patterns = [
            r'/page/(\d+)',
            r'[?&]page=(\d+)',
            r'[?&]p=(\d+)',
            r'[?&]offset=(\d+)',
            r'[?&]start=(\d+)',
            r'/(\d+)/?$',
            r'[?&]pagenum=(\d+)'
        ]
    
    async def detect_pagination(
        self, 
        url: str, 
        html_content: str,
        crawler=None
    ) -> List[PaginationPattern]:
        """
        Detect pagination patterns on a webpage.
        
        Args:
            url: The current page URL
            html_content: HTML content of the page
            crawler: Optional crawler instance for dynamic analysis
            
        Returns:
            List of detected pagination patterns with confidence scores
        """
        
        patterns = []
        
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # Check for numeric pagination
            numeric_pattern = await self._detect_numeric_pagination(url, soup)
            if numeric_pattern:
                patterns.append(numeric_pattern)
            
            # Check for next/previous pagination
            next_prev_pattern = await self._detect_next_prev_pagination(url, soup)
            if next_prev_pattern:
                patterns.append(next_prev_pattern)
            
            # Check for load more buttons
            load_more_pattern = await self._detect_load_more_pagination(soup)
            if load_more_pattern:
                patterns.append(load_more_pattern)
            
            # Check for infinite scroll
            if crawler:  # Dynamic analysis requires crawler
                infinite_scroll_pattern = await self._detect_infinite_scroll(soup, crawler)
                if infinite_scroll_pattern:
                    patterns.append(infinite_scroll_pattern)
            
            # Sort by confidence score
            patterns.sort(key=lambda p: p.confidence_score, reverse=True)
            
            safe_logfire_info(f"Pagination detection completed | url={url} | patterns_found={len(patterns)}")
            
            return patterns
            
        except Exception as e:
            safe_logfire_error(f"Pagination detection failed | url={url} | error={str(e)}")
            return []
    
    async def _detect_numeric_pagination(
        self, 
        url: str, 
        soup
    ) -> Optional[PaginationPattern]:
        """Detect numeric pagination (1, 2, 3, ... Next)."""
        
        found_selectors = []
        confidence = 0.0
        max_pages = None
        
        # Check for pagination elements
        for selector in self.pagination_selectors["numeric"]:
            try:
                elements = soup.select(selector)
                if elements:
                    found_selectors.append(selector)
                    confidence += 0.2
                    
                    # Try to determine max pages
                    page_numbers = []
                    for elem in elements:
                        text = elem.get_text(strip=True)
                        if text.isdigit():
                            page_numbers.append(int(text))
                    
                    if page_numbers:
                        max_pages = max(page_numbers)
                        confidence += 0.3
                        
            except Exception:
                continue
        
        # Check URL for pagination parameters
        url_pattern = None
        for pattern in self.url_patterns:
            if re.search(pattern, url):
                url_pattern = pattern
                confidence += 0.3
                break
        
        if confidence > 0.4:  # Threshold for detection
            return PaginationPattern(
                pattern_type="numeric",
                selectors=found_selectors,
                url_pattern=url_pattern,
                max_pages=max_pages,
                confidence_score=min(confidence, 1.0)
            )
        
        return None
    
    async def _detect_next_prev_pagination(
        self, 
        url: str, 
        soup
    ) -> Optional[PaginationPattern]:
        """Detect next/previous button pagination."""
        
        found_selectors = []
        confidence = 0.0
        
        for selector in self.pagination_selectors["next_prev"]:
            try:
                elements = soup.select(selector)
                if elements:
                    found_selectors.append(selector)
                    confidence += 0.3
                    
                    # Check if the element actually contains "next" text or has next semantics
                    for elem in elements:
                        text = elem.get_text(strip=True).lower()
                        if any(word in text for word in ['next', '>', 'more', 'continue']):
                            confidence += 0.2
                            break
                            
            except Exception:
                continue
        
        if confidence > 0.4:
            return PaginationPattern(
                pattern_type="next_prev",
                selectors=found_selectors,
                confidence_score=min(confidence, 1.0)
            )
        
        return None
    
    async def _detect_load_more_pagination(self, soup) -> Optional[PaginationPattern]:
        """Detect load more button pagination."""
        
        found_selectors = []
        confidence = 0.0
        
        for selector in self.pagination_selectors["load_more"]:
            try:
                elements = soup.select(selector)
                if elements:
                    found_selectors.append(selector)
                    confidence += 0.4
                    
                    # Check for AJAX or JavaScript attributes
                    for elem in elements:
                        if (elem.get('data-ajax') or 
                            elem.get('onclick') or 
                            'ajax' in elem.get('class', [])):
                            confidence += 0.2
                            break
                            
            except Exception:
                continue
        
        if confidence > 0.3:
            return PaginationPattern(
                pattern_type="load_more",
                selectors=found_selectors,
                confidence_score=min(confidence, 1.0),
                javascript_required=True
            )
        
        return None
    
    async def _detect_infinite_scroll(
        self, 
        soup, 
        crawler
    ) -> Optional[PaginationPattern]:
        """Detect infinite scroll pagination."""
        
        found_selectors = []
        confidence = 0.0
        
        # Check for infinite scroll indicators
        for selector in self.pagination_selectors["infinite_scroll"]:
            try:
                elements = soup.select(selector)
                if elements:
                    found_selectors.append(selector)
                    confidence += 0.3
            except Exception:
                continue
        
        # Check for common infinite scroll JavaScript libraries
        scripts = soup.find_all('script')
        for script in scripts:
            script_content = str(script)
            if any(lib in script_content.lower() for lib in [
                'infinitescroll', 'infinite-scroll', 'waypoint', 
                'scrollmagic', 'lazyload', 'endless'
            ]):
                confidence += 0.4
                break
        
        if confidence > 0.3:
            return PaginationPattern(
                pattern_type="infinite_scroll",
                selectors=found_selectors,
                confidence_score=min(confidence, 1.0),
                javascript_required=True
            )
        
        return None


class PaginationHandler:
    """Handles different pagination types with appropriate strategies."""
    
    def __init__(self, crawler=None):
        """Initialize pagination handler."""
        self.crawler = crawler
        self.detector = PaginationDetector()
        
    async def crawl_paginated_content(
        self,
        initial_url: str,
        pagination_pattern: PaginationPattern,
        max_pages: int = 50,
        progress_callback: Optional[Callable] = None,
        content_extractor: Optional[Callable] = None
    ) -> PaginationResult:
        """
        Crawl paginated content based on detected pattern.
        
        Args:
            initial_url: Starting URL
            pagination_pattern: Detected pagination pattern
            max_pages: Maximum pages to crawl
            progress_callback: Progress update callback
            content_extractor: Function to extract content from each page
            
        Returns:
            PaginationResult with crawling results
        """
        
        start_time = time.time()
        
        if pagination_pattern.pattern_type == "numeric":
            return await self._crawl_numeric_pagination(
                initial_url, pagination_pattern, max_pages, progress_callback, content_extractor
            )
        elif pagination_pattern.pattern_type == "next_prev":
            return await self._crawl_next_prev_pagination(
                initial_url, pagination_pattern, max_pages, progress_callback, content_extractor
            )
        elif pagination_pattern.pattern_type == "load_more":
            return await self._crawl_load_more_pagination(
                initial_url, pagination_pattern, max_pages, progress_callback, content_extractor
            )
        elif pagination_pattern.pattern_type == "infinite_scroll":
            return await self._crawl_infinite_scroll(
                initial_url, pagination_pattern, max_pages, progress_callback, content_extractor
            )
        else:
            return PaginationResult(
                total_pages_found=0,
                pages_crawled=0,
                urls_discovered=[],
                content_extracted=[],
                pagination_type=pagination_pattern.pattern_type,
                errors=[f"Unsupported pagination type: {pagination_pattern.pattern_type}"],
                performance_metrics={"duration": time.time() - start_time}
            )
    
    async def _crawl_numeric_pagination(
        self,
        initial_url: str,
        pattern: PaginationPattern,
        max_pages: int,
        progress_callback: Optional[Callable],
        content_extractor: Optional[Callable]
    ) -> PaginationResult:
        """Handle numeric pagination (1, 2, 3, ... Next)."""
        
        urls_discovered = []
        content_extracted = []
        errors = []
        pages_crawled = 0
        
        try:
            # Generate page URLs
            base_url, page_urls = self._generate_numeric_page_urls(initial_url, pattern, max_pages)
            
            # Add initial URL if not in page_urls
            all_urls = [initial_url] + [url for url in page_urls if url != initial_url]
            urls_discovered = all_urls[:max_pages]
            
            # Crawl each page
            for i, url in enumerate(urls_discovered):
                try:
                    if progress_callback:
                        await progress_callback(
                            "crawling_pagination",
                            int((i / len(urls_discovered)) * 100),
                            f"Crawling page {i + 1} of {len(urls_discovered)}: {url}"
                        )
                    
                    # Fetch page content
                    if self.crawler:
                        result = await self.crawler.arun(
                            url=url,
                            timeout=30000,
                            delay_before_return_html=1.0
                        )
                        
                        if result.success:
                            html_content = result.cleaned_html or result.html
                            
                            # Extract content if extractor provided
                            if content_extractor:
                                extracted = await content_extractor(url, html_content)
                                if extracted:
                                    content_extracted.extend(extracted if isinstance(extracted, list) else [extracted])
                            
                            pages_crawled += 1
                        else:
                            errors.append(f"Failed to crawl {url}: {result.error_message}")
                    
                    # Small delay between pages
                    await asyncio.sleep(1.0)
                    
                except Exception as e:
                    errors.append(f"Error crawling page {url}: {str(e)}")
                    continue
            
            return PaginationResult(
                total_pages_found=len(urls_discovered),
                pages_crawled=pages_crawled,
                urls_discovered=urls_discovered,
                content_extracted=content_extracted,
                pagination_type="numeric",
                errors=errors,
                performance_metrics={
                    "pages_per_minute": pages_crawled / max(time.time() - time.time(), 1) * 60,
                    "success_rate": pages_crawled / len(urls_discovered) if urls_discovered else 0
                }
            )
            
        except Exception as e:
            safe_logfire_error(f"Numeric pagination crawling failed: {str(e)}")
            return PaginationResult(
                total_pages_found=0,
                pages_crawled=pages_crawled,
                urls_discovered=urls_discovered,
                content_extracted=content_extracted,
                pagination_type="numeric",
                errors=errors + [f"Pagination crawling failed: {str(e)}"],
                performance_metrics={}
            )
    
    async def _crawl_next_prev_pagination(
        self,
        initial_url: str,
        pattern: PaginationPattern,
        max_pages: int,
        progress_callback: Optional[Callable],
        content_extractor: Optional[Callable]
    ) -> PaginationResult:
        """Handle next/previous button pagination."""
        
        urls_discovered = []
        content_extracted = []
        errors = []
        pages_crawled = 0
        current_url = initial_url
        
        try:
            for page_num in range(max_pages):
                try:
                    if progress_callback:
                        await progress_callback(
                            "crawling_pagination",
                            int((page_num / max_pages) * 100),
                            f"Following pagination: Page {page_num + 1}"
                        )
                    
                    # Fetch current page
                    if self.crawler:
                        result = await self.crawler.arun(
                            url=current_url,
                            timeout=30000,
                            delay_before_return_html=1.0
                        )
                        
                        if result.success:
                            html_content = result.cleaned_html or result.html
                            urls_discovered.append(current_url)
                            
                            # Extract content
                            if content_extractor:
                                extracted = await content_extractor(current_url, html_content)
                                if extracted:
                                    content_extracted.extend(extracted if isinstance(extracted, list) else [extracted])
                            
                            pages_crawled += 1
                            
                            # Find next page URL
                            next_url = self._find_next_page_url(html_content, current_url, pattern)
                            if not next_url or next_url in urls_discovered:
                                break  # No more pages or circular reference
                            
                            current_url = next_url
                            
                        else:
                            errors.append(f"Failed to crawl {current_url}: {result.error_message}")
                            break
                    
                    await asyncio.sleep(1.5)  # Slightly longer delay for next/prev
                    
                except Exception as e:
                    errors.append(f"Error in next/prev pagination: {str(e)}")
                    break
            
            return PaginationResult(
                total_pages_found=pages_crawled,
                pages_crawled=pages_crawled,
                urls_discovered=urls_discovered,
                content_extracted=content_extracted,
                pagination_type="next_prev",
                errors=errors,
                performance_metrics={
                    "pages_per_minute": pages_crawled / max(time.time() - time.time(), 1) * 60
                }
            )
            
        except Exception as e:
            safe_logfire_error(f"Next/prev pagination failed: {str(e)}")
            return PaginationResult(
                total_pages_found=pages_crawled,
                pages_crawled=pages_crawled,
                urls_discovered=urls_discovered,
                content_extracted=content_extracted,
                pagination_type="next_prev",
                errors=errors + [f"Next/prev pagination failed: {str(e)}"],
                performance_metrics={}
            )
    
    async def _crawl_load_more_pagination(
        self,
        initial_url: str,
        pattern: PaginationPattern,
        max_pages: int,
        progress_callback: Optional[Callable],
        content_extractor: Optional[Callable]
    ) -> PaginationResult:
        """Handle load more button pagination."""
        
        if not self.crawler:
            return PaginationResult(
                total_pages_found=0,
                pages_crawled=0,
                urls_discovered=[],
                content_extracted=[],
                pagination_type="load_more",
                errors=["Crawler required for load more pagination"],
                performance_metrics={}
            )
        
        content_extracted = []
        errors = []
        clicks_performed = 0
        
        try:
            # Use JavaScript to handle load more buttons
            js_script = """
            async function loadMoreContent(maxClicks) {
                let clickCount = 0;
                const loadMoreSelectors = ['.load-more', '.show-more', '.view-more', 'button:contains("Load More")', 'button:contains("Show More")'];
                
                while (clickCount < maxClicks) {
                    let buttonFound = false;
                    
                    for (const selector of loadMoreSelectors) {
                        const button = document.querySelector(selector);
                        if (button && button.offsetParent !== null) { // Button is visible
                            button.click();
                            buttonFound = true;
                            clickCount++;
                            
                            // Wait for content to load
                            await new Promise(resolve => setTimeout(resolve, 3000));
                            break;
                        }
                    }
                    
                    if (!buttonFound) break;
                }
                
                return clickCount;
            }
            
            return await loadMoreContent(arguments[0]);
            """
            
            result = await self.crawler.arun(
                url=initial_url,
                timeout=60000,  # Longer timeout for load more
                delay_before_return_html=2.0,
                js_code=js_script,
                js_code_args=[min(max_pages, 20)]  # Limit load more clicks
            )
            
            if result.success:
                html_content = result.cleaned_html or result.html
                clicks_performed = result.js_execution_result if result.js_execution_result else 0
                
                # Extract all content from the loaded page
                if content_extractor:
                    extracted = await content_extractor(initial_url, html_content)
                    if extracted:
                        content_extracted.extend(extracted if isinstance(extracted, list) else [extracted])
                
                return PaginationResult(
                    total_pages_found=1,
                    pages_crawled=1,
                    urls_discovered=[initial_url],
                    content_extracted=content_extracted,
                    pagination_type="load_more",
                    errors=errors,
                    performance_metrics={
                        "load_more_clicks": clicks_performed,
                        "content_loaded": len(content_extracted)
                    }
                )
            else:
                errors.append(f"Load more pagination failed: {result.error_message}")
                
        except Exception as e:
            safe_logfire_error(f"Load more pagination failed: {str(e)}")
            errors.append(f"Load more error: {str(e)}")
        
        return PaginationResult(
            total_pages_found=0,
            pages_crawled=0,
            urls_discovered=[],
            content_extracted=content_extracted,
            pagination_type="load_more",
            errors=errors,
            performance_metrics={"load_more_clicks": clicks_performed}
        )
    
    async def _crawl_infinite_scroll(
        self,
        initial_url: str,
        pattern: PaginationPattern,
        max_pages: int,
        progress_callback: Optional[Callable],
        content_extractor: Optional[Callable]
    ) -> PaginationResult:
        """Handle infinite scroll pagination."""
        
        if not self.crawler:
            return PaginationResult(
                total_pages_found=0,
                pages_crawled=0,
                urls_discovered=[],
                content_extracted=[],
                pagination_type="infinite_scroll",
                errors=["Crawler required for infinite scroll"],
                performance_metrics={}
            )
        
        content_extracted = []
        errors = []
        scrolls_performed = 0
        
        try:
            # JavaScript for infinite scroll handling
            js_script = """
            async function performInfiniteScroll(maxScrolls) {
                let scrollCount = 0;
                let previousHeight = document.body.scrollHeight;
                let noNewContentCount = 0;
                
                while (scrollCount < maxScrolls && noNewContentCount < 3) {
                    // Scroll to bottom
                    window.scrollTo(0, document.body.scrollHeight);
                    scrollCount++;
                    
                    // Wait for content to load
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Check if new content was loaded
                    const currentHeight = document.body.scrollHeight;
                    if (currentHeight === previousHeight) {
                        noNewContentCount++;
                    } else {
                        noNewContentCount = 0;
                        previousHeight = currentHeight;
                    }
                }
                
                return {
                    scrollsPerformed: scrollCount,
                    finalHeight: document.body.scrollHeight,
                    contentLoaded: noNewContentCount < 3
                };
            }
            
            return await performInfiniteScroll(arguments[0]);
            """
            
            result = await self.crawler.arun(
                url=initial_url,
                timeout=120000,  # Extended timeout for infinite scroll
                delay_before_return_html=3.0,
                js_code=js_script,
                js_code_args=[min(max_pages, 30)]  # Limit scrolls
            )
            
            if result.success:
                html_content = result.cleaned_html or result.html
                
                if result.js_execution_result:
                    scrolls_performed = result.js_execution_result.get('scrollsPerformed', 0)
                
                # Extract all loaded content
                if content_extractor:
                    extracted = await content_extractor(initial_url, html_content)
                    if extracted:
                        content_extracted.extend(extracted if isinstance(extracted, list) else [extracted])
                
                return PaginationResult(
                    total_pages_found=1,
                    pages_crawled=1,
                    urls_discovered=[initial_url],
                    content_extracted=content_extracted,
                    pagination_type="infinite_scroll",
                    errors=errors,
                    performance_metrics={
                        "scrolls_performed": scrolls_performed,
                        "content_loaded": len(content_extracted)
                    }
                )
            else:
                errors.append(f"Infinite scroll failed: {result.error_message}")
                
        except Exception as e:
            safe_logfire_error(f"Infinite scroll pagination failed: {str(e)}")
            errors.append(f"Infinite scroll error: {str(e)}")
        
        return PaginationResult(
            total_pages_found=0,
            pages_crawled=0,
            urls_discovered=[],
            content_extracted=content_extracted,
            pagination_type="infinite_scroll",
            errors=errors,
            performance_metrics={"scrolls_performed": scrolls_performed}
        )
    
    def _generate_numeric_page_urls(
        self,
        base_url: str,
        pattern: PaginationPattern,
        max_pages: int
    ) -> Tuple[str, List[str]]:
        """Generate URLs for numeric pagination."""
        
        page_urls = []
        
        # Try to detect URL pattern and generate page URLs
        parsed_url = urlparse(base_url)
        
        # Common pagination URL patterns
        if 'page=' in base_url:
            # Replace or add page parameter
            for page_num in range(1, max_pages + 1):
                new_url = re.sub(r'page=\d+', f'page={page_num}', base_url)
                if new_url == base_url and page_num > 1:  # Add page param if not present
                    separator = '&' if parsed_url.query else '?'
                    new_url = f"{base_url}{separator}page={page_num}"
                page_urls.append(new_url)
                
        elif '/page/' in base_url:
            # Path-based pagination
            for page_num in range(1, max_pages + 1):
                new_url = re.sub(r'/page/\d+', f'/page/{page_num}', base_url)
                if new_url == base_url and page_num > 1:
                    new_url = f"{base_url.rstrip('/')}/page/{page_num}"
                page_urls.append(new_url)
                
        else:
            # Try to add pagination parameters
            separator = '&' if parsed_url.query else '?'
            for page_num in range(1, max_pages + 1):
                page_urls.append(f"{base_url}{separator}page={page_num}")
        
        return base_url, page_urls
    
    def _find_next_page_url(
        self,
        html_content: str,
        current_url: str,
        pattern: PaginationPattern
    ) -> Optional[str]:
        """Find next page URL from current page content."""
        
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # Try pattern selectors
            for selector in pattern.selectors:
                elements = soup.select(selector)
                for element in elements:
                    href = element.get('href')
                    if href:
                        # Convert relative URLs to absolute
                        next_url = urljoin(current_url, href)
                        
                        # Basic validation - next URL should be different
                        if next_url != current_url:
                            return next_url
            
            return None
            
        except Exception as e:
            safe_logfire_error(f"Failed to find next page URL: {str(e)}")
            return None


# Global instance
_pagination_handler = None


def get_pagination_handler(crawler=None) -> PaginationHandler:
    """Get global pagination handler instance."""
    global _pagination_handler
    if _pagination_handler is None:
        _pagination_handler = PaginationHandler(crawler)
    return _pagination_handler