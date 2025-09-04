"""Unit tests for the ProgressMapper class."""

import pytest

from src.server.services.crawling.progress_mapper import ProgressMapper


class TestProgressMapper:
    """Test cases for ProgressMapper functionality."""

    @pytest.fixture
    def progress_mapper(self):
        """Create a fresh ProgressMapper for each test."""
        return ProgressMapper()

    def test_init_sets_initial_state(self, progress_mapper):
        """Test that initialization sets correct initial state."""
        assert progress_mapper.last_overall_progress == 0
        assert progress_mapper.current_stage == "starting"

    def test_stage_ranges_are_valid(self, progress_mapper):
        """Test that all stage ranges are valid and sequential."""
        ranges = progress_mapper.STAGE_RANGES
        
        # Test that ranges don't overlap (except for aliases)
        crawl_stages = ["starting", "analyzing", "crawling", "processing", 
                       "source_creation", "document_storage", "code_extraction", 
                       "finalization", "completed"]
        
        last_end = 0
        for stage in crawl_stages[:-1]:  # Exclude completed which is (100, 100)
            start, end = ranges[stage]
            assert start >= last_end, f"Stage {stage} starts before previous stage ends"
            assert end > start, f"Stage {stage} has invalid range: {start}-{end}"
            last_end = end

        # Test that code extraction gets the largest range (it's the longest)
        code_start, code_end = ranges["code_extraction"]
        code_range = code_end - code_start
        
        doc_start, doc_end = ranges["document_storage"]  
        doc_range = doc_end - doc_start
        
        assert code_range > doc_range, "Code extraction should have larger range than document storage"

    def test_map_progress_basic_functionality(self, progress_mapper):
        """Test basic progress mapping functionality."""
        # Test crawling stage at 50%
        result = progress_mapper.map_progress("crawling", 50.0)
        
        # Should be halfway between crawling range (2-5%)
        expected = 2 + (50 / 100) * (5 - 2)  # 3.5%, rounded to 4
        assert result == 4

    def test_map_progress_document_storage(self, progress_mapper):
        """Test progress mapping for document storage stage."""
        # Test document storage at 25%
        result = progress_mapper.map_progress("document_storage", 25.0)
        
        # Should be 25% through document_storage range (10-30%)
        expected = 10 + (25 / 100) * (30 - 10)  # 10 + 5 = 15
        assert result == 15

    def test_map_progress_code_extraction(self, progress_mapper):
        """Test progress mapping for code extraction stage."""
        # Test code extraction at 50%  
        result = progress_mapper.map_progress("code_extraction", 50.0)
        
        # Should be 50% through code_extraction range (30-95%)
        expected = 30 + (50 / 100) * (95 - 30)  # 30 + 32.5 = 62.5, rounded to 62
        assert result == 62

    def test_map_progress_never_goes_backwards(self, progress_mapper):
        """Test that mapped progress never decreases."""
        # Set initial progress to 50%
        result1 = progress_mapper.map_progress("document_storage", 100.0)  # Should be 30%
        assert result1 == 30
        
        # Try to map a lower stage with lower progress
        result2 = progress_mapper.map_progress("crawling", 50.0)  # Would normally be ~3.5%
        
        # Should maintain higher progress
        assert result2 == 30  # Stays at previous high value

    def test_map_progress_clamping(self, progress_mapper):
        """Test that stage progress is clamped to 0-100 range."""
        # Test negative progress
        result = progress_mapper.map_progress("crawling", -10.0)
        expected = 2  # Start of crawling range
        assert result == expected
        
        # Test progress over 100
        result = progress_mapper.map_progress("crawling", 150.0)  
        expected = 5  # End of crawling range
        assert result == expected

    def test_completion_always_returns_100(self, progress_mapper):
        """Test that completion stages always return 100%."""
        assert progress_mapper.map_progress("completed", 0) == 100
        assert progress_mapper.map_progress("complete", 50) == 100
        assert progress_mapper.map_progress("completed", 100) == 100

    def test_error_returns_negative_one(self, progress_mapper):
        """Test that error stage returns -1."""
        assert progress_mapper.map_progress("error", 50) == -1

    def test_unknown_stage_maintains_current_progress(self, progress_mapper):
        """Test that unknown stages don't change progress."""
        # Set some initial progress
        progress_mapper.map_progress("crawling", 50)
        current = progress_mapper.last_overall_progress
        
        # Try unknown stage
        result = progress_mapper.map_progress("unknown_stage", 75)
        
        # Should maintain current progress
        assert result == current

    def test_get_stage_range(self, progress_mapper):
        """Test getting stage ranges."""
        assert progress_mapper.get_stage_range("crawling") == (2, 5)
        assert progress_mapper.get_stage_range("document_storage") == (10, 30)
        assert progress_mapper.get_stage_range("code_extraction") == (30, 95)
        assert progress_mapper.get_stage_range("unknown") == (0, 100)  # Default

    def test_calculate_stage_progress(self, progress_mapper):
        """Test stage progress calculation from current/max values."""
        # Test normal case
        result = progress_mapper.calculate_stage_progress(25, 100)
        assert result == 25.0
        
        # Test division by zero protection
        result = progress_mapper.calculate_stage_progress(10, 0)
        assert result == 0.0
        
        # Test negative max protection
        result = progress_mapper.calculate_stage_progress(10, -5)
        assert result == 0.0

    def test_map_batch_progress(self, progress_mapper):
        """Test batch progress mapping."""
        # Test batch 3 of 6 in document_storage stage
        result = progress_mapper.map_batch_progress("document_storage", 3, 6)
        
        # Should be (3-1)/6 = 33.3% through document_storage stage
        # document_storage is 10-30%, so 33.3% of 20% = 6.67%, so 10 + 6.67 = 16.67 ≈ 17
        assert result == 17

    def test_map_with_substage(self, progress_mapper):
        """Test progress mapping with substage information."""
        # For now, this should work the same as regular mapping
        result = progress_mapper.map_with_substage("document_storage", "embeddings", 50.0)
        expected = progress_mapper.map_progress("document_storage", 50.0)
        assert result == expected

    def test_reset_functionality(self, progress_mapper):
        """Test that reset() clears state."""
        # Set some progress
        progress_mapper.map_progress("crawling", 50)
        assert progress_mapper.last_overall_progress > 0
        assert progress_mapper.current_stage != "starting"
        
        # Reset
        progress_mapper.reset()
        
        # Should be back to initial state
        assert progress_mapper.last_overall_progress == 0
        assert progress_mapper.current_stage == "starting"

    def test_get_current_stage_and_progress(self, progress_mapper):
        """Test getting current stage and progress."""
        # Initial state
        assert progress_mapper.get_current_stage() == "starting"
        assert progress_mapper.get_current_progress() == 0
        
        # After mapping some progress
        progress_mapper.map_progress("document_storage", 50)
        assert progress_mapper.get_current_stage() == "document_storage"
        assert progress_mapper.get_current_progress() == 20  # 50% of 10-30% range

    def test_realistic_crawl_sequence(self, progress_mapper):
        """Test a realistic sequence of crawl progress updates."""
        stages = [
            ("starting", 0, 0),
            ("analyzing", 100, 2),
            ("crawling", 100, 5),
            ("processing", 100, 8),
            ("source_creation", 100, 10),
            ("document_storage", 25, 15),  # 25% of storage
            ("document_storage", 50, 20),  # 50% of storage
            ("document_storage", 75, 25),  # 75% of storage
            ("document_storage", 100, 30), # Complete storage
            ("code_extraction", 25, 46),   # 25% of extraction
            ("code_extraction", 50, 62),   # 50% of extraction
            ("code_extraction", 100, 95),  # Complete extraction
            ("finalization", 100, 100),    # Finalization
            ("completed", 0, 100),         # Completion
        ]
        
        progress_mapper.reset()
        
        for stage, stage_progress, expected_overall in stages:
            result = progress_mapper.map_progress(stage, stage_progress)
            assert result == expected_overall, f"Stage {stage} at {stage_progress}% should map to {expected_overall}%, got {result}%"

    def test_upload_stage_ranges(self, progress_mapper):
        """Test upload-specific stage ranges."""
        upload_stages = ["reading", "extracting", "chunking", "creating_source", "summarizing", "storing"]
        
        # Test that upload stages have valid ranges
        last_end = 0
        for stage in upload_stages:
            start, end = progress_mapper.get_stage_range(stage)
            assert start >= last_end, f"Upload stage {stage} overlaps with previous"
            assert end > start, f"Upload stage {stage} has invalid range"
            last_end = end
        
        # Test that final upload stage reaches 100%
        assert progress_mapper.get_stage_range("storing")[1] == 100