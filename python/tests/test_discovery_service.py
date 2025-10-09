"""Unit tests for DiscoveryService class."""
from unittest.mock import Mock, patch

from src.server.services.crawling.discovery_service import DiscoveryService


class TestDiscoveryService:
    """Test suite for DiscoveryService class."""

    @patch('requests.get')
    def test_discover_files_basic(self, mock_get):
        """Test main discovery method returns single best file."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps)
        robots_response = Mock()
        robots_response.status_code = 200
        robots_response.text = "User-agent: *\nDisallow: /admin/"

        # Mock file existence - llms-full.txt doesn't exist, but llms.txt does
        def mock_get_side_effect(url, **kwargs):
            response = Mock()
            if url.endswith('robots.txt'):
                return robots_response
            elif url.endswith('llms-full.txt'):
                response.status_code = 404  # Highest priority doesn't exist
            elif url.endswith('llms.txt'):
                response.status_code = 200  # Second priority exists
            else:
                response.status_code = 404
            return response

        mock_get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should return single URL string (not dict, not list)
        assert isinstance(result, str)
        assert result == 'https://example.com/llms.txt'

    @patch('requests.get')
    def test_discover_files_no_files_found(self, mock_get):
        """Test discovery when no files are found."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock all HTTP requests to return 404
        mock_response = Mock()
        mock_response.status_code = 404
        mock_get.return_value = mock_response

        result = service.discover_files(base_url)

        # Should return None when no files found
        assert result is None

    @patch('requests.get')
    def test_discover_files_priority_order(self, mock_get):
        """Test that discovery follows the correct priority order."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps declared)
        robots_response = Mock()
        robots_response.status_code = 200
        robots_response.text = "User-agent: *\nDisallow: /admin/"

        # Mock file existence - both sitemap.xml and llms.txt exist, but llms.txt has higher priority
        def mock_get_side_effect(url, **kwargs):
            response = Mock()
            if url.endswith('robots.txt'):
                return robots_response
            elif url.endswith('llms.txt') or url.endswith('sitemap.xml'):
                response.status_code = 200  # Both exist
            else:
                response.status_code = 404
            return response

        mock_get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should return llms.txt since it has higher priority than sitemap.xml
        assert result == 'https://example.com/llms.txt'

    @patch('requests.get')
    def test_discover_files_robots_sitemap_priority(self, mock_get):
        """Test that robots.txt sitemap declarations have highest priority."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response WITH sitemap declaration
        robots_response = Mock()
        robots_response.status_code = 200
        robots_response.text = "User-agent: *\nSitemap: https://example.com/declared-sitemap.xml"

        # Mock other files also exist
        def mock_get_side_effect(url, **kwargs):
            response = Mock()
            if url.endswith('robots.txt'):
                return robots_response
            elif 'llms' in url or 'sitemap' in url:
                response.status_code = 200
            else:
                response.status_code = 404
            return response

        mock_get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should return the sitemap declared in robots.txt (highest priority)
        assert result == 'https://example.com/declared-sitemap.xml'

    @patch('requests.get')
    def test_discover_files_subdirectory_fallback(self, mock_get):
        """Test discovery falls back to subdirectories for llms files."""
        service = DiscoveryService()
        base_url = "https://example.com"

        # Mock robots.txt response (no sitemaps declared)
        robots_response = Mock()
        robots_response.status_code = 200
        robots_response.text = "User-agent: *\nDisallow: /admin/"

        # Mock file existence - no root llms files, but static/llms.txt exists
        def mock_get_side_effect(url, **kwargs):
            response = Mock()
            if url.endswith('robots.txt'):
                return robots_response
            elif '/static/llms.txt' in url:
                response.status_code = 200  # Found in subdirectory
            else:
                response.status_code = 404
            return response

        mock_get.side_effect = mock_get_side_effect

        result = service.discover_files(base_url)

        # Should find the file in static subdirectory
        assert result == 'https://example.com/static/llms.txt'

    @patch('requests.get')
    def test_check_url_exists(self, mock_get):
        """Test URL existence checking."""
        service = DiscoveryService()

        # Test successful response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_get.return_value = mock_response

        assert service._check_url_exists("https://example.com/exists") is True

        # Test 404 response
        mock_response.status_code = 404
        assert service._check_url_exists("https://example.com/not-found") is False

        # Test network error
        mock_get.side_effect = Exception("Network error")
        assert service._check_url_exists("https://example.com/error") is False

    @patch('requests.get')
    def test_parse_robots_txt_with_sitemap(self, mock_get):
        """Test robots.txt parsing with sitemap directives."""
        service = DiscoveryService()

        # Mock successful robots.txt response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = """User-agent: *
Disallow: /admin/
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml"""
        mock_get.return_value = mock_response

        result = service._parse_robots_txt("https://example.com")

        assert len(result) == 2
        assert "https://example.com/sitemap.xml" in result
        assert "https://example.com/sitemap-news.xml" in result
        mock_get.assert_called_once_with("https://example.com/robots.txt", timeout=30)

    @patch('requests.get')
    def test_parse_robots_txt_no_sitemap(self, mock_get):
        """Test robots.txt parsing without sitemap directives."""
        service = DiscoveryService()

        # Mock robots.txt without sitemaps
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = """User-agent: *
Disallow: /admin/
Allow: /public/"""
        mock_get.return_value = mock_response

        result = service._parse_robots_txt("https://example.com")

        assert len(result) == 0
        mock_get.assert_called_once_with("https://example.com/robots.txt", timeout=30)

    @patch('requests.get')
    def test_parse_html_meta_tags(self, mock_get):
        """Test HTML meta tag parsing for sitemaps."""
        service = DiscoveryService()

        # Mock HTML with sitemap references
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.text = """
        <html>
        <head>
            <link rel="sitemap" href="/sitemap.xml">
            <meta name="sitemap" content="https://example.com/sitemap-meta.xml">
        </head>
        <body>Content here</body>
        </html>
        """
        mock_get.return_value = mock_response

        result = service._parse_html_meta_tags("https://example.com")

        # Should find sitemaps from both link and meta tags
        assert len(result) >= 1
        assert any('sitemap' in url.lower() for url in result)
        mock_get.assert_called_once_with("https://example.com", timeout=30)

    def test_discovery_priority_constant(self):
        """Test that discovery priority constant is properly defined."""
        service = DiscoveryService()

        # Verify the priority list exists and has expected order
        assert hasattr(service, 'DISCOVERY_PRIORITY')
        assert isinstance(service.DISCOVERY_PRIORITY, list)
        assert len(service.DISCOVERY_PRIORITY) > 0

        # Verify llms-full.txt is first (highest priority)
        assert service.DISCOVERY_PRIORITY[0] == 'llms-full.txt'

        # Verify llms.txt comes before sitemap files
        llms_txt_index = service.DISCOVERY_PRIORITY.index('llms.txt')
        sitemap_index = service.DISCOVERY_PRIORITY.index('sitemap.xml')
        assert llms_txt_index < sitemap_index

    @patch('requests.get')
    def test_network_error_handling(self, mock_get):
        """Test error scenarios with network failures."""
        service = DiscoveryService()

        # Mock network error
        mock_get.side_effect = Exception("Network error")

        # Should not raise exception, but return None
        result = service.discover_files("https://example.com")
        assert result is None

        # Individual methods should also handle errors gracefully
        result = service._parse_robots_txt("https://example.com")
        assert result == []

        result = service._parse_html_meta_tags("https://example.com")
        assert result == []
