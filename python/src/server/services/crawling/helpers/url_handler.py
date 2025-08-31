"""
URL Handler Helper

Handles URL transformations and validations.
"""
import re
from urllib.parse import urlparse, urljoin
from typing import List, Optional

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
    def is_markdown(url: str) -> bool:
        """
        Check if a URL points to a markdown file (.md, .mdx, .markdown).
        
        Args:
            url: URL to check
            
        Returns:
            True if URL is a markdown file, False otherwise
        """
        try:
            parsed = urlparse(url)
            # Normalize to lowercase and ignore query/fragment
            path = parsed.path.lower()
            return path.endswith(('.md', '.mdx', '.markdown'))
        except Exception as e:
            logger.warning(f"Error checking if URL is markdown file: {e}", exc_info=True)
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
            parsed = urlparse(url)
            # Normalize to lowercase and ignore query/fragment
            return parsed.path.lower().endswith('.txt')
        except Exception as e:
            logger.warning(f"Error checking if URL is text file: {e}", exc_info=True)
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
            # Strip query parameters and fragments that break raw URLs
            path = path.split('?', 1)[0].split('#', 1)[0]
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
    def extract_markdown_links(content: str, base_url: Optional[str] = None) -> List[str]:
        """
        Extract markdown-style links from text content.
        
        Args:
            content: Text content to extract links from
            base_url: Base URL to resolve relative links against
            
        Returns:
            List of absolute URLs found in the content
        """
        try:
            if not content:
                return []
            
            # Ultimate URL pattern with comprehensive format support:
            #  1) [text](url) - markdown links
            #  2) <https://...> - autolinks  
            #  3) https://... - bare URLs with protocol
            #  4) //example.com - protocol-relative URLs
            #  5) www.example.com - scheme-less www URLs
            combined_pattern = re.compile(
                r'\[(?P<text>[^\]]*)\]\((?P<md>[^)]+)\)'      # named: md
                r'|<\s*(?P<auto>https?://[^>\s]+)\s*>'        # named: auto
                r'|(?P<bare>https?://[^\s<>()\[\]"]+)'        # named: bare
                r'|(?P<proto>//[^\s<>()\[\]"]+)'              # named: protocol-relative
                r'|(?P<www>www\.[^\s<>()\[\]"]+)'             # named: www.* without scheme
            )

            def _clean_url(u: str) -> str:
                # Trim whitespace and comprehensive trailing punctuation
                # Also remove invisible Unicode characters that can break URLs
                import unicodedata
                cleaned = u.strip().rstrip('.,;:)]>')
                # Remove invisible/control characters but keep valid URL characters
                cleaned = ''.join(c for c in cleaned if unicodedata.category(c) not in ('Cf', 'Cc'))
                return cleaned

            urls = []
            for match in re.finditer(combined_pattern, content):
                url = (
                    match.group('md')
                    or match.group('auto')
                    or match.group('bare')
                    or match.group('proto')
                    or match.group('www')
                )
                if not url:
                    continue
                url = _clean_url(url)

                # Skip empty URLs, anchors, and mailto links
                if not url or url.startswith('#') or url.startswith('mailto:'):
                    continue

                # Normalize all URL formats to https://
                if url.startswith('//'):
                    url = f'https:{url}'
                elif url.startswith('www.'):
                    url = f'https://{url}'

                # Convert relative URLs to absolute if base_url provided
                if base_url and not url.startswith(('http://', 'https://')):
                    try:
                        url = urljoin(base_url, url)
                    except Exception as e:
                        logger.warning(f"Failed to resolve relative URL {url} with base {base_url}: {e}")
                        continue

                # Only include HTTP/HTTPS URLs
                if url.startswith(('http://', 'https://')):
                    urls.append(url)
            
            # Remove duplicates while preserving order
            seen = set()
            unique_urls = []
            for url in urls:
                if url not in seen:
                    seen.add(url)
                    unique_urls.append(url)
            
            logger.info(f"Extracted {len(unique_urls)} unique links from content")
            return unique_urls
            
        except Exception as e:
            logger.error(f"Error extracting markdown links: {e}", exc_info=True)
            return []
    
    @staticmethod
    def is_link_collection_file(url: str, content: Optional[str] = None) -> bool:
        """
        Check if a URL/file appears to be a link collection file like llms.txt.
        
        Args:
            url: URL to check
            content: Optional content to analyze for link density
            
        Returns:
            True if file appears to be a link collection, False otherwise
        """
        try:
            # Extract filename from URL
            parsed = urlparse(url)
            filename = parsed.path.split('/')[-1].lower()
            
            # Check for specific link collection filenames
            # Note: "full-*" or "*-full" patterns are NOT link collections - they contain complete content, not just links
            link_collection_patterns = [
                # .txt variants - files that typically contain lists of links
                'llms.txt', 'links.txt', 'resources.txt', 'references.txt',
                # .md/.mdx/.markdown variants
                'llms.md', 'links.md', 'resources.md', 'references.md',
                'llms.mdx', 'links.mdx', 'resources.mdx', 'references.mdx',
                'llms.markdown', 'links.markdown', 'resources.markdown', 'references.markdown',
            ]
            
            # Direct filename match
            if filename in link_collection_patterns:
                logger.info(f"Detected link collection file by filename: {filename}")
                return True
            
            # Pattern-based detection for variations, but exclude "full" variants
            # Only match files that are likely link collections, not complete content files
            if filename.endswith(('.txt', '.md', '.mdx', '.markdown')):
                # Exclude files with "full" in the name - these typically contain complete content, not just links
                if 'full' not in filename:
                    # Match files that start with common link collection prefixes
                    base_patterns = ['llms', 'links', 'resources', 'references']
                    if any(filename.startswith(pattern + '.') or filename.startswith(pattern + '-') for pattern in base_patterns):
                        logger.info(f"Detected potential link collection file: {filename}")
                        return True
            
            # Content-based detection if content is provided
            if content:
                # Reuse extractor to avoid regex divergence and maintain consistency
                extracted_links = URLHandler.extract_markdown_links(content)
                total_links = len(extracted_links)
                
                # Calculate link density (links per 100 characters)
                content_length = len(content.strip())
                if content_length > 0:
                    link_density = (total_links * 100) / content_length
                    
                    # If more than 2% of content is links, likely a link collection
                    if link_density > 2.0 and total_links > 3:
                        logger.info(f"Detected link collection by content analysis: {total_links} links, density {link_density:.2f}%")
                        return True
            
            return False
            
        except Exception as e:
            logger.warning(f"Error checking if file is link collection: {e}", exc_info=True)
            return False