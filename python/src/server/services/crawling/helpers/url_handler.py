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
            return url.endswith('sitemap.xml') or 'sitemap' in urlparse(url).path
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
            return url.endswith('.txt')
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
                '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.tgz',
                # Executables and installers
                '.exe', '.dmg', '.pkg', '.deb', '.rpm', '.msi', '.app', '.appimage',
                # Documents (non-HTML)
                '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
                # Images
                '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff',
                # Audio/Video
                '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.wav', '.flac',
                # Data files
                '.csv', '.sql', '.db', '.sqlite',
                # Binary data
                '.iso', '.img', '.bin', '.dat',
                # Development files (usually not meant to be crawled as pages)
                '.wasm', '.pyc', '.jar', '.war', '.class', '.dll', '.so', '.dylib'
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
        github_file_pattern = r'https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)'
        match = re.match(github_file_pattern, url)
        if match:
            owner, repo, branch, path = match.groups()
            raw_url = f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}'
            logger.info(f"Transformed GitHub file URL to raw: {url} -> {raw_url}")
            return raw_url

        # Pattern for GitHub directory URLs
        github_dir_pattern = r'https://github\.com/([^/]+)/([^/]+)/tree/([^/]+)/(.+)'
        match = re.match(github_dir_pattern, url)
        if match:
            # For directories, we can't directly get raw content
            # Return original URL but log a warning
            logger.warning(f"GitHub directory URL detected: {url} - consider using specific file URLs or GitHub API")

        return url

    @staticmethod
    def generate_unique_source_id(url: str, max_length: int = 100) -> str:
        """
        Generate a unique source ID for a crawl URL that prevents race conditions.

        This replaces the domain-based approach that causes conflicts when multiple
        concurrent crawls target the same domain (e.g., different GitHub repos).

        Strategy: Always include a URL hash for absolute uniqueness while maintaining
        readability with meaningful path components.

        Args:
            url: The original crawl URL
            max_length: Maximum length for the source ID

        Returns:
            Unique source ID combining readable path + hash for complete uniqueness
        """
        try:
            parsed = urlparse(url)
            domain = parsed.netloc
            path = parsed.path.strip('/')

            # Generate hash for absolute uniqueness
            url_hash = hashlib.md5(url.encode('utf-8')).hexdigest()[:8]

            # For GitHub repos, extract meaningful path components
            if (domain == "github.com" or domain.endswith(".github.com")) and path:
                # Extract owner/repo from paths like: /owner/repo/... or /owner/repo
                path_parts = path.split('/')
                if len(path_parts) >= 2:
                    # Use format: github.com/owner/repo-hash
                    readable_part = f"{domain}/{path_parts[0]}/{path_parts[1]}"
                else:
                    readable_part = f"{domain}/{path}"
            elif path:
                # For other sites with paths, include domain + meaningful path portion
                # Take up to first 2 path segments to create more unique IDs
                path_parts = path.split('/')
                if len(path_parts) >= 2:
                    path_portion = f"{path_parts[0]}/{path_parts[1]}"
                else:
                    path_portion = path_parts[0] if path_parts else path
                readable_part = f"{domain}/{path_portion}"
            else:
                # Fallback to just domain
                readable_part = domain

            # Always append hash for absolute uniqueness (even if readable part is short)
            # Reserve 9 chars for hash (8 chars + 1 dash)
            max_readable = max_length - 9
            if len(readable_part) > max_readable:
                readable_part = readable_part[:max_readable].rstrip('/')

            return f"{readable_part}-{url_hash}"

        except Exception as e:
            logger.error(f"Error generating unique source ID for {url}: {e}")
            # Fallback: use hash of full URL if parsing fails
            url_hash = hashlib.md5(url.encode('utf-8')).hexdigest()[:12]
            return f"fallback-{url_hash}"
