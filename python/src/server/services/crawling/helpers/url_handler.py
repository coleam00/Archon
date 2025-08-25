"""
URL Handler Helper

Handles URL transformations and validations.
"""
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
