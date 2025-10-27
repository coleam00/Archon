"""Unit tests for DiscoveryService class."""
import socket
from unittest.mock import Mock, patch

from src.server.services.crawling.discovery_service import DiscoveryService


def create_mock_dns_response():
    """Create mock DNS response for safe public IPs."""
    # Return a safe public IP for testing
    return [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 0))  # example.com's actual IP
    ]


def create_mock_response(status_code: int, text: str = "", url: str = "https://example.com") -> Mock:
    """Create a mock response object that supports streaming API."""
    response = Mock()
    response.status_code = status_code
    response.text = text
    response.encoding = 'utf-8'
    response.history = []  # Empty list for no redirects
    response.url = url  # Mock URL for redirect checks (must be string, not Mock)

    # Mock iter_content to yield text in chunks as bytes
    text_bytes = text.encode('utf-8')
    chunk_size = 8192
    chunks = [text_bytes[i:i+chunk_size] for i in range(0, len(text_bytes), chunk_size)]
    if not chunks:
        chunks = [b'']  # Ensure at least one empty chunk
    response.iter_content = Mock(return_value=iter(chunks))

    # Mock close method
    response.close = Mock()

    return response


class TestDiscoveryService:
    """Test suite for DiscoveryService class."""

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_discover_files_basic(self, mock_get, mock_session, mock_dns):
        """Test main discovery method returns single best file."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps)
        robots_response = create_mock_response(200, "User-agent: *\nDisallow: /admin/")

        # Mock file existence - llms-full.txt doesn't exist, but llms.txt does
        def mock_get_side_effect(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif url.endswith('llms-full.txt'):
                return create_mock_response(404)  # Highest priority doesn't exist
            elif url.endswith('llms.txt'):
                return create_mock_response(200)  # Second priority exists
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_get_side_effect
        mock_session.return_value.get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should return single URL string (not dict, not list)
        assert isinstance(result, str)
        assert result == 'https://example.com/llms.txt'

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_discover_files_no_files_found(self, mock_get, mock_session, mock_dns):
        """Test discovery when no files are found."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock all HTTP requests to return 404
        mock_get.return_value = create_mock_response(404)
        mock_session.return_value.get.return_value = create_mock_response(404)

        result = service.discover_files(base_url)

        # Should return None when no files found
        assert result is None

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_discover_files_priority_order(self, mock_get, mock_session, mock_dns):
        """Test that discovery follows the correct priority order."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps declared)
        robots_response = create_mock_response(200, "User-agent: *\nDisallow: /admin/")

        # Mock file existence - both sitemap.xml and llms.txt exist, but llms.txt has higher priority
        def mock_get_side_effect(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif url.endswith('llms.txt') or url.endswith('sitemap.xml'):
                return create_mock_response(200)  # Both exist
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_get_side_effect
        mock_session.return_value.get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should return llms.txt since it has higher priority than sitemap.xml
        assert result == 'https://example.com/llms.txt'

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_discover_files_robots_sitemap_priority(self, mock_get, mock_session, mock_dns):
        """Test that llms files have priority over robots.txt sitemap declarations."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response WITH sitemap declaration
        robots_response = create_mock_response(200, "User-agent: *\nSitemap: https://example.com/declared-sitemap.xml")

        # Mock other files also exist (both llms and sitemap files)
        def mock_get_side_effect(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif 'llms' in url or 'sitemap' in url:
                return create_mock_response(200)
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_get_side_effect
        mock_session.return_value.get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should return llms.txt (highest priority llms file) since llms files have priority over sitemaps
        # even when sitemaps are declared in robots.txt
        assert result == 'https://example.com/llms.txt'

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_discover_files_subdirectory_fallback(self, mock_get, mock_session, mock_dns):
        """Test discovery falls back to subdirectories for llms files."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps declared)
        robots_response = create_mock_response(200, "User-agent: *\nDisallow: /admin/")

        # Mock file existence - no root llms files, but static/llms.txt exists
        def mock_get_side_effect(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif '/static/llms.txt' in url:
                return create_mock_response(200)  # Found in subdirectory
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_get_side_effect
        mock_session.return_value.get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should find the file in static subdirectory
        assert result == 'https://example.com/static/llms.txt'

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_check_url_exists(self, mock_get, mock_session, mock_dns):
        """Test URL existence checking."""
        service = DiscoveryService()

        # Test successful response
        mock_get.return_value = create_mock_response(200)
        mock_session.return_value.get.return_value = create_mock_response(200)
        assert service._check_url_exists("https://example.com/exists") is True

        # Test 404 response
        mock_get.return_value = create_mock_response(404)
        mock_session.return_value.get.return_value = create_mock_response(404)
        assert service._check_url_exists("https://example.com/not-found") is False

        # Test network error
        mock_get.side_effect = Exception
        mock_session.return_value.get.side_effect = Exception("Network error")
        assert service._check_url_exists("https://example.com/error") is False

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_parse_robots_txt_with_sitemap(self, mock_get, mock_session, mock_dns):
        """Test robots.txt parsing with sitemap directives."""
        service = DiscoveryService()

        # Mock successful robots.txt response
        robots_text = """User-agent: *
Disallow: /admin/
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml"""
        mock_get.return_value = create_mock_response(200, robots_text)

        result = service._parse_robots_txt("https://example.com")

        assert len(result) == 2
        assert "https://example.com/sitemap.xml" in result
        assert "https://example.com/sitemap-news.xml" in result
        mock_get.assert_called_once_with("https://example.com/robots.txt", timeout=30, stream=True, verify=True, headers={'User-Agent': 'Archon-Discovery/1.0 (SSRF-Protected)'})

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_parse_robots_txt_no_sitemap(self, mock_get, mock_session, mock_dns):
        """Test robots.txt parsing without sitemap directives."""
        service = DiscoveryService()

        # Mock robots.txt without sitemaps
        robots_text = """User-agent: *
Disallow: /admin/
Allow: /public/"""
        mock_get.return_value = create_mock_response(200, robots_text)

        result = service._parse_robots_txt("https://example.com")

        assert len(result) == 0
        mock_get.assert_called_once_with("https://example.com/robots.txt", timeout=30, stream=True, verify=True, headers={'User-Agent': 'Archon-Discovery/1.0 (SSRF-Protected)'})

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_parse_html_meta_tags(self, mock_get, mock_session, mock_dns):
        """Test HTML meta tag parsing for sitemaps."""
        service = DiscoveryService()

        # Mock HTML with sitemap references
        html_content = """
        <html>
        <head>
            <link rel="sitemap" href="/sitemap.xml">
            <meta name="sitemap" content="https://example.com/sitemap-meta.xml">
        </head>
        <body>Content here</body>
        </html>
        """
        mock_get.return_value = create_mock_response(200, html_content)

        result = service._parse_html_meta_tags("https://example.com")

        # Should find sitemaps from both link and meta tags
        assert len(result) >= 1
        assert any('sitemap' in url.lower() for url in result)
        mock_get.assert_called_once_with("https://example.com", timeout=30, stream=True, verify=True, headers={'User-Agent': 'Archon-Discovery/1.0 (SSRF-Protected)'})

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_discovery_priority_behavior(self, mock_get, mock_session, mock_dns):
        """Test that discovery returns highest-priority file when multiple files exist."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps declared)
        robots_response = create_mock_response(200, "User-agent: *\nDisallow: /admin/")

        # Scenario 1: All files exist - should return llms.txt (highest priority)
        def mock_all_exist(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif any(file in url for file in ['llms.txt', 'llms-full.txt', 'sitemap.xml']):
                return create_mock_response(200)
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_all_exist
        mock_session.return_value.get.side_effect = mock_all_exist
        result = service.discover_files(base_url)
        assert result == 'https://example.com/llms.txt', "Should return llms.txt when all files exist (highest priority)"

        # Scenario 2: llms.txt missing, others exist - should return llms-full.txt
        def mock_without_txt(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif url.endswith('llms.txt'):
                return create_mock_response(404)
            elif any(file in url for file in ['llms-full.txt', 'sitemap.xml']):
                return create_mock_response(200)
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_without_txt
        mock_session.return_value.get.side_effect = mock_without_txt
        result = service.discover_files(base_url)
        assert result == 'https://example.com/llms-full.txt', "Should return llms-full.txt when llms.txt is missing"

        # Scenario 3: Only sitemap files exist - should return sitemap.xml
        def mock_only_sitemaps(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif any(file in url for file in ['llms.txt', 'llms-full.txt']):
                return create_mock_response(404)
            elif url.endswith('sitemap.xml'):
                return create_mock_response(200)
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_only_sitemaps
        mock_session.return_value.get.side_effect = mock_only_sitemaps
        result = service.discover_files(base_url)
        assert result == 'https://example.com/sitemap.xml', "Should return sitemap.xml when llms files are missing"

        # Scenario 4: llms files have priority over sitemap files
        def mock_llms_and_sitemap(url, **kwargs):
            if url.endswith('robots.txt'):
                return robots_response
            elif url.endswith('llms.txt') or url.endswith('sitemap.xml'):
                return create_mock_response(200)
            else:
                return create_mock_response(404)

        mock_get.side_effect = mock_llms_and_sitemap
        mock_session.return_value.get.side_effect = mock_llms_and_sitemap
        result = service.discover_files(base_url)
        assert result == 'https://example.com/llms.txt', "Should prefer llms.txt over sitemap.xml"

    @patch('socket.getaddrinfo', return_value=create_mock_dns_response())
    @patch('requests.Session')
    @patch('requests.get')
    def test_network_error_handling(self, mock_get, mock_session, mock_dns):
        """Test error scenarios with network failures."""
        service = DiscoveryService()

        # Mock network error
        mock_get.side_effect = Exception("Network error")
        mock_session.return_value.get.side_effect = Exception("Network error")

        # Should not raise exception, but return None
        result = service.discover_files("https://example.com")
        assert result is None

        # Individual methods should also handle errors gracefully
        result = service._parse_robots_txt("https://example.com")
        assert result == []

        result = service._parse_html_meta_tags("https://example.com")
        assert result == []
