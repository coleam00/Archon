"""
Crawling Service Module for Archon RAG

This module combines crawling functionality and orchestration.
It handles web crawling operations including single page crawling,
batch crawling, recursive crawling, and overall orchestration with progress tracking.
"""

import asyncio
import uuid
from typing import Dict, Any, List, Optional, Callable, Awaitable
from urllib.parse import urlparse

from ...config.logfire_config import safe_logfire_info, safe_logfire_error, get_logger
from ...utils import get_supabase_client

# Lazy import socket.IO handlers to avoid circular dependencies
# These are imported as module-level variables but resolved at runtime
update_crawl_progress = None
complete_crawl_progress = None


def _ensure_socketio_imports():
    """Ensure socket.IO handlers are imported."""
    global update_crawl_progress, complete_crawl_progress
    if update_crawl_progress is None:
        from ...api_routes.socketio_handlers import (
            update_crawl_progress as _update,
            complete_crawl_progress as _complete,
        )

        update_crawl_progress = _update
        complete_crawl_progress = _complete


# Import strategies
from .strategies.batch import BatchCrawlStrategy
from .strategies.recursive import RecursiveCrawlStrategy
from .strategies.single_page import SinglePageCrawlStrategy
from .strategies.sitemap import SitemapCrawlStrategy

# Import helpers
from .helpers.url_handler import URLHandler
from .helpers.site_config import SiteConfig

# Import operations
from .document_storage_operations import DocumentStorageOperations
from .progress_mapper import ProgressMapper

logger = get_logger(__name__)

# Global registry to track active orchestration services for cancellation support
_active_orchestrations: Dict[str, "CrawlingService"] = {}


def get_active_orchestration(progress_id: str) -> Optional["CrawlingService"]:
    """Get an active orchestration service by progress ID."""
    return _active_orchestrations.get(progress_id)


def register_orchestration(progress_id: str, orchestration: "CrawlingService"):
    """Register an active orchestration service."""
    _active_orchestrations[progress_id] = orchestration


def unregister_orchestration(progress_id: str):
    """Unregister an orchestration service."""
    if progress_id in _active_orchestrations:
        del _active_orchestrations[progress_id]


