"""
Unit tests for domain filtering functionality
"""

from src.server.models.crawl_models import CrawlConfig
from src.server.services.crawling.domain_filter import DomainFilter


class TestDomainFilter:
    """Test suite for DomainFilter class."""

    def setup_method(self):
        """Set up test fixtures."""
        self.filter = DomainFilter()

    def test_no_config_allows_all(self):
        """Test that no configuration allows all URLs."""
        assert self.filter.is_url_allowed("https://example.com/page", "https://example.com", None) is True
        assert self.filter.is_url_allowed("https://other.com/page", "https://example.com", None) is True

    def test_whitelist_only(self):
        """Test whitelist-only configuration."""
        config = CrawlConfig(
            allowed_domains=["example.com", "docs.example.com"]
        )

        # Should allow whitelisted domains
        assert self.filter.is_url_allowed("https://example.com/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://docs.example.com/api", "https://example.com", config) is True

        # Should block non-whitelisted domains
        assert self.filter.is_url_allowed("https://other.com/page", "https://example.com", config) is False
        assert self.filter.is_url_allowed("https://evil.com", "https://example.com", config) is False

    def test_blacklist_only(self):
        """Test blacklist-only configuration."""
        config = CrawlConfig(
            excluded_domains=["evil.com", "ads.example.com"]
        )

        # Should block blacklisted domains
        assert self.filter.is_url_allowed("https://evil.com/page", "https://example.com", config) is False
        assert self.filter.is_url_allowed("https://ads.example.com/track", "https://example.com", config) is False

        # Should allow non-blacklisted domains
        assert self.filter.is_url_allowed("https://example.com/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://docs.example.com/api", "https://example.com", config) is True

    def test_blacklist_overrides_whitelist(self):
        """Test that blacklist takes priority over whitelist."""
        config = CrawlConfig(
            allowed_domains=["example.com", "blog.example.com"],
            excluded_domains=["blog.example.com"]
        )

        # Blacklist should override whitelist
        assert self.filter.is_url_allowed("https://blog.example.com/post", "https://example.com", config) is False

        # Non-blacklisted whitelisted domain should work
        assert self.filter.is_url_allowed("https://example.com/page", "https://example.com", config) is True

    def test_subdomain_matching(self):
        """Test subdomain matching patterns."""
        config = CrawlConfig(
            allowed_domains=["example.com"]
        )

        # Should match subdomains of allowed domain
        assert self.filter.is_url_allowed("https://docs.example.com/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://api.example.com/v1", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://sub.sub.example.com", "https://example.com", config) is True

        # Should not match different domains
        assert self.filter.is_url_allowed("https://notexample.com", "https://example.com", config) is False

    def test_wildcard_subdomain_matching(self):
        """Test wildcard subdomain patterns."""
        config = CrawlConfig(
            allowed_domains=["*.example.com"]
        )

        # Should match subdomains
        assert self.filter.is_url_allowed("https://docs.example.com/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://api.example.com/v1", "https://example.com", config) is True

        # Should NOT match the base domain without subdomain
        assert self.filter.is_url_allowed("https://example.com/page", "https://example.com", config) is False

    def test_url_patterns_include(self):
        """Test include URL patterns."""
        config = CrawlConfig(
            include_patterns=["*/api/*", "*/docs/*"]
        )

        # Should match include patterns
        assert self.filter.is_url_allowed("https://example.com/api/v1", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://example.com/docs/guide", "https://example.com", config) is True

        # Should not match URLs not in patterns
        assert self.filter.is_url_allowed("https://example.com/blog/post", "https://example.com", config) is False
        assert self.filter.is_url_allowed("https://example.com/", "https://example.com", config) is False

    def test_url_patterns_exclude(self):
        """Test exclude URL patterns."""
        config = CrawlConfig(
            exclude_patterns=["*/private/*", "*.pdf", "*/admin/*"]
        )

        # Should block excluded patterns
        assert self.filter.is_url_allowed("https://example.com/private/data", "https://example.com", config) is False
        assert self.filter.is_url_allowed("https://example.com/file.pdf", "https://example.com", config) is False
        assert self.filter.is_url_allowed("https://example.com/admin/panel", "https://example.com", config) is False

        # Should allow non-excluded URLs
        assert self.filter.is_url_allowed("https://example.com/public/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://example.com/file.html", "https://example.com", config) is True

    def test_combined_filters(self):
        """Test combination of all filter types."""
        config = CrawlConfig(
            allowed_domains=["example.com", "docs.example.com"],
            excluded_domains=["ads.example.com"],
            include_patterns=["*/api/*", "*/guide/*"],
            exclude_patterns=["*/deprecated/*"]
        )

        # Should pass all filters
        assert self.filter.is_url_allowed("https://docs.example.com/api/v2", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://example.com/guide/intro", "https://example.com", config) is True

        # Should fail on blacklist (highest priority)
        assert self.filter.is_url_allowed("https://ads.example.com/api/track", "https://example.com", config) is False

        # Should fail on not in whitelist
        assert self.filter.is_url_allowed("https://other.com/api/v1", "https://example.com", config) is False

        # Should fail on exclude pattern
        assert self.filter.is_url_allowed("https://example.com/api/deprecated/old", "https://example.com", config) is False

        # Should fail on not matching include pattern
        assert self.filter.is_url_allowed("https://example.com/blog/post", "https://example.com", config) is False

    def test_relative_urls(self):
        """Test handling of relative URLs."""
        config = CrawlConfig(
            allowed_domains=["example.com"]
        )

        # Relative URLs should use base URL's domain
        assert self.filter.is_url_allowed("/page/path", "https://example.com", config) is True
        assert self.filter.is_url_allowed("page.html", "https://example.com", config) is True
        assert self.filter.is_url_allowed("../other/page", "https://example.com", config) is True

    def test_domain_normalization(self):
        """Test that domains are properly normalized."""
        config = CrawlConfig(
            allowed_domains=["EXAMPLE.COM", "https://docs.example.com/", "www.test.com"]
        )

        # Should handle different cases and formats
        assert self.filter.is_url_allowed("https://example.com/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://EXAMPLE.COM/PAGE", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://docs.example.com/api", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://www.test.com/page", "https://example.com", config) is True
        assert self.filter.is_url_allowed("https://test.com/page", "https://example.com", config) is True

    def test_edge_cases(self):
        """Test edge cases and error handling."""
        config = CrawlConfig(
            allowed_domains=["example.com"]
        )

        # Should handle malformed URLs gracefully
        assert self.filter.is_url_allowed("not-a-url", "https://example.com", config) is True  # Treated as relative
        assert self.filter.is_url_allowed("", "https://example.com", config) is True  # Empty URL
        assert self.filter.is_url_allowed("//example.com/page", "https://example.com", config) is True  # Protocol-relative

    def test_get_domains_from_urls(self):
        """Test extracting domains from URL list."""
        urls = [
            "https://example.com/page1",
            "https://docs.example.com/api",
            "https://example.com/page2",
            "https://other.com/resource",
            "https://WWW.TEST.COM/page",
            "/relative/path",  # Should be skipped
            "invalid-url",  # Should be skipped
        ]

        domains = self.filter.get_domains_from_urls(urls)

        assert domains == {"example.com", "docs.example.com", "other.com", "test.com"}

    def test_empty_filter_lists(self):
        """Test that empty filter lists behave correctly."""
        config = CrawlConfig(
            allowed_domains=[],
            excluded_domains=[],
            include_patterns=[],
            exclude_patterns=[]
        )

        # Empty lists should be ignored (allow all)
        assert self.filter.is_url_allowed("https://any.com/page", "https://example.com", config) is True
