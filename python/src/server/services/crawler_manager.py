"""
Crawler Manager Service

Handles initialization and management of the Crawl4AI crawler instance.
This avoids circular imports by providing a service-level access to the crawler.
"""

import os
from typing import Optional

try:
    from crawl4ai import AsyncWebCrawler, BrowserConfig
except ImportError:
    AsyncWebCrawler = None
    BrowserConfig = None

from ..config.config import get_crawler_config
from ..config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info

logger = get_logger(__name__)


class CrawlerManager:
    """Manages the global crawler instance."""

    _instance: Optional["CrawlerManager"] = None
    _crawler: AsyncWebCrawler | None = None
    _initialized: bool = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def get_crawler(self) -> AsyncWebCrawler:
        """Get or create the crawler instance."""
        if not self._initialized:
            await self.initialize()
        return self._crawler

    async def initialize(self):
        """Initialize the crawler if not already initialized."""
        if self._initialized:
            safe_logfire_info("Crawler already initialized, skipping")
            return

        try:
            safe_logfire_info("Initializing Crawl4AI crawler...")
            logger.info("=== CRAWLER INITIALIZATION START ===")

            # Check if crawl4ai is available
            if not AsyncWebCrawler or not BrowserConfig:
                logger.error("ERROR: crawl4ai not available")
                logger.error(f"AsyncWebCrawler: {AsyncWebCrawler}")
                logger.error(f"BrowserConfig: {BrowserConfig}")
                raise ImportError("crawl4ai is not installed or available")

            # Check for Docker environment
            in_docker = os.path.exists("/.dockerenv") or os.getenv("DOCKER_CONTAINER", False)

            # Initialize browser config - same for Docker and local
            # crawl4ai/Playwright will handle Docker-specific settings internally
            crawler_config = get_crawler_config()
            browser_config = BrowserConfig(
                headless=True,
                verbose=False,
                # Set viewport for proper rendering
                viewport_width=1920,
                viewport_height=1080,
                # Use proper bot identification
                user_agent=crawler_config["user_agent"],
                # Set browser type
                browser_type="chromium",
                # Extra args for Chromium - optimized for speed
                extra_args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-web-security",
                    "--disable-features=IsolateOrigins,site-per-process",
                    # Performance optimizations
                    "--disable-images",  # Skip image loading for faster page loads
                    "--disable-gpu",
                    "--disable-extensions",
                    "--disable-plugins",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                    "--disable-features=TranslateUI",
                    "--disable-ipc-flooding-protection",
                    # Additional speed optimizations
                    "--aggressive-cache-discard",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--metrics-recording-only",
                    "--no-first-run",
                    "--disable-popup-blocking",
                    "--disable-prompt-on-repost",
                    "--disable-domain-reliability",
                    "--disable-component-update",
                ],
            )

            safe_logfire_info(f"Creating AsyncWebCrawler with config | in_docker={in_docker}")

            # Initialize crawler with the correct parameter name
            self._crawler = AsyncWebCrawler(config=browser_config)
            safe_logfire_info("AsyncWebCrawler instance created, entering context...")
            await self._crawler.__aenter__()
            self._initialized = True
            safe_logfire_info(f"Crawler entered context successfully | crawler={self._crawler}")

            safe_logfire_info("✅ Crawler initialized successfully")
            logger.info("=== CRAWLER INITIALIZATION SUCCESS ===")
            logger.info(f"Crawler instance: {self._crawler}")
            logger.info(f"Initialized: {self._initialized}")

        except Exception as e:
            safe_logfire_error(f"Failed to initialize crawler: {e}")
            import traceback

            tb = traceback.format_exc()
            safe_logfire_error(f"Crawler initialization traceback: {tb}")
            # Log error details
            logger.error("=== CRAWLER INITIALIZATION ERROR ===")
            logger.error(f"Error: {e}")
            logger.error(f"Traceback:\n{tb}")
            logger.error("=== END CRAWLER ERROR ===")
            # Don't mark as initialized if the crawler is None
            # This allows retries and proper error propagation
            self._crawler = None
            self._initialized = False
            raise Exception(f"Failed to initialize Crawl4AI crawler: {e}")

    async def cleanup(self):
        """Clean up the crawler resources."""
        if self._crawler and self._initialized:
            try:
                await self._crawler.__aexit__(None, None, None)
                safe_logfire_info("Crawler cleaned up successfully")
            except Exception as e:
                safe_logfire_error(f"Error cleaning up crawler: {e}")
            finally:
                self._crawler = None
                self._initialized = False


# Global instance
_crawler_manager = CrawlerManager()


async def get_crawler() -> AsyncWebCrawler | None:
    """Get the global crawler instance."""
    global _crawler_manager
    crawler = await _crawler_manager.get_crawler()
    if crawler is None:
        logger.warning("get_crawler() returning None")
        logger.warning(f"_crawler_manager: {_crawler_manager}")
        logger.warning(
            f"_crawler_manager._crawler: {_crawler_manager._crawler if _crawler_manager else 'N/A'}"
        )
        logger.warning(
            f"_crawler_manager._initialized: {_crawler_manager._initialized if _crawler_manager else 'N/A'}"
        )
    return crawler


async def initialize_crawler():
    """Initialize the global crawler."""
    await _crawler_manager.initialize()


async def cleanup_crawler():
    """Clean up the global crawler."""
    await _crawler_manager.cleanup()
