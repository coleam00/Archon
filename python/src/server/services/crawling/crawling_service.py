"""
Crawling Service Module for Archon RAG

This module combines crawling functionality and orchestration.
It handles web crawling operations including single page crawling,
batch crawling, recursive crawling, and overall orchestration with progress tracking.
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, Optional

import tldextract

from ...config.config import get_crawler_config
from ...config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info
from ...utils import get_supabase_client
from ...utils.progress.progress_tracker import ProgressTracker
from ..credential_service import credential_service

# Import strategies
# Import operations
from .discovery_service import DiscoveryService
from .document_storage_operations import DocumentStorageOperations
from .helpers.site_config import SiteConfig

# Import helpers
from .helpers.url_handler import URLHandler
from .page_storage_operations import PageStorageOperations
from .progress_mapper import ProgressMapper
from .robots_checker import RobotsChecker
from .strategies.batch import BatchCrawlStrategy
from .strategies.recursive import RecursiveCrawlStrategy
from .strategies.single_page import SinglePageCrawlStrategy
from .strategies.sitemap import SitemapCrawlStrategy

logger = get_logger(__name__)

# Global registry to track active orchestration services for cancellation support
_active_orchestrations: dict[str, "CrawlingService"] = {}
_orchestration_lock: asyncio.Lock | None = None


def get_root_domain(host: str) -> str:
    """
    Extract the root domain from a hostname using tldextract.
    Handles multi-part public suffixes correctly (e.g., .co.uk, .com.au).

    Args:
        host: Hostname to extract root domain from

    Returns:
        Root domain (domain + suffix) or original host if extraction fails

    Examples:
        - "docs.example.com" -> "example.com"
        - "api.example.co.uk" -> "example.co.uk"
        - "localhost" -> "localhost"
    """
    try:
        extracted = tldextract.extract(host)
        # Return domain.suffix if both are present
        if extracted.domain and extracted.suffix:
            return f"{extracted.domain}.{extracted.suffix}"
        # Fallback to original host if extraction yields no domain or suffix
        return host
    except Exception:
        # If extraction fails, return original host
        return host


def _ensure_orchestration_lock() -> asyncio.Lock:
    global _orchestration_lock
    if _orchestration_lock is None:
        _orchestration_lock = asyncio.Lock()
    return _orchestration_lock


async def get_active_orchestration(progress_id: str) -> Optional["CrawlingService"]:
    """Get an active orchestration service by progress ID."""
    lock = _ensure_orchestration_lock()
    async with lock:
        return _active_orchestrations.get(progress_id)


async def register_orchestration(progress_id: str, orchestration: "CrawlingService"):
    """Register an active orchestration service."""
    lock = _ensure_orchestration_lock()
    async with lock:
        _active_orchestrations[progress_id] = orchestration


async def unregister_orchestration(progress_id: str):
    """Unregister an orchestration service."""
    lock = _ensure_orchestration_lock()
    async with lock:
        _active_orchestrations.pop(progress_id, None)


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
            progress_id: Optional progress ID for HTTP polling updates
        """
        self.crawler = crawler
        self.supabase_client = supabase_client or get_supabase_client()
        self.progress_id = progress_id
        self.progress_tracker = None

        # Initialize helpers
        self.url_handler = URLHandler()
        self.site_config = SiteConfig()
        self.markdown_generator = self.site_config.get_markdown_generator()
        self.link_pruning_markdown_generator = self.site_config.get_link_pruning_markdown_generator()

        # Initialize strategies
        self.batch_strategy = BatchCrawlStrategy(crawler, self.link_pruning_markdown_generator)
        self.recursive_strategy = RecursiveCrawlStrategy(crawler, self.link_pruning_markdown_generator)
        self.single_page_strategy = SinglePageCrawlStrategy(crawler, self.markdown_generator)
        self.sitemap_strategy = SitemapCrawlStrategy()

        # Initialize operations
        self.doc_storage_ops = DocumentStorageOperations(self.supabase_client)
        self.discovery_service = DiscoveryService()
        self.page_storage_ops = PageStorageOperations(self.supabase_client)

        # Initialize robots.txt checker
        crawler_config = get_crawler_config()
        self.robots_checker = RobotsChecker(crawler_config) if crawler_config.get("respect_robots") else None

        # Track progress state across all stages to prevent UI resets
        self.progress_state = {"progressId": self.progress_id} if self.progress_id else {}
        # Initialize progress mapper to prevent backwards jumps
        self.progress_mapper = ProgressMapper()
        # Cancellation support
        self._cancelled = False

    def set_progress_id(self, progress_id: str):
        """Set the progress ID for HTTP polling updates."""
        self.progress_id = progress_id
        if self.progress_id:
            self.progress_state = {"progressId": self.progress_id}
            # Initialize progress tracker for HTTP polling
            self.progress_tracker = ProgressTracker(progress_id, operation_type="crawl")

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

    async def _can_fetch_url(self, url: str) -> bool:
        """
        Check if URL is allowed by robots.txt.

        Note: This method only validates URLs, it does NOT enforce crawl delays.
        Crawl delays are handled by Crawl4AI's internal rate limiting and
        concurrency controls. Enforcing delays during validation would cause
        unacceptable performance (e.g., 540 seconds to validate 54 sitemap URLs).

        Args:
            url: URL to check

        Returns:
            True if crawling is allowed, False if blocked by robots.txt

        Raises:
            No exceptions - errors result in allowing the crawl (fail open)
        """
        if not self.robots_checker:
            return True  # Robots checking disabled

        try:
            # Check if URL is allowed (no delay enforcement during validation)
            return await self.robots_checker.can_fetch(url)
        except Exception as e:
            # Log error but allow crawl (fail open)
            logger.warning(f"robots.txt check failed for {url}: {e}, allowing crawl")
            return True

    async def _create_crawl_progress_callback(
        self, base_status: str
    ) -> Callable[[str, int, str], Awaitable[None]]:
        """Create a progress callback for crawling operations.

        Args:
            base_status: The base status to use for progress updates

        Returns:
            Async callback function with signature (status: str, progress: int, message: str, **kwargs) -> None
        """
        async def callback(status: str, progress: int, message: str, **kwargs):
            if self.progress_tracker:
                # Debug log what we're receiving
                safe_logfire_info(
                    f"Progress callback received | status={status} | progress={progress} | "
                    f"total_pages={kwargs.get('total_pages', 'N/A')} | processed_pages={kwargs.get('processed_pages', 'N/A')} | "
                    f"kwargs_keys={list(kwargs.keys())}"
                )

                # Map the progress to the overall progress range
                mapped_progress = self.progress_mapper.map_progress(base_status, progress)

                # Update progress via tracker (stores in memory for HTTP polling)
                await self.progress_tracker.update(
                    status=base_status,
                    progress=mapped_progress,
                    log=message,
                    **kwargs
                )
                safe_logfire_info(
                    f"Updated crawl progress | progress_id={self.progress_id} | status={base_status} | "
                    f"raw_progress={progress} | mapped_progress={mapped_progress} | "
                    f"total_pages={kwargs.get('total_pages', 'N/A')} | processed_pages={kwargs.get('processed_pages', 'N/A')}"
                )

        return callback

    async def _handle_progress_update(self, task_id: str, update: dict[str, Any]) -> None:
        """
        Handle progress updates from background task.

        Args:
            task_id: The task ID for the progress update
            update: Dictionary containing progress update data
        """
        if self.progress_tracker:
            # Update progress via tracker for HTTP polling
            await self.progress_tracker.update(
                status=update.get("status", "processing"),
                progress=update.get("progress", update.get("percentage", 0)),  # Support both for compatibility
                log=update.get("log", "Processing..."),
                **{k: v for k, v in update.items() if k not in ["status", "progress", "percentage", "log"]}
            )

    # Simple delegation methods for backward compatibility
    async def crawl_single_page(self, url: str, retry_count: int = 3) -> dict[str, Any]:
        """Crawl a single web page."""
        return await self.single_page_strategy.crawl_single_page(
            url,
            self.url_handler.transform_github_url,
            self.site_config.is_documentation_site,
            retry_count,
        )

    async def crawl_markdown_file(
        self, url: str, progress_callback: Callable[[str, int, str], Awaitable[None]] | None = None,
        start_progress: int = 10, end_progress: int = 20
    ) -> list[dict[str, Any]]:
        """Crawl a .txt or markdown file."""
        return await self.single_page_strategy.crawl_markdown_file(
            url,
            self.url_handler.transform_github_url,
            progress_callback,
            start_progress,
            end_progress,
        )

    def parse_sitemap(self, sitemap_url: str) -> list[str]:
        """Parse a sitemap and extract URLs."""
        return self.sitemap_strategy.parse_sitemap(sitemap_url, self._check_cancellation)

    async def crawl_batch_with_progress(
        self,
        urls: list[str],
        max_concurrent: int | None = None,
        progress_callback: Callable[[str, int, str], Awaitable[None]] | None = None,
        link_text_fallbacks: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        """Batch crawl multiple URLs in parallel."""
        return await self.batch_strategy.crawl_batch_with_progress(
            urls,
            self.url_handler.transform_github_url,
            self.site_config.is_documentation_site,
            max_concurrent,
            progress_callback,
            self._check_cancellation,  # Pass cancellation check
            link_text_fallbacks,  # Pass link text fallbacks
        )

    async def crawl_recursive_with_progress(
        self,
        start_urls: list[str],
        max_depth: int = 3,
        max_concurrent: int | None = None,
        progress_callback: Callable[[str, int, str], Awaitable[None]] | None = None,
    ) -> list[dict[str, Any]]:
        """Recursively crawl internal links from start URLs."""
        return await self.recursive_strategy.crawl_recursive_with_progress(
            start_urls,
            self.url_handler.transform_github_url,
            self.site_config.is_documentation_site,
            max_depth,
            max_concurrent,
            progress_callback,
            self._check_cancellation,  # Pass cancellation check
            self.robots_checker,  # Pass robots checker for URL validation
        )

    # Orchestration methods
    async def orchestrate_crawl(self, request: dict[str, Any]) -> dict[str, Any]:
        """
        Main orchestration method - non-blocking using asyncio.create_task.

        Args:
            request: The crawl request containing url, knowledge_type, tags, max_depth, etc.

        Returns:
            Dict containing task_id, status, and the asyncio task reference
        """
        url = str(request.get("url", ""))
        safe_logfire_info(f"Starting background crawl orchestration | url={url}")

        # Create task ID
        task_id = self.progress_id or str(uuid.uuid4())

        # Register this orchestration service for cancellation support
        if self.progress_id:
            await register_orchestration(self.progress_id, self)

        # Start the crawl as an async task in the main event loop
        # Store the task reference for proper cancellation
        crawl_task = asyncio.create_task(self._async_orchestrate_crawl(request, task_id))

        # Set a name for the task to help with debugging
        if self.progress_id:
            crawl_task.set_name(f"crawl_{self.progress_id}")

        # Return immediately with task reference
        return {
            "task_id": task_id,
            "status": "started",
            "message": f"Crawl operation started for {url}",
            "progress_id": self.progress_id,
            "task": crawl_task,  # Return the actual task for proper cancellation
        }

    async def _async_orchestrate_crawl(self, request: dict[str, Any], task_id: str):
        """
        Async orchestration that runs in the main event loop.
        """
        last_heartbeat = asyncio.get_event_loop().time()
        heartbeat_interval = 30.0  # Send heartbeat every 30 seconds

        async def send_heartbeat_if_needed():
            """Send heartbeat to keep connection alive"""
            nonlocal last_heartbeat
            current_time = asyncio.get_event_loop().time()
            if current_time - last_heartbeat >= heartbeat_interval:
                await self._handle_progress_update(
                    task_id,
                    {
                        "status": self.progress_mapper.get_current_stage(),
                        "progress": self.progress_mapper.get_current_progress(),
                        "heartbeat": True,
                        "log": "Background task still running...",
                        "message": "Processing...",
                    },
                )
                last_heartbeat = current_time

        try:
            url = str(request.get("url", ""))
            safe_logfire_info(f"Starting async crawl orchestration | url={url} | task_id={task_id}")

            # Start the progress tracker if available
            if self.progress_tracker:
                await self.progress_tracker.start({
                    "url": url,
                    "status": "starting",
                    "progress": 0,
                    "log": f"Starting crawl of {url}"
                })

            # Generate unique source_id and display name from the original URL
            original_source_id = self.url_handler.generate_unique_source_id(url)
            source_display_name = self.url_handler.extract_display_name(url)
            safe_logfire_info(
                f"Generated unique source_id '{original_source_id}' and display name '{source_display_name}' from URL '{url}'"
            )

            # Helper to update progress with mapper
            async def update_mapped_progress(
                stage: str, stage_progress: int, message: str, **kwargs
            ):
                overall_progress = self.progress_mapper.map_progress(stage, stage_progress)
                await self._handle_progress_update(
                    task_id,
                    {
                        "status": stage,
                        "progress": overall_progress,
                        "log": message,
                        "message": message,
                        **kwargs,
                    },
                )

            # Initial progress
            await update_mapped_progress(
                "starting", 100, f"Starting crawl of {url}", current_url=url
            )

            # Check for cancellation before proceeding
            self._check_cancellation()

            # Discovery phase - find the single best related file
            discovered_urls = []
            # Skip discovery if the URL itself is already a discovery target (sitemap, llms file, etc.)
            is_already_discovery_target = (
                self.url_handler.is_sitemap(url) or
                self.url_handler.is_llms_variant(url) or
                self.url_handler.is_robots_txt(url) or
                self.url_handler.is_well_known_file(url) or
                self.url_handler.is_txt(url)  # Also skip for any .txt file that user provides directly
            )

            if is_already_discovery_target:
                safe_logfire_info(f"Skipping discovery - URL is already a discovery target file: {url}")

            if request.get("auto_discovery", True) and not is_already_discovery_target:  # Default enabled, but skip if already a discovery file
                await update_mapped_progress(
                    "discovery", 25, f"Discovering best related file for {url}", current_url=url
                )
                try:
                    # Offload potential sync I/O to avoid blocking the event loop
                    discovered_file = await asyncio.to_thread(self.discovery_service.discover_files, url)

                    # Add the single best discovered file to crawl list
                    if discovered_file:
                        safe_logfire_info(f"Discovery found file: {discovered_file}")
                        # Filter through is_binary_file() check like existing code
                        if not self.url_handler.is_binary_file(discovered_file):
                            discovered_urls.append(discovered_file)
                            safe_logfire_info(f"Adding discovered file to crawl: {discovered_file}")

                            # Determine file type for user feedback
                            discovered_file_type = "unknown"
                            if self.url_handler.is_llms_variant(discovered_file):
                                discovered_file_type = "llms.txt"
                            elif self.url_handler.is_sitemap(discovered_file):
                                discovered_file_type = "sitemap"
                            elif self.url_handler.is_robots_txt(discovered_file):
                                discovered_file_type = "robots.txt"

                            await update_mapped_progress(
                                "discovery", 100,
                                f"Discovery completed: found {discovered_file_type} file",
                                current_url=url,
                                discovered_file=discovered_file,
                                discovered_file_type=discovered_file_type
                            )
                        else:
                            safe_logfire_info(f"Skipping binary file: {discovered_file}")
                    else:
                        safe_logfire_info(f"Discovery found no files for {url}")
                        await update_mapped_progress(
                            "discovery", 100,
                            "Discovery completed: no special files found, will crawl main URL",
                            current_url=url
                        )

                except Exception as e:
                    safe_logfire_error(f"Discovery phase failed: {e}")
                    # Continue with regular crawl even if discovery fails
                    await update_mapped_progress(
                        "discovery", 100, "Discovery phase failed, continuing with regular crawl", current_url=url
                    )

            # Analyzing stage - determine what to crawl
            if discovered_urls:
                # Discovery found a file - crawl ONLY the discovered file, not the main URL
                total_urls_to_crawl = len(discovered_urls)
                await update_mapped_progress(
                    "analyzing", 50, f"Analyzing discovered file: {discovered_urls[0]}",
                    total_pages=total_urls_to_crawl,
                    processed_pages=0
                )

                # Crawl only the discovered file with discovery context
                discovered_url = discovered_urls[0]
                safe_logfire_info(f"Crawling discovered file instead of main URL: {discovered_url}")

                # Mark this as a discovery target for domain filtering
                discovery_request = request.copy()
                discovery_request["is_discovery_target"] = True
                discovery_request["original_domain"] = self.url_handler.get_base_url(discovered_url)

                crawl_results, crawl_type = await self._crawl_by_url_type(discovered_url, discovery_request)

            else:
                # No discovery - crawl the main URL normally
                total_urls_to_crawl = 1
                await update_mapped_progress(
                    "analyzing", 50, f"Analyzing URL type for {url}",
                    total_pages=total_urls_to_crawl,
                    processed_pages=0
                )

                # Crawl the main URL
                safe_logfire_info(f"No discovery file found, crawling main URL: {url}")
                crawl_results, crawl_type = await self._crawl_by_url_type(url, request)

            # Update progress tracker with crawl type
            if self.progress_tracker and crawl_type:
                # Use mapper to get correct progress value
                mapped_progress = self.progress_mapper.map_progress("crawling", 100)  # 100% of crawling stage
                await self.progress_tracker.update(
                    status="crawling",
                    progress=mapped_progress,
                    log=f"Processing {crawl_type} content",
                    crawl_type=crawl_type
                )

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

            # Calculate total work units for accurate progress tracking
            total_pages = len(crawl_results)

            # Process and store documents using document storage operations
            last_logged_progress = 0

            async def doc_storage_callback(
                status: str, progress: int, message: str, **kwargs
            ):
                nonlocal last_logged_progress

                # Log only significant progress milestones (every 5%) or status changes
                should_log_debug = (
                    status != "document_storage" or  # Status changes
                    progress == 100 or  # Completion
                    progress == 0 or  # Start
                    abs(progress - last_logged_progress) >= 5  # 5% progress changes
                )

                if should_log_debug:
                    safe_logfire_info(
                        f"Document storage progress: {progress}% | status={status} | "
                        f"message={message[:50]}..." + ("..." if len(message) > 50 else "")
                    )
                    last_logged_progress = progress

                if self.progress_tracker:
                    # Use ProgressMapper to ensure progress never goes backwards
                    mapped_progress = self.progress_mapper.map_progress("document_storage", progress)

                    # Update progress state via tracker
                    await self.progress_tracker.update(
                        status="document_storage",
                        progress=mapped_progress,
                        log=message,
                        total_pages=total_pages,
                        **kwargs
                    )

            storage_results = await self.doc_storage_ops.process_and_store_documents(
                crawl_results,
                request,
                crawl_type,
                original_source_id,
                doc_storage_callback,
                self._check_cancellation,
                source_url=url,
                source_display_name=source_display_name,
                url_to_page_id=None,  # Will be populated after page storage
            )

            # Update progress tracker with source_id now that it's created
            if self.progress_tracker and storage_results.get("source_id"):
                # Update the tracker to include source_id for frontend matching
                # Use update method to maintain timestamps and invariants
                await self.progress_tracker.update(
                    status=self.progress_tracker.state.get("status", "document_storage"),
                    progress=self.progress_tracker.state.get("progress", 0),
                    log=self.progress_tracker.state.get("log", "Processing documents"),
                    source_id=storage_results["source_id"]
                )
                safe_logfire_info(
                    f"Updated progress tracker with source_id | progress_id={self.progress_id} | source_id={storage_results['source_id']}"
                )

            # Check for cancellation after document storage
            self._check_cancellation()

            # Send heartbeat after document storage
            await send_heartbeat_if_needed()

            # CRITICAL: Verify that chunks were actually stored
            actual_chunks_stored = storage_results.get("chunks_stored", 0)
            if storage_results["chunk_count"] > 0 and actual_chunks_stored == 0:
                # We processed chunks but none were stored - this is a failure
                error_msg = (
                    f"Failed to store documents: {storage_results['chunk_count']} chunks processed but 0 stored "
                    f"| url={url} | progress_id={self.progress_id}"
                )
                safe_logfire_error(error_msg)
                raise ValueError(error_msg)

            # Extract code examples if requested
            code_examples_count = 0
            if request.get("extract_code_examples", True) and actual_chunks_stored > 0:
                # Check for cancellation before starting code extraction
                self._check_cancellation()

                await update_mapped_progress("code_extraction", 0, "Starting code extraction...")

                # Create progress callback for code extraction
                async def code_progress_callback(data: dict):
                    if self.progress_tracker:
                        # Use ProgressMapper to ensure progress never goes backwards
                        raw_progress = data.get("progress", data.get("percentage", 0))
                        mapped_progress = self.progress_mapper.map_progress("code_extraction", raw_progress)

                        # Update progress state via tracker
                        await self.progress_tracker.update(
                            status=data.get("status", "code_extraction"),
                            progress=mapped_progress,
                            log=data.get("log", "Extracting code examples..."),
                            total_pages=total_pages,  # Include total context
                            **{k: v for k, v in data.items() if k not in ["status", "progress", "percentage", "log"]}
                        )

                try:
                    # Extract provider from request or use credential service default
                    provider = request.get("provider")
                    embedding_provider = None

                    if not provider:
                        try:
                            provider_config = await credential_service.get_active_provider("llm")
                            provider = provider_config.get("provider", "openai")
                        except Exception as e:
                            logger.warning(
                                f"Failed to get provider from credential service: {e}, defaulting to openai"
                            )
                            provider = "openai"

                    try:
                        embedding_config = await credential_service.get_active_provider("embedding")
                        embedding_provider = embedding_config.get("provider")
                    except Exception as e:
                        logger.warning(
                            f"Failed to get embedding provider from credential service: {e}. Using configured default."
                        )
                        embedding_provider = None

                    code_examples_count = await self.doc_storage_ops.extract_and_store_code_examples(
                        crawl_results,
                        storage_results["url_to_full_document"],
                        storage_results["source_id"],
                        code_progress_callback,
                        self._check_cancellation,
                        provider,
                        embedding_provider,
                    )
                except RuntimeError as e:
                    # Code extraction failed, continue crawl with warning
                    logger.error("Code extraction failed, continuing crawl without code examples", exc_info=True)
                    safe_logfire_error(f"Code extraction failed | error={e}")
                    code_examples_count = 0

                    # Report code extraction failure to progress tracker
                    if self.progress_tracker:
                        await self.progress_tracker.update(
                            status="code_extraction",
                            progress=self.progress_mapper.map_progress("code_extraction", 100),
                            log=f"Code extraction failed: {str(e)}. Continuing crawl without code examples.",
                            total_pages=total_pages,
                        )

                # Check for cancellation after code extraction
                self._check_cancellation()

                # Send heartbeat after code extraction
                await send_heartbeat_if_needed()

            # Finalization
            await update_mapped_progress(
                "finalization",
                50,
                "Finalizing crawl results...",
                chunks_stored=actual_chunks_stored,
                code_examples_found=code_examples_count,
            )

            # Complete - send both the progress update and completion event
            await update_mapped_progress(
                "completed",
                100,
                f"Crawl completed: {actual_chunks_stored} chunks, {code_examples_count} code examples",
                chunks_stored=actual_chunks_stored,
                code_examples_found=code_examples_count,
                processed_pages=len(crawl_results),
                total_pages=len(crawl_results),
            )

            # Mark crawl as completed
            if self.progress_tracker:
                await self.progress_tracker.complete({
                    "chunks_stored": actual_chunks_stored,
                    "code_examples_found": code_examples_count,
                    "processed_pages": len(crawl_results),
                    "total_pages": len(crawl_results),
                    "sourceId": storage_results.get("source_id", ""),
                    "log": "Crawl completed successfully!",
                })

            # Unregister after successful completion
            if self.progress_id:
                await unregister_orchestration(self.progress_id)
                safe_logfire_info(
                    f"Unregistered orchestration service after completion | progress_id={self.progress_id}"
                )

        except asyncio.CancelledError:
            safe_logfire_info(f"Crawl operation cancelled | progress_id={self.progress_id}")
            # Use ProgressMapper to get proper progress value for cancelled state
            cancelled_progress = self.progress_mapper.map_progress("cancelled", 0)
            await self._handle_progress_update(
                task_id,
                {
                    "status": "cancelled",
                    "progress": cancelled_progress,
                    "log": "Crawl operation was cancelled by user",
                },
            )
            # Unregister on cancellation
            if self.progress_id:
                await unregister_orchestration(self.progress_id)
                safe_logfire_info(
                    f"Unregistered orchestration service on cancellation | progress_id={self.progress_id}"
                )
        except Exception as e:
            # Log full stack trace for debugging
            logger.error("Async crawl orchestration failed", exc_info=True)
            safe_logfire_error(f"Async crawl orchestration failed | error={str(e)}")
            error_message = f"Crawl failed: {str(e)}"
            # Use ProgressMapper to get proper progress value for error state
            error_progress = self.progress_mapper.map_progress("error", 0)
            await self._handle_progress_update(
                task_id, {
                    "status": "error",
                    "progress": error_progress,
                    "log": error_message,
                    "error": str(e)
                }
            )
            # Mark error in progress tracker with standardized schema
            if self.progress_tracker:
                await self.progress_tracker.error(error_message)
            # Unregister on error
            if self.progress_id:
                await unregister_orchestration(self.progress_id)
                safe_logfire_info(
                    f"Unregistered orchestration service on error | progress_id={self.progress_id}"
                )

    def _is_same_domain(self, url: str, base_domain: str) -> bool:
        """
        Check if a URL belongs to the same domain as the base domain.

        Args:
            url: URL to check
            base_domain: Base domain URL to compare against

        Returns:
            True if the URL is from the same domain
        """
        try:
            from urllib.parse import urlparse
            u, b = urlparse(url), urlparse(base_domain)
            url_host = (u.hostname or "").lower()
            base_host = (b.hostname or "").lower()
            return bool(url_host) and url_host == base_host
        except Exception:
            # If parsing fails, be conservative and exclude the URL
            return False

    def _is_same_domain_or_subdomain(self, url: str, base_domain: str) -> bool:
        """
        Check if a URL belongs to the same root domain or subdomain.

        Examples:
            - docs.supabase.com matches supabase.com (subdomain)
            - api.supabase.com matches supabase.com (subdomain)
            - supabase.com matches supabase.com (exact match)
            - external.com does NOT match supabase.com

        Args:
            url: URL to check
            base_domain: Base domain URL to compare against

        Returns:
            True if the URL is from the same root domain or subdomain
        """
        try:
            from urllib.parse import urlparse
            u, b = urlparse(url), urlparse(base_domain)
            url_host = (u.hostname or "").lower()
            base_host = (b.hostname or "").lower()

            if not url_host or not base_host:
                return False

            # Exact match
            if url_host == base_host:
                return True

            # Check if url_host is a subdomain of base_host using tldextract
            url_root = get_root_domain(url_host)
            base_root = get_root_domain(base_host)

            return url_root == base_root
        except Exception:
            # If parsing fails, be conservative and exclude the URL
            return False

    def _is_self_link(self, link: str, base_url: str) -> bool:
        """
        Check if a link is a self-referential link to the base URL.
        Handles query parameters, fragments, trailing slashes, and normalizes
        scheme/host/ports for accurate comparison.

        Args:
            link: The link to check
            base_url: The base URL to compare against

        Returns:
            True if the link is self-referential, False otherwise
        """
        try:
            from urllib.parse import urlparse

            def _core(u: str) -> str:
                p = urlparse(u)
                scheme = (p.scheme or "http").lower()
                host = (p.hostname or "").lower()
                port = p.port
                if (scheme == "http" and port in (None, 80)) or (scheme == "https" and port in (None, 443)):
                    port_part = ""
                else:
                    port_part = f":{port}" if port else ""
                path = p.path.rstrip("/")
                return f"{scheme}://{host}{port_part}{path}"

            return _core(link) == _core(base_url)
        except Exception as e:
            logger.warning(f"Error checking if link is self-referential: {e}", exc_info=True)
            # Fallback to simple string comparison
            return link.rstrip('/') == base_url.rstrip('/')

    async def _crawl_by_url_type(self, url: str, request: dict[str, Any]) -> tuple:
        """
        Detect URL type and perform appropriate crawling.

        Returns:
            Tuple of (crawl_results, crawl_type)
        """
        crawl_results = []
        crawl_type = None

        # Helper to update progress with mapper
        async def update_crawl_progress(stage_progress: int, message: str, **kwargs):
            if self.progress_tracker:
                mapped_progress = self.progress_mapper.map_progress("crawling", stage_progress)
                await self.progress_tracker.update(
                    status="crawling",
                    progress=mapped_progress,
                    log=message,
                    current_url=url,
                    **kwargs
                )

        if self.url_handler.is_txt(url) or self.url_handler.is_markdown(url):
            # Handle text files
            crawl_type = "llms-txt" if "llms" in url.lower() else "text_file"
            await update_crawl_progress(
                50,  # 50% of crawling stage
                "Detected text file, fetching content...",
                crawl_type=crawl_type
            )
            crawl_results = await self.crawl_markdown_file(
                url,
                progress_callback=await self._create_crawl_progress_callback("crawling"),
            )
            # Check if this is a link collection file and extract links
            if crawl_results and len(crawl_results) > 0:
                content = crawl_results[0].get('markdown', '')
                if self.url_handler.is_link_collection_file(url, content):
                    # If this file was selected by discovery, check if it's an llms.txt file
                    if request.get("is_discovery_target"):
                        # Check if this is an llms.txt file (not sitemap or other discovery targets)
                        is_llms_file = self.url_handler.is_llms_variant(url)

                        if is_llms_file:
                            logger.info(f"Discovery llms.txt mode: following ALL same-domain links from {url}")

                            # Extract all links from the file
                            extracted_links_with_text = self.url_handler.extract_markdown_links_with_text(content, url)

                            # Filter for same-domain links (all types, not just llms.txt)
                            same_domain_links = []
                            if extracted_links_with_text:
                                original_domain = request.get("original_domain")
                                if original_domain:
                                    for link, text in extracted_links_with_text:
                                        # Check same domain/subdomain for ALL links
                                        if self._is_same_domain_or_subdomain(link, original_domain):
                                            same_domain_links.append((link, text))
                                            logger.debug(f"Found same-domain link: {link}")

                            if same_domain_links:
                                # Build mapping and extract just URLs
                                url_to_link_text = dict(same_domain_links)
                                extracted_urls = [link for link, _ in same_domain_links]

                                # Filter URLs with robots.txt validation
                                if self.robots_checker:
                                    original_count = len(extracted_urls)
                                    allowed_urls = []
                                    for url_to_check in extracted_urls:
                                        if await self._can_fetch_url(url_to_check):
                                            allowed_urls.append(url_to_check)
                                        else:
                                            logger.info(f"Skipped (robots.txt): {url_to_check}")
                                    extracted_urls = allowed_urls
                                    robots_filtered = original_count - len(extracted_urls)
                                    if robots_filtered > 0:
                                        logger.info(f"Filtered out {robots_filtered} URLs by robots.txt from llms.txt links")

                                logger.info(f"Following {len(extracted_urls)} same-domain links from llms.txt")

                                # Notify user about linked files being crawled
                                await update_crawl_progress(
                                    60,  # 60% of crawling stage
                                    f"Found {len(extracted_urls)} links in llms.txt, crawling them now...",
                                    crawl_type="llms_txt_linked_files",
                                    linked_files=extracted_urls
                                )

                                # Crawl all same-domain links from llms.txt (no recursion, just one level)
                                batch_results = await self.crawl_batch_with_progress(
                                    extracted_urls,
                                    max_concurrent=request.get('max_concurrent'),
                                    progress_callback=await self._create_crawl_progress_callback("crawling"),
                                    link_text_fallbacks=url_to_link_text,
                                )

                                # Combine original llms.txt with linked pages
                                crawl_results.extend(batch_results)
                                crawl_type = "llms_txt_with_linked_pages"
                                logger.info(f"llms.txt crawling completed: {len(crawl_results)} total pages (1 llms.txt + {len(batch_results)} linked pages)")
                                return crawl_results, crawl_type

                        # For non-llms.txt discovery targets (sitemaps, robots.txt), keep single-file mode
                        logger.info(f"Discovery single-file mode: skipping link extraction for {url}")
                        crawl_type = "discovery_single_file"
                        logger.info(f"Discovery file crawling completed: {len(crawl_results)} result")
                        return crawl_results, crawl_type

                    # Extract links WITH text from the content
                    extracted_links_with_text = self.url_handler.extract_markdown_links_with_text(content, url)

                    # Filter out self-referential links to avoid redundant crawling
                    if extracted_links_with_text:
                        original_count = len(extracted_links_with_text)
                        extracted_links_with_text = [
                            (link, text) for link, text in extracted_links_with_text
                            if not self._is_self_link(link, url)
                        ]
                        self_filtered_count = original_count - len(extracted_links_with_text)
                        if self_filtered_count > 0:
                            logger.info(f"Filtered out {self_filtered_count} self-referential links from {original_count} extracted links")

                    # For discovery targets, only follow same-domain links
                    if extracted_links_with_text and request.get("is_discovery_target"):
                        original_domain = request.get("original_domain")
                        if original_domain:
                            original_count = len(extracted_links_with_text)
                            extracted_links_with_text = [
                                (link, text) for link, text in extracted_links_with_text
                                if self._is_same_domain(link, original_domain)
                            ]
                            domain_filtered_count = original_count - len(extracted_links_with_text)
                            if domain_filtered_count > 0:
                                safe_logfire_info(f"Discovery mode: filtered out {domain_filtered_count} external links, keeping {len(extracted_links_with_text)} same-domain links")

                    # Filter out binary files (PDFs, images, archives, etc.) to avoid wasteful crawling
                    if extracted_links_with_text:
                        original_count = len(extracted_links_with_text)
                        extracted_links_with_text = [(link, text) for link, text in extracted_links_with_text if not self.url_handler.is_binary_file(link)]
                        filtered_count = original_count - len(extracted_links_with_text)
                        if filtered_count > 0:
                            logger.info(f"Filtered out {filtered_count} binary files from {original_count} extracted links")

                    if extracted_links_with_text:
                        # Build mapping of URL -> link text for title fallback
                        url_to_link_text = dict(extracted_links_with_text)
                        extracted_links = [link for link, _ in extracted_links_with_text]

                        # Filter URLs with robots.txt validation
                        if self.robots_checker:
                            original_count = len(extracted_links)
                            allowed_links = []
                            for url_to_check in extracted_links:
                                if await self._can_fetch_url(url_to_check):
                                    allowed_links.append(url_to_check)
                                else:
                                    logger.info(f"Skipped (robots.txt): {url_to_check}")
                            extracted_links = allowed_links
                            robots_filtered = original_count - len(extracted_links)
                            if robots_filtered > 0:
                                logger.info(f"Filtered out {robots_filtered} URLs by robots.txt from extracted links")

                        # For discovery targets, respect max_depth for same-domain links
                        max_depth = request.get('max_depth', 2) if request.get("is_discovery_target") else request.get('max_depth', 1)

                        if max_depth > 1 and request.get("is_discovery_target"):
                            # Use recursive crawling to respect depth limit for same-domain links
                            logger.info(f"Crawling {len(extracted_links)} same-domain links with max_depth={max_depth-1}")
                            batch_results = await self.crawl_recursive_with_progress(
                                extracted_links,
                                max_depth=max_depth - 1,  # Reduce depth since we're already 1 level deep
                                max_concurrent=request.get('max_concurrent'),
                                progress_callback=await self._create_crawl_progress_callback("crawling"),
                            )
                        else:
                            # Use normal batch crawling (with link text fallbacks)
                            logger.info(f"Crawling {len(extracted_links)} extracted links from {url}")
                            batch_results = await self.crawl_batch_with_progress(
                                extracted_links,
                                max_concurrent=request.get('max_concurrent'),  # None -> use DB settings
                                progress_callback=await self._create_crawl_progress_callback("crawling"),
                                link_text_fallbacks=url_to_link_text,  # Pass link text for title fallback
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
            crawl_type = "sitemap"
            await update_crawl_progress(
                50,  # 50% of crawling stage
                "Detected sitemap, parsing URLs...",
                crawl_type=crawl_type
            )

            # If this sitemap was selected by discovery, just return the sitemap itself (single-file mode)
            if request.get("is_discovery_target"):
                logger.info(f"Discovery single-file mode: returning sitemap itself without crawling URLs from {url}")
                crawl_type = "discovery_sitemap"
                # Return the sitemap file as the result
                crawl_results = [{
                    'url': url,
                    'markdown': f"# Sitemap: {url}\n\nThis is a sitemap file discovered and returned in single-file mode.",
                    'title': f"Sitemap - {self.url_handler.extract_display_name(url)}",
                    'crawl_type': crawl_type
                }]
                return crawl_results, crawl_type

            sitemap_urls = self.parse_sitemap(url)

            if sitemap_urls:
                # Filter URLs with robots.txt validation
                if self.robots_checker:
                    original_count = len(sitemap_urls)
                    allowed_sitemap_urls = []
                    for url_to_check in sitemap_urls:
                        if await self._can_fetch_url(url_to_check):
                            allowed_sitemap_urls.append(url_to_check)
                        else:
                            logger.info(f"Skipped (robots.txt): {url_to_check}")
                    sitemap_urls = allowed_sitemap_urls
                    robots_filtered = original_count - len(sitemap_urls)
                    if robots_filtered > 0:
                        logger.info(f"Filtered out {robots_filtered} URLs by robots.txt from sitemap")

                # Update progress before starting batch crawl
                await update_crawl_progress(
                    75,  # 75% of crawling stage
                    f"Starting batch crawl of {len(sitemap_urls)} URLs...",
                    crawl_type=crawl_type
                )

                crawl_results = await self.crawl_batch_with_progress(
                    sitemap_urls,
                    progress_callback=await self._create_crawl_progress_callback("crawling"),
                )

        else:
            # Handle regular webpages with recursive crawling
            crawl_type = "normal"
            await update_crawl_progress(
                50,  # 50% of crawling stage
                f"Starting recursive crawl with max depth {request.get('max_depth', 1)}...",
                crawl_type=crawl_type
            )

            max_depth = request.get("max_depth", 1)
            # Let the strategy handle concurrency from settings
            # This will use CRAWL_MAX_CONCURRENT from database (default: 10)

            crawl_results = await self.crawl_recursive_with_progress(
                [url],
                max_depth=max_depth,
                max_concurrent=None,  # Let strategy use settings
                progress_callback=await self._create_crawl_progress_callback("crawling"),
            )

        return crawl_results, crawl_type

    async def close(self) -> None:
        """
        Close resources and cleanup.

        Note: robots_checker uses a shared HTTP client that is not closed per-instance.
        This method is kept for API compatibility and future cleanup needs.
        """
        pass  # No per-instance cleanup needed currently


# Alias for backward compatibility
CrawlOrchestrationService = CrawlingService
