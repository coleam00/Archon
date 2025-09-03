"""Unit tests for ETag utilities used in HTTP polling."""

import json

import pytest

from src.server.utils.etag_utils import check_etag, generate_etag


class TestGenerateEtag:
    """Tests for ETag generation function."""

    def test_generate_etag_with_dict(self):
        """Test ETag generation with dictionary data."""
        data = {"name": "test", "value": 123, "active": True}
        etag = generate_etag(data)
        
        # ETag should be quoted MD5 hash
        assert etag.startswith('"')
        assert etag.endswith('"')
        assert len(etag) == 34  # 32 char MD5 + 2 quotes
        
        # Same data should generate same ETag
        etag2 = generate_etag(data)
        assert etag == etag2

    def test_generate_etag_with_list(self):
        """Test ETag generation with list data."""
        data = [1, 2, 3, {"nested": "value"}]
        etag = generate_etag(data)
        
        assert etag.startswith('"')
        assert etag.endswith('"')
        
        # Different order should generate different ETag
        data_reordered = [3, 2, 1, {"nested": "value"}]
        etag2 = generate_etag(data_reordered)
        assert etag != etag2

    def test_generate_etag_stable_ordering(self):
        """Test that dict keys are sorted for stable ETags."""
        # Different key insertion order
        data1 = {"b": 2, "a": 1, "c": 3}
        data2 = {"a": 1, "c": 3, "b": 2}
        
        etag1 = generate_etag(data1)
        etag2 = generate_etag(data2)
        
        # Should be same despite different insertion order
        assert etag1 == etag2

    def test_generate_etag_with_none(self):
        """Test ETag generation with None values."""
        data = {"key": None, "list": [None, 1, 2]}
        etag = generate_etag(data)
        
        assert etag.startswith('"')
        assert etag.endswith('"')

    def test_generate_etag_with_datetime(self):
        """Test ETag generation with datetime objects."""
        from datetime import datetime
        
        data = {"timestamp": datetime(2024, 1, 1, 12, 0, 0)}
        etag = generate_etag(data)
        
        assert etag.startswith('"')
        assert etag.endswith('"')
        
        # Same datetime should generate same ETag
        data2 = {"timestamp": datetime(2024, 1, 1, 12, 0, 0)}
        etag2 = generate_etag(data2)
        assert etag == etag2

    def test_generate_etag_empty_data(self):
        """Test ETag generation with empty data structures."""
        empty_dict = {}
        empty_list = []
        
        etag_dict = generate_etag(empty_dict)
        etag_list = generate_etag(empty_list)
        
        # Both should generate valid but different ETags
        assert etag_dict.startswith('"')
        assert etag_list.startswith('"')
        assert etag_dict != etag_list


class TestCheckEtag:
    """Tests for ETag checking function."""

    def test_check_etag_match(self):
        """Test ETag check with matching ETags."""
        current_etag = '"abc123def456"'
        request_etag = '"abc123def456"'
        
        assert check_etag(request_etag, current_etag) is True

    def test_check_etag_no_match(self):
        """Test ETag check with non-matching ETags."""
        current_etag = '"abc123def456"'
        request_etag = '"xyz789ghi012"'
        
        assert check_etag(request_etag, current_etag) is False

    def test_check_etag_none_request(self):
        """Test ETag check with None request ETag."""
        current_etag = '"abc123def456"'
        request_etag = None
        
        assert check_etag(request_etag, current_etag) is False

    def test_check_etag_empty_request(self):
        """Test ETag check with empty request ETag."""
        current_etag = '"abc123def456"'
        request_etag = ""
        
        assert check_etag(request_etag, current_etag) is False

    def test_check_etag_case_sensitive(self):
        """Test that ETag check is case-sensitive."""
        current_etag = '"ABC123DEF456"'
        request_etag = '"abc123def456"'
        
        assert check_etag(request_etag, current_etag) is False

    def test_check_etag_with_weak_etag(self):
        """Test ETag check with weak ETags (W/ prefix)."""
        # Current implementation doesn't handle weak ETags
        # This documents the expected behavior
        current_etag = '"abc123"'
        weak_etag = 'W/"abc123"'
        
        assert check_etag(weak_etag, current_etag) is False


class TestEtagIntegration:
    """Integration tests for ETag generation and checking."""

    def test_etag_roundtrip(self):
        """Test complete ETag generation and checking flow."""
        # Simulate API response data
        response_data = {
            "projects": [
                {"id": "proj-1", "name": "Project 1", "status": "active"},
                {"id": "proj-2", "name": "Project 2", "status": "completed"}
            ],
            "count": 2
        }
        
        # Generate ETag for response
        etag = generate_etag(response_data)
        
        # Simulate client sending back the ETag
        assert check_etag(etag, etag) is True
        
        # Modify data slightly
        response_data["count"] = 3
        new_etag = generate_etag(response_data)
        
        # Old ETag should not match new data
        assert check_etag(etag, new_etag) is False

    def test_etag_with_progress_data(self):
        """Test ETags with progress polling data."""
        progress_data = {
            "operation_id": "op-123",
            "status": "running",
            "percentage": 45,
            "message": "Processing items...",
            "metadata": {"processed": 45, "total": 100}
        }
        
        etag1 = generate_etag(progress_data)
        
        # Update progress
        progress_data["percentage"] = 50
        progress_data["metadata"]["processed"] = 50
        etag2 = generate_etag(progress_data)
        
        # ETags should differ after progress update
        assert etag1 != etag2
        assert not check_etag(etag1, etag2)
        
        # Completion
        progress_data["status"] = "completed"
        progress_data["percentage"] = 100
        etag3 = generate_etag(progress_data)
        
        assert etag2 != etag3
        assert not check_etag(etag2, etag3)