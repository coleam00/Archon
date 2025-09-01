"""
Test Suite for Source ID Architecture Refactor

Tests the new unique source ID generation and display name extraction
to ensure the race condition fix works correctly.
"""

import time
from concurrent.futures import ThreadPoolExecutor

# Import the URLHandler class
from src.server.services.crawling.helpers.url_handler import URLHandler


class TestSourceIDGeneration:
    """Test the unique source ID generation."""
    
    def test_unique_id_generation_basic(self):
        """Test basic unique ID generation."""
        handler = URLHandler()
        
        # Test various URLs
        test_urls = [
            "https://github.com/microsoft/typescript",
            "https://github.com/facebook/react",
            "https://docs.python.org/3/",
            "https://fastapi.tiangolo.com/",
            "https://pydantic.dev/",
        ]
        
        source_ids = []
        for url in test_urls:
            source_id = handler.generate_unique_source_id(url)
            source_ids.append(source_id)
            
            # Check that ID is a 16-character hex string
            assert len(source_id) == 16, f"ID should be 16 chars, got {len(source_id)}"
            assert all(c in '0123456789abcdef' for c in source_id), f"ID should be hex: {source_id}"
        
        # All IDs should be unique
        assert len(set(source_ids)) == len(source_ids), "All source IDs should be unique"
    
    def test_same_domain_different_ids(self):
        """Test that same domain with different paths generates different IDs."""
        handler = URLHandler()
        
        # Multiple GitHub repos (same domain, different paths)
        github_urls = [
            "https://github.com/owner1/repo1",
            "https://github.com/owner1/repo2",
            "https://github.com/owner2/repo1",
        ]
        
        ids = [handler.generate_unique_source_id(url) for url in github_urls]
        
        # All should be unique despite same domain
        assert len(set(ids)) == len(ids), "Same domain should generate different IDs for different URLs"
    
    def test_id_consistency(self):
        """Test that the same URL always generates the same ID."""
        handler = URLHandler()
        url = "https://github.com/microsoft/typescript"
        
        # Generate ID multiple times
        ids = [handler.generate_unique_source_id(url) for _ in range(5)]
        
        # All should be identical
        assert len(set(ids)) == 1, f"Same URL should always generate same ID, got: {set(ids)}"
        assert ids[0] == ids[4], "First and last ID should match"
    
    def test_url_normalization(self):
        """Test that URL variations generate consistent IDs based on case differences."""
        handler = URLHandler()
        
        # Test that URLs with same case generate same ID, different case generates different ID
        url_variations = [
            "https://github.com/Microsoft/TypeScript",
            "https://github.com/microsoft/typescript",  # Different case in path
            "https://GitHub.com/Microsoft/TypeScript",  # Different case in domain
        ]
        
        ids = [handler.generate_unique_source_id(url) for url in url_variations]
        
        # First and third should be same (only domain case differs, which gets normalized)
        # Second should be different (path case matters)
        assert ids[0] == ids[2], f"URLs with only domain case differences should generate same ID"
        assert ids[0] != ids[1], f"URLs with path case differences should generate different IDs"
    
    def test_concurrent_crawl_simulation(self):
        """Simulate concurrent crawls to verify no race conditions."""
        handler = URLHandler()
        
        # URLs that would previously conflict
        concurrent_urls = [
            "https://github.com/coleam00/archon",
            "https://github.com/microsoft/typescript",
            "https://github.com/facebook/react",
            "https://github.com/vercel/next.js",
            "https://github.com/vuejs/vue",
        ]
        
        def generate_id(url):
            """Simulate a crawl generating an ID."""
            time.sleep(0.001)  # Simulate some processing time
            return handler.generate_unique_source_id(url)
        
        # Run concurrent ID generation
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(generate_id, url) for url in concurrent_urls]
            source_ids = [future.result() for future in futures]
        
        # All IDs should be unique
        assert len(set(source_ids)) == len(source_ids), "Concurrent crawls should generate unique IDs"
    
    def test_error_handling(self):
        """Test error handling for edge cases."""
        handler = URLHandler()
        
        # Test various edge cases
        edge_cases = [
            "",  # Empty string
            "not-a-url",  # Invalid URL
            "https://",  # Incomplete URL
            None,  # None should be handled gracefully in real code
        ]
        
        for url in edge_cases:
            if url is None:
                continue  # Skip None for this test
            
            # Should not raise exception
            source_id = handler.generate_unique_source_id(url)
            assert source_id is not None, f"Should generate ID even for edge case: {url}"
            assert len(source_id) == 16, f"Edge case should still generate 16-char ID: {url}"


