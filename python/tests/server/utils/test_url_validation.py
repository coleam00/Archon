"""
Tests for URL validation and security utilities.

This module tests SSRF protection and glob pattern sanitization
to ensure the preview-links endpoint is secure.
"""

import pytest
from fastapi import HTTPException

from src.server.utils.url_validation import (
    sanitize_glob_patterns,
    validate_url_against_ssrf,
)


class TestSSRFProtection:
    """Test SSRF (Server-Side Request Forgery) protection in URL validation."""

    def test_blocks_localhost_hostname(self):
        """Should block localhost URLs."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("http://localhost:8080/admin")

        assert exc.value.status_code == 400
        assert "localhost" in str(exc.value.detail).lower()

    def test_blocks_localhost_variations(self):
        """Should block various localhost representations."""
        localhost_urls = [
            "http://localhost/",
            "http://LOCALHOST/",
            "http://localhost.localdomain/",
            "https://localhost:443/",
        ]

        for url in localhost_urls:
            with pytest.raises(HTTPException) as exc:
                validate_url_against_ssrf(url)
            assert exc.value.status_code == 400

    def test_blocks_loopback_ip(self):
        """Should block 127.0.0.1 loopback address."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("http://127.0.0.1/internal")

        assert exc.value.status_code == 400
        assert "localhost" in str(exc.value.detail).lower()

    def test_blocks_ipv6_loopback(self):
        """Should block IPv6 loopback address ::1."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("http://[::1]/admin")

        assert exc.value.status_code == 400

    def test_blocks_zero_address(self):
        """Should block 0.0.0.0 address."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("http://0.0.0.0/")

        assert exc.value.status_code == 400

    def test_blocks_private_ip_ranges(self):
        """Should block RFC 1918 private IP ranges."""
        private_urls = [
            "http://192.168.1.1/admin",
            "http://192.168.0.1/internal",
            "http://10.0.0.1/private",
            "http://10.10.10.10/secret",
            "http://172.16.0.1/internal",
            "http://172.20.1.1/admin",
        ]

        for url in private_urls:
            with pytest.raises(HTTPException) as exc:
                validate_url_against_ssrf(url)
            assert exc.value.status_code == 400
            assert "private" in str(exc.value.detail).lower() or "internal" in str(exc.value.detail).lower()

    def test_blocks_file_protocol(self):
        """Should block file:// protocol."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("file:///etc/passwd")

        assert exc.value.status_code == 400
        assert "protocol" in str(exc.value.detail).lower()

    def test_blocks_ftp_protocol(self):
        """Should block non-HTTP protocols."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("ftp://example.com/file.txt")

        assert exc.value.status_code == 400
        assert "protocol" in str(exc.value.detail).lower()

    def test_blocks_data_protocol(self):
        """Should block data: URLs."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("data:text/plain,Hello")

        assert exc.value.status_code == 400

    def test_allows_public_https_urls(self):
        """Should allow public HTTPS URLs."""
        public_urls = [
            "https://docs.example.com",
            "https://api.github.com",
            "https://www.google.com",
            "https://claude.ai/docs",
        ]

        for url in public_urls:
            # Should not raise
            validate_url_against_ssrf(url)

    def test_allows_public_http_urls(self):
        """Should allow public HTTP URLs (for backward compatibility)."""
        # Should not raise
        validate_url_against_ssrf("http://example.com/page")

    def test_rejects_missing_hostname(self):
        """Should reject URLs without hostname."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("http:///path")

        assert exc.value.status_code == 400
        assert "hostname" in str(exc.value.detail).lower()

    def test_rejects_invalid_protocol(self):
        """Should reject URLs with invalid protocol."""
        with pytest.raises(HTTPException) as exc:
            validate_url_against_ssrf("javascript:alert(1)")

        assert exc.value.status_code == 400

    def test_handles_dns_resolution_failure_gracefully(self):
        """Should allow URLs with unresolvable hostnames (DNS failure)."""
        # Use a domain that doesn't exist but passes syntax validation
        # DNS lookup will fail with socket.gaierror, which should be caught
        validate_url_against_ssrf("https://thisdomaindoesnotexistatall123456.com")
        # Should not raise - DNS failures are allowed to pass through

    def test_handles_malformed_url_gracefully(self):
        """Should handle unexpected URL parsing errors."""
        # This tests the generic exception handler (lines 86-87)
        # Use a URL that causes unexpected parsing behavior
        with pytest.raises(HTTPException) as exc:
            # Pass None to trigger unexpected error
            validate_url_against_ssrf(None)  # type: ignore

        assert exc.value.status_code == 400
        # Will catch at protocol validation or generic handler
        assert "protocol" in str(exc.value.detail).lower() or "validation failed" in str(exc.value.detail).lower()


