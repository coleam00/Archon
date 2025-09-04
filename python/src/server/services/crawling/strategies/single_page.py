"""
Single Page Crawling Strategy

Handles crawling of individual web pages.
"""
import asyncio
import traceback
from collections.abc import Awaitable, Callable
from typing import Any

from crawl4ai import CacheMode, CrawlerRunConfig

from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class SinglePageCrawlStrategy:
    """Strategy for crawling a single web page."""

    def __init__(self, crawler, markdown_generator):
        """
        Initialize single page crawl strategy.
        
        Args:
            crawler (AsyncWebCrawler): The Crawl4AI crawler instance for web crawling operations
            markdown_generator (DefaultMarkdownGenerator): The markdown generator instance for converting HTML to markdown
        """
        self.crawler = crawler
        self.markdown_generator = markdown_generator

    def _get_wait_selector_for_docs(self, url: str) -> str:
        """Get appropriate wait selector based on documentation framework."""
        url_lower = url.lower()

        # Common selectors for different documentation frameworks
        if 'docusaurus' in url_lower:
            return '.markdown, .theme-doc-markdown, article'
        elif 'vitepress' in url_lower:
            return '.VPDoc, .vp-doc, .content'
        elif 'gitbook' in url_lower:
            return '.markdown-section, .page-wrapper'
        elif 'mkdocs' in url_lower:
            return '.md-content, article'
        elif 'docsify' in url_lower:
            return '#main, .markdown-section'
        elif 'copilotkit' in url_lower:
            # CopilotKit uses a custom setup, wait for any content
            return 'div[class*="content"], div[class*="doc"], #__next'
        elif 'milkdown' in url_lower:
            # Milkdown uses a custom rendering system
            return 'main, article, .prose, [class*="content"]'
        else:
            # Simplified generic selector - just wait for body to have content
            return 'body'

    async def crawl_single_page(
        self,
        url: str,
        transform_url_func: Callable[[str], str],
        is_documentation_site_func: Callable[[str], bool],
        retry_count: int = 3
    ) -> dict[str, Any]:
        """
        Crawl a single web page and return the result with retry logic.
        
        Args:
            url: URL of the web page to crawl
            transform_url_func: Function to transform URLs (e.g., GitHub URLs)
            is_documentation_site_func: Function to check if URL is a documentation site
            retry_count: Number of retry attempts
            
        Returns:
            Dict with success status, content, and metadata
        """
        # Transform GitHub URLs to raw content URLs if applicable
        original_url = url
        url = transform_url_func(url)

        last_error = None

        for attempt in range(retry_count):
            try:
                if not self.crawler:
                    logger.error(f"No crawler instance available for URL: {url}")
                    return {
                        "success": False,
                        "error": "No crawler instance available - crawler initialization may have failed"
                    }

                # Use ENABLED cache mode for better performance, BYPASS only on retries
                cache_mode = CacheMode.BYPASS if attempt > 0 else CacheMode.ENABLED

                # Check if this is a documentation site that needs special handling
                is_doc_site = is_documentation_site_func(url)

                # Enhanced configuration for documentation sites
                if is_doc_site:
                    wait_selector = self._get_wait_selector_for_docs(url)
                    logger.info(f"Detected documentation site, using wait selector: {wait_selector}")

                    crawl_config = CrawlerRunConfig(
                        cache_mode=cache_mode,
                        stream=True,  # Enable streaming for faster parallel processing
                        markdown_generator=self.markdown_generator,
                        # Wait for documentation content to load
                        wait_for=wait_selector,
                        # Use domcontentloaded for problematic sites
                        wait_until='domcontentloaded',  # Always use domcontentloaded for speed
                        # Increased timeout for JavaScript rendering
                        page_timeout=30000,  # 30 seconds
                        # Give JavaScript time to render
                        delay_before_return_html=0.5,  # Reduced from 2.0s
                        # Enable image waiting for completeness
                        wait_for_images=False,  # Skip images for faster crawling
                        # Scan full page to trigger lazy loading
                        scan_full_page=True,
                        # Keep images for documentation sites
                        exclude_all_images=False,
                        # Still remove popups
                        remove_overlay_elements=True,
                        # Process iframes for complete content
                        process_iframes=True
                    )
                else:
                    # Configuration for regular sites
                    crawl_config = CrawlerRunConfig(
                        cache_mode=cache_mode,
                        stream=True,  # Enable streaming
                        markdown_generator=self.markdown_generator,
                        wait_until='domcontentloaded',  # Use domcontentloaded for better reliability
                        page_timeout=45000,  # 45 seconds timeout
                        delay_before_return_html=0.3,  # Reduced from 1.0s
                        scan_full_page=True  # Trigger lazy loading
                    )

                logger.info(f"Crawling {url} (attempt {attempt + 1}/{retry_count})")
                logger.info(f"Using wait_until: {crawl_config.wait_until}, page_timeout: {crawl_config.page_timeout}")

                try:
                    result = await self.crawler.arun(url=url, config=crawl_config)
                except Exception as e:
                    last_error = f"Crawler exception for {url}: {str(e)}"
                    logger.error(last_error)
                    if attempt < retry_count - 1:
                        await asyncio.sleep(2 ** attempt)
                    continue

                if not result.success:
                    last_error = f"Failed to crawl {url}: {result.error_message}"
                    logger.warning(f"Crawl attempt {attempt + 1} failed: {last_error}")

                    # Exponential backoff before retry
                    if attempt < retry_count - 1:
                        await asyncio.sleep(2 ** attempt)
                    continue

                # Validate content
                if not result.markdown or len(result.markdown.strip()) < 50:
                    last_error = f"Insufficient content from {url}"
                    logger.warning(f"Crawl attempt {attempt + 1}: {last_error}")

                    if attempt < retry_count - 1:
                        await asyncio.sleep(2 ** attempt)
                    continue

                # Success! Return both markdown AND HTML
                # Debug logging to see what we got
                markdown_sample = result.markdown[:1000] if result.markdown else "NO MARKDOWN"
                has_triple_backticks = '```' in result.markdown if result.markdown else False
                backtick_count = result.markdown.count('```') if result.markdown else 0

                logger.info(f"Crawl result for {url} | has_markdown={bool(result.markdown)} | markdown_length={len(result.markdown) if result.markdown else 0} | has_triple_backticks={has_triple_backticks} | backtick_count={backtick_count}")

                # Log markdown info for debugging if needed
                if backtick_count > 0:
                    logger.info(f"Markdown has {backtick_count} code blocks for {url}")

                if 'getting-started' in url:
                    logger.info(f"Markdown sample for getting-started: {markdown_sample}")

                return {
                    "success": True,
                    "url": original_url,  # Use original URL for tracking
                    "markdown": result.markdown,
                    "html": result.html,  # Use raw HTML instead of cleaned_html for code extraction
                    "title": result.title or "Untitled",
                    "links": result.links,
                    "content_length": len(result.markdown)
                }

            except TimeoutError:
                last_error = f"Timeout crawling {url}"
                logger.warning(f"Crawl attempt {attempt + 1} timed out")
            except Exception as e:
                last_error = f"Error crawling page: {str(e)}"
                logger.error(f"Error on attempt {attempt + 1} crawling {url}: {e}")
                logger.error(traceback.format_exc())

            # Exponential backoff before retry
            if attempt < retry_count - 1:
                await asyncio.sleep(2 ** attempt)

        # All retries failed
        return {
            "success": False,
            "error": last_error or f"Failed to crawl {url} after {retry_count} attempts"
        }

    async def crawl_markdown_file(
        self,
        url: str,
        transform_url_func: Callable[[str], str],
        progress_callback: Callable[..., Awaitable[None]] | None = None,
        start_progress: int = 10,
        end_progress: int = 20
    ) -> list[dict[str, Any]]:
        """
        Crawl a .txt or markdown file with comprehensive error handling and progress reporting.
        
        Args:
            url: URL of the text/markdown file
            transform_url_func: Function to transform URLs (e.g., GitHub URLs)
            progress_callback: Optional callback for progress updates
            start_progress: Starting progress percentage
            end_progress: Ending progress percentage
            
        Returns:
            List containing the crawled document
        """
        try:
            # Transform GitHub URLs to raw content URLs if applicable
            original_url = url
            url = transform_url_func(url)
            logger.info(f"Crawling markdown file: {url}")

            # Define local report_progress helper like in other methods
            async def report_progress(progress: int, message: str, **kwargs):
                """Helper to report progress if callback is available"""
                if progress_callback:
                    await progress_callback('crawling', progress, message, **kwargs)

            # Report initial progress (single file = 1 page)
            await report_progress(
                start_progress, 
                f"Fetching text file: {url}",
                total_pages=1,
                processed_pages=0
            )

            # Use consistent configuration even for text files
            crawl_config = CrawlerRunConfig(
                cache_mode=CacheMode.ENABLED,
                stream=False
            )

            result = await self.crawler.arun(url=url, config=crawl_config)
            if result.success and result.markdown:
                logger.info(f"Successfully crawled markdown file: {url}")

                # Report completion progress
                await report_progress(
                    end_progress, 
                    f"Text file crawled successfully: {original_url}",
                    total_pages=1,
                    processed_pages=1
                )

                return [{'url': original_url, 'markdown': result.markdown, 'html': result.html}]
            else:
                logger.error(f"Failed to crawl {url}: {result.error_message}")
                return []
        except Exception as e:
            logger.error(f"Exception while crawling markdown file {url}: {e}")
            logger.error(traceback.format_exc())
            return []
