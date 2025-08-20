"""
Recursive Crawling Strategy

Handles recursive crawling of websites by following internal links.
"""
import asyncio
from typing import List, Dict, Any, Optional, Callable
from urllib.parse import urldefrag

from crawl4ai import CrawlerRunConfig, CacheMode, MemoryAdaptiveDispatcher
from ....config.logfire_config import get_logger
from ...credential_service import credential_service
from ..helpers.url_handler import URLHandler

logger = get_logger(__name__)


class RecursiveCrawlStrategy:
    """Strategy for recursive crawling of websites."""
    
    def __init__(self, crawler, markdown_generator):
        """
        Initialize recursive crawl strategy.
        
        Args:
            crawler (AsyncWebCrawler): The Crawl4AI crawler instance for web crawling operations
            markdown_generator (DefaultMarkdownGenerator): The markdown generator instance for converting HTML to markdown
        """
        self.crawler = crawler
        self.markdown_generator = markdown_generator
        self.url_handler = URLHandler()
    
    async def crawl_recursive_with_progress(
        self,
        start_urls: List[str],
        transform_url_func: Callable[[str], str],
        is_documentation_site_func: Callable[[str], bool],
        max_depth: int = 3,
        max_concurrent: int = None,
        progress_callback: Optional[Callable] = None,
        start_progress: int = 10,
        end_progress: int = 60
    ) -> List[Dict[str, Any]]:
        """
        Recursively crawl internal links from start URLs up to a maximum depth with progress reporting.
        
        Args:
            start_urls: List of starting URLs
            transform_url_func: Function to transform URLs (e.g., GitHub URLs)
            is_documentation_site_func: Function to check if URL is a documentation site
            max_depth: Maximum crawl depth
            max_concurrent: Maximum concurrent crawls
            progress_callback: Optional callback for progress updates
            start_progress: Starting progress percentage
            end_progress: Ending progress percentage
            
        Returns:
            List of crawl results
        """
        if not self.crawler:
            logger.error("No crawler instance available for recursive crawling")
            if progress_callback:
                await progress_callback('error', 0, 'Crawler not available')
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
            raise ValueError(f"Failed to load crawler configuration: {e}")
        except Exception as e:
            # For non-critical errors (e.g., network issues), use defaults but log prominently
            logger.error(f"Failed to load crawl settings from database: {e}, using defaults", exc_info=True)
            batch_size = 50
            if max_concurrent is None:
                max_concurrent = 10  # Safe default to prevent memory issues
            memory_threshold = 80.0
            check_interval = 0.5
            settings = {}  # Empty dict for defaults
        
        # Check if start URLs include documentation sites
        has_doc_sites = any(is_documentation_site_func(url) for url in start_urls)
        
        if has_doc_sites:
            logger.info("Detected documentation sites for recursive crawl, using enhanced configuration")
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
                process_iframes=True
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
                scan_full_page=True
            )
        
        dispatcher = MemoryAdaptiveDispatcher(
            memory_threshold_percent=memory_threshold,
            check_interval=check_interval,
            max_session_permit=max_concurrent
        )
        
        async def report_progress(percentage: int, message: str, **kwargs):
            """Helper to report progress if callback is available"""
            if progress_callback:
                # Add step information for multi-progress tracking
                step_info = {
                    'currentStep': message,
                    'stepMessage': message,
                    **kwargs
                }
                await progress_callback('crawling', percentage, message, **step_info)
        
        visited = set()
        
        def normalize_url(url):
            return urldefrag(url)[0]
        
        current_urls = set([normalize_url(u) for u in start_urls])
        results_all = []
        total_processed = 0
        
        for depth in range(max_depth):
            urls_to_crawl = [normalize_url(url) for url in current_urls if normalize_url(url) not in visited]
            if not urls_to_crawl:
                break
            
            # Calculate progress for this depth level
            depth_start = start_progress + int((depth / max_depth) * (end_progress - start_progress) * 0.8)
            depth_end = start_progress + int(((depth + 1) / max_depth) * (end_progress - start_progress) * 0.8)
            
            await report_progress(depth_start, f'Crawling depth {depth + 1}/{max_depth}: {len(urls_to_crawl)} URLs to process')
            
            # Use configured batch size for recursive crawling
            next_level_urls = set()
            depth_successful = 0
            
            for batch_idx in range(0, len(urls_to_crawl), batch_size):
                batch_urls = urls_to_crawl[batch_idx:batch_idx + batch_size]
                batch_end_idx = min(batch_idx + batch_size, len(urls_to_crawl))
                
                # Calculate progress for this batch within the depth
                batch_progress = depth_start + int((batch_idx / len(urls_to_crawl)) * (depth_end - depth_start))
                await report_progress(batch_progress,
                                    f'Depth {depth + 1}: crawling URLs {batch_idx + 1}-{batch_end_idx} of {len(urls_to_crawl)}',
                                    totalPages=total_processed + batch_idx,
                                    processedPages=len(results_all))
                
                # Use arun_many for native parallel crawling with streaming
                logger.info(f"Starting parallel crawl of {len(batch_urls)} URLs with arun_many")
                batch_results = await self.crawler.arun_many(urls=batch_urls, config=run_config, dispatcher=dispatcher)
                
                # Handle streaming results from arun_many
                i = 0
                async for result in batch_results:
                    # Map back to original URL if transformed
                    original_url = result.url
                    for orig_url in batch_urls:
                        if transform_url_func(orig_url) == result.url:
                            original_url = orig_url
                            break
                    
                    norm_url = normalize_url(original_url)
                    visited.add(norm_url)
                    total_processed += 1
                    
                    if result.success and result.markdown:
                        results_all.append({
                            'url': original_url,
                            'markdown': result.markdown,
                            'html': result.html  # Always use raw HTML for code extraction
                        })
                        depth_successful += 1
                        
                        # Find internal links for next depth
                        for link in result.links.get("internal", []):
                            next_url = normalize_url(link["href"])
                            # Skip binary files and already visited URLs
                            if next_url not in visited and not self.url_handler.is_binary_file(next_url):
                                next_level_urls.add(next_url)
                            elif self.url_handler.is_binary_file(next_url):
                                logger.debug(f"Skipping binary file from crawl queue: {next_url}")
                    else:
                        logger.warning(f"Failed to crawl {original_url}: {getattr(result, 'error_message', 'Unknown error')}")
                    
                    # Report progress every few URLs
                    current_idx = batch_idx + i + 1
                    if current_idx % 5 == 0 or current_idx == len(urls_to_crawl):
                        current_progress = depth_start + int((current_idx / len(urls_to_crawl)) * (depth_end - depth_start))
                        await report_progress(current_progress,
                                            f'Depth {depth + 1}: processed {current_idx}/{len(urls_to_crawl)} URLs ({depth_successful} successful)',
                                            totalPages=total_processed,
                                            processedPages=len(results_all))
                    i += 1
            
            current_urls = next_level_urls
            
            # Report completion of this depth
            await report_progress(depth_end,
                                f'Depth {depth + 1} completed: {depth_successful} pages crawled, {len(next_level_urls)} URLs found for next depth')
        
        await report_progress(end_progress, f'Recursive crawling completed: {len(results_all)} total pages crawled across {max_depth} depth levels')
        return results_all