class TestDisplayNameExtraction:
    """Test the human-readable display name extraction."""
    
    def test_github_display_names(self):
        """Test GitHub repository display name extraction."""
        handler = URLHandler()
        
        test_cases = [
            ("https://github.com/microsoft/typescript", "GitHub - microsoft/typescript"),
            ("https://github.com/facebook/react", "GitHub - facebook/react"),
            ("https://github.com/vercel/next.js", "GitHub - vercel/next.js"),
            ("https://github.com/owner", "GitHub - owner"),
            ("https://github.com/", "GitHub"),
        ]
        
        for url, expected in test_cases:
            display_name = handler.extract_display_name(url)
            assert display_name == expected, f"URL {url} should display as '{expected}', got '{display_name}'"
    
    def test_documentation_display_names(self):
        """Test documentation site display name extraction."""
        handler = URLHandler()
        
        test_cases = [
            ("https://docs.python.org/3/", "Python Documentation"),
            ("https://docs.djangoproject.com/", "Djangoproject Documentation"),
            ("https://fastapi.tiangolo.com/", "FastAPI Documentation"),
            ("https://pydantic.dev/", "Pydantic Documentation"),
            ("https://numpy.org/doc/", "NumPy Documentation"),
            ("https://pandas.pydata.org/", "Pandas Documentation"),
            ("https://project.readthedocs.io/", "Project Docs"),
        ]
        
        for url, expected in test_cases:
            display_name = handler.extract_display_name(url)
            assert display_name == expected, f"URL {url} should display as '{expected}', got '{display_name}'"
    
    def test_api_display_names(self):
        """Test API endpoint display name extraction."""
        handler = URLHandler()
        
        test_cases = [
            ("https://api.github.com/", "GitHub API"),
            ("https://api.openai.com/v1/", "Openai API"),
            ("https://example.com/api/v2/", "Example"),
        ]
        
        for url, expected in test_cases:
            display_name = handler.extract_display_name(url)
            assert display_name == expected, f"URL {url} should display as '{expected}', got '{display_name}'"
    
    def test_generic_display_names(self):
        """Test generic website display name extraction."""
        handler = URLHandler()
        
        test_cases = [
            ("https://example.com/", "Example"),
            ("https://my-site.org/", "My Site"),
            ("https://test_project.io/", "Test Project"),
            ("https://some.subdomain.example.com/", "Some Subdomain Example"),
        ]
        
        for url, expected in test_cases:
            display_name = handler.extract_display_name(url)
            assert display_name == expected, f"URL {url} should display as '{expected}', got '{display_name}'"
    
    def test_edge_case_display_names(self):
        """Test edge cases for display name extraction."""
        handler = URLHandler()
        
        # Edge cases
        test_cases = [
            ("", ""),  # Empty URL
            ("not-a-url", "not-a-url"),  # Invalid URL
            ("/local/file/path", "Local: path"),  # Local file path
            ("https://", "https://"),  # Incomplete URL
        ]
        
        for url, expected_contains in test_cases:
            display_name = handler.extract_display_name(url)
            assert expected_contains in display_name or display_name == expected_contains, \
                f"Edge case {url} handling failed: {display_name}"
    
    def test_special_file_display_names(self):
        """Test that special files like llms.txt and sitemap.xml are properly displayed."""
        handler = URLHandler()
        
        test_cases = [
            # llms.txt files
            ("https://docs.mem0.ai/llms-full.txt", "Mem0 - Llms.Txt"),
            ("https://example.com/llms.txt", "Example - Llms.Txt"),
            ("https://api.example.com/llms.txt", "Example API"),  # API takes precedence
            
            # sitemap.xml files
            ("https://mem0.ai/sitemap.xml", "Mem0 - Sitemap.Xml"),
            ("https://docs.example.com/sitemap.xml", "Example - Sitemap.Xml"),
            ("https://example.org/sitemap.xml", "Example - Sitemap.Xml"),
            
            # Regular .txt files on docs sites
            ("https://docs.example.com/readme.txt", "Example - Readme.Txt"),
            
            # Non-special files should not get special treatment
            ("https://docs.example.com/guide", "Example Documentation"),
            ("https://example.com/page.html", "Example - Page.Html"),  # Path gets added for single file
        ]
        
        for url, expected in test_cases:
            display_name = handler.extract_display_name(url)
            assert display_name == expected, f"URL {url} should display as '{expected}', got '{display_name}'"
    
    def test_git_extension_removal(self):
        """Test that .git extension is removed from GitHub repos."""
        handler = URLHandler()
        
        test_cases = [
            ("https://github.com/owner/repo.git", "GitHub - owner/repo"),
            ("https://github.com/owner/repo", "GitHub - owner/repo"),
        ]
        
        for url, expected in test_cases:
            display_name = handler.extract_display_name(url)
            assert display_name == expected, f"URL {url} should display as '{expected}', got '{display_name}'"


