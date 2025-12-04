"""
Unit tests for sitemap parsing with relative URLs.

Tests the fix for issue #825: Sitemap ingestion fails when XML contains relative URLs
"""
import pytest
from unittest.mock import Mock, patch
from src.server.services.crawling.strategies.sitemap import SitemapCrawlStrategy


class TestSitemapRelativeURLs:
    """Test suite for sitemap parsing with relative URL support."""

    @pytest.fixture
    def sitemap_strategy(self):
        """Fixture to create a SitemapCrawlStrategy instance."""
        return SitemapCrawlStrategy()

    def test_parse_sitemap_with_absolute_urls(self, sitemap_strategy):
        """Test that absolute URLs in sitemaps are preserved correctly."""
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>https://example.com/docs/guide/</loc>
        <lastmod>2020-10-06T08:48:45+00:00</lastmod>
    </url>
    <url>
        <loc>https://example.com/docs/api/</loc>
        <lastmod>2020-10-07T08:48:45+00:00</lastmod>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            assert len(urls) == 2
            assert "https://example.com/docs/guide/" in urls
            assert "https://example.com/docs/api/" in urls

    def test_parse_sitemap_with_relative_urls(self, sitemap_strategy):
        """
        Test that relative URLs in sitemaps are composed to absolute URLs.
        This is the core fix for issue #825.
        """
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>/docs/apps/</loc>
        <lastmod>2020-10-06T08:48:45+00:00</lastmod>
    </url>
    <url>
        <loc>/docs/guides/</loc>
        <lastmod>2020-10-07T08:48:45+00:00</lastmod>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://waha.devlike.pro/docs/sitemap.xml")

            assert len(urls) == 2
            # Relative URLs should be composed to absolute
            assert "https://waha.devlike.pro/docs/apps/" in urls
            assert "https://waha.devlike.pro/docs/guides/" in urls
            # Should NOT contain relative URLs
            assert "/docs/apps/" not in urls
            assert "/docs/guides/" not in urls

    def test_parse_sitemap_with_mixed_urls(self, sitemap_strategy):
        """Test sitemap with both absolute and relative URLs."""
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>https://example.com/docs/absolute/</loc>
    </url>
    <url>
        <loc>/docs/relative/</loc>
    </url>
    <url>
        <loc>https://example.com/api/</loc>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            assert len(urls) == 3
            assert "https://example.com/docs/absolute/" in urls
            assert "https://example.com/docs/relative/" in urls  # Composed from relative
            assert "https://example.com/api/" in urls

    def test_parse_sitemap_with_subdirectory_base(self, sitemap_strategy):
        """Test URL composition when sitemap is in a subdirectory."""
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>/guide/intro</loc>
    </url>
    <url>
        <loc>../about</loc>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/docs/sitemap.xml")

            assert len(urls) == 2
            # Root-relative path
            assert "https://example.com/guide/intro" in urls
            # Parent-relative path
            assert "https://example.com/about" in urls

    def test_parse_sitemap_skips_invalid_urls(self, sitemap_strategy):
        """Test that invalid URLs are skipped gracefully."""
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>https://example.com/valid/</loc>
    </url>
    <url>
        <loc></loc>
    </url>
    <url>
        <loc>   </loc>
    </url>
    <url>
        <loc>mailto:test@example.com</loc>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            # Should only extract valid HTTP(S) URLs
            assert len(urls) == 1
            assert "https://example.com/valid/" in urls
            # Should skip empty, whitespace, and non-http URLs
            assert "" not in urls
            assert "mailto:test@example.com" not in urls

    def test_parse_sitemap_http_error(self, sitemap_strategy):
        """Test handling of HTTP errors when fetching sitemap."""
        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 404
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            # Should return empty list on HTTP error
            assert urls == []

    def test_parse_sitemap_network_error(self, sitemap_strategy):
        """Test handling of network errors when fetching sitemap."""
        import requests

        with patch('requests.get') as mock_get:
            mock_get.side_effect = requests.exceptions.ConnectionError("Connection refused")

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            # Should return empty list on network error
            assert urls == []

    def test_parse_sitemap_malformed_xml(self, sitemap_strategy):
        """Test handling of malformed XML in sitemap."""
        malformed_xml = b"<urlset><url><loc>Not properly closed"

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = malformed_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            # Should return empty list on XML parse error
            assert urls == []

    def test_parse_sitemap_url_trimming(self, sitemap_strategy):
        """Test that URLs with whitespace are trimmed correctly."""
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>  /docs/guide/  </loc>
    </url>
    <url>
        <loc>
            /docs/api/
        </loc>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://example.com/sitemap.xml")

            assert len(urls) == 2
            # URLs should be trimmed
            assert "https://example.com/docs/guide/" in urls
            assert "https://example.com/docs/api/" in urls

    def test_parse_sitemap_real_world_waha_example(self, sitemap_strategy):
        """
        Test with real-world example from issue #825.
        This is the exact sitemap format from waha.devlike.pro.
        """
        sitemap_xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>/docs/apps/</loc>
        <lastmod>2020-10-06T08:48:45+00:00</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.5</priority>
    </url>
    <url>
        <loc>/docs/overview/</loc>
        <lastmod>2020-10-07T08:48:45+00:00</lastmod>
        <changefreq>monthly</changefreq>
        <priority>0.5</priority>
    </url>
</urlset>"""

        with patch('requests.get') as mock_get:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.content = sitemap_xml
            mock_get.return_value = mock_response

            urls = sitemap_strategy.parse_sitemap("https://waha.devlike.pro/docs/sitemap.xml")

            # Should successfully parse and compose all URLs
            assert len(urls) == 2
            assert "https://waha.devlike.pro/docs/apps/" in urls
            assert "https://waha.devlike.pro/docs/overview/" in urls

            # Should not contain the raw relative paths
            assert "/docs/apps/" not in urls
            assert "/docs/overview/" not in urls

