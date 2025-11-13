"""
Integration tests for /crawl/preview-links endpoint with glob pattern filtering.

Tests the complete flow of link discovery (llms.txt, llms-full.txt, sitemap.xml)
combined with glob pattern filtering, which is the core feature of PR #847.

Per Contributing Guidelines: Tests all required discovery types.
"""

from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from fastapi import HTTPException

# Sample llms.txt content (from https://docs.mem0.ai/llms.txt)
SAMPLE_LLMS_TXT = """# Mem0 Documentation

- [Introduction](https://docs.mem0.ai/en/introduction)
- [Getting Started](https://docs.mem0.ai/en/getting-started)
- [API Reference](https://docs.mem0.ai/en/api/overview)
- [Python SDK](https://docs.mem0.ai/en/guides/python)
- [French Guide](https://docs.mem0.ai/fr/guides/intro)
- [German Guide](https://docs.mem0.ai/de/guides/intro)
"""

# Sample llms-full.txt content (full documentation with embedded links)
SAMPLE_LLMS_FULL_TXT = """# Introduction

Welcome to Mem0 documentation. Read more at [Introduction](https://docs.mem0.ai/en/introduction).

# Getting Started

## Installation

Install via pip. See our [Getting Started Guide](https://docs.mem0.ai/en/getting-started).

```
pip install mem0ai
```

# API Reference

## Endpoints

### POST /api/memories

Create a new memory. Full details at [API Reference](https://docs.mem0.ai/en/api/overview).
"""

# Sample sitemap.xml content (from https://mem0.ai/sitemap.xml)
SAMPLE_SITEMAP_XML = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>https://mem0.ai/blog/2024/memory-ai</loc>
        <lastmod>2024-01-15</lastmod>
    </url>
    <url>
        <loc>https://mem0.ai/blog/2024/embeddings</loc>
        <lastmod>2024-01-20</lastmod>
    </url>
    <url>
        <loc>https://mem0.ai/docs/overview</loc>
        <lastmod>2024-01-10</lastmod>
    </url>
    <url>
        <loc>https://mem0.ai/admin/settings</loc>
        <lastmod>2024-01-05</lastmod>
    </url>
