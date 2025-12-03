"""Integration tests for llms.txt link following functionality."""
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.server.services.crawling.crawling_service import CrawlingService


class TestLlmsTxtLinkFollowing:
    """Test suite for llms.txt link following feature."""

    @pytest.fixture
    def service(self):
        """Create a CrawlingService instance for testing."""
        return CrawlingService(crawler=None, supabase_client=None)

    @pytest.fixture
    def supabase_llms_content(self):
        """Return the actual Supabase llms.txt content."""
        return """# Supabase Docs

- [Supabase Guides](https://supabase.com/llms/guides.txt)
- [Supabase Reference (JavaScript)](https://supabase.com/llms/js.txt)
- [Supabase Reference (Dart)](https://supabase.com/llms/dart.txt)
- [Supabase Reference (Swift)](https://supabase.com/llms/swift.txt)
- [Supabase Reference (Kotlin)](https://supabase.com/llms/kotlin.txt)
- [Supabase Reference (Python)](https://supabase.com/llms/python.txt)
- [Supabase Reference (C#)](https://supabase.com/llms/csharp.txt)
- [Supabase CLI Reference](https://supabase.com/llms/cli.txt)
"""

    def test_extract_links_from_supabase_llms_txt(self, service, supabase_llms_content):
        """Test that links are correctly extracted from Supabase llms.txt."""
        url = "https://supabase.com/docs/llms.txt"

        extracted_links = service.url_handler.extract_markdown_links_with_text(
            supabase_llms_content, url
        )

        # Should extract 8 links
        assert len(extracted_links) == 8

        # Verify all extracted links
        expected_links = [
            "https://supabase.com/llms/guides.txt",
            "https://supabase.com/llms/js.txt",
            "https://supabase.com/llms/dart.txt",
            "https://supabase.com/llms/swift.txt",
            "https://supabase.com/llms/kotlin.txt",
            "https://supabase.com/llms/python.txt",
            "https://supabase.com/llms/csharp.txt",
            "https://supabase.com/llms/cli.txt",
        ]

        extracted_urls = [link for link, _ in extracted_links]
        assert extracted_urls == expected_links

    def test_all_links_are_llms_variants(self, service, supabase_llms_content):
        """Test that all extracted links are recognized as llms.txt variants."""
        url = "https://supabase.com/docs/llms.txt"

        extracted_links = service.url_handler.extract_markdown_links_with_text(
            supabase_llms_content, url
        )

        # All links should be recognized as llms variants
        for link, _ in extracted_links:
            is_llms = service.url_handler.is_llms_variant(link)
            assert is_llms, f"Link {link} should be recognized as llms.txt variant"

    def test_all_links_are_same_domain(self, service, supabase_llms_content):
        """Test that all extracted links are from the same domain."""
        url = "https://supabase.com/docs/llms.txt"
        original_domain = "https://supabase.com"

        extracted_links = service.url_handler.extract_markdown_links_with_text(
            supabase_llms_content, url
        )

        # All links should be from the same domain
        for link, _ in extracted_links:
            is_same = service._is_same_domain_or_subdomain(link, original_domain)
            assert is_same, f"Link {link} should match domain {original_domain}"

    def test_filter_llms_links_from_supabase(self, service, supabase_llms_content):
        """Test the complete filtering logic for Supabase llms.txt."""
        url = "https://supabase.com/docs/llms.txt"
        original_domain = "https://supabase.com"

        # Extract all links
        extracted_links = service.url_handler.extract_markdown_links_with_text(
            supabase_llms_content, url
        )

        # Filter for llms.txt files on same domain (mimics actual code)
        llms_links = []
        for link, text in extracted_links:
            if service.url_handler.is_llms_variant(link):
                if service._is_same_domain_or_subdomain(link, original_domain):
                    llms_links.append((link, text))

        # Should have all 8 links
        assert len(llms_links) == 8, f"Expected 8 llms links, got {len(llms_links)}"

    @pytest.mark.asyncio
    async def test_llms_txt_link_following_integration(self, service, supabase_llms_content):
        """Integration test for the complete llms.txt link following flow."""
        url = "https://supabase.com/docs/llms.txt"

        # Mock the crawl_batch_with_progress to verify it's called with correct URLs
        mock_batch_results = [
            {'url': f'https://supabase.com/llms/{name}.txt', 'markdown': f'# {name}', 'title': f'{name}'}
            for name in ['guides', 'js', 'dart', 'swift', 'kotlin', 'python', 'csharp', 'cli']
        ]

        service.crawl_batch_with_progress = AsyncMock(return_value=mock_batch_results)
        service.crawl_markdown_file = AsyncMock(return_value=[{
            'url': url,
            'markdown': supabase_llms_content,
            'title': 'Supabase Docs'
        }])

        # Create progress tracker mock
        service.progress_tracker = MagicMock()
        service.progress_tracker.update = AsyncMock()

        # Simulate the request that would come from orchestration
        request = {
            "is_discovery_target": True,
            "original_domain": "https://supabase.com",
            "max_concurrent": 5
        }

        # Call the actual crawl method
        crawl_results, crawl_type = await service._crawl_by_url_type(url, request)

        # Verify batch crawl was called with the 8 llms.txt URLs
        service.crawl_batch_with_progress.assert_called_once()
        call_args = service.crawl_batch_with_progress.call_args
        crawled_urls = call_args[0][0]  # First positional argument

        assert len(crawled_urls) == 8, f"Should crawl 8 linked files, got {len(crawled_urls)}"

        expected_urls = [
            "https://supabase.com/llms/guides.txt",
            "https://supabase.com/llms/js.txt",
            "https://supabase.com/llms/dart.txt",
            "https://supabase.com/llms/swift.txt",
            "https://supabase.com/llms/kotlin.txt",
            "https://supabase.com/llms/python.txt",
            "https://supabase.com/llms/csharp.txt",
            "https://supabase.com/llms/cli.txt",
        ]

        assert set(crawled_urls) == set(expected_urls)

        # Verify total results include main file + linked pages
        assert len(crawl_results) == 9, f"Should have 9 total pages (1 main + 8 linked), got {len(crawl_results)}"

        # Verify crawl type
        assert crawl_type == "llms_txt_with_linked_pages"

    def test_external_llms_links_are_filtered(self, service):
        """Test that external domain llms.txt links are filtered out."""
        content = """# Test llms.txt

- [Internal Link](https://supabase.com/llms/internal.txt)
- [External Link](https://external.com/llms/external.txt)
- [Another Internal](https://docs.supabase.com/llms/docs.txt)
"""
        url = "https://supabase.com/llms.txt"
        original_domain = "https://supabase.com"

        extracted_links = service.url_handler.extract_markdown_links_with_text(content, url)

        # Filter for same-domain llms links
        llms_links = []
        for link, text in extracted_links:
            if service.url_handler.is_llms_variant(link):
                if service._is_same_domain_or_subdomain(link, original_domain):
                    llms_links.append((link, text))

        # Should only have 2 links (internal and subdomain), external filtered out
        assert len(llms_links) == 2

        urls = [link for link, _ in llms_links]
        assert "https://supabase.com/llms/internal.txt" in urls
        assert "https://docs.supabase.com/llms/docs.txt" in urls
        assert "https://external.com/llms/external.txt" not in urls

    def test_non_llms_links_are_filtered(self, service):
        """Test that non-llms.txt links are filtered out."""
        content = """# Test llms.txt

- [LLMs Link](https://supabase.com/llms/guide.txt)
- [Regular Doc](https://supabase.com/docs/guide)
- [PDF File](https://supabase.com/docs/guide.pdf)
- [Another LLMs](https://supabase.com/llms/api.txt)
"""
        url = "https://supabase.com/llms.txt"
        original_domain = "https://supabase.com"

        extracted_links = service.url_handler.extract_markdown_links_with_text(content, url)

        # Filter for llms links only
        llms_links = []
        for link, text in extracted_links:
            if service.url_handler.is_llms_variant(link):
                if service._is_same_domain_or_subdomain(link, original_domain):
                    llms_links.append((link, text))

        # Should only have 2 llms.txt links
        assert len(llms_links) == 2

        urls = [link for link, _ in llms_links]
        assert "https://supabase.com/llms/guide.txt" in urls
        assert "https://supabase.com/llms/api.txt" in urls
        assert "https://supabase.com/docs/guide" not in urls
        assert "https://supabase.com/docs/guide.pdf" not in urls