class CrawlingService:
    """
    Service class for web crawling and orchestration operations.
    Combines functionality from both CrawlingService and CrawlOrchestrationService.
    """

    def __init__(self, crawler=None, supabase_client=None, progress_id=None):
        """
        Initialize the crawling service.

        Args:
            crawler: The Crawl4AI crawler instance
            supabase_client: The Supabase client for database operations
            progress_id: Optional progress ID for Socket.IO updates
        """
        self.crawler = crawler
        self.supabase_client = supabase_client or get_supabase_client()
        self.progress_id = progress_id

        # Initialize helpers
        self.url_handler = URLHandler()
        self.site_config = SiteConfig()
        self.markdown_generator = self.site_config.get_markdown_generator()

        # Initialize strategies
        self.batch_strategy = BatchCrawlStrategy(crawler, self.markdown_generator)
        self.recursive_strategy = RecursiveCrawlStrategy(crawler, self.markdown_generator)
        self.single_page_strategy = SinglePageCrawlStrategy(crawler, self.markdown_generator)
        self.sitemap_strategy = SitemapCrawlStrategy()

        # Initialize operations
        self.doc_storage_ops = DocumentStorageOperations(self.supabase_client)

        # Track progress state across all stages to prevent UI resets
        self.progress_state = {"progressId": self.progress_id} if self.progress_id else {}
        # Initialize progress mapper to prevent backwards jumps
        self.progress_mapper = ProgressMapper()
        # Cancellation support
        self._cancelled = False

    def set_progress_id(self, progress_id: str):
        """Set the progress ID for Socket.IO updates."""
        self.progress_id = progress_id
        if self.progress_id:
            self.progress_state = {"progressId": self.progress_id}

    def cancel(self):
        """Cancel the crawl operation."""
        self._cancelled = True
        safe_logfire_info(f"Crawl operation cancelled | progress_id={self.progress_id}")

    def is_cancelled(self) -> bool:
        """Check if the crawl operation has been cancelled."""
        return self._cancelled

    def _check_cancellation(self):
        """Check if cancelled and raise an exception if so."""
        if self._cancelled:
            raise asyncio.CancelledError("Crawl operation was cancelled by user")

    async def _create_crawl_progress_callback(
        self, base_status: str
    ) -> Callable[[str, int, str], Awaitable[None]]:
        """Create a progress callback for crawling operations.

        Args:
            base_status: The base status to use for progress updates

        Returns:
            Async callback function with signature (status: str, percentage: int, message: str, **kwargs) -> None
        """
        _ensure_socketio_imports()

        async def callback(status: str, percentage: int, message: str, **kwargs):
            if self.progress_id:
                # Update and preserve progress state
                self.progress_state.update({
                    "status": base_status,
                    "percentage": percentage,
                    "log": message,
                    **kwargs,
                })
                safe_logfire_info(
                    f"Emitting crawl progress | progress_id={self.progress_id} | status={base_status} | percentage={percentage}"
                )
                await update_crawl_progress(self.progress_id, self.progress_state)

        return callback

    async def _handle_progress_update(self, task_id: str, update: Dict[str, Any]) -> None:
        """
        Handle progress updates from background task.

        Args:
            task_id: The task ID for the progress update
            update: Dictionary containing progress update data
        """
        _ensure_socketio_imports()

        if self.progress_id:
            # Update and preserve progress state
            self.progress_state.update(update)
            # Ensure progressId is always included
            if self.progress_id and "progressId" not in self.progress_state:
                self.progress_state["progressId"] = self.progress_id

            # Always emit progress updates for real-time feedback
            await update_crawl_progress(self.progress_id, self.progress_state)

    # Simple delegation methods for backward compatibility
    async def crawl_single_page(self, url: str, retry_count: int = 3) -> Dict[str, Any]:
        """Crawl a single web page."""
        return await self.single_page_strategy.crawl_single_page(
            url,
            self.url_handler.transform_github_url,
            self.site_config.is_documentation_site,
            retry_count,
        )

    async def crawl_markdown_file(
        self, url: str, progress_callback=None, start_progress: int = 10, end_progress: int = 20
    ) -> List[Dict[str, Any]]:
        """Crawl a .txt or markdown file."""
        return await self.single_page_strategy.crawl_markdown_file(
            url,
            self.url_handler.transform_github_url,
            progress_callback,
            start_progress,
            end_progress,
        )

    def parse_sitemap(self, sitemap_url: str) -> List[str]:
        """Parse a sitemap and extract URLs."""
        return self.sitemap_strategy.parse_sitemap(sitemap_url)

    async def crawl_batch_with_progress(
        self,
        urls: List[str],
        max_concurrent: int = None,
        progress_callback=None,
        start_progress: int = 15,
        end_progress: int = 60,
    ) -> List[Dict[str, Any]]:
        """Batch crawl multiple URLs in parallel."""
        return await self.batch_strategy.crawl_batch_with_progress(
            urls,
            self.url_handler.transform_github_url,
            self.site_config.is_documentation_site,
            max_concurrent,
            progress_callback,
            start_progress,
            end_progress,
        )

    async def crawl_recursive_with_progress(
        self,
        start_urls: List[str],
        max_depth: int = 3,
        max_concurrent: int = None,
        progress_callback=None,
        start_progress: int = 10,
        end_progress: int = 60,
    ) -> List[Dict[str, Any]]:
        """Recursively crawl internal links from start URLs."""
        return await self.recursive_strategy.crawl_recursive_with_progress(
            start_urls,
            self.url_handler.transform_github_url,
            self.site_config.is_documentation_site,
            max_depth,
            max_concurrent,
            progress_callback,
            start_progress,
            end_progress,
        )

    # Orchestration methods
    async def orchestrate_crawl(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Main orchestration method - non-blocking using asyncio.create_task.

        Args:
            request: The crawl request containing url, knowledge_type, tags, max_depth, etc.

        Returns:
            Dict containing task_id and status
        """
        url = str(request.get("url", ""))
        safe_logfire_info(f"Starting background crawl orchestration | url={url}")

        # Create task ID
        task_id = self.progress_id or str(uuid.uuid4())

        # Register this orchestration service for cancellation support
        if self.progress_id:
            register_orchestration(self.progress_id, self)

        # Start the crawl as an async task in the main event loop
        asyncio.create_task(self._async_orchestrate_crawl(request, task_id))

        # Return immediately
        return {
            "task_id": task_id,
            "status": "started",
            "message": f"Crawl operation started for {url}",
            "progress_id": self.progress_id,
        }

    async def _async_orchestrate_crawl(self, request: Dict[str, Any], task_id: str):
        """
        Async orchestration that runs in the main event loop.
        """
        last_heartbeat = asyncio.get_event_loop().time()
        heartbeat_interval = 30.0  # Send heartbeat every 30 seconds

        async def send_heartbeat_if_needed():
            """Send heartbeat to keep Socket.IO connection alive"""
            nonlocal last_heartbeat
            current_time = asyncio.get_event_loop().time()
            if current_time - last_heartbeat >= heartbeat_interval:
                await self._handle_progress_update(
                    task_id,
                    {
                        "status": self.progress_mapper.get_current_stage(),
                        "percentage": self.progress_mapper.get_current_progress(),
                        "heartbeat": True,
                        "log": "Background task still running...",
                        "message": "Processing...",
                    },
                )
                last_heartbeat = current_time

        try:
            url = str(request.get("url", ""))
            safe_logfire_info(f"Starting async crawl orchestration | url={url} | task_id={task_id}")

            # Extract source_id from the original URL
            parsed_original_url = urlparse(url)
            original_source_id = parsed_original_url.netloc or parsed_original_url.path
            safe_logfire_info(f"Using source_id '{original_source_id}' from original URL '{url}'")

            # Helper to update progress with mapper
            async def update_mapped_progress(
                stage: str, stage_progress: int, message: str, **kwargs
            ):
                overall_progress = self.progress_mapper.map_progress(stage, stage_progress)
                await self._handle_progress_update(
                    task_id,
                    {
                        "status": stage,
                        "percentage": overall_progress,
                        "log": message,
                        "message": message,
                        **kwargs,
                    },
                )

            # Initial progress
            await update_mapped_progress(
                "starting", 100, f"Starting crawl of {url}", currentUrl=url
            )

            # Check for cancellation before proceeding
            self._check_cancellation()

            # Analyzing stage
            await update_mapped_progress("analyzing", 50, f"Analyzing URL type for {url}")

            # Detect URL type and perform crawl
            crawl_results, crawl_type = await self._crawl_by_url_type(url, request)

            # Check for cancellation after crawling
            self._check_cancellation()

            # Send heartbeat after potentially long crawl operation
            await send_heartbeat_if_needed()

            if not crawl_results:
                raise ValueError("No content was crawled from the provided URL")

            # Processing stage
            await update_mapped_progress("processing", 50, "Processing crawled content")

            # Check for cancellation before document processing
            self._check_cancellation()

            # Process and store documents using document storage operations
            async def doc_storage_callback(
                message: str, percentage: int, batch_info: Optional[dict] = None
            ):
                if self.progress_id:
                    _ensure_socketio_imports()
                    # Use ProgressMapper to consistently map document storage progress
                    overall_progress = self.progress_mapper.map_progress("document_storage", percentage)
                    safe_logfire_info(
                        f"Document storage progress mapping: {percentage}% -> {overall_progress}%"
                    )

                    # Update progress state while preserving existing fields
                    self.progress_state.update({
                        "status": "document_storage",
                        "percentage": overall_progress,
                        "log": message,
                    })

                    # Add batch_info fields if provided
                    if batch_info:
                        self.progress_state.update(batch_info)

                    await update_crawl_progress(self.progress_id, self.progress_state)

            storage_results = await self.doc_storage_ops.process_and_store_documents(
                crawl_results,
                request,
                crawl_type,
                original_source_id,
                doc_storage_callback,
                self._check_cancellation,
            )

            # Check for cancellation after document storage
            self._check_cancellation()

            # Send heartbeat after document storage
            await send_heartbeat_if_needed()

            # Extract code examples if requested
            code_examples_count = 0
            if request.get("extract_code_examples", True):
                await update_mapped_progress("code_extraction", 0, "Starting code extraction...")

                # Create progress callback for code extraction
                async def code_progress_callback(data: dict):
                    if self.progress_id:
                        _ensure_socketio_imports()
                        # Update progress state while preserving existing fields
                        self.progress_state.update(data)
                        await update_crawl_progress(self.progress_id, self.progress_state)

                code_examples_count = await self.doc_storage_ops.extract_and_store_code_examples(
                    crawl_results,
                    storage_results["url_to_full_document"],
                    code_progress_callback,
                    85,
                    95,
                )

                # Send heartbeat after code extraction
                await send_heartbeat_if_needed()

            # Finalization
            await update_mapped_progress(
                "finalization",
                50,
                "Finalizing crawl results...",
                chunks_stored=storage_results["chunk_count"],
                code_examples_found=code_examples_count,
            )

            # Complete - send both the progress update and completion event
            await update_mapped_progress(
                "completed",
                100,
                f"Crawl completed: {storage_results['chunk_count']} chunks, {code_examples_count} code examples",
                chunks_stored=storage_results["chunk_count"],
                code_examples_found=code_examples_count,
                processed_pages=len(crawl_results),
                total_pages=len(crawl_results),
            )

            # Also send the completion event that frontend expects
            _ensure_socketio_imports()
            await complete_crawl_progress(
                task_id,
                {
                    "chunks_stored": storage_results["chunk_count"],
                    "code_examples_found": code_examples_count,
                    "processed_pages": len(crawl_results),
                    "total_pages": len(crawl_results),
                    "sourceId": storage_results.get("source_id", ""),
                    "log": "Crawl completed successfully!",
                },
            )

            # Unregister after successful completion
            if self.progress_id:
                unregister_orchestration(self.progress_id)
                safe_logfire_info(
                    f"Unregistered orchestration service after completion | progress_id={self.progress_id}"
                )

        except asyncio.CancelledError:
            safe_logfire_info(f"Crawl operation cancelled | progress_id={self.progress_id}")
            await self._handle_progress_update(
                task_id,
                {
                    "status": "cancelled",
                    "percentage": -1,
                    "log": "Crawl operation was cancelled by user",
                },
            )
            # Unregister on cancellation
            if self.progress_id:
                unregister_orchestration(self.progress_id)
                safe_logfire_info(
                    f"Unregistered orchestration service on cancellation | progress_id={self.progress_id}"
                )
        except Exception as e:
            safe_logfire_error(f"Async crawl orchestration failed | error={str(e)}")
            await self._handle_progress_update(
                task_id, {"status": "error", "percentage": -1, "log": f"Crawl failed: {str(e)}"}
            )
            # Unregister on error
            if self.progress_id:
                unregister_orchestration(self.progress_id)
                safe_logfire_info(
                    f"Unregistered orchestration service on error | progress_id={self.progress_id}"
                )

    def _is_self_link(self, link: str, base_url: str) -> bool:
        """
        Check if a link is a self-referential link to the base URL.
        Handles query parameters, fragments, and trailing slashes.
        
        Args:
            link: The link to check
            base_url: The base URL to compare against
            
        Returns:
            True if the link is self-referential, False otherwise
        """
        try:
            from urllib.parse import urlparse
            
            # Parse both URLs to compare their core components
            link_parsed = urlparse(link)
            base_parsed = urlparse(base_url)
            
            # Compare scheme, netloc, and path (ignoring query and fragment)
            link_core = f"{link_parsed.scheme}://{link_parsed.netloc}{link_parsed.path.rstrip('/')}"
            base_core = f"{base_parsed.scheme}://{base_parsed.netloc}{base_parsed.path.rstrip('/')}"
            
            return link_core == base_core
            
        except Exception as e:
            logger.warning(f"Error checking if link is self-referential: {e}")
            # Fallback to simple string comparison
            return link.rstrip('/') == base_url.rstrip('/')

    async def _crawl_by_url_type(self, url: str, request: Dict[str, Any]) -> tuple:
        """
        Detect URL type and perform appropriate crawling.

        Returns:
            Tuple of (crawl_results, crawl_type)
        """
        _ensure_socketio_imports()

        crawl_results = []
        crawl_type = None

        if self.url_handler.is_txt(url) or self.url_handler.is_markdown(url):
            # Handle text files
            if self.progress_id:
                self.progress_state.update({
                    "status": "crawling",
                    "percentage": 10,
                    "log": "Detected text/markdown file, fetching content...",
                })
                # Keep heartbeat stage/progress in sync with direct emissions
                self.progress_mapper.map_progress("crawling", 10)
                await update_crawl_progress(self.progress_id, self.progress_state)
            crawl_results = await self.crawl_markdown_file(
                url,
                progress_callback=await self._create_crawl_progress_callback("crawling"),
                start_progress=10,
                end_progress=20,
            )
            crawl_type = "text_file"
            
            # Check if this is a link collection file and extract links
            if crawl_results and len(crawl_results) > 0:
                content = crawl_results[0].get('markdown', '')
                if self.url_handler.is_link_collection_file(url, content):
                    if self.progress_id:
                        # Use ProgressMapper to stay within crawling range (5-30%)
                        overall_progress = self.progress_mapper.map_progress("crawling", 80)  # 80% within crawling = ~25%
                        self.progress_state.update({
                            "status": "crawling",
                            "percentage": overall_progress,
                            "log": "Link collection file detected, extracting embedded links...",
                        })
                        await update_crawl_progress(self.progress_id, self.progress_state)
                    
                    # Extract links from the content
                    extracted_links = self.url_handler.extract_markdown_links(content, url)
                    
                    # Filter out self-referential links to avoid redundant crawling
                    if extracted_links:
                        original_count = len(extracted_links)
                        extracted_links = [
                            link for link in extracted_links
                            if not self._is_self_link(link, url)
                        ]
                        self_filtered_count = original_count - len(extracted_links)
                        if self_filtered_count > 0:
                            logger.info(f"Filtered out {self_filtered_count} self-referential links from {original_count} extracted links")
                    
                    # Filter out binary files (PDFs, images, archives, etc.) to avoid wasteful crawling
                    if extracted_links:
                        original_count = len(extracted_links)
                        extracted_links = [link for link in extracted_links if not self.url_handler.is_binary_file(link)]
                        filtered_count = original_count - len(extracted_links)
                        if filtered_count > 0:
                            logger.info(f"Filtered out {filtered_count} binary files from {original_count} extracted links")
                    
                    if extracted_links:
                        if self.progress_id:
                            # Use ProgressMapper to stay within crawling range (5-30%)
                            overall_progress = self.progress_mapper.map_progress("crawling", 90)  # 90% within crawling = ~27%
                            self.progress_state.update({
                                "status": "crawling",
                                "percentage": overall_progress,
                                "log": f"Found {len(extracted_links)} links to crawl from {url}",
                            })
                            await update_crawl_progress(self.progress_id, self.progress_state)
                        
                        # Crawl the extracted links using batch crawling
                        logger.info(f"Crawling {len(extracted_links)} extracted links from {url}")
                        batch_results = await self.crawl_batch_with_progress(
                            extracted_links,
                            max_concurrent=request.get('max_concurrent'),  # None -> use DB settings
                            progress_callback=await self._create_crawl_progress_callback("crawling"),
                            start_progress=20,
                            end_progress=30,
                        )
                        
                        # Combine original text file results with batch results
                        crawl_results.extend(batch_results)
                        crawl_type = "link_collection_with_crawled_links"
                        
                        logger.info(f"Link collection crawling completed: {len(crawl_results)} total results (1 text file + {len(batch_results)} extracted links)")
                    else:
                        logger.info(f"No valid links found in link collection file: {url}")
                        logger.info(f"Text file crawling completed: {len(crawl_results)} results")

        elif self.url_handler.is_sitemap(url):
            # Handle sitemaps
            if self.progress_id:
                self.progress_state.update({
                    "status": "crawling",
                    "percentage": 10,
                    "log": "Detected sitemap, parsing URLs...",
                })
                await update_crawl_progress(self.progress_id, self.progress_state)
            sitemap_urls = self.parse_sitemap(url)

            if sitemap_urls:
                # Emit progress before starting batch crawl
                if self.progress_id:
                    self.progress_state.update({
                        "status": "crawling",
                        "percentage": 15,
                        "log": f"Starting batch crawl of {len(sitemap_urls)} URLs...",
                    })
                    await update_crawl_progress(self.progress_id, self.progress_state)

                crawl_results = await self.crawl_batch_with_progress(
                    sitemap_urls,
                    progress_callback=await self._create_crawl_progress_callback("crawling"),
                    start_progress=15,
                    end_progress=20,
                )
                crawl_type = "sitemap"

        else:
            # Handle regular webpages with recursive crawling
            if self.progress_id:
                self.progress_state.update({
                    "status": "crawling",
                    "percentage": 10,
                    "log": f"Starting recursive crawl with max depth {request.get('max_depth', 1)}...",
                })
                await update_crawl_progress(self.progress_id, self.progress_state)

            max_depth = request.get("max_depth", 1)
            # Let the strategy handle concurrency from settings
            # This will use CRAWL_MAX_CONCURRENT from database (default: 10)
            
            crawl_results = await self.crawl_recursive_with_progress(
                [url],
                max_depth=max_depth,
                max_concurrent=None,  # Let strategy use settings
                progress_callback=await self._create_crawl_progress_callback("crawling"),
                start_progress=10,
                end_progress=20,
            )
            crawl_type = "webpage"

        return crawl_results, crawl_type


# Alias for backward compatibility
CrawlOrchestrationService = CrawlingService
