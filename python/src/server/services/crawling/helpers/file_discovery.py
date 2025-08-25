"""
File Discovery Service

Handles automatic discovery of llms.txt, sitemap.xml, and related files
using database-driven configuration with fallback defaults.
"""

import asyncio
import json
import re
from urllib.parse import urljoin

import aiohttp

from ....config.logfire_config import get_logger
from ...credential_service import credential_service

logger = get_logger(__name__)


class FileDiscoveryService:
    """Service for discovering files on websites automatically."""

    def __init__(self):
        """Initialize the file discovery service."""
        self.timeout = aiohttp.ClientTimeout(total=10)  # 10 second timeout for discovery

        # Hardcoded fallback defaults if database access fails
        self._fallback_defaults = {
            "CRAWL_DISCOVERY_LLM_FILES": ["llms-full.txt", "llms-ctx.txt", "llms.md", "llms.txt"],
            "CRAWL_DISCOVERY_SITEMAP_FILES": ["sitemap.xml", "sitemap_index.xml", "sitemap-*.xml"],
            "CRAWL_DISCOVERY_METADATA_FILES": ["robots.txt", ".well-known/security.txt", ".well-known/humans.txt", "humans.txt", "security.txt"]
        }

    async def _get_file_list_from_db(self, setting_key: str) -> list[str]:
        """
        Get file list from database settings with fallback to hardcoded defaults.
        
        Args:
            setting_key: The database setting key
            
        Returns:
            List of files to discover
        """
        try:
            # Get setting from database via credential service
            raw_value = await credential_service.get_credential(setting_key, decrypt=False)

            if raw_value is None:
                logger.info(f"No database setting found for {setting_key}, using fallback defaults")
                return self._fallback_defaults.get(setting_key, [])

            # Parse JSON string to list
            if isinstance(raw_value, str):
                file_list = json.loads(raw_value)
            elif isinstance(raw_value, dict) and 'value' in raw_value:
                file_list = json.loads(raw_value['value'])
            else:
                file_list = raw_value

            if not isinstance(file_list, list):
                logger.warning(f"Setting {setting_key} is not a list, using fallback defaults")
                return self._fallback_defaults.get(setting_key, [])

            logger.info(f"Loaded {len(file_list)} files from database setting {setting_key}")
            return file_list

        except (json.JSONDecodeError, TypeError, KeyError) as e:
            logger.error(f"Error parsing database setting {setting_key}: {e}, using fallback defaults")
            return self._fallback_defaults.get(setting_key, [])
        except Exception as e:
            logger.error(f"Unexpected error getting database setting {setting_key}: {e}, using fallback defaults")
            return self._fallback_defaults.get(setting_key, [])

    async def _check_file_exists(self, session: aiohttp.ClientSession, url: str) -> bool:
        """
        Check if a file exists at the given URL using HEAD request.
        
        Args:
            session: HTTP session
            url: URL to check
            
        Returns:
            True if file exists and is accessible
        """
        try:
            async with session.head(url, timeout=self.timeout) as response:
                # Consider 2xx status codes as successful
                return 200 <= response.status < 300
        except Exception as e:
            logger.debug(f"File check failed for {url}: {e}")
            return False

    async def discover_robots_sitemaps(self, base_url: str) -> list[str]:
        """
        Extract sitemap URLs from robots.txt file.
        
        Args:
            base_url: Base URL of the website
            
        Returns:
            List of sitemap URLs found in robots.txt
        """
        sitemaps = []
        robots_url = urljoin(base_url, "/robots.txt")

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(robots_url, timeout=self.timeout) as response:
                    if response.status == 200:
                        robots_content = await response.text()

                        # Parse all Sitemap directives (case-insensitive)
                        sitemap_pattern = re.compile(r'^sitemap:\s*(.+)$', re.IGNORECASE | re.MULTILINE)
                        matches = sitemap_pattern.findall(robots_content)

                        for match in matches:
                            sitemap_url = match.strip()
                            # Convert relative URLs to absolute
                            if not sitemap_url.startswith(('http://', 'https://')):
                                sitemap_url = urljoin(base_url, sitemap_url)
                            sitemaps.append(sitemap_url)

                        logger.info(f"Found {len(sitemaps)} sitemaps in robots.txt: {sitemaps}")
                    else:
                        logger.debug(f"robots.txt not accessible at {robots_url} (status: {response.status})")

        except Exception as e:
            logger.debug(f"Error fetching robots.txt from {robots_url}: {e}")

        return sitemaps

    async def discover_llm_files(self, base_url: str) -> list[str]:
        """
        Discover LLM-specific files using database-configured file lists.
        Returns the highest priority LLM file found, not all of them.
        
        Args:
            base_url: Base URL of the website
            
        Returns:
            List containing the single best LLM file URL, or empty list if none found
        """
        discovered_files = []
        llm_files = await self._get_file_list_from_db("CRAWL_DISCOVERY_LLM_FILES")

        try:
            async with aiohttp.ClientSession() as session:
                # Check each LLM file pattern in priority order (first in list = highest priority)
                for file_pattern in llm_files:
                    # Simple patterns without wildcards
                    if "*" not in file_pattern:
                        file_url = urljoin(base_url, f"/{file_pattern.lstrip('/')}")
                        if await self._check_file_exists(session, file_url):
                            logger.info(f"Discovered LLM file: {file_url}")
                            # Return immediately with the highest priority file found
                            return [file_url]

        except Exception as e:
            logger.error(f"Error during LLM file discovery for {base_url}: {e}")

        return discovered_files

    async def discover_sitemap_files(self, base_url: str) -> list[str]:
        """
        Discover sitemap files using database-configured patterns with wildcard support.
        
        Args:
            base_url: Base URL of the website
            
        Returns:
            List of discovered sitemap URLs
        """
        discovered_files = []
        sitemap_files = await self._get_file_list_from_db("CRAWL_DISCOVERY_SITEMAP_FILES")

        try:
            async with aiohttp.ClientSession() as session:
                for file_pattern in sitemap_files:
                    if "*" in file_pattern:
                        # Handle wildcard patterns (simplified for now)
                        # For "sitemap-*.xml", try common numbered patterns
                        if file_pattern == "sitemap-*.xml":
                            for i in range(1, 6):  # Try sitemap-1.xml to sitemap-5.xml
                                file_url = urljoin(base_url, f"/sitemap-{i}.xml")
                                if await self._check_file_exists(session, file_url):
                                    discovered_files.append(file_url)
                                    logger.info(f"Discovered numbered sitemap: {file_url}")
                    else:
                        # Simple file patterns
                        file_url = urljoin(base_url, f"/{file_pattern.lstrip('/')}")
                        if await self._check_file_exists(session, file_url):
                            discovered_files.append(file_url)
                            logger.info(f"Discovered sitemap file: {file_url}")

        except Exception as e:
            logger.error(f"Error during sitemap discovery for {base_url}: {e}")

        return discovered_files

    async def discover_metadata_files(self, base_url: str) -> list[str]:
        """
        Discover metadata files using database-configured lists.
        
        Args:
            base_url: Base URL of the website
            
        Returns:
            List of discovered metadata file URLs
        """
        discovered_files = []
        metadata_files = await self._get_file_list_from_db("CRAWL_DISCOVERY_METADATA_FILES")

        try:
            async with aiohttp.ClientSession() as session:
                for file_pattern in metadata_files:
                    file_url = urljoin(base_url, f"/{file_pattern.lstrip('/')}")
                    if await self._check_file_exists(session, file_url):
                        discovered_files.append(file_url)
                        logger.info(f"Discovered metadata file: {file_url}")

        except Exception as e:
            logger.error(f"Error during metadata file discovery for {base_url}: {e}")

        return discovered_files

    async def discover_all_files(self, base_url: str) -> dict[str, list[str]]:
        """
        Perform comprehensive file discovery using all available methods.
        
        Args:
            base_url: Base URL of the website
            
        Returns:
            Dictionary with discovery results categorized by type
        """
        logger.info(f"Starting file discovery for {base_url}")

        try:
            # Run all discovery methods concurrently for performance
            results = await asyncio.gather(
                self.discover_robots_sitemaps(base_url),
                self.discover_llm_files(base_url),
                self.discover_sitemap_files(base_url),
                self.discover_metadata_files(base_url),
                return_exceptions=True
            )

            # Handle any exceptions from individual discovery methods
            robots_sitemaps = results[0] if not isinstance(results[0], Exception) else []
            llm_files = results[1] if not isinstance(results[1], Exception) else []
            sitemap_files = results[2] if not isinstance(results[2], Exception) else []
            metadata_files = results[3] if not isinstance(results[3], Exception) else []

            discovery_result = {
                "robots_sitemaps": robots_sitemaps,
                "llm_files": llm_files,
                "sitemap_files": sitemap_files,
                "metadata_files": metadata_files
            }

            total_discovered = sum(len(files) for files in discovery_result.values())
            logger.info(f"File discovery completed for {base_url}: {total_discovered} files discovered")

            return discovery_result

        except Exception as e:
            logger.error(f"Unexpected error during file discovery for {base_url}: {e}")
            # Return empty results on failure
            return {
                "robots_sitemaps": [],
                "llm_files": [],
                "sitemap_files": [],
                "metadata_files": []
            }