class TestGlobPatternSanitization:
    """Test glob pattern input validation and sanitization."""

    def test_sanitizes_valid_patterns(self):
        """Should accept and return valid glob patterns."""
        patterns = ["**/en/**", "**/docs/**", "*.html", "page-*.md"]
        result = sanitize_glob_patterns(patterns)

        assert result == patterns

    def test_returns_empty_for_empty_input(self):
        """Should handle empty pattern list."""
        result = sanitize_glob_patterns([])
        assert result == []

    def test_returns_empty_for_none_input(self):
        """Should handle None input."""
        result = sanitize_glob_patterns(None)
        assert result == []

    def test_strips_whitespace_from_patterns(self):
        """Should strip leading and trailing whitespace."""
        patterns = ["  **/en/**  ", "\t**/docs/**\n", " *.html "]
        result = sanitize_glob_patterns(patterns)

        assert result == ["**/en/**", "**/docs/**", "*.html"]

    def test_filters_empty_patterns_after_strip(self):
        """Should remove patterns that become empty after stripping."""
        patterns = ["**/en/**", "   ", "", "\t\n", "**/docs/**"]
        result = sanitize_glob_patterns(patterns)

        assert result == ["**/en/**", "**/docs/**"]

    def test_rejects_path_traversal_attempts(self):
        """Should reject path traversal patterns."""
        dangerous_patterns = [
            ["../../etc/passwd"],
            ["../../../secret"],
            ["**/../../config"],
            ["test/../secret"],
        ]

        for patterns in dangerous_patterns:
            with pytest.raises(HTTPException) as exc:
                sanitize_glob_patterns(patterns)
            assert exc.value.status_code == 400
            assert "path traversal" in str(exc.value.detail).lower()

    def test_rejects_command_injection_attempts(self):
        """Should reject patterns with command injection attempts."""
        dangerous_patterns = [
            ["$(rm -rf /)"],
            ["`whoami`"],
            ["$(cat /etc/passwd)"],
            ["; ls -la"],
            ["| cat /etc/passwd"],
        ]

        for patterns in dangerous_patterns:
            with pytest.raises(HTTPException) as exc:
                sanitize_glob_patterns(patterns)
            assert exc.value.status_code == 400

    def test_rejects_patterns_with_null_bytes(self):
        """Should reject patterns containing null bytes."""
        with pytest.raises(HTTPException):
            sanitize_glob_patterns(["path\x00/file"])

    def test_limits_pattern_count(self):
        """Should limit number of patterns to prevent DoS."""
        # Create more than MAX_PATTERNS (50)
        patterns = [f"pattern{i}" for i in range(100)]

        with pytest.raises(HTTPException) as exc:
            sanitize_glob_patterns(patterns)

        assert exc.value.status_code == 400
        assert "too many" in str(exc.value.detail).lower()

    def test_limits_individual_pattern_length(self):
        """Should limit individual pattern length."""
        # Create pattern longer than 200 characters
        long_pattern = "a" * 250

        with pytest.raises(HTTPException) as exc:
            sanitize_glob_patterns([long_pattern])

        assert exc.value.status_code == 400
        assert "too long" in str(exc.value.detail).lower()

    def test_allows_common_glob_patterns(self):
        """Should allow common legitimate glob patterns."""
        common_patterns = [
            "**/en/**",
            "**/docs/*.md",
            "page-*.html",
            "**/*.{js,ts}",
            "**/v2/**",
            "*.txt",
            "**",
            "*",
        ]

        result = sanitize_glob_patterns(common_patterns)
        assert len(result) == len(common_patterns)

    def test_allows_patterns_with_safe_special_chars(self):
        """Should allow patterns with safe special characters."""
        safe_patterns = [
            "file-name.txt",
            "path/to/file",
            "**/*-v2.*.md",
            "docs_2024.html",
        ]

        result = sanitize_glob_patterns(safe_patterns)
        assert result == safe_patterns

    def test_rejects_patterns_with_unicode_exploits(self):
        """Should reject patterns with potentially dangerous Unicode."""
        # Patterns with Unicode that could be interpreted differently
        dangerous_patterns = [
            ["file\u202ename.txt"],  # Right-to-left override
            ["path\ufefffile"],      # Zero-width no-break space
        ]

        for patterns in dangerous_patterns:
            with pytest.raises(HTTPException):
                sanitize_glob_patterns(patterns)

    def test_rejects_patterns_with_control_characters(self):
        """Should reject patterns with control characters."""
        with pytest.raises(HTTPException):
            sanitize_glob_patterns(["file\nname"])

        with pytest.raises(HTTPException):
            sanitize_glob_patterns(["file\rname"])

    def test_case_insensitive_alphanumeric(self):
        """Should allow both uppercase and lowercase alphanumeric."""
        patterns = ["Path/To/File", "UPPER/lower/MiXeD"]
        result = sanitize_glob_patterns(patterns)

        assert result == patterns


class TestIntegrationScenarios:
    """Integration tests combining URL validation and pattern sanitization."""

    def test_typical_docs_crawl_scenario(self):
        """Should handle typical documentation crawl scenario."""
        url = "https://docs.example.com/llms.txt"
        include_patterns = ["**/en/**", "**/docs/**"]
        exclude_patterns = ["**/fr/**", "**/de/**"]

        # Should not raise
        validate_url_against_ssrf(url)
        sanitized_include = sanitize_glob_patterns(include_patterns)
        sanitized_exclude = sanitize_glob_patterns(exclude_patterns)

        assert sanitized_include == include_patterns
        assert sanitized_exclude == exclude_patterns

    def test_malicious_request_blocked(self):
        """Should block request with both malicious URL and patterns."""
        url = "http://localhost/admin"
        patterns = ["../../etc/passwd", "$(whoami)"]

        # URL validation should fail
        with pytest.raises(HTTPException):
            validate_url_against_ssrf(url)

        # Pattern validation should also fail
        with pytest.raises(HTTPException):
            sanitize_glob_patterns(patterns)

    def test_edge_case_empty_patterns(self):
        """Should handle valid URL with empty patterns."""
        url = "https://example.com/docs"

        # Should not raise
        validate_url_against_ssrf(url)
        result = sanitize_glob_patterns([])

        assert result == []

    def test_sitemap_url_validation(self):
        """Should handle sitemap.xml URLs correctly."""
        sitemap_urls = [
            "https://example.com/sitemap.xml",
            "https://docs.site.com/sitemap_index.xml",
        ]

        for url in sitemap_urls:
            # Should not raise
            validate_url_against_ssrf(url)
