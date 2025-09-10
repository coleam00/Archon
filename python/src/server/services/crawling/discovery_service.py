"""
Discovery Service for Automatic File Detection

Handles automatic discovery and parsing of llms.txt, sitemap.xml, and related files
to enhance crawling capabilities with priority-based discovery methods.
"""

from urllib.parse import urljoin

import requests

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class DiscoveryService:
    """Service for discovering related files automatically during crawls."""

    # Global priority order - select ONE best file from all categories
    # All these files contain similar AI/crawling guidance content
    DISCOVERY_PRIORITY = [
        # LLMs files (highest priority - most comprehensive AI guidance)
        "llms-full.txt",
        "llms.txt", 
        "llms.md",
        "llms.mdx",
        "llms.markdown",
        
        # Sitemap files (structural crawling guidance)  
        "sitemap_index.xml",
        "sitemap-index.xml",
        "sitemap.xml",
        
        # Robots file (basic crawling rules)
        "robots.txt",
        
        # Well-known variants (alternative locations)
        ".well-known/ai.txt",
        ".well-known/llms.txt", 
        ".well-known/sitemap.xml"
    ]

    def discover_files(self, base_url: str) -> str | None:
        """
        Main discovery orchestrator - selects ONE best file across all categories.
        All files contain similar AI/crawling guidance, so we only need the best one.
        
        Args:
            base_url: Base URL to discover files for
            
        Returns:
            Single best URL found, or None if no files discovered
        """
        try:
            logger.info(f"Starting single-file discovery for {base_url}")

            # First check robots.txt for explicit sitemap declarations (special case)
            robots_sitemaps = self._parse_robots_txt(base_url)
            if robots_sitemaps:
                best_file = robots_sitemaps[0]  # Use first sitemap from robots.txt
                logger.info(f"Discovery found best file from robots.txt: {best_file}")
                return best_file

            # Check files in global priority order
            for filename in self.DISCOVERY_PRIORITY:
                # Try root location first
                file_url = urljoin(base_url, f"/{filename}")
                if self._check_url_exists(file_url):
                    logger.info(f"Discovery found best file: {file_url}")
                    return file_url
                
                # For llms files, also try common subdirectories
                if filename.startswith('llms'):
                    for subdir in ["static", "public", "docs", "assets", "doc", "api"]:
                        subdir_url = urljoin(base_url, f"/{subdir}/{filename}")
                        if self._check_url_exists(subdir_url):
                            logger.info(f"Discovery found best file in subdirectory: {subdir_url}")
                            return subdir_url
                
                # For sitemap files, also try common subdirectories
                if filename.endswith('.xml') and not filename.startswith('.well-known'):
                    for subdir in ["sitemaps", "sitemap", "xml", "feed"]:
                        subdir_url = urljoin(base_url, f"/{subdir}/{filename}")
                        if self._check_url_exists(subdir_url):
                            logger.info(f"Discovery found best file in subdirectory: {subdir_url}")
                            return subdir_url

            # Check HTML meta tags for sitemap references as final fallback
            html_sitemaps = self._parse_html_meta_tags(base_url)
            if html_sitemaps:
                best_file = html_sitemaps[0]
                logger.info(f"Discovery found best file from HTML meta tags: {best_file}")
                return best_file

            logger.info(f"Discovery completed for {base_url}: no files found")
            return None

        except Exception:
            logger.exception(f"Unexpected error during discovery for {base_url}")
            return None

    def _discover_best_sitemap(self, base_url: str) -> str | None:
        """
        Discover the best available sitemap using priority-based selection.
        
        Priority order:
        1. Sitemaps from robots.txt (highest priority - explicitly declared)
        2. Standard locations (sitemap_index.xml > sitemap-index.xml > sitemap.xml)
        3. Common subdirectory variations
        4. HTML meta tag references
        5. .well-known directory
        """
        try:
            # Priority 1: Check robots.txt for sitemap declarations
            robots_sitemaps = self._parse_robots_txt(base_url)
            if robots_sitemaps:
                return robots_sitemaps[0]  # Use first sitemap from robots.txt

            # Priority 2: Check standard locations in priority order
            for filename in self.DISCOVERY_TARGETS["sitemap_files"]:
                sitemap_url = urljoin(base_url, f"/{filename}")
                if self._check_url_exists(sitemap_url):
                    return sitemap_url

            # Priority 3: Check common subdirectory variations
            subdirs = ["sitemaps", "sitemap", "xml", "feed"]
            for subdir in subdirs:
                for filename in self.DISCOVERY_TARGETS["sitemap_files"]:
                    sitemap_url = urljoin(base_url, f"/{subdir}/{filename}")
                    if self._check_url_exists(sitemap_url):
                        return sitemap_url

            # Priority 4: Check HTML meta tag references
            html_sitemaps = self._parse_html_meta_tags(base_url)
            if html_sitemaps:
                return html_sitemaps[0]  # Use first sitemap from HTML

            # Priority 5: Check .well-known directory
            well_known_sitemap = urljoin(base_url, "/.well-known/sitemap.xml")
            if self._check_url_exists(well_known_sitemap):
                return well_known_sitemap

        except Exception:
            logger.exception(f"Error discovering best sitemap for {base_url}")

        return None

    def _discover_best_llms_file(self, base_url: str) -> str | None:
        """
        Discover the best available llms file using priority-based selection.
        
        Priority order:
        1. Standard locations (llms-full.txt > llms.txt > llms.md > llms.mdx > llms.markdown)
        2. Common subdirectory variations (static, public, docs, assets)
        3. .well-known directory variants
        """
        try:
            # Priority 1: Check standard root locations in priority order
            for filename in self.DISCOVERY_TARGETS["llms_files"]:
                llms_url = urljoin(base_url, f"/{filename}")
                if self._check_url_exists(llms_url):
                    return llms_url

            # Priority 2: Check common subdirectory variations
            subdirs = ["static", "public", "docs", "assets", "doc", "api"]
            for subdir in subdirs:
                for filename in self.DISCOVERY_TARGETS["llms_files"]:
                    llms_url = urljoin(base_url, f"/{subdir}/{filename}")
                    if self._check_url_exists(llms_url):
                        return llms_url

            # Priority 3: Check .well-known directory variants
            for well_known_file in [".well-known/ai.txt", ".well-known/llms.txt"]:
                well_known_url = urljoin(base_url, f"/{well_known_file}")
                if self._check_url_exists(well_known_url):
                    return well_known_url

        except Exception:
            logger.exception(f"Error discovering best llms file for {base_url}")

        return None

    def _discover_robots_file(self, base_url: str) -> str | None:
        """
        Discover robots.txt file (always single file at root).
        """
        try:
            robots_url = urljoin(base_url, "/robots.txt")
            if self._check_url_exists(robots_url):
                return robots_url
        except Exception:
            logger.exception(f"Error discovering robots file for {base_url}")
        
        return None

    def _check_url_exists(self, url: str) -> bool:
        """
        Check if a URL exists and returns a successful response.
        """
        try:
            resp = requests.get(url, timeout=5, allow_redirects=True)
            success = resp.status_code == 200
            logger.debug(f"URL check: {url} -> {resp.status_code} ({'exists' if success else 'not found'})")
            return success
        except Exception as e:
            logger.debug(f"URL check failed: {url} -> {e}")
            return False

    def _parse_robots_txt(self, base_url: str) -> list[str]:
        """
        Extract sitemap URLs from robots.txt.
        
        Args:
            base_url: Base URL to check robots.txt for
            
        Returns:
            List of sitemap URLs found in robots.txt
        """
        sitemaps: list[str] = []

        try:
            robots_url = urljoin(base_url, "/robots.txt")
            logger.info(f"Checking robots.txt at {robots_url}")

            resp = requests.get(robots_url, timeout=30)

            if resp.status_code != 200:
                logger.info(f"No robots.txt found: HTTP {resp.status_code}")
                return sitemaps

            # Parse robots.txt content for sitemap directives
            for line in resp.text.splitlines():
                line = line.strip().lower()
                if line.startswith("sitemap:"):
                    sitemap_url = line.split(":", 1)[1].strip()
                    # Validate URL format before adding
                    if sitemap_url and (sitemap_url.startswith('http://') or sitemap_url.startswith('https://')):
                        sitemaps.append(sitemap_url)
                        logger.info(f"Found sitemap in robots.txt: {sitemap_url}")

        except requests.exceptions.RequestException:
            logger.exception(f"Network error fetching robots.txt from {base_url}")
        except Exception:
            logger.exception(f"Unexpected error parsing robots.txt from {base_url}")

        return sitemaps

    def _check_standard_patterns(self, base_url: str) -> dict[str, list[str]]:
        """
        Check common file locations for discovery targets.
        
        Args:
            base_url: Base URL to check standard locations for
            
        Returns:
            Dictionary with file types and discovered URLs
        """
        discovered: dict[str, list[str]] = {
            "sitemaps": [],
            "llms_files": [],
            "robots_files": []
        }

        try:
            # Check all discovery targets at standard locations
            all_targets = []
            for target_type, files in self.DISCOVERY_TARGETS.items():
                if target_type != "well_known_files":  # Skip well-known, handled separately
                    for filename in files:
                        all_targets.append((target_type, filename))

            for target_type, filename in all_targets:
                try:
                    file_url = urljoin(base_url, f"/{filename}")
                    resp = requests.get(file_url, timeout=30, allow_redirects=True)

                    if resp.status_code == 200:
                        # Map target type to discovery category
                        if target_type == "sitemap_files":
                            discovered["sitemaps"].append(file_url)
                        elif target_type == "llms_files":
                            discovered["llms_files"].append(file_url)
                        elif target_type == "robots_files":
                            discovered["robots_files"].append(file_url)

                        logger.info(f"Found {target_type} file: {file_url}")

                except requests.exceptions.RequestException:
                    logger.debug(f"File not found or network error: {filename}")
                except Exception:
                    logger.exception(f"Unexpected error checking {filename}")

        except Exception:
            logger.exception(f"Unexpected error in standard pattern checking for {base_url}")

        return discovered

    def _parse_html_meta_tags(self, base_url: str) -> list[str]:
        """
        Extract sitemap references from HTML meta tags.
        
        Args:
            base_url: Base URL to check HTML for meta tags
            
        Returns:
            List of sitemap URLs found in HTML meta tags
        """
        sitemaps: list[str] = []

        try:
            logger.info(f"Checking HTML meta tags for sitemaps at {base_url}")
            resp = requests.get(base_url, timeout=30)

            if resp.status_code != 200:
                logger.debug(f"Could not fetch HTML for meta tag parsing: HTTP {resp.status_code}")
                return sitemaps

            content = resp.text.lower()

            # Look for sitemap meta tags or link elements
            import re

            # Check for <link rel="sitemap" href="...">
            sitemap_link_pattern = r'<link[^>]*rel=["\']sitemap["\'][^>]*href=["\']([^"\']+)["\']'
            matches = re.findall(sitemap_link_pattern, content)

            for match in matches:
                sitemap_url = urljoin(base_url, match)
                sitemaps.append(sitemap_url)
                logger.info(f"Found sitemap in HTML link tag: {sitemap_url}")

            # Check for <meta name="sitemap" content="...">
            sitemap_meta_pattern = r'<meta[^>]*name=["\']sitemap["\'][^>]*content=["\']([^"\']+)["\']'
            matches = re.findall(sitemap_meta_pattern, content)

            for match in matches:
                sitemap_url = urljoin(base_url, match)
                sitemaps.append(sitemap_url)
                logger.info(f"Found sitemap in HTML meta tag: {sitemap_url}")

        except requests.exceptions.RequestException:
            logger.exception(f"Network error fetching HTML from {base_url}")
        except Exception:
            logger.exception(f"Unexpected error parsing HTML meta tags from {base_url}")

        return sitemaps

    def _check_well_known_directory(self, base_url: str) -> list[str]:
        """
        Check .well-known/* files for discovery targets.
        
        Args:
            base_url: Base URL to check .well-known directory for
            
        Returns:
            List of URLs found in .well-known directory
        """
        well_known_files: list[str] = []

        try:
            for filename in self.DISCOVERY_TARGETS["well_known_files"]:
                try:
                    file_url = urljoin(base_url, f"/{filename}")
                    resp = requests.get(file_url, timeout=30, allow_redirects=True)

                    if resp.status_code == 200:
                        well_known_files.append(file_url)
                        logger.info(f"Found .well-known file: {file_url}")

                except requests.exceptions.RequestException:
                    logger.debug(f"Well-known file not found or network error: {filename}")
                except Exception:
                    logger.exception(f"Unexpected error checking well-known file: {filename}")

        except Exception:
            logger.exception(f"Unexpected error checking .well-known directory for {base_url}")

        return well_known_files

    def _try_common_variations(self, base_url: str) -> dict[str, list[str]]:
        """
        Try pattern variations for discovery targets.
        
        Args:
            base_url: Base URL to try variations for
            
        Returns:
            Dictionary with file types and discovered variation URLs
        """
        discovered: dict[str, list[str]] = {
            "sitemaps": [],
            "llms_files": []
        }

        try:
            # Common subdirectories to check
            subdirs = ["public", "static", "assets", "docs", "doc", "api"]

            # Try llms.txt variants in subdirectories
            for subdir in subdirs:
                for llms_file in self.DISCOVERY_TARGETS["llms_files"]:
                    try:
                        file_url = urljoin(base_url, f"/{subdir}/{llms_file}")
                        resp = requests.get(file_url, timeout=30, allow_redirects=True)

                        if resp.status_code == 200:
                            discovered["llms_files"].append(file_url)
                            logger.info(f"Found llms file variant: {file_url}")

                    except requests.exceptions.RequestException:
                        logger.debug(f"Variant not found: {subdir}/{llms_file}")
                    except Exception:
                        logger.exception(f"Error checking variant: {subdir}/{llms_file}")

            # Try sitemap variants with different paths
            sitemap_paths = [
                "sitemaps/sitemap.xml",
                "sitemap/sitemap.xml",
                "xml/sitemap.xml",
                "feed/sitemap.xml"
            ]

            for sitemap_path in sitemap_paths:
                try:
                    file_url = urljoin(base_url, f"/{sitemap_path}")
                    resp = requests.get(file_url, timeout=30, allow_redirects=True)

                    if resp.status_code == 200:
                        discovered["sitemaps"].append(file_url)
                        logger.info(f"Found sitemap variant: {file_url}")

                except requests.exceptions.RequestException:
                    logger.debug(f"Sitemap variant not found: {sitemap_path}")
                except Exception:
                    logger.exception(f"Error checking sitemap variant: {sitemap_path}")

        except Exception:
            logger.exception(f"Unexpected error trying common variations for {base_url}")

        return discovered
