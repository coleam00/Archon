"""
Tests for ProgressMapper
"""

import pytest

from src.server.services.crawling.progress_mapper import ProgressMapper


class TestProgressMapper:
    """Test suite for ProgressMapper"""

    def test_initialization(self):
        """Test ProgressMapper initialization"""
        mapper = ProgressMapper()
        
        assert mapper.last_overall_progress == 0
        assert mapper.current_stage == "starting"
        
    def test_map_progress_basic(self):
        """Test basic progress mapping"""
        mapper = ProgressMapper()
        
        # Starting stage (0-1%)
        progress = mapper.map_progress("starting", 50)
        assert progress == 0  # 50% of 0-1 range
        
        # Analyzing stage (1-3%)
        progress = mapper.map_progress("analyzing", 50)
        assert progress == 2  # 1 + (50% of 2) = 2
        
        # Crawling stage (3-15%)
        progress = mapper.map_progress("crawling", 50)
        assert progress == 9  # 3 + (50% of 12) = 9
        
    def test_progress_never_goes_backwards(self):
        """Test that progress never decreases"""
        mapper = ProgressMapper()
        
        # Move to 50% of crawling (3-15%) = 9%
        progress1 = mapper.map_progress("crawling", 50)
        assert progress1 == 9
        
        # Try to go back to analyzing (1-3%) - should stay at 9%
        progress2 = mapper.map_progress("analyzing", 100)
        assert progress2 == 9  # Should not go backwards
        
        # Can move forward to document_storage
        progress3 = mapper.map_progress("document_storage", 50)
        assert progress3 == 32  # 25 + (50% of 15) = 32.5 -> 32
        
    def test_completion_handling(self):
        """Test completion status handling"""
        mapper = ProgressMapper()
        
        # Jump straight to completed
        progress = mapper.map_progress("completed", 0)
        assert progress == 100
        
        # Any percentage at completed should be 100
        progress = mapper.map_progress("completed", 50)
        assert progress == 100
        
    def test_error_handling(self):
        """Test error status handling - preserves last known progress"""
        mapper = ProgressMapper()
        
        # Error with no prior progress should return 0 (initial state)
        progress = mapper.map_progress("error", 50)
        assert progress == 0
        
        # Set some progress first, then error should preserve it
        mapper.map_progress("crawling", 50)  # Should map to somewhere in the crawling range
        current_progress = mapper.last_overall_progress
        error_progress = mapper.map_progress("error", 50)
        assert error_progress == current_progress  # Should preserve the progress
        
    def test_cancelled_handling(self):
        """Test cancelled status handling - preserves last known progress"""
        mapper = ProgressMapper()
        
        # Cancelled with no prior progress should return 0 (initial state)
        progress = mapper.map_progress("cancelled", 50)
        assert progress == 0
        
        # Set some progress first, then cancelled should preserve it
        mapper.map_progress("crawling", 75)  # Should map to somewhere in the crawling range
        current_progress = mapper.last_overall_progress
        cancelled_progress = mapper.map_progress("cancelled", 50)
        assert cancelled_progress == current_progress  # Should preserve the progress
        
    def test_unknown_stage(self):
        """Test handling of unknown stages"""
        mapper = ProgressMapper()
        
        # Set some initial progress
        mapper.map_progress("crawling", 50)
        current = mapper.last_overall_progress
        
        # Unknown stage should maintain current progress
        progress = mapper.map_progress("unknown_stage", 50)
        assert progress == current
        
    def test_stage_ranges(self):
        """Test all defined stage ranges"""
        mapper = ProgressMapper()
        
        # Verify ranges are correctly defined with new balanced values
        assert mapper.STAGE_RANGES["starting"] == (0, 1)
        assert mapper.STAGE_RANGES["analyzing"] == (1, 3)
        assert mapper.STAGE_RANGES["crawling"] == (3, 15)
        assert mapper.STAGE_RANGES["processing"] == (15, 20)
        assert mapper.STAGE_RANGES["source_creation"] == (20, 25)
        assert mapper.STAGE_RANGES["document_storage"] == (25, 40)
        assert mapper.STAGE_RANGES["code_extraction"] == (40, 90)
        assert mapper.STAGE_RANGES["finalization"] == (90, 100)
        assert mapper.STAGE_RANGES["completed"] == (100, 100)
        
        # Upload-specific stages
        assert mapper.STAGE_RANGES["reading"] == (0, 5)
        assert mapper.STAGE_RANGES["text_extraction"] == (5, 10)
        assert mapper.STAGE_RANGES["chunking"] == (10, 15)
        # Note: source_creation is shared between crawl and upload operations at (20, 25)
        assert mapper.STAGE_RANGES["summarizing"] == (25, 35)
        assert mapper.STAGE_RANGES["storing"] == (35, 100)
        
    def test_calculate_stage_progress(self):
        """Test calculating percentage within a stage"""
        mapper = ProgressMapper()
        
        # 5 out of 10 = 50%
        progress = mapper.calculate_stage_progress(5, 10)
        assert progress == 50.0
        
        # 0 out of 10 = 0%
        progress = mapper.calculate_stage_progress(0, 10)
        assert progress == 0.0
        
        # 10 out of 10 = 100%
        progress = mapper.calculate_stage_progress(10, 10)
        assert progress == 100.0
        
        # Handle division by zero
        progress = mapper.calculate_stage_progress(5, 0)
        assert progress == 0.0
        
    def test_map_batch_progress(self):
        """Test batch progress mapping"""
        mapper = ProgressMapper()
        
        # Batch 1 of 5 in document_storage stage
        progress = mapper.map_batch_progress("document_storage", 1, 5)
        assert progress == 25  # Start of document_storage range (25-40)
        
        # Batch 3 of 5
        progress = mapper.map_batch_progress("document_storage", 3, 5)
        assert progress == 31  # 40% through 25-40 range
        
        # Batch 5 of 5
        progress = mapper.map_batch_progress("document_storage", 5, 5)
        assert progress == 37  # 80% through 25-40 range
        
    def test_map_with_substage(self):
        """Test mapping with substage information"""
        mapper = ProgressMapper()
        
        # Currently just uses main stage
        progress = mapper.map_with_substage("document_storage", "embeddings", 50)
        assert progress == 32  # 50% of 25-40 range = 32.5 -> 32
        
    def test_reset(self):
        """Test resetting the mapper"""
        mapper = ProgressMapper()
        
        # Set some progress
        mapper.map_progress("document_storage", 50)
        assert mapper.last_overall_progress == 32  # 25 + (50% of 15) = 32.5 -> 32
        assert mapper.current_stage == "document_storage"
        
        # Reset
        mapper.reset()
        assert mapper.last_overall_progress == 0
        assert mapper.current_stage == "starting"
        
    def test_get_current_stage(self):
        """Test getting current stage"""
        mapper = ProgressMapper()
        
        assert mapper.get_current_stage() == "starting"
        
        mapper.map_progress("crawling", 50)
        assert mapper.get_current_stage() == "crawling"
        
        mapper.map_progress("code_extraction", 50)
        assert mapper.get_current_stage() == "code_extraction"
        
    def test_get_current_progress(self):
        """Test getting current progress"""
        mapper = ProgressMapper()
        
        assert mapper.get_current_progress() == 0
        
        mapper.map_progress("crawling", 50)
        assert mapper.get_current_progress() == 9  # 3 + (50% of 12) = 9
        
        mapper.map_progress("code_extraction", 50)
        assert mapper.get_current_progress() == 65  # 40 + (50% of 50) = 65
        
    def test_get_stage_range(self):
        """Test getting stage range"""
        mapper = ProgressMapper()
        
        assert mapper.get_stage_range("starting") == (0, 1)
        assert mapper.get_stage_range("code_extraction") == (40, 90)
        assert mapper.get_stage_range("unknown") == (0, 100)  # Default range
        
    def test_realistic_crawl_sequence(self):
        """Test a realistic crawl progress sequence"""
        mapper = ProgressMapper()
        
        # Starting
        assert mapper.map_progress("starting", 0) == 0
        assert mapper.map_progress("starting", 100) == 1
        
        # Analyzing
        assert mapper.map_progress("analyzing", 0) == 1
        assert mapper.map_progress("analyzing", 100) == 3
        
        # Crawling
        assert mapper.map_progress("crawling", 0) == 3
        assert mapper.map_progress("crawling", 33) == 7  # 3 + (33% of 12) = 6.96 -> 7
        assert mapper.map_progress("crawling", 66) == 11  # 3 + (66% of 12) = 10.92 -> 11
        assert mapper.map_progress("crawling", 100) == 15
        
        # Processing
        assert mapper.map_progress("processing", 0) == 15
        assert mapper.map_progress("processing", 100) == 20
        
        # Source creation
        assert mapper.map_progress("source_creation", 0) == 20
        assert mapper.map_progress("source_creation", 100) == 25
        
        # Document storage
        assert mapper.map_progress("document_storage", 0) == 25
        assert mapper.map_progress("document_storage", 50) == 32  # 25 + (50% of 15) = 32.5 -> 32
        assert mapper.map_progress("document_storage", 100) == 40
        
        # Code extraction (longest phase)
        assert mapper.map_progress("code_extraction", 0) == 40
        assert mapper.map_progress("code_extraction", 25) == 52  # 40 + (25% of 50) = 52.5 -> 52
        assert mapper.map_progress("code_extraction", 50) == 65  # 40 + (50% of 50) = 65
        assert mapper.map_progress("code_extraction", 75) == 78  # 40 + (75% of 50) = 77.5 -> 78
        assert mapper.map_progress("code_extraction", 100) == 90
        
        # Finalization
        assert mapper.map_progress("finalization", 0) == 90
        assert mapper.map_progress("finalization", 100) == 100
        
        # Completed
        assert mapper.map_progress("completed", 0) == 100