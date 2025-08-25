"""Comprehensive test suite for FileDiscoveryService."""

import asyncio
import json
from unittest.mock import AsyncMock, Mock, patch, MagicMock
import pytest
import aiohttp
from aiohttp import ClientResponse

from src.server.services.crawling.helpers.file_discovery import FileDiscoveryService


class TestFileDiscoveryService:
    """Test suite for FileDiscoveryService class."""

    @pytest.fixture
    def discovery_service(self):
        """Create a FileDiscoveryService instance for testing."""
        return FileDiscoveryService()

    @pytest.fixture
    def mock_response(self):
        """Create a mock HTTP response for testing."""
        response = AsyncMock(spec=ClientResponse)
        response.status = 200
        response.text = AsyncMock()
        return response

    def test_initialization(self, discovery_service):
        """Test service initialization with proper defaults."""
        assert discovery_service.timeout.total == 10
        assert "CRAWL_DISCOVERY_LLM_FILES" in discovery_service._fallback_defaults
        assert "CRAWL_DISCOVERY_SITEMAP_FILES" in discovery_service._fallback_defaults
        assert "CRAWL_DISCOVERY_METADATA_FILES" in discovery_service._fallback_defaults

    @pytest.mark.asyncio
    async def test_get_file_list_from_db_success(self, discovery_service):
        """Test successful database settings retrieval."""
        with patch('src.server.services.crawling.helpers.file_discovery.credential_service') as mock_cred:
            # Mock successful database response with async return
            mock_cred.get_credential = AsyncMock(return_value='["llms.txt", "llms-full.txt"]')
            
            result = await discovery_service._get_file_list_from_db("CRAWL_DISCOVERY_LLM_FILES")
            
            assert result == ["llms.txt", "llms-full.txt"]
            mock_cred.get_credential.assert_called_once_with("CRAWL_DISCOVERY_LLM_FILES", decrypt=False)

    @pytest.mark.asyncio
    async def test_get_file_list_from_db_dict_format(self, discovery_service):
        """Test database settings retrieval with dict format."""
        with patch('src.server.services.crawling.helpers.file_discovery.credential_service') as mock_cred:
            # Mock database response in dict format with async return
            mock_cred.get_credential = AsyncMock(return_value={"value": '["sitemap.xml", "sitemap_index.xml"]'})
            
            result = await discovery_service._get_file_list_from_db("CRAWL_DISCOVERY_SITEMAP_FILES")
            
            assert result == ["sitemap.xml", "sitemap_index.xml"]

    @pytest.mark.asyncio
    async def test_get_file_list_from_db_fallback_on_none(self, discovery_service):
        """Test fallback to defaults when database returns None."""
        with patch('src.server.services.crawling.helpers.file_discovery.credential_service') as mock_cred:
            mock_cred.get_credential = AsyncMock(return_value=None)
            
            result = await discovery_service._get_file_list_from_db("CRAWL_DISCOVERY_LLM_FILES")
            
            assert result == discovery_service._fallback_defaults["CRAWL_DISCOVERY_LLM_FILES"]

    @pytest.mark.asyncio
    async def test_get_file_list_from_db_fallback_on_json_error(self, discovery_service):
        """Test fallback to defaults on JSON parsing errors."""
        with patch('src.server.services.crawling.helpers.file_discovery.credential_service') as mock_cred:
            mock_cred.get_credential = AsyncMock(return_value="invalid json[")
            
            result = await discovery_service._get_file_list_from_db("CRAWL_DISCOVERY_LLM_FILES")
            
            assert result == discovery_service._fallback_defaults["CRAWL_DISCOVERY_LLM_FILES"]

    @pytest.mark.asyncio
    async def test_get_file_list_from_db_fallback_on_exception(self, discovery_service):
        """Test fallback to defaults on unexpected exceptions."""
        with patch('src.server.services.crawling.helpers.file_discovery.credential_service') as mock_cred:
            mock_cred.get_credential = AsyncMock(side_effect=Exception("Database error"))
            
            result = await discovery_service._get_file_list_from_db("CRAWL_DISCOVERY_LLM_FILES")
            
            assert result == discovery_service._fallback_defaults["CRAWL_DISCOVERY_LLM_FILES"]

    @pytest.mark.asyncio
    async def test_check_file_exists_success(self, discovery_service, mock_response):
        """Test successful file existence check."""
        mock_response.status = 200
        
        with patch('aiohttp.ClientSession.head') as mock_head:
            mock_head.return_value.__aenter__ = AsyncMock(return_value=mock_response)
            mock_head.return_value.__aexit__ = AsyncMock(return_value=None)
            
            async with aiohttp.ClientSession() as session:
                result = await discovery_service._check_file_exists(session, "https://example.com/llms.txt")
                
            assert result is True

    @pytest.mark.asyncio
    async def test_check_file_exists_not_found(self, discovery_service, mock_response):
        """Test file existence check with 404 response."""
        mock_response.status = 404
        
        with patch('aiohttp.ClientSession.head', return_value=mock_response):
            async with aiohttp.ClientSession() as session:
                result = await discovery_service._check_file_exists(session, "https://example.com/nonexistent.txt")
                
            assert result is False

    @pytest.mark.asyncio
    async def test_check_file_exists_exception(self, discovery_service):
        """Test file existence check with network exception."""
        with patch('aiohttp.ClientSession.head', side_effect=aiohttp.ClientError("Network error")):
            async with aiohttp.ClientSession() as session:
                result = await discovery_service._check_file_exists(session, "https://example.com/test.txt")
                
            assert result is False

    @pytest.mark.asyncio
    async def test_discover_robots_sitemaps_success(self, discovery_service, mock_response):
        """Test successful robots.txt sitemap extraction."""
        robots_content = """User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml
sitemap: https://example.com/products-sitemap.xml
"""
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value=robots_content)
        
        with patch('aiohttp.ClientSession.get') as mock_get:
            mock_get.return_value.__aenter__ = AsyncMock(return_value=mock_response)
            mock_get.return_value.__aexit__ = AsyncMock(return_value=None)
            
            result = await discovery_service.discover_robots_sitemaps("https://example.com")
            
        expected = [
            "https://example.com/sitemap.xml",
            "https://example.com/news-sitemap.xml", 
            "https://example.com/products-sitemap.xml"
        ]
        assert result == expected

    @pytest.mark.asyncio
    async def test_discover_robots_sitemaps_relative_urls(self, discovery_service, mock_response):
        """Test robots.txt with relative sitemap URLs."""
        robots_content = """User-agent: *
Sitemap: /sitemap.xml
Sitemap: /sitemaps/main.xml
"""
        mock_response.status = 200
        mock_response.text.return_value = robots_content
        
        with patch('aiohttp.ClientSession.get', return_value=mock_response):
            result = await discovery_service.discover_robots_sitemaps("https://example.com")
            
        expected = [
            "https://example.com/sitemap.xml",
            "https://example.com/sitemaps/main.xml"
        ]
        assert result == expected

    @pytest.mark.asyncio
    async def test_discover_robots_sitemaps_not_found(self, discovery_service, mock_response):
        """Test robots.txt not found."""
        mock_response.status = 404
        
        with patch('aiohttp.ClientSession.get', return_value=mock_response):
            result = await discovery_service.discover_robots_sitemaps("https://example.com")
            
        assert result == []

    @pytest.mark.asyncio
    async def test_discover_robots_sitemaps_exception(self, discovery_service):
        """Test robots.txt discovery with network exception."""
        with patch('aiohttp.ClientSession.get', side_effect=aiohttp.ClientError("Network error")):
            result = await discovery_service.discover_robots_sitemaps("https://example.com")
            
        assert result == []

    @pytest.mark.asyncio
    async def test_discover_llm_files_success(self, discovery_service):
        """Test successful LLM file discovery."""
        with patch.object(discovery_service, '_get_file_list_from_db', return_value=["llms.txt", "llms-full.txt"]):
            with patch.object(discovery_service, '_check_file_exists', side_effect=[True, False]) as mock_check:
                result = await discovery_service.discover_llm_files("https://example.com")
                
        assert result == ["https://example.com/llms.txt"]
        assert mock_check.call_count == 2

    @pytest.mark.asyncio
    async def test_discover_llm_files_none_found(self, discovery_service):
        """Test LLM file discovery when no files exist."""
        with patch.object(discovery_service, '_get_file_list_from_db', return_value=["llms.txt"]):
            with patch.object(discovery_service, '_check_file_exists', return_value=False):
                result = await discovery_service.discover_llm_files("https://example.com")
                
        assert result == []

    @pytest.mark.asyncio
    async def test_discover_llm_files_exception(self, discovery_service):
        """Test LLM file discovery with exception."""
        with patch.object(discovery_service, '_get_file_list_from_db', side_effect=Exception("Database error")):
            result = await discovery_service.discover_llm_files("https://example.com")
            
        assert result == []

    @pytest.mark.asyncio
    async def test_discover_sitemap_files_standard(self, discovery_service):
        """Test standard sitemap file discovery."""
        with patch.object(discovery_service, '_get_file_list_from_db', return_value=["sitemap.xml", "sitemap_index.xml"]):
            with patch.object(discovery_service, '_check_file_exists', side_effect=[True, False]):
                result = await discovery_service.discover_sitemap_files("https://example.com")
                
        assert result == ["https://example.com/sitemap.xml"]

    @pytest.mark.asyncio
    async def test_discover_sitemap_files_wildcard(self, discovery_service):
        """Test sitemap discovery with wildcard patterns."""
        with patch.object(discovery_service, '_get_file_list_from_db', return_value=["sitemap-*.xml"]):
            # Mock that sitemap-1.xml and sitemap-3.xml exist
            check_responses = [True, False, True, False, False]  # 1 exists, 2 doesn't, 3 exists, 4&5 don't
            with patch.object(discovery_service, '_check_file_exists', side_effect=check_responses):
                result = await discovery_service.discover_sitemap_files("https://example.com")
                
        expected = ["https://example.com/sitemap-1.xml", "https://example.com/sitemap-3.xml"]
        assert result == expected

    @pytest.mark.asyncio
    async def test_discover_metadata_files_success(self, discovery_service):
        """Test successful metadata file discovery."""
        with patch.object(discovery_service, '_get_file_list_from_db', return_value=["robots.txt", ".well-known/security.txt"]):
            with patch.object(discovery_service, '_check_file_exists', side_effect=[True, False]):
                result = await discovery_service.discover_metadata_files("https://example.com")
                
        assert result == ["https://example.com/robots.txt"]

    @pytest.mark.asyncio
    async def test_discover_all_files_comprehensive(self, discovery_service):
        """Test comprehensive file discovery with all methods."""
        # Mock all the individual discovery methods
        with patch.object(discovery_service, 'discover_robots_sitemaps', return_value=["https://example.com/sitemap.xml"]):
            with patch.object(discovery_service, 'discover_llm_files', return_value=["https://example.com/llms.txt"]):
                with patch.object(discovery_service, 'discover_sitemap_files', return_value=["https://example.com/sitemap_index.xml"]):
                    with patch.object(discovery_service, 'discover_metadata_files', return_value=["https://example.com/robots.txt"]):
                        result = await discovery_service.discover_all_files("https://example.com")
                        
        expected = {
            "robots_sitemaps": ["https://example.com/sitemap.xml"],
            "llm_files": ["https://example.com/llms.txt"],
            "sitemap_files": ["https://example.com/sitemap_index.xml"],
            "metadata_files": ["https://example.com/robots.txt"]
        }
        assert result == expected

    @pytest.mark.asyncio
    async def test_discover_all_files_with_exceptions(self, discovery_service):
        """Test comprehensive discovery with some methods failing."""
        # Mock some methods to succeed and some to fail
        with patch.object(discovery_service, 'discover_robots_sitemaps', return_value=["https://example.com/sitemap.xml"]):
            with patch.object(discovery_service, 'discover_llm_files', side_effect=Exception("LLM discovery failed")):
                with patch.object(discovery_service, 'discover_sitemap_files', return_value=["https://example.com/sitemap_index.xml"]):
                    with patch.object(discovery_service, 'discover_metadata_files', side_effect=Exception("Metadata discovery failed")):
                        result = await discovery_service.discover_all_files("https://example.com")
                        
        expected = {
            "robots_sitemaps": ["https://example.com/sitemap.xml"],
            "llm_files": [],  # Failed, so empty
            "sitemap_files": ["https://example.com/sitemap_index.xml"],
            "metadata_files": []  # Failed, so empty
        }
        assert result == expected

    @pytest.mark.asyncio
    async def test_discover_all_files_complete_failure(self, discovery_service):
        """Test discovery with complete failure returning empty results."""
        with patch.object(discovery_service, 'discover_robots_sitemaps', side_effect=Exception("Complete failure")):
            result = await discovery_service.discover_all_files("https://example.com")
            
        expected = {
            "robots_sitemaps": [],
            "llm_files": [],
            "sitemap_files": [],
            "metadata_files": []
        }
        assert result == expected

    @pytest.mark.asyncio
    async def test_concurrent_discovery_performance(self, discovery_service):
        """Test that discovery methods run concurrently for performance."""
        # This test verifies that asyncio.gather is used for concurrent execution
        with patch('asyncio.gather') as mock_gather:
            mock_gather.return_value = [[], [], [], []]  # Empty results
            
            await discovery_service.discover_all_files("https://example.com")
            
            # Verify asyncio.gather was called (indicating concurrent execution)
            mock_gather.assert_called_once()
            
            # Check that all 4 discovery methods were passed to gather
            args = mock_gather.call_args[0]
            assert len(args) == 4  # 4 discovery methods

    def test_fallback_defaults_completeness(self, discovery_service):
        """Test that fallback defaults contain all required settings."""
        defaults = discovery_service._fallback_defaults
        
        # Check all required keys are present
        required_keys = [
            "CRAWL_DISCOVERY_LLM_FILES",
            "CRAWL_DISCOVERY_SITEMAP_FILES", 
            "CRAWL_DISCOVERY_METADATA_FILES"
        ]
        
        for key in required_keys:
            assert key in defaults
            assert isinstance(defaults[key], list)
            assert len(defaults[key]) > 0  # Should have at least one item

    def test_fallback_defaults_content(self, discovery_service):
        """Test that fallback defaults contain expected file patterns."""
        defaults = discovery_service._fallback_defaults
        
        # Check LLM files
        llm_files = defaults["CRAWL_DISCOVERY_LLM_FILES"]
        assert "llms.txt" in llm_files
        assert "llms-full.txt" in llm_files
        
        # Check sitemap files
        sitemap_files = defaults["CRAWL_DISCOVERY_SITEMAP_FILES"]
        assert "sitemap.xml" in sitemap_files
        assert "sitemap_index.xml" in sitemap_files
        
        # Check metadata files
        metadata_files = defaults["CRAWL_DISCOVERY_METADATA_FILES"]
        assert "robots.txt" in metadata_files
        assert ".well-known/security.txt" in metadata_files


