"""
Recursive Crawling Strategy

Handles recursive crawling of websites by following internal links.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urldefrag

from crawl4ai import CacheMode, CrawlerRunConfig, MemoryAdaptiveDispatcher

from ....config.logfire_config import get_logger
from ...credential_service import credential_service
from ..helpers.url_handler import URLHandler

logger = get_logger(__name__)


class RecursiveCrawlStrategy:
    """Strategy for recursive crawling of websites."""

    def __init__(self, crawler, markdown_generator, domain_filter=None):
        """
        Initialize recursive crawl strategy.

        Args:
            crawler (AsyncWebCrawler): The Crawl4AI crawler instance for web crawling operations
            markdown_generator (DefaultMarkdownGenerator): The markdown generator instance for converting HTML to markdown
            domain_filter: Optional DomainFilter instance for URL filtering
        """
        self.crawler = crawler
        self.markdown_generator = markdown_generator
        self.url_handler = URLHandler()
        self.domain_filter = domain_filter

    async def crawl_recursive_with_progress(
        self,
        start_urls: list[str],
        transform_url_func: Callable[[str], str],
        is_documentation_site_func: Callable[[str], bool],
        max_depth: int = 3,
        max_concurrent: int | None = None,
        progress_callback: Callable[..., Awaitable[None]] | None = None,
        cancellation_check: Callable[[], None] | None = None,
        crawl_config=None,
    ) -> list[dict[str, Any]]:
        """
        Recursively crawl internal links from start URLs up to a maximum depth with progress reporting.

        Args:
            start_urls: List of starting URLs
            transform_url_func: Function to transform URLs (e.g., GitHub URLs)
            is_documentation_site_func: Function to check if URL is a documentation site
            max_depth: Maximum crawl depth
            max_concurrent: Maximum concurrent crawls
            progress_callback: Optional callback for progress updates
            cancellation_check: Optional function to check for cancellation

        Returns:
            List of crawl results
        """
        if not self.crawler:
            logger.error("No crawler instance available for recursive crawling")
            if progress_callback:
                await progress_callback("error", 0, "Crawler not available")
            return []

        # Load settings from database - fail fast on configuration errors
        try:
            settings = await credential_service.get_credentials_by_category("rag_strategy")

            # Clamp batch_size to prevent zero step in range()
            raw_batch_size = int(settings.get("CRAWL_BATCH_SIZE", "50"))
            batch_size = max(1, raw_batch_size)
            if batch_size != raw_batch_size:
                logger.warning(f"Invalid CRAWL_BATCH_SIZE={raw_batch_size}, clamped to {batch_size}")

            if max_concurrent is None:
                # CRAWL_MAX_CONCURRENT: Pages to crawl in parallel within this single crawl operation
                # (Different from server-level CONCURRENT_CRAWL_LIMIT which limits total crawl operations)
                raw_max_concurrent = int(settings.get("CRAWL_MAX_CONCURRENT", "10"))
                max_concurrent = max(1, raw_max_concurrent)
                if max_concurrent != raw_max_concurrent:
                    logger.warning(f"Invalid CRAWL_MAX_CONCURRENT={raw_max_concurrent}, clamped to {max_concurrent}")

            # Clamp memory threshold to sane bounds for dispatcher
            raw_memory_threshold = float(settings.get("MEMORY_THRESHOLD_PERCENT", "80"))
            memory_threshold = min(99.0, max(10.0, raw_memory_threshold))
            if memory_threshold != raw_memory_threshold:
                logger.warning(f"Invalid MEMORY_THRESHOLD_PERCENT={raw_memory_threshold}, clamped to {memory_threshold}")
            check_interval = float(settings.get("DISPATCHER_CHECK_INTERVAL", "0.5"))
        except (ValueError, KeyError, TypeError) as e:
            # Critical configuration errors should fail fast
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

        # Check if start URLs include documentation sites
        has_doc_sites = any(is_documentation_site_func(url) for url in start_urls)

        if has_doc_sites:
            logger.info(
                "Detected documentation sites for recursive crawl, using enhanced configuration"
            )
            run_config = CrawlerRunConfig(
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
            # Configuration for regular recursive crawling
            run_config = CrawlerRunConfig(
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

        async def report_progress(progress_val: int, message: str, status: str = "crawling", **kwargs):
            """Helper to report progress if callback is available"""
            if progress_callback:
                # Pass step information as flattened kwargs for consistency
                await progress_callback(
                    status,
                    progress_val,
                    message,
                    current_step=message,
                    step_message=message,
                    **kwargs
                )

        visited = set()

        def normalize_url(url):
            return urldefrag(url)[0]

        current_urls = {normalize_url(u) for u in start_urls}
        results_all = []
        total_processed = 0
        total_discovered = len(current_urls)  # Track total URLs discovered (normalized & de-duped)
        cancelled = False

        for depth in range(max_depth):
            # Check for cancellation at the start of each depth level
            if cancellation_check:
                try:
                    cancellation_check()
                except asyncio.CancelledError:
                    cancelled = True
                    await report_progress(
                        int(((depth) / max_depth) * 99),  # Cap at 99% for cancellation
                        f"Crawl cancelled at depth {depth + 1}",
                        status="cancelled",
                        total_pages=total_discovered,
                        processed_pages=total_processed,
                    )
                    break
                except Exception:
                    logger.exception("Unexpected error from cancellation_check()")
                    raise

            urls_to_crawl = [
                normalize_url(url) for url in current_urls if normalize_url(url) not in visited
            ]
            if not urls_to_crawl:
                break

            # Calculate progress for this depth level
            # Report 0-100 to properly integrate with ProgressMapper architecture
            depth_progress = int((depth / max(max_depth, 1)) * 100)

            await report_progress(
                depth_progress,
                f"Crawling depth {depth + 1}/{max_depth}: {len(urls_to_crawl)} URLs to process",
                total_pages=total_discovered,
                processed_pages=total_processed,
            )

            # Use configured batch size for recursive crawling
            next_level_urls = set()
            depth_successful = 0

            for batch_idx in range(0, len(urls_to_crawl), batch_size):
                # Check for cancellation before processing each batch
                if cancellation_check:
                    try:
                        cancellation_check()
                    except asyncio.CancelledError:
                        cancelled = True
                        break
                    except Exception:
                        logger.exception("Unexpected error from cancellation_check()")
                        raise

                batch_urls = urls_to_crawl[batch_idx : batch_idx + batch_size]
                batch_end_idx = min(batch_idx + batch_size, len(urls_to_crawl))

                # Transform URLs and create mapping for this batch
                url_mapping = {}
                transformed_batch_urls = []
                for url in batch_urls:
                    transformed = transform_url_func(url)
                    transformed_batch_urls.append(transformed)
                    url_mapping[transformed] = url

                # Calculate overall progress based on URLs actually being crawled at this depth
                # Use a more accurate progress calculation that accounts for depth
                urls_at_this_depth = len(urls_to_crawl)
                progress_within_depth = (batch_idx / urls_at_this_depth) if urls_at_this_depth > 0 else 0
                # Weight by depth to show overall progress (later depths contribute less)
                overall_progress = int(((depth + progress_within_depth) / max_depth) * 100)
                await report_progress(
                    min(overall_progress, 99),  # Never show 100% until actually complete
                    f"Crawling URLs {batch_idx + 1}-{batch_end_idx} of {len(urls_to_crawl)} at depth {depth + 1}",
                    total_pages=total_discovered,
                    processed_pages=total_processed,
                )

                # Use arun_many for native parallel crawling with streaming
                logger.info(f"Starting parallel crawl of {len(batch_urls)} URLs with arun_many")
                batch_results = await self.crawler.arun_many(
                    urls=transformed_batch_urls, config=run_config, dispatcher=dispatcher
                )

                # Handle streaming results from arun_many
                i = 0
                async for result in batch_results:
                    # Check for cancellation during streaming results
                    if cancellation_check:
                        try:
                            cancellation_check()
                        except asyncio.CancelledError:
                            cancelled = True
                            await report_progress(
                                min(int((total_processed / max(total_discovered, 1)) * 100), 99),
                                "Crawl cancelled during batch processing",
                                status="cancelled",
                                total_pages=total_discovered,
                                processed_pages=total_processed,
                            )
                            break
                        except Exception:
                            logger.exception("Unexpected error from cancellation_check()")
                            raise

                    # Map back to original URL using the mapping dict
                    original_url = url_mapping.get(result.url, result.url)

                    norm_url = normalize_url(original_url)
                    visited.add(norm_url)
                    total_processed += 1

                    if result.success and result.markdown and result.markdown.fit_markdown:
                        results_all.append({
                            "url": original_url,
                            "markdown": result.markdown.fit_markdown,
                            "html": result.html,  # Always use raw HTML for code extraction
                        })
                        depth_successful += 1

                        # Find internal links for next depth
                        links = getattr(result, "links", {}) or {}
                        for link in links.get("internal", []):
                            next_url = normalize_url(link["href"])
                            # Skip binary files and already visited URLs
                            is_binary = self.url_handler.is_binary_file(next_url)
                            if next_url not in visited and not is_binary:
                                # Apply domain filtering if configured
                                if self.domain_filter and crawl_config:
                                    # Use next_url's origin for domain checks, fallback to original_url
                                    # This ensures we're checking against the appropriate domain
                                    base_url = original_url
                                    if len(start_urls) > 0:
                                        # If we have start_urls, use the first one
                                        base_url = start_urls[0]
                                    else:
                                        # Try to use the current page's URL as base
                                        # This handles relative links better
                                        try:
                                            from urllib.parse import urljoin
                                            base_url = urljoin(original_url, next_url)
                                        except Exception:
                                            base_url = original_url

                                    # Wrap filter check in try/except to prevent crashes
                                    try:
                                        if not self.domain_filter.is_url_allowed(next_url, base_url, crawl_config):
                                            logger.debug(f"Filtering URL based on domain rules: {next_url}")
                                            continue
                                    except Exception as e:
                                        # Log error and conservatively skip the URL
                                        logger.warning(f"Error checking domain filter for {next_url}: {str(e)}. Skipping URL.")
                                        continue

                                if next_url not in next_level_urls:
                                    next_level_urls.add(next_url)
                                    total_discovered += 1  # Increment when we discover a new URL
                            elif is_binary:
                                logger.debug(f"Skipping binary file from crawl queue: {next_url}")
                    else:
                        logger.warning(
                            f"Failed to crawl {original_url}: {getattr(result, 'error_message', 'Unknown error')}"
                        )

                    # Skip the confusing "processed X/Y URLs" updates
                    # The "crawling URLs" message at the start of each batch is more accurate
                    i += 1
                if cancelled:
                    break

            if cancelled:
                break

            current_urls = next_level_urls

            # Report completion of this depth
            await report_progress(
                int(((depth + 1) / max_depth) * 100),
                f"Depth {depth + 1} completed: {depth_successful} pages crawled, {len(next_level_urls)} URLs found for next depth",
                total_pages=total_discovered,
                processed_pages=total_processed,
            )

        if cancelled:
            return results_all
        await report_progress(
            100,
            f"Recursive crawling completed: {len(results_all)} total pages crawled across {max_depth} depth levels",
            total_pages=total_discovered,
            processed_pages=total_processed,
        )
        return results_all
