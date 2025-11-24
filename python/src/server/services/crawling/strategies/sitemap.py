"""
Sitemap Crawling Strategy

Handles crawling of URLs from XML sitemaps.
"""
import asyncio
from collections.abc import Callable
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

import requests

from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class SitemapCrawlStrategy:
    """Strategy for parsing and crawling sitemaps."""

    def parse_sitemap(self, sitemap_url: str, cancellation_check: Callable[[], None] | None = None) -> list[str]:
        """
        Parse a sitemap and extract URLs with comprehensive error handling.
        Automatically composes absolute URLs from relative paths.
        
        Args:
            sitemap_url: URL of the sitemap to parse
            cancellation_check: Optional function to check for cancellation
            
        Returns:
            List of absolute URLs extracted from the sitemap
        """
        urls = []

        try:
            # Check for cancellation before making the request
            if cancellation_check:
                try:
                    cancellation_check()
                except asyncio.CancelledError:
                    logger.info("Sitemap parsing cancelled by user")
                    raise  # Re-raise to let the caller handle progress reporting

            logger.info(f"Parsing sitemap: {sitemap_url}")
            resp = requests.get(sitemap_url, timeout=30)

            if resp.status_code != 200:
                logger.error(f"Failed to fetch sitemap: HTTP {resp.status_code}")
                return urls

            try:
                tree = ElementTree.fromstring(resp.content)
                raw_urls = [loc.text for loc in tree.findall('.//{*}loc') if loc.text]
                
                # Compose absolute URLs from relative paths
                for raw_url in raw_urls:
                    try:
                        raw_url = raw_url.strip()
                        if not raw_url:
                            continue
                        
                        # Check if URL is already absolute
                        parsed = urlparse(raw_url)
                        if parsed.scheme and parsed.netloc:
                            # Already absolute URL
                            urls.append(raw_url)
                        else:
                            # Relative URL - compose with sitemap's base URL
                            absolute_url = urljoin(sitemap_url, raw_url)
                            # Validate composed URL
                            parsed_absolute = urlparse(absolute_url)
                            if parsed_absolute.scheme in ('http', 'https') and parsed_absolute.netloc:
                                urls.append(absolute_url)
                                logger.debug(f"Composed absolute URL: {raw_url} -> {absolute_url}")
                            else:
                                logger.warning(f"Failed to compose valid absolute URL from: {raw_url}")
                    except Exception as e:
                        logger.warning(f"Error processing URL '{raw_url}': {e}")
                        continue
                
                logger.info(f"Successfully extracted {len(urls)} URLs from sitemap (composed {len(raw_urls) - len([u for u in raw_urls if urlparse(u.strip()).scheme])} relative URLs)")

            except ElementTree.ParseError:
                logger.exception(f"Error parsing sitemap XML from {sitemap_url}")
            except Exception:
                logger.exception(f"Unexpected error parsing sitemap from {sitemap_url}")

        except requests.exceptions.RequestException:
            logger.exception(f"Network error fetching sitemap from {sitemap_url}")
        except Exception:
            logger.exception(f"Unexpected error in sitemap parsing for {sitemap_url}")

        return urls
