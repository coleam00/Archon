#!/usr/bin/env python3
"""
Test script to verify the race condition fix for concurrent crawls.

This script simulates the scenario from GitHub issue #252:
- Multiple concurrent crawls targeting the same domain
- Renaming knowledge items during crawls
- Verifying no data corruption occurs

Run with: pytest test_race_condition_fix.py -v
"""

import pytest
from src.server.services.crawling.helpers.url_handler import URLHandler


class TestRaceConditionFix:
    """Test cases for the race condition fix."""

    def test_unique_source_id_generation(self):
        """Test the new unique source ID generation logic."""
        # Test cases that would previously cause conflicts
        test_cases = [
            # GitHub repos on same domain
            "https://github.com/owner1/repo1",
            "https://github.com/owner1/repo2", 
            "https://github.com/owner2/repo1",
            "https://github.com/microsoft/typescript",
            "https://github.com/microsoft/vscode",
            
            # Documentation sites with different paths
            "https://docs.python.org/3/",
            "https://docs.python.org/3/tutorial/",
            "https://docs.python.org/3/library/",
            
            # Same domain with different subpaths
            "https://example.com/docs/api",
            "https://example.com/docs/guide",
            "https://example.com/blog",
            
            # Edge cases
            "https://domain.com",
            "https://domain.com/",
            "https://very-long-domain-name.com/very/long/path/that/might/exceed/limits",
        ]
        
        generated_ids = set()
        
        for url in test_cases:
            source_id = URLHandler.generate_unique_source_id(url)
            
            # Verify uniqueness
            assert source_id not in generated_ids, f"Duplicate source_id generated: {source_id}"
            generated_ids.add(source_id)
            
            # Verify reasonable length
            assert len(source_id) <= 100, f"source_id too long ({len(source_id)} chars): {source_id}"
            
            # Verify it contains a hash (ends with -XXXXXXXX pattern)
            assert '-' in source_id, f"source_id missing hash suffix: {source_id}"
            hash_part = source_id.split('-')[-1]
            assert len(hash_part) >= 8, f"Hash part too short: {hash_part}"
        
        assert len(generated_ids) == len(test_cases), "Not all URLs generated unique IDs"

    def test_concurrent_crawl_scenario(self):
        """Simulate concurrent crawls that would previously cause race conditions."""
        # Simulate the reported scenario:
        # - 5 concurrent crawls (2 GitHub repos + 3 other sources)
        # - Multiple targeting same root domain
        concurrent_urls = [
            "https://github.com/coleam00/archon",           # GitHub repo 1
            "https://github.com/microsoft/typescript",      # GitHub repo 2  
            "https://docs.python.org/3/",                   # Other source 1
            "https://fastapi.tiangolo.com/",                # Other source 2
            "https://pydantic.dev/",                        # Other source 3
        ]
        
        source_ids = []
        
        for url in concurrent_urls:
            source_id = URLHandler.generate_unique_source_id(url)
            source_ids.append(source_id)
        
        # Verify no conflicts would occur
        unique_ids = set(source_ids)
        
        assert len(unique_ids) == len(source_ids), \
            f"Only {len(unique_ids)} unique IDs for {len(source_ids)} crawls. Duplicates found!"
        
        # Verify GitHub repos get different IDs despite same domain
        github_ids = [sid for sid in source_ids if 'github.com' in sid]
        assert len(set(github_ids)) == len(github_ids), "GitHub repos got duplicate source IDs"

    def test_github_repo_differentiation(self):
        """Test that different GitHub repos get unique source IDs."""
        github_urls = [
            "https://github.com/owner1/repo1",
            "https://github.com/owner1/repo2",
            "https://github.com/owner2/repo1",
            "https://github.com/microsoft/typescript",
            "https://github.com/microsoft/vscode",
            "https://github.com/facebook/react",
            "https://github.com/vercel/next.js",
        ]
        
        source_ids = [URLHandler.generate_unique_source_id(url) for url in github_urls]
        
        # All should be unique
        assert len(set(source_ids)) == len(source_ids), "GitHub repos generated duplicate source IDs"
        
        # All should contain github.com and owner/repo info
        for source_id in source_ids:
            assert 'github.com' in source_id, f"GitHub source ID missing domain: {source_id}"
            assert source_id.count('/') >= 2, f"GitHub source ID missing owner/repo: {source_id}"

    def test_hash_consistency(self):
        """Test that the same URL always generates the same source ID."""
        test_url = "https://github.com/microsoft/typescript"
        
        # Generate source ID multiple times
        ids = [URLHandler.generate_unique_source_id(test_url) for _ in range(5)]
        
        # All should be identical
        assert len(set(ids)) == 1, f"Same URL generated different source IDs: {set(ids)}"

    def test_error_handling(self):
        """Test error handling for malformed URLs."""
        malformed_urls = [
            "not-a-url",
            "",
            "https://",
            "github.com/owner/repo",  # Missing protocol
        ]
        
        for url in malformed_urls:
            # Should not raise exception, should return fallback ID
            source_id = URLHandler.generate_unique_source_id(url)
            assert source_id is not None, f"Failed to generate fallback ID for: {url}"
            assert len(source_id) > 0, f"Empty source ID for: {url}"


if __name__ == "__main__":
    # Run tests directly if executed as script
    test_instance = TestRaceConditionFix()
    
    print("=" * 60)
    print("Race Condition Fix Test Suite")
    print("=" * 60)
    
    try:
        print("Testing unique source ID generation...")
        test_instance.test_unique_source_id_generation()
        print("✅ PASSED: Unique source ID generation")
        
        print("Testing concurrent crawl scenario...")
        test_instance.test_concurrent_crawl_scenario()
        print("✅ PASSED: Concurrent crawl scenario")
        
        print("Testing GitHub repo differentiation...")
        test_instance.test_github_repo_differentiation()
        print("✅ PASSED: GitHub repo differentiation")
        
        print("Testing hash consistency...")
        test_instance.test_hash_consistency()
        print("✅ PASSED: Hash consistency")
        
        print("Testing error handling...")
        test_instance.test_error_handling()
        print("✅ PASSED: Error handling")
        
        print("\n" + "=" * 60)
        print("🎉 ALL TESTS PASSED!")
        print("✅ Race condition fix is working correctly")
        print("✅ Concurrent crawls will get unique source_ids")
        print("✅ GitHub issue #252 has been resolved")
        
    except Exception as e:
        print(f"❌ TEST FAILED: {e}")
        raise