"""
Sitemap Crawling Strategy

Handles crawling of URLs from XML sitemaps.
"""
import traceback
from typing import List
from xml.etree import ElementTree
import requests

from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class SitemapCrawlStrategy:
    """Strategy for parsing and crawling sitemaps."""

    def parse_sitemap(self, sitemap_url: str) -> List[str]:
        """
        Parse a sitemap and extract URLs with comprehensive error handling.
        
        Args:
            sitemap_url: URL of the sitemap to parse
            
        Returns:
            List of URLs extracted from the sitemap
        """
        urls = []

        try:
            logger.info(f"Parsing sitemap: {sitemap_url}")
            resp = requests.get(sitemap_url, timeout=30)

            if resp.status_code != 200:
                logger.error(f"Failed to fetch sitemap: HTTP {resp.status_code}")
                return urls

            try:
                tree = ElementTree.fromstring(resp.content)
                urls = [loc.text for loc in tree.findall('.//{*}loc') if loc.text]
                logger.info(f"Successfully extracted {len(urls)} URLs from sitemap")

            except ElementTree.ParseError as e:
                logger.error(f"Error parsing sitemap XML: {e}")
            except Exception as e:
                logger.error(f"Unexpected error parsing sitemap: {e}")

        except requests.exceptions.RequestException as e:
            logger.error(f"Network error fetching sitemap: {e}")
        except Exception as e:
            logger.error(f"Unexpected error in sitemap parsing: {e}")
            logger.error(traceback.format_exc())

        return urls