</urlset>
"""


class TestPreviewLinksWithGlobPatterns:
    """Test preview-links endpoint with glob pattern filtering."""

    @pytest.fixture
    def mock_aiohttp_session(self):
        """Mock aiohttp session for HTTP requests."""
        with patch("aiohttp.ClientSession") as mock_session:
            yield mock_session

    @pytest.fixture
    def mock_crawler(self):
        """Mock crawler instance."""
        with patch("src.server.api_routes.knowledge_api.get_crawler") as mock:
            mock.return_value = AsyncMock()
            yield mock

    @pytest.fixture
    def mock_supabase(self):
        """Mock Supabase client."""
        with patch("src.server.api_routes.knowledge_api.get_supabase_client") as mock:
            mock.return_value = Mock()
            yield mock

    @pytest.mark.asyncio
    async def test_llms_txt_with_include_pattern(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test llms.txt discovery with include pattern filtering."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Mock HTTP response with proper async context manager
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=SAMPLE_LLMS_TXT)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session_instance = MagicMock()
        mock_session_instance.get.return_value = mock_response
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
        mock_session_instance.__aexit__ = AsyncMock(return_value=None)
        mock_aiohttp_session.return_value = mock_session_instance

        # Create request with include pattern for English docs only
        request = LinkPreviewRequest(
            url="https://docs.mem0.ai/llms.txt",
            url_include_patterns=["**/en/**"],
            url_exclude_patterns=[]
        )

        # Call endpoint
        result = await preview_link_collection(request)

        # Verify response structure
        assert result["is_link_collection"] is True
        assert result["collection_type"] == "llms-txt"
        assert result["source_url"] == "https://docs.mem0.ai/llms.txt"
        assert result["total_links"] == 6  # All links in file

        # Verify glob filtering worked
        matching_links = [link for link in result["links"] if link["matches_filter"]]
        non_matching_links = [link for link in result["links"] if not link["matches_filter"]]

        # Should match: 4 English links
        assert result["matching_links"] == 4
        assert len(matching_links) == 4

        # Should NOT match: 2 non-English links (fr, de)
        assert len(non_matching_links) == 2

        # Verify specific links
        english_urls = [link["url"] for link in matching_links]
        assert "https://docs.mem0.ai/en/introduction" in english_urls
        assert "https://docs.mem0.ai/en/getting-started" in english_urls
        assert "https://docs.mem0.ai/en/api/overview" in english_urls
        assert "https://docs.mem0.ai/en/guides/python" in english_urls

        non_english_urls = [link["url"] for link in non_matching_links]
        assert "https://docs.mem0.ai/fr/guides/intro" in non_english_urls
        assert "https://docs.mem0.ai/de/guides/intro" in non_english_urls

    @pytest.mark.asyncio
    async def test_llms_txt_with_exclude_pattern(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test llms.txt discovery with exclude pattern filtering."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Mock HTTP response (context manager)
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=SAMPLE_LLMS_TXT)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock()
        # Mock session instance
        mock_session_instance = MagicMock()
        mock_session_instance.get.return_value = mock_response
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
        mock_session_instance.__aexit__ = AsyncMock()
        mock_aiohttp_session.return_value = mock_session_instance

        # Create request excluding API references
        request = LinkPreviewRequest(
            url="https://docs.mem0.ai/llms.txt",
            url_include_patterns=[],
            url_exclude_patterns=["**/api/**"]
        )

        # Call endpoint
        result = await preview_link_collection(request)

        # Verify filtering
        matching_links = [link for link in result["links"] if link["matches_filter"]]
        excluded_links = [link for link in result["links"] if not link["matches_filter"]]

        # Should exclude: 1 API link
        assert len(excluded_links) == 1
        assert excluded_links[0]["url"] == "https://docs.mem0.ai/en/api/overview"

        # Should include: 5 non-API links
        assert len(matching_links) == 5

    @pytest.mark.asyncio
    async def test_llms_txt_with_include_and_exclude_patterns(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test llms.txt with both include and exclude patterns."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Mock HTTP response (context manager)
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=SAMPLE_LLMS_TXT)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock()
        # Mock session instance
        mock_session_instance = MagicMock()
        mock_session_instance.get.return_value = mock_response
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
        mock_session_instance.__aexit__ = AsyncMock()
        mock_aiohttp_session.return_value = mock_session_instance

        # Create request: Include English, exclude API
        request = LinkPreviewRequest(
            url="https://docs.mem0.ai/llms.txt",
            url_include_patterns=["**/en/**"],
            url_exclude_patterns=["**/api/**"]
        )

        # Call endpoint
        result = await preview_link_collection(request)

        # Verify filtering: Should match English non-API links only
        matching_links = [link for link in result["links"] if link["matches_filter"]]
        assert len(matching_links) == 3  # English links - API link

        matching_urls = [link["url"] for link in matching_links]
        assert "https://docs.mem0.ai/en/introduction" in matching_urls
        assert "https://docs.mem0.ai/en/getting-started" in matching_urls
        assert "https://docs.mem0.ai/en/guides/python" in matching_urls

        # Should NOT match: API (excluded) and non-English (not included)
        non_matching_links = [link for link in result["links"] if not link["matches_filter"]]
        assert len(non_matching_links) == 3

    @pytest.mark.asyncio
    async def test_llms_txt_with_no_patterns(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test llms.txt with no patterns (accept all)."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Mock HTTP response (context manager)
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=SAMPLE_LLMS_TXT)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock()
        # Mock session instance
        mock_session_instance = MagicMock()
        mock_session_instance.get.return_value = mock_response
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
        mock_session_instance.__aexit__ = AsyncMock()
        mock_aiohttp_session.return_value = mock_session_instance

        # Create request with no patterns
        request = LinkPreviewRequest(
            url="https://docs.mem0.ai/llms.txt",
            url_include_patterns=[],
            url_exclude_patterns=[]
        )

        # Call endpoint
        result = await preview_link_collection(request)

        # All links should match when no patterns specified
        assert result["matching_links"] == result["total_links"]
        assert all(link["matches_filter"] for link in result["links"])

    @pytest.mark.asyncio
    async def test_sitemap_xml_with_glob_patterns(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test sitemap.xml discovery with glob pattern filtering."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection
        from src.server.services.crawling.crawling_service import CrawlingService

        # Mock sitemap parsing
        with patch.object(CrawlingService, 'parse_sitemap') as mock_parse:
            mock_parse.return_value = [
                "https://mem0.ai/blog/2024/memory-ai",
                "https://mem0.ai/blog/2024/embeddings",
                "https://mem0.ai/docs/overview",
                "https://mem0.ai/admin/settings"
            ]

            # Create request: Include blog posts, exclude admin
            request = LinkPreviewRequest(
                url="https://mem0.ai/sitemap.xml",
                url_include_patterns=["**/blog/**"],
                url_exclude_patterns=["**/admin/**"]
            )

            # Call endpoint
            result = await preview_link_collection(request)

            # Verify sitemap detected
            assert result["collection_type"] == "sitemap"

            # Verify filtering
            matching_links = [link for link in result["links"] if link["matches_filter"]]
            assert len(matching_links) == 2  # Only blog posts

            matching_urls = [link["url"] for link in matching_links]
            assert "https://mem0.ai/blog/2024/memory-ai" in matching_urls
            assert "https://mem0.ai/blog/2024/embeddings" in matching_urls

    @pytest.mark.asyncio
    async def test_llms_full_txt_with_patterns(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test llms-full.txt discovery with glob patterns."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Mock HTTP response
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=SAMPLE_LLMS_FULL_TXT)
        mock_session_instance = AsyncMock()
        mock_session_instance.get = AsyncMock(return_value=mock_response)
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
        mock_session_instance.__aexit__ = AsyncMock()
        mock_aiohttp_session.return_value = mock_session_instance

        # Create request
        request = LinkPreviewRequest(
            url="https://docs.mem0.ai/llms-full.txt",
            url_include_patterns=[],
            url_exclude_patterns=[]
        )

        # Call endpoint
        result = await preview_link_collection(request)

        # Verify collection type
        assert result["collection_type"] == "llms-txt"  # llms-full detected as llms-txt
        assert result["is_link_collection"] is True

    @pytest.mark.asyncio
    async def test_security_validation_applied(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test that security validation (SSRF, sanitization) is applied."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Test SSRF protection
        request_localhost = LinkPreviewRequest(
            url="http://localhost:8080/llms.txt",
            url_include_patterns=[],
            url_exclude_patterns=[]
        )

        with pytest.raises(HTTPException) as exc:
            await preview_link_collection(request_localhost)

        assert exc.value.status_code == 400
        assert "localhost" in str(exc.value.detail).lower()

    @pytest.mark.asyncio
    async def test_invalid_glob_patterns_rejected(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test that dangerous glob patterns are rejected."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Test command injection attempt
        request_injection = LinkPreviewRequest(
            url="https://docs.example.com/llms.txt",
            url_include_patterns=["$(whoami)"],
            url_exclude_patterns=[]
        )

        with pytest.raises(HTTPException) as exc:
            await preview_link_collection(request_injection)

        assert exc.value.status_code == 400
        assert "invalid" in str(exc.value.detail).lower()

    @pytest.mark.asyncio
    async def test_real_world_documentation_filtering(
        self, mock_aiohttp_session, mock_crawler, mock_supabase
    ):
        """Test realistic documentation filtering scenario."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        # Sample content mimicking Anthropic Claude docs
        claude_docs_llms_txt = """# Claude Documentation

- [Overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Getting Started](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [API Reference](https://docs.anthropic.com/en/api/reference)
- [French Guide](https://docs.anthropic.com/fr/docs/guide)
- [Japanese Guide](https://docs.anthropic.com/ja/docs/guide)
"""

        # Mock HTTP response
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=claude_docs_llms_txt)
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock()
        mock_session_instance = MagicMock()
        mock_session_instance.get.return_value = mock_response
        mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
        mock_session_instance.__aexit__ = AsyncMock()
        mock_aiohttp_session.return_value = mock_session_instance

        # Filter: English docs only, exclude API references
        request = LinkPreviewRequest(
            url="https://docs.anthropic.com/llms.txt",
            url_include_patterns=["**/en/**"],
            url_exclude_patterns=["**/api/**"]
        )

        # Call endpoint
        result = await preview_link_collection(request)

        # Should match: English non-API docs (2 links)
        matching_links = [link for link in result["links"] if link["matches_filter"]]
        assert len(matching_links) == 2

        matching_urls = [link["url"] for link in matching_links]
        assert "https://docs.anthropic.com/en/docs/claude-code/overview" in matching_urls
        assert "https://docs.anthropic.com/en/docs/claude-code/getting-started" in matching_urls

        # Should NOT match: API reference (excluded), French/Japanese (not included)
        assert result["matching_links"] == 2
        assert result["total_links"] == 5


