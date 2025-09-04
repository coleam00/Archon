"""
Batch Crawling Strategy

Handles batch crawling of multiple URLs in parallel.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from crawl4ai import CacheMode, CrawlerRunConfig, MemoryAdaptiveDispatcher

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
        urls: list[str],
        transform_url_func: Callable[[str], str],
        is_documentation_site_func: Callable[[str], bool],
        max_concurrent: int | None = None,
        progress_callback: Callable[..., Awaitable[None]] | None = None,
        start_progress: int = 15,
        end_progress: int = 60,
        cancellation_check: Callable[[], None] | None = None,
    ) -> list[dict[str, Any]]:
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
                # CRAWL_MAX_CONCURRENT: Pages to crawl in parallel within this single crawl operation
                # (Different from server-level CONCURRENT_CRAWL_LIMIT which limits total crawl operations)
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
                f"Failed to load crawl settings from database: {e}, using defaults", exc_info=True
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
                remove_overlay_elements=True,
                process_iframes=True,
            )
        else:
            # Configuration for regular batch crawling
            crawl_config = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                stream=True,  # Enable streaming
                markdown_generator=self.markdown_generator,
                wait_until=settings.get("CRAWL_WAIT_STRATEGY", "domcontentloaded"),
                page_timeout=int(settings.get("CRAWL_PAGE_TIMEOUT", "45000")),
                delay_before_return_html=float(settings.get("CRAWL_DELAY_BEFORE_HTML", "0.5")),
                scan_full_page=True,
            )

        dispatcher = MemoryAdaptiveDispatcher(
            memory_threshold_percent=memory_threshold,
            check_interval=check_interval,
            max_session_permit=max_concurrent,
        )

        async def report_progress(progress_val: int, message: str, **kwargs):
            """Helper to report progress if callback is available"""
            if progress_callback:
                # Pass step information as flattened kwargs for consistency
                await progress_callback(
                    "crawling",
                    progress_val,
                    message,
                    currentStep=message,
                    stepMessage=message,
                    **kwargs
                )

        total_urls = len(urls)
        await report_progress(
            start_progress, 
            f"Starting to crawl {total_urls} URLs...",
            total_pages=total_urls,
            processed_pages=0
        )

        # Use configured batch size
        successful_results = []
        processed = 0

        # Transform all URLs at the beginning
        url_mapping = {}  # Map transformed URLs back to original
        transformed_urls = []
        for url in urls:
            transformed = transform_url_func(url)
            transformed_urls.append(transformed)
            url_mapping[transformed] = url

        for i in range(0, total_urls, batch_size):
            # Check for cancellation before processing each batch
            if cancellation_check:
                cancellation_check()

            batch_urls = transformed_urls[i : i + batch_size]
            batch_start = i
            batch_end = min(i + batch_size, total_urls)

            # Report batch start with smooth progress
            progress_percentage = start_progress + int(
                (i / total_urls) * (end_progress - start_progress)
            )
            await report_progress(
                progress_percentage,
                f"Processing batch {batch_start + 1}-{batch_end} of {total_urls} URLs...",
                total_pages=total_urls,
                processed_pages=processed
            )

            # Crawl this batch using arun_many with streaming
            logger.info(
                f"Starting parallel crawl of batch {batch_start + 1}-{batch_end} ({len(batch_urls)} URLs)"
            )
            batch_results = await self.crawler.arun_many(
                urls=batch_urls, config=crawl_config, dispatcher=dispatcher
            )

            # Handle streaming results
            async for result in batch_results:
                # Check for cancellation during streaming
                if cancellation_check:
                    try:
                        cancellation_check()
                    except Exception:
                        # If cancelled, break out of the loop
                        logger.info("Batch crawl cancelled during processing")
                        break

                processed += 1
                if result.success and result.markdown:
                    # Map back to original URL
                    original_url = url_mapping.get(result.url, result.url)
                    successful_results.append({
                        "url": original_url,
                        "markdown": result.markdown,
                        "html": result.html,  # Use raw HTML
                    })
                else:
                    logger.warning(
                        f"Failed to crawl {result.url}: {getattr(result, 'error_message', 'Unknown error')}"
                    )

                # Report individual URL progress with smooth increments
                progress_percentage = start_progress + int(
                    (processed / total_urls) * (end_progress - start_progress)
                )
                # Report more frequently for smoother progress
                if (
                    processed % 5 == 0 or processed == total_urls
                ):  # Report every 5 URLs or at the end
                    await report_progress(
                        progress_percentage,
                        f"Crawled {processed}/{total_urls} pages ({len(successful_results)} successful)",
                        total_pages=total_urls,
                        processed_pages=processed,
                        successful_count=len(successful_results)
                    )

        await report_progress(
            end_progress,
            f"Batch crawling completed: {len(successful_results)}/{total_urls} pages successful",
            total_pages=total_urls,
            processed_pages=processed,
            successful_count=len(successful_results)
        )
        return successful_results