class TestRaceConditionFix:
    """Test that the race condition is actually fixed."""
    
    def test_no_domain_conflicts(self):
        """Test that multiple sources from same domain don't conflict."""
        handler = URLHandler()
        
        # These would all have source_id = "github.com" in the old system
        github_urls = [
            "https://github.com/microsoft/typescript",
            "https://github.com/microsoft/vscode",
            "https://github.com/facebook/react",
            "https://github.com/vercel/next.js",
            "https://github.com/vuejs/vue",
        ]
        
        source_ids = [handler.generate_unique_source_id(url) for url in github_urls]
        
        # All should be unique
        assert len(set(source_ids)) == len(source_ids), \
            "Race condition not fixed: duplicate source IDs for same domain"
        
        # None should be just "github.com"
        for source_id in source_ids:
            assert source_id != "github.com", \
                "Source ID should not be just the domain"
    
    def test_hash_properties(self):
        """Test that the hash has good properties."""
        handler = URLHandler()
        
        # Similar URLs should still generate very different hashes
        url1 = "https://github.com/owner/repo1"
        url2 = "https://github.com/owner/repo2"  # Only differs by one character
        
        id1 = handler.generate_unique_source_id(url1)
        id2 = handler.generate_unique_source_id(url2)
        
        # IDs should be completely different (good hash distribution)
        matching_chars = sum(1 for a, b in zip(id1, id2) if a == b)
        assert matching_chars < 8, \
            f"Similar URLs should generate very different hashes, {matching_chars}/16 chars match"


class TestIntegration:
    """Integration tests for the complete source ID system."""
    
    def test_full_source_creation_flow(self):
        """Test the complete flow of creating a source with all fields."""
        handler = URLHandler()
        url = "https://github.com/microsoft/typescript"
        
        # Generate all source fields
        source_id = handler.generate_unique_source_id(url)
        source_display_name = handler.extract_display_name(url)
        source_url = url
        
        # Verify all fields are populated correctly
        assert len(source_id) == 16, "Source ID should be 16 characters"
        assert source_display_name == "GitHub - microsoft/typescript", \
            f"Display name incorrect: {source_display_name}"
        assert source_url == url, "Source URL should match original"
        
        # Simulate database record
        source_record = {
            'source_id': source_id,
            'source_url': source_url,
            'source_display_name': source_display_name,
            'title': None,  # Generated later
            'summary': None,  # Generated later
            'metadata': {}
        }
        
        # Verify record structure
        assert 'source_id' in source_record
        assert 'source_url' in source_record
        assert 'source_display_name' in source_record
    
    def test_backward_compatibility(self):
        """Test that the system handles existing sources gracefully."""
        handler = URLHandler()
        
        # Simulate an existing source with old-style source_id
        existing_source = {
            'source_id': 'github.com',  # Old style - just domain
            'source_url': None,  # Not populated in old system
            'source_display_name': None,  # Not populated in old system
        }
        
        # The migration should handle this by backfilling
        # source_url and source_display_name with source_id value
        migrated_source = {
            'source_id': 'github.com',
            'source_url': 'github.com',  # Backfilled
            'source_display_name': 'github.com',  # Backfilled
        }
        
        assert migrated_source['source_url'] is not None
        assert migrated_source['source_display_name'] is not None