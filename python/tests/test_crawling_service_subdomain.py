"""Unit tests for CrawlingService subdomain checking functionality."""
import pytest

from src.server.services.crawling.crawling_service import CrawlingService


class TestCrawlingServiceSubdomain:
    """Test suite for CrawlingService subdomain checking methods."""

    @pytest.fixture
    def service(self):
        """Create a CrawlingService instance for testing."""
        # Create service without crawler or supabase for testing domain checking
        return CrawlingService(crawler=None, supabase_client=None)

    def test_is_same_domain_or_subdomain_exact_match(self, service):
        """Test exact domain matches."""
        # Same domain should match
        assert service._is_same_domain_or_subdomain(
            "https://supabase.com/docs",
            "https://supabase.com"
        ) is True

        assert service._is_same_domain_or_subdomain(
            "https://supabase.com/path/to/page",
            "https://supabase.com"
        ) is True

    def test_is_same_domain_or_subdomain_subdomains(self, service):
        """Test subdomain matching."""
        # Subdomain should match
        assert service._is_same_domain_or_subdomain(
            "https://docs.supabase.com/llms.txt",
            "https://supabase.com"
        ) is True

        assert service._is_same_domain_or_subdomain(
            "https://api.supabase.com/v1/endpoint",
            "https://supabase.com"
        ) is True

        # Multiple subdomain levels
        assert service._is_same_domain_or_subdomain(
            "https://dev.api.supabase.com/test",
            "https://supabase.com"
        ) is True

    def test_is_same_domain_or_subdomain_different_domains(self, service):
        """Test that different domains are rejected."""
        # Different domain should not match
        assert service._is_same_domain_or_subdomain(
            "https://external.com/llms.txt",
            "https://supabase.com"
        ) is False

        assert service._is_same_domain_or_subdomain(
            "https://docs.other-site.com",
            "https://supabase.com"
        ) is False

        # Similar but different domains
        assert service._is_same_domain_or_subdomain(
            "https://supabase.org",
            "https://supabase.com"
        ) is False

    def test_is_same_domain_or_subdomain_protocols(self, service):
        """Test that protocol differences don't affect matching."""
        # Different protocols should still match
        assert service._is_same_domain_or_subdomain(
            "http://supabase.com/docs",
            "https://supabase.com"
        ) is True

        assert service._is_same_domain_or_subdomain(
            "https://docs.supabase.com",
            "http://supabase.com"
        ) is True

    def test_is_same_domain_or_subdomain_ports(self, service):
        """Test handling of port numbers."""
        # Same root domain with different ports should match
        assert service._is_same_domain_or_subdomain(
            "https://supabase.com:8080/api",
            "https://supabase.com"
        ) is True

        assert service._is_same_domain_or_subdomain(
            "http://localhost:3000/dev",
            "http://localhost:8080"
        ) is True

    def test_is_same_domain_or_subdomain_edge_cases(self, service):
        """Test edge cases and error handling."""
        # Empty or malformed URLs should return False
        assert service._is_same_domain_or_subdomain(
            "",
            "https://supabase.com"
        ) is False

        assert service._is_same_domain_or_subdomain(
            "https://supabase.com",
            ""
        ) is False

        assert service._is_same_domain_or_subdomain(
            "not-a-url",
            "https://supabase.com"
        ) is False

    def test_is_same_domain_or_subdomain_real_world_examples(self, service):
        """Test with real-world examples."""
        # GitHub examples
        assert service._is_same_domain_or_subdomain(
            "https://api.github.com/repos",
            "https://github.com"
        ) is True

        assert service._is_same_domain_or_subdomain(
            "https://raw.githubusercontent.com/owner/repo",
            "https://github.com"
        ) is False  # githubusercontent.com is different root domain

        # Documentation sites
        assert service._is_same_domain_or_subdomain(
            "https://docs.python.org/3/library",
            "https://python.org"
        ) is True

        assert service._is_same_domain_or_subdomain(
            "https://api.stripe.com/v1",
            "https://stripe.com"
        ) is True

    def test_is_same_domain_backward_compatibility(self, service):
        """Test that _is_same_domain still works correctly for exact matches."""
        # Exact domain match should work
        assert service._is_same_domain(
            "https://supabase.com/docs",
            "https://supabase.com"
        ) is True

        # Subdomain should NOT match with _is_same_domain (only with _is_same_domain_or_subdomain)
        assert service._is_same_domain(
            "https://docs.supabase.com/llms.txt",
            "https://supabase.com"
        ) is False

        # Different domain should not match
        assert service._is_same_domain(
            "https://external.com/llms.txt",
            "https://supabase.com"
        ) is False
