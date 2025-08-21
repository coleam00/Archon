"""
Batch Crawling Strategy

Handles batch crawling of multiple URLs in parallel.
"""

from typing import List, Dict, Any, Optional, Callable

from crawl4ai import CrawlerRunConfig, CacheMode, MemoryAdaptiveDispatcher
from ....config.logfire_config import get_logger
from ...credential_service import credential_service

logger = get_logger(__name__)


class BatchCrawlStrategy:
    """Strategy for crawling multiple URLs in batch."""

    def __init__(self, crawler, markdown_generator):
        """
        Initialize batch crawl strategy.

        Args:
            crawler (AsyncWebCrawler): The Crawl4AI crawler instance for web crawling operations
            markdown_generator (DefaultMarkdownGenerator): The markdown generator instance for converting HTML to markdown
        """
        self.crawler = crawler
        self.markdown_generator = markdown_generator

    async def crawl_batch_with_progress(
        self,
        urls: List[str],
        transform_url_func: Callable[[str], str],
        is_documentation_site_func: Callable[[str], bool],
        max_concurrent: int = None,
        progress_callback: Optional[Callable] = None,
        start_progress: int = 15,
        end_progress: int = 60,
    ) -> List[Dict[str, Any]]:
        """
        Batch crawl multiple URLs in parallel with progress reporting.

        Args:
            urls: List of URLs to crawl
            transform_url_func: Function to transform URLs (e.g., GitHub URLs)
            is_documentation_site_func: Function to check if URL is a documentation site
            max_concurrent: Maximum concurrent crawls
            progress_callback: Optional callback for progress updates
            start_progress: Starting progress percentage
            end_progress: Ending progress percentage

        Returns:
            List of crawl results
        """
        if not self.crawler:
            logger.error("No crawler instance available for batch crawling")
            if progress_callback:
                await progress_callback("error", 0, "Crawler not available")
            return []

        # Load settings from database - fail fast on configuration errors
        try:
            settings = await credential_service.get_credentials_by_category("rag_strategy")
            batch_size = int(settings.get("CRAWL_BATCH_SIZE", "50"))
            if max_concurrent is None:
                max_concurrent = int(settings.get("CRAWL_MAX_CONCURRENT", "10"))
            memory_threshold = float(settings.get("MEMORY_THRESHOLD_PERCENT", "80"))
            check_interval = float(settings.get("DISPATCHER_CHECK_INTERVAL", "0.5"))
        except (ValueError, KeyError, TypeError) as e:
            # Critical configuration errors should fail fast in alpha
            logger.error(f"Invalid crawl settings format: {e}", exc_info=True)
            raise ValueError(f"Failed to load crawler configuration: {e}") from e
        except Exception as e:
            # For non-critical errors (e.g., network issues), use defaults but log prominently
            logger.error(
                f"Failed to load crawl settings from database: {e}, using defaults",
                exc_info=True
            )
            batch_size = 50
            if max_concurrent is None:
                max_concurrent = 10  # Safe default to prevent memory issues
            memory_threshold = 80.0
            check_interval = 0.5
            settings = {}  # Empty dict for defaults

        # Check if any URLs are documentation sites
        has_doc_sites = any(is_documentation_site_func(url) for url in urls)

        if has_doc_sites:
            logger.info("Detected documentation sites in batch, using enhanced configuration")
            # Use generic documentation selectors for batch crawling
            crawl_config = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                stream=True,  # Enable streaming for faster parallel processing
                markdown_generator=self.markdown_generator,
                wait_until=settings.get("CRAWL_WAIT_STRATEGY", "domcontentloaded"),
                page_timeout=int(settings.get("CRAWL_PAGE_TIMEOUT", "30000")),
                delay_before_return_html=float(settings.get("CRAWL_DELAY_BEFORE_HTML", "1.0")),
                wait_for_images=False,  # Skip images for faster crawling
                scan_full_page=True,  # Trigger lazy loading
                exclude_all_images=False,
            )
        else:
            # Regular sites use standard configuration
            crawl_config = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                stream=True,
                markdown_generator=self.markdown_generator,
                wait_until=settings.get("CRAWL_WAIT_STRATEGY", "domcontentloaded"),
                page_timeout=int(settings.get("CRAWL_PAGE_TIMEOUT", "30000")),
                delay_before_return_html=float(settings.get("CRAWL_DELAY_BEFORE_HTML", "0.5")),
                wait_for_images=False,
                scan_full_page=False,  # Don't scan full page for non-doc sites
                exclude_all_images=False,
            )

        # Transform URLs if needed
        processed_urls = [transform_url_func(url) for url in urls]

        # Create memory adaptive dispatcher
        dispatcher = MemoryAdaptiveDispatcher(
            max_sessions=max_concurrent,
            memory_threshold_mb=memory_threshold,
            check_interval=check_interval,
        )

        # Crawl URLs in batches using arun_many
        results = []
        total_urls = len(processed_urls)

        for batch_start in range(0, total_urls, batch_size):
            batch_end = min(batch_start + batch_size, total_urls)
            batch = processed_urls[batch_start:batch_end]

            # Calculate progress for this batch
            if progress_callback:
                batch_progress = start_progress + ((batch_start / total_urls) * (end_progress - start_progress))
                await progress_callback(
                    "batch_crawling",
                    int(batch_progress),
                    f"Crawling batch {batch_start // batch_size + 1} ({batch_start + 1}-{batch_end}/{total_urls} URLs)"
                )

            # Run batch crawl
            try:
                batch_results = await self.crawler.arun_many(
                    batch, 
                    config=crawl_config, 
                    dispatcher=dispatcher
                )

                # Process results
                for result in batch_results:
                    if result.success:
                        results.append({
                            "url": result.url,
                            "markdown": result.markdown_v2.raw_markdown if result.markdown_v2 else "",
                            "success": True,
                            "metadata": result.extracted_content if hasattr(result, 'extracted_content') else {}
                        })
                    else:
                        logger.warning(f"Failed to crawl {result.url}: {result.error_message}")
                        results.append({
                            "url": result.url,
                            "markdown": "",
                            "success": False,
                            "error": result.error_message
                        })

            except Exception as e:
                logger.error(f"Batch crawl error: {e}", exc_info=True)
                # Add failed results for this batch
                for url in batch:
                    results.append({
                        "url": url,
                        "markdown": "",
                        "success": False,
                        "error": str(e)
                    })

            # Update progress after batch completion
            # IMPORTANT: Use "finished" not "completed" - only the final orchestrator should send "completed"
            if progress_callback:
                batch_progress = start_progress + ((batch_end / total_urls) * (end_progress - start_progress))
                await progress_callback(
                    "batch_crawling",
                    int(batch_progress),
                    f"Finished batch {batch_start // batch_size + 1}"
                )

        return results