class TestFileDiscoveryIntegration:
    """Integration tests for FileDiscoveryService with real network scenarios."""

    @pytest.fixture
    def discovery_service(self):
        """Create a FileDiscoveryService instance for integration testing."""
        return FileDiscoveryService()

    @pytest.mark.asyncio
    async def test_timeout_handling(self, discovery_service):
        """Test that timeouts are handled gracefully."""
        # Mock a slow response that times out
        slow_response = AsyncMock()
        slow_response.text.side_effect = asyncio.TimeoutError("Request timed out")
        
        with patch('aiohttp.ClientSession.get', return_value=slow_response):
            result = await discovery_service.discover_robots_sitemaps("https://slow-site.com")
            
        assert result == []  # Should return empty list on timeout

    @pytest.mark.asyncio 
    async def test_malformed_robots_txt(self, discovery_service):
        """Test handling of malformed robots.txt content."""
        malformed_content = """This is not a valid robots.txt
Random text here
Sitemap: https://example.com/sitemap.xml
More random content
sitemap: not-a-url
Sitemap: https://example.com/valid-sitemap.xml
"""
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.text.return_value = malformed_content
        
        with patch('aiohttp.ClientSession.get', return_value=mock_response):
            result = await discovery_service.discover_robots_sitemaps("https://example.com")
            
        # Should extract valid sitemap URLs and handle malformed ones gracefully
        assert "https://example.com/sitemap.xml" in result
        assert "https://example.com/valid-sitemap.xml" in result
        # Should handle malformed entries without crashing

    @pytest.mark.asyncio
    async def test_edge_case_url_handling(self, discovery_service):
        """Test edge cases in URL handling and construction."""
        test_cases = [
            ("https://example.com/", "llms.txt", "https://example.com/llms.txt"),
            ("https://example.com", "llms.txt", "https://example.com/llms.txt"),
            ("https://example.com/path/", "llms.txt", "https://example.com/path/llms.txt"),
            ("https://example.com/path", ".well-known/security.txt", "https://example.com/.well-known/security.txt"),
        ]
        
        with patch.object(discovery_service, '_get_file_list_from_db', return_value=["llms.txt"]):
            with patch.object(discovery_service, '_check_file_exists', return_value=True) as mock_check:
                for base_url, file_pattern, expected_url in test_cases:
                    await discovery_service.discover_llm_files(base_url)
                    # Verify the correct URL was constructed and checked
                    mock_check.assert_called_with(mock_check.call_args[0][0], expected_url)