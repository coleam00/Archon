"""
Unit tests for URLHandler.matches_glob_patterns() function.

Tests glob pattern filtering logic for URL path matching, which is the core
feature of PR #847's link review functionality.
"""

import pytest
from src.server.services.crawling.helpers.url_handler import URLHandler


class TestMatchesGlobPatterns:
    """Test suite for glob pattern matching logic."""

    @pytest.fixture
    def url_handler(self):
        """Create URLHandler instance for testing."""
        return URLHandler()

    def test_no_patterns_accepts_all_urls(self, url_handler):
        """Should accept all URLs when no patterns specified."""
        urls = [
            "https://docs.example.com/en/intro",
            "https://docs.example.com/fr/guide",
            "https://docs.example.com/api/reference",
            "https://docs.example.com/",
        ]

        for url in urls:
            assert url_handler.matches_glob_patterns(url) is True

    def test_include_pattern_single_match(self, url_handler):
        """Should accept URLs matching include pattern."""
        include = ["**/en/**"]

        # Should match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/intro", include
        ) is True
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/v1/en/api", include
        ) is True

    def test_include_pattern_single_no_match(self, url_handler):
        """Should reject URLs not matching include pattern."""
        include = ["**/en/**"]

        # Should not match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/fr/intro", include
        ) is False
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/de/guide", include
        ) is False

    def test_include_pattern_multiple(self, url_handler):
        """Should accept URLs matching ANY include pattern."""
        include = ["**/en/**", "**/docs/**"]

        # Match first pattern
        assert url_handler.matches_glob_patterns(
            "https://example.com/en/intro", include
        ) is True

        # Match second pattern
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/guide", include
        ) is True

        # Match both patterns
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/en/api", include
        ) is True

        # Match neither pattern
        assert url_handler.matches_glob_patterns(
            "https://example.com/fr/guide", include
        ) is False

    def test_exclude_pattern_single(self, url_handler):
        """Should reject URLs matching exclude pattern."""
        exclude = ["**/api/**"]

        # Should be excluded
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/api/reference", exclude_patterns=exclude
        ) is False
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/v1/api/intro", exclude_patterns=exclude
        ) is False

        # Should be included (no exclude match)
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/guides/intro", exclude_patterns=exclude
        ) is True

    def test_exclude_pattern_multiple(self, url_handler):
        """Should reject URLs matching ANY exclude pattern."""
        exclude = ["**/fr/**", "**/de/**", "**/api/**"]

        # Should be excluded (match one pattern)
        assert url_handler.matches_glob_patterns(
            "https://example.com/fr/intro", exclude_patterns=exclude
        ) is False
        assert url_handler.matches_glob_patterns(
            "https://example.com/de/guide", exclude_patterns=exclude
        ) is False
        assert url_handler.matches_glob_patterns(
            "https://example.com/api/v1", exclude_patterns=exclude
        ) is False

        # Should be included (no exclude match)
        assert url_handler.matches_glob_patterns(
            "https://example.com/en/intro", exclude_patterns=exclude
        ) is True

    def test_include_and_exclude_both_specified(self, url_handler):
        """Exclude patterns should take precedence over include patterns."""
        include = ["**/en/**"]
        exclude = ["**/api/**"]

        # Match include, no exclude → accept
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/intro", include, exclude
        ) is True

        # Match both include and exclude → reject (exclude wins)
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/api/intro", include, exclude
        ) is False

        # No include match, no exclude match → reject
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/fr/intro", include, exclude
        ) is False

    def test_docstring_examples(self, url_handler):
        """Test examples from function docstring."""
        # Example 1: Include pattern match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/intro", ["**/en/**"]
        ) is True

        # Example 2: Include pattern no match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/fr/intro", ["**/en/**"]
        ) is False

        # Example 3: Include match, no exclude match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/intro", ["**/en/**"], ["**/api/**"]
        ) is True

        # Example 4: Include and exclude both match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/api/intro", ["**/en/**"], ["**/api/**"]
        ) is False

    def test_pattern_with_file_extensions(self, url_handler):
        """Should match patterns with file extensions."""
        include = ["**/*.md", "**/*.txt"]

        # Should match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/readme.md", include
        ) is True
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/guides/intro.txt", include
        ) is True

        # Should not match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/page.html", include
        ) is False

    def test_pattern_with_exact_paths(self, url_handler):
        """Should match exact path patterns."""
        include = ["/docs/guides/*"]

        # Should match (exact path)
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/guides/intro", include
        ) is True

        # Should not match (different path)
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/api/intro", include
        ) is False

        # fnmatch * matches any characters including /, so this WILL match
        # This is expected behavior for Unix-style glob patterns
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/guides/en/intro", include
        ) is True

    def test_pattern_with_wildcards(self, url_handler):
        """Should handle wildcards in patterns."""
        # In fnmatch, * matches any sequence of characters (including /)
        # Note: fnmatch doesn't distinguish between * and ** like gitignore does
        include_pattern = ["/docs/*/intro"]

        # Both of these match because * matches any characters including /
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/en/intro", include_pattern
        ) is True
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/en/v1/intro", include_pattern
        ) is True

        # Test ** pattern (behaves same as * in fnmatch)
        include_double = ["/docs/**/intro"]
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/en/intro", include_double
        ) is True
        assert url_handler.matches_glob_patterns(
            "https://example.com/docs/en/v1/intro", include_double
        ) is True

    def test_url_without_path(self, url_handler):
        """Should handle URLs without path (root)."""
        include = ["**/en/**"]

        # Root URL should not match specific path patterns
        assert url_handler.matches_glob_patterns(
            "https://example.com/", include
        ) is False
        assert url_handler.matches_glob_patterns(
            "https://example.com", include
        ) is False

    def test_url_normalization(self, url_handler):
        """Should normalize paths consistently."""
        include = ["/en/**"]

        # Both should behave the same after normalization
        assert url_handler.matches_glob_patterns(
            "https://example.com/en/intro", include
        ) is True
        assert url_handler.matches_glob_patterns(
            "https://example.com/en/guides/page", include
        ) is True

    def test_case_sensitive_matching(self, url_handler):
        """Pattern matching should be case-sensitive by default."""
        include = ["**/EN/**"]

        # Different case should not match
        assert url_handler.matches_glob_patterns(
            "https://example.com/en/intro", include
        ) is False

        # Same case should match
        assert url_handler.matches_glob_patterns(
            "https://example.com/EN/intro", include
        ) is True

    def test_real_world_documentation_patterns(self, url_handler):
        """Test patterns commonly used for documentation sites."""
        # Include only English docs, exclude API references
        include = ["**/en/**"]
        exclude = ["**/api/**", "**/reference/**"]

        # Should include: English guides
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/guides/getting-started", include, exclude
        ) is True

        # Should exclude: API reference even if English (exclude wins)
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/api/endpoints", include, exclude
        ) is False

        # Should exclude: Non-English guides (doesn't match include pattern)
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/fr/guides/intro", include, exclude
        ) is False

        # Should exclude: Generic guides not under /en/
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/guides/intro", include, exclude
        ) is False

    def test_llms_txt_style_patterns(self, url_handler):
        """Test patterns for filtering llms.txt link collections."""
        # Common pattern: Include English docs, exclude translations
        include = ["**/en/**"]
        exclude = ["**/fr/**", "**/de/**", "**/es/**", "**/ja/**"]

        # English docs should match
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/en/docs/overview", include, exclude
        ) is True

        # French docs should be excluded
        assert url_handler.matches_glob_patterns(
            "https://docs.example.com/fr/docs/overview", include, exclude
        ) is False

    def test_sitemap_style_patterns(self, url_handler):
        """Test patterns for filtering sitemap.xml URLs."""
        # Include only blog posts, exclude admin pages
        include = ["**/blog/**"]
        exclude = ["**/admin/**", "**/draft/**"]

        # Blog posts should match
        assert url_handler.matches_glob_patterns(
            "https://example.com/blog/2024/my-post", include, exclude
        ) is True

        # Admin pages should be excluded
        assert url_handler.matches_glob_patterns(
            "https://example.com/blog/admin/editor", include, exclude
        ) is False

        # Draft posts should be excluded
        assert url_handler.matches_glob_patterns(
            "https://example.com/blog/draft/unpublished", include, exclude
        ) is False

    def test_error_handling_invalid_url(self, url_handler):
        """Should handle invalid URLs gracefully."""
        include = ["**/en/**"]

        # urlparse doesn't validate, it just parses
        # Invalid URL will have path that doesn't match pattern
        result = url_handler.matches_glob_patterns("not-a-valid-url", include)
        # Parsed as path, won't match **/en/** pattern
        assert result is False

        # URL without pattern should accept all (even invalid ones)
        result_no_pattern = url_handler.matches_glob_patterns("not-a-valid-url")
        assert result_no_pattern is True

    def test_empty_pattern_lists(self, url_handler):
        """Should handle empty pattern lists correctly."""
        # Empty lists should behave same as None
        assert url_handler.matches_glob_patterns(
            "https://example.com/en/intro", [], []
        ) is True

        assert url_handler.matches_glob_patterns(
            "https://example.com/en/intro", None, None
        ) is True
