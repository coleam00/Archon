"""
URL Handler Helper

Handles URL transformations and validations.
"""

import hashlib
import re
from urllib.parse import urlparse

from ....config.logfire_config import get_logger

logger = get_logger(__name__)


class URLHandler:
    """Helper class for URL operations."""

    @staticmethod
    def is_sitemap(url: str) -> bool:
        """
        Check if a URL is a sitemap with error handling.

        Args:
            url: URL to check

        Returns:
            True if URL is a sitemap, False otherwise
        """
        try:
            return url.endswith("sitemap.xml") or "sitemap" in urlparse(url).path
        except Exception as e:
            logger.warning(f"Error checking if URL is sitemap: {e}")
            return False

    @staticmethod
    def is_txt(url: str) -> bool:
        """
        Check if a URL is a text file with error handling.

        Args:
            url: URL to check

        Returns:
            True if URL is a text file, False otherwise
        """
        try:
            return url.endswith(".txt")
        except Exception as e:
            logger.warning(f"Error checking if URL is text file: {e}")
            return False

    @staticmethod
    def is_binary_file(url: str) -> bool:
        """
        Check if a URL points to a binary file that shouldn't be crawled.

        Args:
            url: URL to check

        Returns:
            True if URL is a binary file, False otherwise
        """
        try:
            # Remove query parameters and fragments for cleaner extension checking
            parsed = urlparse(url)
            path = parsed.path.lower()

            # Comprehensive list of binary and non-HTML file extensions
            binary_extensions = {
                # Archives
                ".zip",
                ".tar",
                ".gz",
                ".rar",
                ".7z",
                ".bz2",
                ".xz",
                ".tgz",
                # Executables and installers
                ".exe",
                ".dmg",
                ".pkg",
                ".deb",
                ".rpm",
                ".msi",
                ".app",
                ".appimage",
                # Documents (non-HTML)
                ".pdf",
                ".doc",
                ".docx",
                ".xls",
                ".xlsx",
                ".ppt",
                ".pptx",
                ".odt",
                ".ods",
                # Images
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".svg",
                ".webp",
                ".ico",
                ".bmp",
                ".tiff",
                # Audio/Video
                ".mp3",
                ".mp4",
                ".avi",
                ".mov",
                ".wmv",
                ".flv",
                ".webm",
                ".mkv",
                ".wav",
                ".flac",
                # Data files
                ".csv",
                ".sql",
                ".db",
                ".sqlite",
                # Binary data
                ".iso",
                ".img",
                ".bin",
                ".dat",
                # Development files (usually not meant to be crawled as pages)
                ".wasm",
                ".pyc",
                ".jar",
                ".war",
                ".class",
                ".dll",
                ".so",
                ".dylib",
            }

            # Check if the path ends with any binary extension
            for ext in binary_extensions:
                if path.endswith(ext):
                    logger.debug(f"Skipping binary file: {url} (matched extension: {ext})")
                    return True

            return False
        except Exception as e:
            logger.warning(f"Error checking if URL is binary file: {e}")
            # In case of error, don't skip the URL (safer to attempt crawl than miss content)
            return False

    @staticmethod
    def transform_github_url(url: str) -> str:
        """
        Transform GitHub URLs to raw content URLs for better content extraction.

        Args:
            url: URL to transform

        Returns:
            Transformed URL (or original if not a GitHub file URL)
        """
        # Pattern for GitHub file URLs
        github_file_pattern = r"https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)"
        match = re.match(github_file_pattern, url)
        if match:
            owner, repo, branch, path = match.groups()
            raw_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"
            logger.info(f"Transformed GitHub file URL to raw: {url} -> {raw_url}")
            return raw_url

        # Pattern for GitHub directory URLs
        github_dir_pattern = r"https://github\.com/([^/]+)/([^/]+)/tree/([^/]+)/(.+)"
        match = re.match(github_dir_pattern, url)
        if match:
            # For directories, we can't directly get raw content
            # Return original URL but log a warning
            logger.warning(
                f"GitHub directory URL detected: {url} - consider using specific file URLs or GitHub API"
            )

        return url

    @staticmethod
    def generate_unique_source_id(url: str) -> str:
        """
        Generate a unique source ID from URL using hash.

        This creates a 16-character hash that is extremely unlikely to collide
        for distinct canonical URLs, solving race condition issues when multiple crawls
        target the same domain.
        
        Uses 16-char SHA256 prefix (64 bits) which provides
        ~18 quintillion unique values. Collision probability
        is negligible for realistic usage (<1M sources).

        Args:
            url: The URL to generate an ID for

        Returns:
            A 16-character hexadecimal hash string
        """
        try:
            from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

            # Canonicalize URL for consistent hashing
            parsed = urlparse(url.strip())

            # Normalize scheme and netloc to lowercase
            scheme = (parsed.scheme or "").lower()
            netloc = (parsed.netloc or "").lower()

            # Remove default ports
            if netloc.endswith(":80") and scheme == "http":
                netloc = netloc[:-3]
            if netloc.endswith(":443") and scheme == "https":
                netloc = netloc[:-4]

            # Normalize path (remove trailing slash except for root)
            path = parsed.path or "/"
            if path.endswith("/") and len(path) > 1:
                path = path.rstrip("/")

            # Remove common tracking parameters and sort remaining
            tracking_params = {
                "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
                "gclid", "fbclid", "ref", "source"
            }
            query_items = [
                (k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
                if k not in tracking_params
            ]
            query = urlencode(sorted(query_items))

            # Reconstruct canonical URL (fragment is dropped)
            canonical = urlunparse((scheme, netloc, path, "", query, ""))

            # Generate SHA256 hash and take first 16 characters
            return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]

        except Exception as e:
            # Redact sensitive query params from error logs
            try:
                redacted = url.split("?", 1)[0] if "?" in url else url
            except Exception:
                redacted = "<unparseable-url>"

            logger.error(f"Error generating unique source ID for {redacted}: {e}", exc_info=True)

            # Fallback: use a hash of the error message + url to still get something unique
            fallback = f"error_{redacted}_{str(e)}"
            return hashlib.sha256(fallback.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def extract_display_name(url: str) -> str:
        """
        Extract a human-readable display name from URL.

        This creates user-friendly names for common source patterns
        while falling back to the domain for unknown patterns.

        Args:
            url: The URL to extract a display name from

        Returns:
            A human-readable string suitable for UI display
        """
        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower()

            # Remove www prefix for cleaner display
            if domain.startswith("www."):
                domain = domain[4:]

            # Handle empty domain (might be a file path or malformed URL)
            if not domain:
                if url.startswith("/"):
                    return f"Local: {url.split('/')[-1] if '/' in url else url}"
                return url[:50] + "..." if len(url) > 50 else url

            path = parsed.path.strip("/")

            # Special handling for GitHub repositories and API
            if "github.com" in domain:
                # Check if it's an API endpoint
                if domain.startswith("api."):
                    return "GitHub API"

                parts = path.split("/")
                if len(parts) >= 2:
                    owner = parts[0]
                    repo = parts[1].replace(".git", "")  # Remove .git extension if present
                    return f"GitHub - {owner}/{repo}"
                elif len(parts) == 1 and parts[0]:
                    return f"GitHub - {parts[0]}"
                return "GitHub"

            # Special handling for documentation sites
            if domain.startswith("docs."):
                # Extract the service name from docs.X.com/org
                service_name = domain.replace("docs.", "").split(".")[0]
                base_name = f"{service_name.title()}" if service_name else "Documentation"

                # Special handling for special files - preserve the filename
                if path:
                    # Check for llms.txt files
                    if "llms" in path.lower() and path.endswith(".txt"):
                        return f"{base_name} - Llms.Txt"
                    # Check for sitemap files
                    elif "sitemap" in path.lower() and path.endswith(".xml"):
                        return f"{base_name} - Sitemap.Xml"
                    # Check for any other special .txt files
                    elif path.endswith(".txt"):
                        filename = path.split("/")[-1] if "/" in path else path
                        return f"{base_name} - {filename.title()}"

                return f"{base_name} Documentation" if service_name else "Documentation"

            # Handle readthedocs.io subdomains
            if domain.endswith(".readthedocs.io"):
                project = domain.replace(".readthedocs.io", "")
                return f"{project.title()} Docs"

            # Handle common documentation patterns
            doc_patterns = [
                ("fastapi.tiangolo.com", "FastAPI Documentation"),
                ("pydantic.dev", "Pydantic Documentation"),
                ("python.org", "Python Documentation"),
                ("djangoproject.com", "Django Documentation"),
                ("flask.palletsprojects.com", "Flask Documentation"),
                ("numpy.org", "NumPy Documentation"),
                ("pandas.pydata.org", "Pandas Documentation"),
            ]

            for pattern, name in doc_patterns:
                if pattern in domain:
                    # Add path context if available
                    if path and len(path) > 1:
                        # Get first meaningful path segment
                        path_segment = path.split("/")[0] if "/" in path else path
                        if path_segment and path_segment not in [
                            "docs",
                            "doc",  # Added "doc" to filter list
                            "documentation",
                            "api",
                            "en",
                        ]:
                            return f"{name} - {path_segment.title()}"
                    return name

            # For API endpoints
            if "api." in domain or "/api" in path:
                service = domain.replace("api.", "").split(".")[0]
                return f"{service.title()} API"

            # Special handling for sitemap.xml and llms.txt on any site
            if path:
                if "sitemap" in path.lower() and path.endswith(".xml"):
                    # Get base domain name
                    display = domain
                    for tld in [".com", ".org", ".io", ".dev", ".net", ".ai", ".app"]:
                        if display.endswith(tld):
                            display = display[:-len(tld)]
                            break
                    display_parts = display.replace("-", " ").replace("_", " ").split(".")
                    formatted = " ".join(part.title() for part in display_parts)
                    return f"{formatted} - Sitemap.Xml"
                elif "llms" in path.lower() and path.endswith(".txt"):
                    # Get base domain name
                    display = domain
                    for tld in [".com", ".org", ".io", ".dev", ".net", ".ai", ".app"]:
                        if display.endswith(tld):
                            display = display[:-len(tld)]
                            break
                    display_parts = display.replace("-", " ").replace("_", " ").split(".")
                    formatted = " ".join(part.title() for part in display_parts)
                    return f"{formatted} - Llms.Txt"

            # Default: Use domain with nice formatting
            # Remove common TLDs for cleaner display
            display = domain
            for tld in [".com", ".org", ".io", ".dev", ".net", ".ai", ".app"]:
                if display.endswith(tld):
                    display = display[: -len(tld)]
                    break

            # Capitalize first letter of each word
            display_parts = display.replace("-", " ").replace("_", " ").split(".")
            formatted = " ".join(part.title() for part in display_parts)

            # Add path context if it's meaningful
            if path and len(path) > 1 and "/" not in path:
                formatted += f" - {path.title()}"

            return formatted

        except Exception as e:
            logger.warning(f"Error extracting display name for {url}: {e}, using URL")
            # Fallback: return truncated URL
            return url[:50] + "..." if len(url) > 50 else url
