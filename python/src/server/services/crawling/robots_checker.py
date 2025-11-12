"""
robots.txt Checker Service

This module provides robots.txt compliance checking for the Archon web crawler.
It fetches, parses, caches, and enforces robots.txt rules including:
- Allow/Disallow rules with wildcard support
- Crawl-delay directives
- Per-domain caching with 24-hour TTL
- Thread-safe concurrent access

Uses Protego library for fast, spec-compliant robots.txt parsing.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Optional
from urllib.parse import urlparse

import httpx
from protego import Protego

logger = logging.getLogger(__name__)

# Shared HTTP client for all RobotsChecker instances to prevent connection leaks
# This client is created once and reused across all crawler instances
_shared_http_client: Optional[httpx.AsyncClient] = None


def _get_shared_http_client() -> httpx.AsyncClient:
    """Get or create shared HTTP client for robots.txt fetching."""
    global _shared_http_client
    if _shared_http_client is None:
        _shared_http_client = httpx.AsyncClient(timeout=10.0, follow_redirects=True)
    return _shared_http_client


@dataclass
class CachedRobotsEntry:
    """Cache entry for robots.txt parser with TTL tracking."""

    parser: Protego
    expires_at: datetime


class RobotsChecker:
    """
    Thread-safe robots.txt checker with caching and crawl delay enforcement.

    This service:
    - Fetches and caches robots.txt for each domain (24-hour TTL)
    - Validates URLs against robots.txt Allow/Disallow rules
    - Enforces per-domain crawl delays
    - Handles errors gracefully per RFC 9309 (404 = allow, 5xx = disallow)

    Attributes:
        _config: Crawler configuration dict
        _cache: TTLCache for storing parsed robots.txt by domain
        _locks: Per-domain locks for thread-safe access
        _last_crawl_time: Tracks last crawl timestamp per domain for delay enforcement
        _client: Shared httpx.AsyncClient for fetching robots.txt
    """

    def __init__(self, config: dict):
        """
        Initialize the RobotsChecker.

        Args:
            config: Crawler configuration dict with keys:
                - user_agent: User-Agent string for requests
                - robots_cache_size: Maximum domains to cache (default: 1000)
                - robots_cache_ttl: Cache TTL in seconds (default: 86400 = 24h)
                - default_crawl_delay: Default delay between requests (default: 10.0)
        """
        self._config = config

        # Manual TTL cache for parsed robots.txt (domain -> CachedRobotsEntry)
        self._cache: Dict[str, CachedRobotsEntry] = {}
        self._cache_ttl = timedelta(seconds=config.get("robots_cache_ttl", 86400))  # 24 hours
        self._max_cache_size = config.get("robots_cache_size", 1000)

        # Per-domain locks for thread-safe cache access
        self._locks: Dict[str, asyncio.Lock] = {}

        # Separate locks for delay tracking to avoid deadlock
        self._delay_locks: Dict[str, asyncio.Lock] = {}

        # Track last crawl time per domain for delay enforcement
        self._last_crawl_time: Dict[str, float] = {}

        # Use shared HTTP client for fetching robots.txt (prevents connection leaks)
        self._client = _get_shared_http_client()

    def _get_domain_key(self, url: str) -> str:
        """
        Extract domain key from URL for caching.

        Args:
            url: Full URL to extract domain from

        Returns:
            Domain key in format "scheme://netloc" (e.g., "https://example.com")

        Raises:
            ValueError: If URL is malformed or missing scheme/netloc
        """
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"Invalid URL - missing scheme or netloc: {url}")
        return f"{parsed.scheme}://{parsed.netloc}"

    def _get_domain_lock(self, domain: str) -> asyncio.Lock:
        """
        Get or create asyncio.Lock for domain cache access.

        Thread-safe lock creation for concurrent access control.

        Args:
            domain: Domain key to get lock for

        Returns:
            asyncio.Lock for the specified domain
        """
        if domain not in self._locks:
            self._locks[domain] = asyncio.Lock()
        return self._locks[domain]

    def _get_delay_lock(self, domain: str) -> asyncio.Lock:
        """
        Get or create asyncio.Lock for domain delay tracking.

        Separate from cache locks to avoid deadlock when wait_if_needed
        calls get_crawl_delay which calls get_robots_parser.

        Args:
            domain: Domain key to get lock for

        Returns:
            asyncio.Lock for delay tracking
        """
        if domain not in self._delay_locks:
            self._delay_locks[domain] = asyncio.Lock()
        return self._delay_locks[domain]

    async def can_fetch(self, url: str) -> bool:
        """
        Check if URL can be fetched according to robots.txt.

        This is the main entry point for robots.txt validation.

        Args:
            url: URL to check

        Returns:
            True if crawling is allowed, False if disallowed

        Raises:
            No exceptions raised - errors result in "allow" (fail open)
        """
        try:
            domain = self._get_domain_key(url)
            parser = await self.get_robots_parser(domain)

            # Use configured user agent
            user_agent = self._config.get("user_agent", "*")

            # Protego.can_fetch expects (url, user_agent) - note reversed order from urllib
            allowed = parser.can_fetch(url, user_agent)

            if not allowed:
                logger.info(f"URL blocked by robots.txt: {url}")

            return allowed

        except Exception as e:
            # Fail open - allow crawling on error
            logger.warning(f"Error checking robots.txt for {url}: {e}, allowing crawl")
            return True

    async def get_robots_parser(self, domain: str) -> Protego:
        """
        Get cached or fetch robots.txt parser for domain.

        Implements manual TTL caching with thread-safe access.
        Cache key is domain only (scheme + netloc).

        Args:
            domain: Domain key (e.g., "https://example.com")

        Returns:
            Protego parser instance for the domain

        Raises:
            No exceptions raised - errors result in permissive parser
        """
        # Get or create lock for this domain
        async with self._get_domain_lock(domain):
            # Check cache first
            if domain in self._cache:
                entry = self._cache[domain]
                # Check if entry is still valid
                if datetime.now() < entry.expires_at:
                    logger.debug(f"robots.txt cache hit for {domain}")
                    return entry.parser
                else:
                    # Expired - remove from cache
                    logger.debug(f"robots.txt cache expired for {domain}, refetching...")
                    del self._cache[domain]

            # Cache miss or expired - fetch robots.txt
            robots_content = await self._fetch_robots_txt(domain)
            parser = Protego.parse(robots_content)

            # Evict oldest entry if cache is full
            if len(self._cache) >= self._max_cache_size:
                oldest_domain = min(self._cache.keys(), key=lambda k: self._cache[k].expires_at)
                del self._cache[oldest_domain]
                logger.debug(f"robots.txt cache full, evicted oldest entry: {oldest_domain}")

            # Store in cache
            self._cache[domain] = CachedRobotsEntry(
                parser=parser, expires_at=datetime.now() + self._cache_ttl
            )

            # Log one clear message that robots.txt is being respected
            has_rules = bool(robots_content.strip())
            if has_rules:
                logger.info(f"Respecting robots.txt for {domain} (cached for 24h)")
            else:
                logger.debug(f"No robots.txt found for {domain} - allowing all URLs")

            return parser

    async def _fetch_robots_txt(self, domain: str) -> str:
        """
        Fetch robots.txt content with proper error handling per RFC 9309.

        Error handling:
        - 404: Returns empty string (allow all)
        - 5xx: Returns disallow-all rules (conservative)
        - Timeout: Returns disallow-all rules (conservative)
        - Other errors: Returns empty string (fail open)

        Args:
            domain: Domain to fetch robots.txt from

        Returns:
            robots.txt content as string
        """
        robots_url = f"{domain}/robots.txt"

        try:
            # Use configured user agent for robots.txt request
            headers = {"User-Agent": self._config.get("user_agent", "Archon-Crawler/1.0")}

            response = await self._client.get(robots_url, headers=headers)

            if response.status_code == 404:
                # No robots.txt = allow all (logged in get_robots_parser)
                return ""

            elif response.status_code >= 500:
                # Server error = disallow all (conservative per RFC 9309)
                logger.warning(
                    f"Server error fetching robots.txt for {domain} (HTTP {response.status_code}), disallowing all"
                )
                return "User-agent: *\nDisallow: /"

            elif response.status_code == 200:
                # Success - return content (logged in get_robots_parser)
                return response.text

            else:
                # Other status codes (3xx after redirect handling, 4xx) - allow all
                logger.debug(
                    f"Unexpected status fetching robots.txt for {domain} (HTTP {response.status_code}), allowing all"
                )
                return ""

        except httpx.TimeoutException:
            # Timeout = disallow all (conservative)
            logger.warning(f"Timeout fetching robots.txt for {domain}, disallowing all")
            return "User-agent: *\nDisallow: /"

        except Exception as e:
            # Other errors = allow all (fail open)
            logger.error(f"Error fetching robots.txt for {domain}: {e}, allowing all")
            return ""

    async def get_crawl_delay(self, domain: str) -> float:
        """
        Get crawl delay for domain from robots.txt or default.

        Extracts Crawl-delay directive from robots.txt. Falls back to
        configured default if not specified.

        Args:
            domain: Domain to get crawl delay for

        Returns:
            Crawl delay in seconds (float)
        """
        try:
            parser = await self.get_robots_parser(domain)
            user_agent = self._config.get("user_agent", "*")

            # Get crawl delay from robots.txt
            delay = parser.crawl_delay(user_agent)

            if delay is not None:
                logger.debug(f"Crawl delay for {domain}: {delay}s (from robots.txt)")
                return float(delay)

            # Fall back to default
            default_delay = self._config.get("default_crawl_delay", 10.0)
            logger.debug(f"Crawl delay for {domain}: {default_delay}s (default)")
            return default_delay

        except Exception as e:
            # On error, use default delay
            default_delay = self._config.get("default_crawl_delay", 10.0)
            logger.warning(f"Error getting crawl delay for {domain}: {e}, using default {default_delay}s")
            return default_delay

    async def wait_if_needed(self, domain: str) -> None:
        """
        Wait for crawl delay if needed before next request to domain.

        Enforces minimum delay between requests to the same domain.
        Uses asyncio.sleep() for non-blocking waits.

        Args:
            domain: Domain key (e.g., "https://example.com") to check/enforce delay for

        Returns:
            None (blocks until delay is satisfied)
        """
        async with self._get_delay_lock(domain):
            # Get required delay
            delay = await self.get_crawl_delay(domain)

            # If delay is 0 or negative, no wait needed
            if delay <= 0:
                return

            # Check time since last crawl
            last_time = self._last_crawl_time.get(domain, 0)
            elapsed = time.time() - last_time

            # Wait if needed
            if elapsed < delay:
                wait_time = delay - elapsed
                logger.debug(f"Crawl delay: waiting {wait_time:.1f}s for {domain}")
                await asyncio.sleep(wait_time)

            # Update last crawl time
            self._last_crawl_time[domain] = time.time()

    async def wait_if_needed_for_url(self, url: str) -> None:
        """
        Wait for crawl delay if needed before next request to URL.

        Convenience method that extracts domain from URL and enforces delay.

        Args:
            url: Full URL to check/enforce delay for

        Returns:
            None (blocks until delay is satisfied)
        """
        domain = self._get_domain_key(url)
        await self.wait_if_needed(domain)

    async def close(self) -> None:
        """
        Cleanup resources.

        Note: HTTP client is shared across all instances and should not be closed per-instance.
        This method is kept for API compatibility but doesn't close the shared client.
        """
        pass  # Shared client is not closed per-instance

    def clear_cache(self) -> None:
        """
        Clear all cached robots.txt parsers.

        Useful for testing or forcing refresh.
        """
        self._cache.clear()
        self._last_crawl_time.clear()
        logger.info("Robots.txt cache cleared")
