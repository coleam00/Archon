"""
Domain Filtering Module

This module provides domain filtering utilities for web crawling,
allowing users to control which domains and URL patterns are crawled.
"""

import fnmatch
from urllib.parse import urlparse

from ...config.logfire_config import get_logger
from ...models.crawl_models import CrawlConfig

logger = get_logger(__name__)


class DomainFilter:
    """
    Handles domain and URL pattern filtering for crawl operations.

    Priority order:
    1. Blacklist (excluded_domains) - always blocks
    2. Whitelist (allowed_domains) - must match if specified
    3. Exclude patterns - blocks matching URLs
    4. Include patterns - must match if specified
    """

    def is_url_allowed(self, url: str, base_url: str, config: CrawlConfig | None) -> bool:
        """
        Check if a URL should be crawled based on domain filtering configuration.

        Args:
            url: The URL to check
            base_url: The base URL of the crawl (for resolving relative URLs)
            config: The crawl configuration with filtering rules

        Returns:
            True if the URL should be crawled, False otherwise
        """
        if not config:
            # No filtering configured, allow all URLs
            return True

        try:
            # Parse the URL
            parsed = urlparse(url)

            # Handle relative URLs by using base URL's domain
            if not parsed.netloc:
                base_parsed = urlparse(base_url)
                domain = base_parsed.netloc.lower()
                # Construct full URL for pattern matching
                full_url = f"{base_parsed.scheme}://{base_parsed.netloc}{parsed.path or '/'}"
            else:
                domain = parsed.netloc.lower()
                full_url = url

            # Remove www. prefix for consistent matching
            # Strip leading www. only (not from middle of domain)
            normalized_domain = domain
            if normalized_domain.startswith("www."):
                normalized_domain = normalized_domain[4:]

            # PRIORITY 1: Blacklist always wins
            if config.excluded_domains:
                for excluded in config.excluded_domains:
                    if self._matches_domain(normalized_domain, excluded.lower()):
                        logger.debug(f"URL blocked by excluded domain | url={url} | domain={normalized_domain} | excluded={excluded}")
                        return False

            # PRIORITY 2: If whitelist exists, URL must match
            if config.allowed_domains:
                allowed = False
                for allowed_domain in config.allowed_domains:
                    if self._matches_domain(normalized_domain, allowed_domain.lower()):
                        allowed = True
                        break

                if not allowed:
                    logger.debug(f"URL blocked - not in allowed domains | url={url} | domain={normalized_domain}")
                    return False

            # PRIORITY 3: Check exclude patterns (glob-style)
            if config.exclude_patterns:
                for pattern in config.exclude_patterns:
                    if fnmatch.fnmatch(full_url, pattern):
                        logger.debug(f"URL blocked by exclude pattern | url={url} | pattern={pattern}")
                        return False

            # PRIORITY 4: Check include patterns if specified
            if config.include_patterns:
                matched = False
                for pattern in config.include_patterns:
                    if fnmatch.fnmatch(full_url, pattern):
                        matched = True
                        break

                if not matched:
                    logger.debug(f"URL blocked - doesn't match include patterns | url={url}")
                    return False

            logger.debug(f"URL allowed | url={url} | domain={normalized_domain}")
            return True

        except Exception as e:
            logger.error(f"Error filtering URL | url={url} | error={str(e)}")
            # On error, be conservative and block the URL
            return False

    def _matches_domain(self, domain: str, pattern: str) -> bool:
        """
        Check if a domain matches a pattern.

        Supports:
        - Exact matches: example.com matches example.com
        - Subdomain wildcards: *.example.com matches sub.example.com
        - Subdomain matching: sub.example.com matches sub.example.com and subsub.sub.example.com

        Args:
            domain: The domain to check (already normalized and lowercase)
            pattern: The pattern to match against

        Returns:
            True if the domain matches the pattern
        """
        # Normalize inputs
        domain = (domain or "").lower()
        pattern = (pattern or "").lower()

        # Remove any remaining protocol or path from pattern
        pattern = pattern.replace("http://", "").replace("https://", "").split("/")[0]
        # Drop port if present on pattern (e.g., example.com:8080)
        pattern = pattern.split(":", 1)[0]
        # Strip leading www. only
        if pattern.startswith("www."):
            pattern = pattern[4:]

        # Drop port from domain defensively
        domain = domain.split(":", 1)[0]

        # Exact match
        if domain == pattern:
            return True

        # Wildcard subdomain match (*.example.com)
        if pattern.startswith("*."):
            base_pattern = pattern[2:]  # Remove *.
            # Check if domain ends with the base pattern and has a subdomain
            if domain.endswith(base_pattern):
                # Make sure it's a proper subdomain, not just containing the pattern
                prefix = domain[:-len(base_pattern)]
                if prefix and prefix.endswith("."):
                    return True

        # Subdomain match (allow any subdomain of the pattern)
        # e.g., pattern=example.com should match sub.example.com
        if domain.endswith(f".{pattern}"):
            return True

        return False

    def get_domains_from_urls(self, urls: list[str]) -> set[str]:
        """
        Extract unique domains from a list of URLs.

        Args:
            urls: List of URLs to extract domains from

        Returns:
            Set of unique domains (normalized and lowercase)
        """
        domains = set()
        for url in urls:
            try:
                parsed = urlparse(url)
                if parsed.netloc:
                    domain = parsed.netloc.lower().replace("www.", "")
                    domains.add(domain)
            except Exception as e:
                logger.debug(f"Could not extract domain from URL | url={url} | error={str(e)}")
                continue

        return domains
