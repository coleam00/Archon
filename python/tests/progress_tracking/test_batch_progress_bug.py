"""
Test for batch progress bug where progress jumps to 100% prematurely.

This test ensures that when document_storage completes (100% of its stage),
the overall progress maps correctly to 40% and doesn't contaminate future stages.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from src.server.services.crawling.crawling_service import CrawlingService
from src.server.services.crawling.progress_mapper import ProgressMapper
from src.server.utils.progress.progress_tracker import ProgressTracker


class TestBatchProgressBug:
    """Test that batch progress doesn't jump to 100% prematurely."""
    
    @pytest.mark.asyncio
    async def test_document_storage_completion_maps_correctly(self):
        """Test that document_storage at 100% maps to 40% overall, not 100%."""
        
        # Create a progress mapper
        mapper = ProgressMapper()
        
        # Simulate document_storage progress
        progress_values = []
        
        # Document storage progresses from 0 to 100%
        for i in range(0, 101, 20):
            mapped = mapper.map_progress("document_storage", i)
            progress_values.append(mapped)
            
            # Document storage range is 25-40%
            # So 0% -> 25%, 50% -> 32.5%, 100% -> 40%
            if i == 0:
                assert mapped == 25, f"document_storage at 0% should map to 25%, got {mapped}%"
            elif i == 100:
                assert mapped == 40, f"document_storage at 100% should map to 40%, got {mapped}%"
            else:
                assert 25 <= mapped <= 40, f"document_storage at {i}% should be between 25-40%, got {mapped}%"
        
        # Verify final state after document_storage completes
        assert mapper.last_overall_progress == 40, "After document_storage completes, overall should be 40%"
        
        # Now start code_extraction at 0%
        code_start = mapper.map_progress("code_extraction", 0)
        assert code_start == 40, f"code_extraction at 0% should map to 40%, got {code_start}%"
        
        # Progress through code_extraction
        code_mid = mapper.map_progress("code_extraction", 50)
        assert code_mid == 65, f"code_extraction at 50% should map to 65%, got {code_mid}%"
        
        code_end = mapper.map_progress("code_extraction", 100)
        assert code_end == 90, f"code_extraction at 100% should map to 90%, got {code_end}%"
    
    @pytest.mark.asyncio
    async def test_progress_tracker_prevents_raw_value_contamination(self):
        """Test that ProgressTracker doesn't allow raw progress values to contaminate state."""
        
        tracker = ProgressTracker("test-progress-123", "crawl")
        
        # Start tracking
        await tracker.start({"url": "https://example.com"})
        
        # Simulate document_storage sending updates
        await tracker.update("document_storage", 25, "Starting document storage")
        assert tracker.state["progress"] == 25
        
        # Midway through
        await tracker.update("document_storage", 32, "Processing batches")
        assert tracker.state["progress"] == 32
        
        # Document storage completes (mapped to 40%)
        await tracker.update("document_storage", 40, "Document storage complete")
        assert tracker.state["progress"] == 40
        
        # Verify that logs also have correct progress
        logs = tracker.state.get("logs", [])
        if logs:
            last_log = logs[-1]
            assert last_log["progress"] == 40, f"Log should have progress=40, got {last_log['progress']}"
        
        # Start code_extraction at 40% (not 100%!)
        await tracker.update("code_extraction", 40, "Starting code extraction")
        assert tracker.state["progress"] == 40, "Progress should stay at 40% when code_extraction starts"
        
        # Progress through code_extraction
        await tracker.update("code_extraction", 65, "Extracting code examples")
        assert tracker.state["progress"] == 65
        
        # Verify protected fields aren't overridden via kwargs
        await tracker.update("code_extraction", 70, "More extraction", raw_progress=100, fake_status="fake")
        assert tracker.state["progress"] == 70, "Progress should remain at 70%"
        assert tracker.state["status"] == "code_extraction", "Status should remain code_extraction"
        # Verify that raw_progress doesn't override the actual progress
        assert tracker.state.get("raw_progress") != 70, "raw_progress can be stored but shouldn't affect progress"
    
    @pytest.mark.asyncio
    async def test_batch_processing_progress_sequence(self):
        """Test realistic batch processing sequence to ensure no premature 100%."""
        
        mapper = ProgressMapper()
        tracker = ProgressTracker("test-batch-123", "crawl")
        
        await tracker.start({"url": "https://example.com/sitemap.xml"})
        
        # Simulate crawling 20 pages
        total_pages = 20
        
        # Crawling phase (3-15%)
        for page in range(1, total_pages + 1):
            progress = (page / total_pages) * 100
            mapped = mapper.map_progress("crawling", progress)
            await tracker.update("crawling", mapped, f"Crawled {page}/{total_pages} pages")
            
            # Should never exceed 15% during crawling
            assert mapped <= 15, f"Crawling progress should not exceed 15%, got {mapped}%"
        
        # Document storage phase (25-40%) - process in 5 batches
        total_batches = 5
        for batch in range(1, total_batches + 1):
            progress = (batch / total_batches) * 100
            mapped = mapper.map_progress("document_storage", progress)
            await tracker.update("document_storage", mapped, f"Batch {batch}/{total_batches}")
            
            # Should be between 25-40% during document storage
            assert 25 <= mapped <= 40, f"Document storage should be 25-40%, got {mapped}%"
            
            # Specifically check batch 4/5 (80% of stage = ~37% overall)
            if batch == 4:
                assert mapped < 40, f"Batch 4/{total_batches} should not be at 40% yet, got {mapped}%"
                assert mapped < 100, f"Batch 4/{total_batches} should NEVER be 100%, got {mapped}%"
        
        # After all document storage batches
        final_doc_progress = tracker.state["progress"]
        assert final_doc_progress == 40, f"After document storage, should be at 40%, got {final_doc_progress}%"
        
        # Code extraction phase (40-90%)
        code_batches = 10
        for batch in range(1, code_batches + 1):
            progress = (batch / code_batches) * 100
            mapped = mapper.map_progress("code_extraction", progress)
            await tracker.update("code_extraction", mapped, f"Code batch {batch}/{code_batches}")
            
            # Should be between 40-90% during code extraction
            assert 40 <= mapped <= 90, f"Code extraction should be 40-90%, got {mapped}%"
        
        # Finalization (90-100%)
        finalize_mapped = mapper.map_progress("finalization", 50)
        await tracker.update("finalization", finalize_mapped, "Finalizing")
        assert 90 <= finalize_mapped <= 100, f"Finalization should be 90-100%, got {finalize_mapped}%"
        
        # Only at the very end should we reach 100%
        complete_mapped = mapper.map_progress("completed", 100)
        await tracker.update("completed", complete_mapped, "Completed")
        assert complete_mapped == 100, "Only 'completed' stage should reach 100%"
        
        # Verify the entire sequence never jumped to 100% prematurely
        # by checking the logs
        logs = tracker.state.get("logs", [])
        for i, log in enumerate(logs[:-1]):  # All except the last one
            assert log["progress"] < 100, f"Log {i} shows premature 100%: {log}"
        
        # Only the last log should be 100%
        if logs:
            assert logs[-1]["progress"] == 100, "Final log should be 100%"


if __name__ == "__main__":
    asyncio.run(pytest.main([__file__, "-v"]))