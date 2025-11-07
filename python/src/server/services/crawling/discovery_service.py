"""
Discovery Service for Automatic File Detection

Handles automatic discovery and parsing of llms.txt, sitemap.xml, and related files
to enhance crawling capabilities with priority-based discovery methods.
"""

import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import requests

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class SitemapHTMLParser(HTMLParser):
    """HTML parser for extracting sitemap references from link and meta tags."""

    def __init__(self):
        super().__init__()
        self.sitemaps = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        """Handle start tags to find sitemap references."""
        attrs_dict = {k.lower(): v for k, v in attrs if v is not None}

        # Check <link rel="sitemap" href="...">
        if tag == 'link':
            rel = attrs_dict.get('rel', '').lower()
            # Handle multi-valued rel attributes (space-separated)
            rel_values = rel.split() if rel else []
            if 'sitemap' in rel_values:
                href = attrs_dict.get('href')
                if href:
                    self.sitemaps.append(('link', href))

        # Check <meta name="sitemap" content="...">
        elif tag == 'meta':
            name = attrs_dict.get('name', '').lower()
            if name == 'sitemap':
                content = attrs_dict.get('content')
                if content:
                    self.sitemaps.append(('meta', content))


class DiscoveryService:
    """Service for discovering related files automatically during crawls."""

    # Maximum response size to prevent memory exhaustion (10MB default)
    MAX_RESPONSE_SIZE = 10 * 1024 * 1024  # 10 MB

    # Global priority order - select ONE best file from all categories
    # Based on actual usage research - only includes files commonly found in the wild
    DISCOVERY_PRIORITY = [
        # LLMs files (highest priority - most comprehensive AI guidance)
        "llms.txt",          # Standard llms.txt spec - widely adopted
        "llms-full.txt",     # Part of llms.txt spec - comprehensive content
        # Sitemap files (structural crawling guidance)
        "sitemap.xml",       # Universal standard for site structure
        # Well-known variants (alternative locations per RFC 8615)
        ".well-known/ai.txt",
        ".well-known/llms.txt",
        ".well-known/sitemap.xml"
    ]

    # Known file extensions for path detection
    FILE_EXTENSIONS = {
        '.html', '.htm', '.xml', '.json', '.txt', '.md', '.csv',
        '.rss', '.yaml', '.yml', '.pdf', '.zip'
    }

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

            # Extract directory path from base URL
            base_dir = self._extract_directory(base_url)

            # Try each file in priority order
            for filename in self.DISCOVERY_PRIORITY:
                discovered_url = self._try_locations(base_url, base_dir, filename)
                if discovered_url:
                    logger.info(f"Discovery found best file: {discovered_url}")
                    return discovered_url

            # Fallback: Check HTML meta tags for sitemap references
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

    def _extract_directory(self, base_url: str) -> str:
        """
        Extract directory path from URL, handling both file URLs and directory URLs.

        Args:
            base_url: URL to extract directory from

        Returns:
            Directory path (without trailing slash)
        """
        parsed = urlparse(base_url)
        base_path = parsed.path.rstrip('/')

        # Check if last segment is a file (has known extension)
        last_segment = base_path.split('/')[-1] if base_path else ''
        has_file_extension = any(last_segment.lower().endswith(ext) for ext in self.FILE_EXTENSIONS)

        if has_file_extension:
            # Remove filename to get directory
            return '/'.join(base_path.split('/')[:-1])
        else:
            # Last segment is a directory
            return base_path

    def _try_locations(self, base_url: str, base_dir: str, filename: str) -> str | None:
        """
        Try different locations for a given filename in priority order.

        Priority:
        1. Same directory as base_url (if not root)
        2. Root level
        3. Common subdirectories (based on file type)

        Args:
            base_url: Original base URL
            base_dir: Extracted directory path
            filename: Filename to search for

        Returns:
            URL if file found, None otherwise
        """
        parsed = urlparse(base_url)

        # Priority 1: Check same directory (if not root)
        if base_dir and base_dir != '/':
            same_dir_url = f"{parsed.scheme}://{parsed.netloc}{base_dir}/{filename}"
            if self._check_url_exists(same_dir_url):
                return same_dir_url

        # Priority 2: Check root level
        root_url = urljoin(base_url, filename)
        if self._check_url_exists(root_url):
            return root_url

        # Priority 3: Check common subdirectories
        subdirs = self._get_subdirs_for_file(base_dir, filename)
        for subdir in subdirs:
            subdir_url = urljoin(base_url, f"{subdir}/{filename}")
            if self._check_url_exists(subdir_url):
                return subdir_url

        return None

    def _get_subdirs_for_file(self, base_dir: str, filename: str) -> list[str]:
        """
        Get relevant subdirectories to check based on file type.

        Args:
            base_dir: Base directory path
            filename: Filename being searched for

        Returns:
            List of subdirectory names to check
        """
        subdirs = []

        # Include base directory name if available
        if base_dir and base_dir != '/':
            base_dir_name = base_dir.split('/')[-1]
            if base_dir_name:
                subdirs.append(base_dir_name)

        # Add type-specific subdirectories
        if filename.startswith('llms') or filename.endswith('.txt') or filename.endswith('.md'):
            # LLMs files commonly in these locations
            subdirs.extend(["docs", "static", "public", "assets", "doc", "api"])
        elif filename.endswith('.xml') and not filename.startswith('.well-known'):
            # Sitemap files commonly in these locations
            subdirs.extend(["docs", "sitemaps", "sitemap", "xml", "feed"])

        return subdirs

    def _is_safe_ip(self, ip_str: str) -> bool:
        """
        Check if an IP address is safe (not private, loopback, link-local, or cloud metadata).

        Args:
            ip_str: IP address string to check

        Returns:
            True if IP is safe for outbound requests, False otherwise
        """
        try:
            ip = ipaddress.ip_address(ip_str)

            # Block private networks
            if ip.is_private:
                logger.warning(f"Blocked private IP address: {ip_str}")
                return False

            # Block loopback (127.0.0.0/8, ::1)
            if ip.is_loopback:
                logger.warning(f"Blocked loopback IP address: {ip_str}")
                return False

            # Block link-local (169.254.0.0/16, fe80::/10)
            if ip.is_link_local:
                logger.warning(f"Blocked link-local IP address: {ip_str}")
                return False

            # Block multicast
            if ip.is_multicast:
                logger.warning(f"Blocked multicast IP address: {ip_str}")
                return False

            # Block reserved ranges
            if ip.is_reserved:
                logger.warning(f"Blocked reserved IP address: {ip_str}")
                return False

            # Additional explicit checks for cloud metadata services
            # AWS metadata service
            if str(ip) == "169.254.169.254":
                logger.warning(f"Blocked AWS metadata service IP: {ip_str}")
                return False

            # GCP metadata service
            if str(ip) == "169.254.169.254":
                logger.warning(f"Blocked GCP metadata service IP: {ip_str}")
                return False

            return True

        except ValueError:
            logger.warning(f"Invalid IP address format: {ip_str}")
            return False

    def _resolve_and_validate_hostname(self, hostname: str) -> bool:
        """
        Resolve hostname to IP and validate it's safe.

        Args:
            hostname: Hostname to resolve and validate

        Returns:
            True if hostname resolves to safe IPs only, False otherwise
        """
        try:
            # Resolve hostname to IP addresses
            addr_info = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)

            # Check all resolved IPs
            for info in addr_info:
                ip_str = info[4][0]
                if not self._is_safe_ip(ip_str):
                    logger.warning(f"Hostname {hostname} resolves to unsafe IP {ip_str}")
                    return False

            return True

        except socket.gaierror as e:
            logger.warning(f"DNS resolution failed for {hostname}: {e}")
            return False
        except Exception as e:
            logger.warning(f"Error resolving hostname {hostname}: {e}")
            return False

    def _check_url_exists(self, url: str) -> bool:
        """
        Check if a URL exists and returns a successful response.
        Includes SSRF protection by validating hostnames and blocking private IPs.

        Args:
            url: URL to check

        Returns:
            True if URL returns 200, False otherwise
        """
        try:
            # Parse URL to extract hostname
            parsed = urlparse(url)
            if not parsed.scheme or not parsed.netloc:
                logger.warning(f"Invalid URL format: {url}")
                return False

            # Only allow HTTP/HTTPS
            if parsed.scheme not in ('http', 'https'):
                logger.warning(f"Blocked non-HTTP(S) scheme: {parsed.scheme}")
                return False

            # Validate initial hostname
            hostname = parsed.netloc.split(':')[0]  # Remove port if present
            if not self._resolve_and_validate_hostname(hostname):
                logger.warning(f"URL check blocked due to unsafe hostname: {url}")
                return False

            # Set safe User-Agent header
            headers = {
                'User-Agent': 'Archon-Discovery/1.0 (SSRF-Protected)'
            }

            # Create a session with limited redirects
            session = requests.Session()
            session.max_redirects = 3

            # Make request with redirect validation
            resp = session.get(
                url,
                timeout=5,
                allow_redirects=True,
                verify=True,
                headers=headers
            )

            try:
                # Check if there were redirects (history attribute exists on real responses)
                if hasattr(resp, 'history') and resp.history:
                    logger.debug(f"URL {url} had {len(resp.history)} redirect(s)")

                    # Validate final destination
                    final_url = resp.url
                    final_parsed = urlparse(final_url)

                    # Only allow HTTP/HTTPS for final destination
                    if final_parsed.scheme not in ('http', 'https'):
                        logger.warning(f"Blocked redirect to non-HTTP(S) scheme: {final_parsed.scheme}")
                        return False

                    # Validate final hostname
                    final_hostname = final_parsed.netloc.split(':')[0]
                    if not self._resolve_and_validate_hostname(final_hostname):
                        logger.warning(f"Redirect target blocked due to unsafe hostname: {final_url}")
                        return False

                # Check response status
                success = resp.status_code == 200
                logger.debug(f"URL check: {url} -> {resp.status_code} ({'exists' if success else 'not found'})")
                return success

            finally:
                if hasattr(resp, 'close'):
                    resp.close()

        except requests.exceptions.TooManyRedirects:
            logger.warning(f"Too many redirects for URL: {url}")
            return False
        except requests.exceptions.Timeout:
            logger.debug(f"Timeout checking URL: {url}")
            return False
        except requests.exceptions.RequestException as e:
            logger.debug(f"Request error checking URL {url}: {e}")
            return False
        except Exception as e:
            logger.warning(f"Unexpected error checking URL {url}: {e}", exc_info=True)
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
            robots_url = urljoin(base_url, "robots.txt")
            logger.info(f"Checking robots.txt at {robots_url}")

            # Set safe User-Agent header
            headers = {
                'User-Agent': 'Archon-Discovery/1.0 (SSRF-Protected)'
            }

            resp = requests.get(robots_url, timeout=30, stream=True, verify=True, headers=headers)

            try:
                if resp.status_code != 200:
                    logger.info(f"No robots.txt found: HTTP {resp.status_code}")
                    return sitemaps

                # Read response with size limit
                content = self._read_response_with_limit(resp, robots_url)

                # Parse robots.txt content for sitemap directives
                for raw_line in content.splitlines():
                    line = raw_line.strip()
                    if line.lower().startswith("sitemap:"):
                        sitemap_value = line.split(":", 1)[1].strip()
                        if sitemap_value:
                            # Allow absolute and relative sitemap values
                            if sitemap_value.lower().startswith(("http://", "https://")):
                                sitemap_url = sitemap_value
                            else:
                                # Resolve relative path against base_url
                                sitemap_url = urljoin(base_url, sitemap_value)

                            # Validate scheme is HTTP/HTTPS only
                            parsed = urlparse(sitemap_url)
                            if parsed.scheme not in ("http", "https"):
                                logger.warning(f"Skipping non-HTTP(S) sitemap in robots.txt: {sitemap_url}")
                                continue

                            sitemaps.append(sitemap_url)
                            logger.info(f"Found sitemap in robots.txt: {sitemap_url}")

            finally:
                resp.close()

        except requests.exceptions.RequestException:
            logger.exception(f"Network error fetching robots.txt from {base_url}")
        except ValueError as e:
            logger.warning(f"robots.txt too large at {base_url}: {e}")
        except Exception:
            logger.exception(f"Unexpected error parsing robots.txt from {base_url}")

        return sitemaps

    def _parse_html_meta_tags(self, base_url: str) -> list[str]:
        """
        Extract sitemap references from HTML meta tags using proper HTML parsing.

        Args:
            base_url: Base URL to check HTML for meta tags

        Returns:
            List of sitemap URLs found in HTML meta tags
        """
        sitemaps: list[str] = []

        try:
            logger.info(f"Checking HTML meta tags for sitemaps at {base_url}")

            # Set safe User-Agent header
            headers = {
                'User-Agent': 'Archon-Discovery/1.0 (SSRF-Protected)'
            }

            resp = requests.get(base_url, timeout=30, stream=True, verify=True, headers=headers)

            try:
                if resp.status_code != 200:
                    logger.debug(f"Could not fetch HTML for meta tag parsing: HTTP {resp.status_code}")
                    return sitemaps

                # Read response with size limit
                content = self._read_response_with_limit(resp, base_url)

                # Parse HTML using proper HTML parser
                parser = SitemapHTMLParser()
                try:
                    parser.feed(content)
                except Exception as e:
                    logger.warning(f"HTML parsing error for {base_url}: {e}")
                    return sitemaps

                # Process found sitemaps
                for tag_type, url in parser.sitemaps:
                    # Resolve relative URLs
                    sitemap_url = urljoin(base_url, url.strip())

                    # Validate scheme is HTTP/HTTPS
                    parsed = urlparse(sitemap_url)
                    if parsed.scheme not in ("http", "https"):
                        logger.debug(f"Skipping non-HTTP(S) sitemap URL: {sitemap_url}")
                        continue

                    sitemaps.append(sitemap_url)
                    logger.info(f"Found sitemap in HTML {tag_type} tag: {sitemap_url}")

            finally:
                resp.close()

        except requests.exceptions.RequestException:
            logger.exception(f"Network error fetching HTML from {base_url}")
        except ValueError as e:
            logger.warning(f"HTML response too large at {base_url}: {e}")
        except Exception:
            logger.exception(f"Unexpected error parsing HTML meta tags from {base_url}")

        return sitemaps

    def _read_response_with_limit(self, response: requests.Response, url: str, max_size: int | None = None) -> str:
        """
        Read response content with size limit to prevent memory exhaustion.

        Args:
            response: The response object to read from
            url: URL being read (for logging)
            max_size: Maximum bytes to read (defaults to MAX_RESPONSE_SIZE)

        Returns:
            Response text content

        Raises:
            ValueError: If response exceeds size limit
        """
        if max_size is None:
            max_size = self.MAX_RESPONSE_SIZE

        try:
            chunks = []
            total_size = 0

            # Read response in chunks to enforce size limit
            for chunk in response.iter_content(chunk_size=8192, decode_unicode=False):
                if chunk:
                    total_size += len(chunk)
                    if total_size > max_size:
                        response.close()
                        size_mb = max_size / (1024 * 1024)
                        logger.warning(
                            f"Response size exceeded limit of {size_mb:.1f}MB for {url}, "
                            f"received {total_size / (1024 * 1024):.1f}MB"
                        )
                        raise ValueError(f"Response size exceeds {size_mb:.1f}MB limit")
                    chunks.append(chunk)

            # Decode the complete response
            content_bytes = b''.join(chunks)
            encoding = response.encoding or 'utf-8'
            try:
                return content_bytes.decode(encoding)
            except UnicodeDecodeError:
                # Fallback to utf-8 with error replacement
                return content_bytes.decode('utf-8', errors='replace')

        except Exception:
            response.close()
            raise