class TestPreviewLinksEdgeCases:
    """Test edge cases and error handling."""

    @pytest.mark.asyncio
    async def test_not_a_link_collection(self):
        """Test handling of regular HTML page (not link collection)."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        with patch("aiohttp.ClientSession") as mock_session:
            # Mock HTML response (not a link collection)
            mock_response = AsyncMock()
            mock_response.status = 200
            mock_response.text = AsyncMock(return_value="<html><body>Regular page</body></html>")
            mock_session_instance = AsyncMock()
            mock_session_instance.get = AsyncMock(return_value=mock_response)
            mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
            mock_session_instance.__aexit__ = AsyncMock()
            mock_session.return_value = mock_session_instance

            with patch("src.server.api_routes.knowledge_api.get_crawler") as mock_crawler:
                mock_crawler.return_value = AsyncMock()

                with patch("src.server.api_routes.knowledge_api.get_supabase_client") as mock_supabase:
                    mock_supabase.return_value = Mock()

                    request = LinkPreviewRequest(
                        url="https://example.com/page.html",
                        url_include_patterns=[],
                        url_exclude_patterns=[]
                    )

                    result = await preview_link_collection(request)

                    assert result["is_link_collection"] is False
                    assert "message" in result

    @pytest.mark.asyncio
    async def test_empty_llms_txt(self):
        """Test handling of empty llms.txt file."""
        from src.server.api_routes.knowledge_api import LinkPreviewRequest, preview_link_collection

        with patch("aiohttp.ClientSession") as mock_session:
            # Mock empty response
            mock_response = AsyncMock()
            mock_response.status = 200
            mock_response.text = AsyncMock(return_value="# Title\n\n(no links)")
            mock_session_instance = AsyncMock()
            mock_session_instance.get = AsyncMock(return_value=mock_response)
            mock_session_instance.__aenter__ = AsyncMock(return_value=mock_session_instance)
            mock_session_instance.__aexit__ = AsyncMock()
            mock_session.return_value = mock_session_instance

            with patch("src.server.api_routes.knowledge_api.get_crawler") as mock_crawler:
                mock_crawler.return_value = AsyncMock()

                with patch("src.server.api_routes.knowledge_api.get_supabase_client") as mock_supabase:
                    mock_supabase.return_value = Mock()

                    request = LinkPreviewRequest(
                        url="https://docs.example.com/llms.txt",
                        url_include_patterns=[],
                        url_exclude_patterns=[]
                    )

                    result = await preview_link_collection(request)

                    # Should handle empty gracefully
                    assert result["is_link_collection"] is True
                    assert result["total_links"] == 0
                    assert result["matching_links"] == 0
