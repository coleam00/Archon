"""Integration tests for crawl orchestration progress tracking."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from src.server.services.crawling.crawling_service import CrawlingService
from src.server.services.crawling.progress_mapper import ProgressMapper
from src.server.utils.progress.progress_tracker import ProgressTracker
from tests.progress_tracking.utils.test_helpers import ProgressTestHelper


@pytest.fixture
def mock_crawler():
    """Create a mock Crawl4AI crawler."""
    crawler = MagicMock()
    return crawler


@pytest.fixture
def crawl_progress_mock_supabase_client():
    """Create a mock Supabase client for crawl orchestration progress tests."""
    client = MagicMock()
    
    # Mock table operations
    mock_table = MagicMock()
    mock_table.select.return_value = mock_table
    mock_table.eq.return_value = mock_table
    mock_table.execute.return_value = MagicMock(data=[])
    
    client.table.return_value = mock_table
    return client


@pytest.fixture
def crawling_service(mock_crawler, crawl_progress_mock_supabase_client):
    """Create a CrawlingService instance for testing."""
    service = CrawlingService(
        crawler=mock_crawler,
        supabase_client=crawl_progress_mock_supabase_client,
        progress_id="test-crawl-123"
    )
    # Initialize progress tracker for testing
    service.set_progress_id("test-crawl-123")
    return service


class TestCrawlOrchestrationProgressIntegration:
    """Integration tests for crawl orchestration progress tracking."""

    @pytest.mark.asyncio
    @patch('src.server.services.crawling.document_storage_operations.DocumentStorageOperations.process_and_store_documents')
    @patch('src.server.services.crawling.strategies.batch.BatchCrawlStrategy.crawl_batch_with_progress')
    async def test_full_crawl_orchestration_progress(self, mock_batch_crawl, mock_doc_storage, crawling_service):
        """Test complete crawl orchestration with progress mapping."""
        
        # Mock batch crawl results
        mock_crawl_results = [
            {"url": f"https://example.com/page{i}", "markdown": f"Content {i}"}
            for i in range(1, 61)  # 60 pages
        ]
        mock_batch_crawl.return_value = mock_crawl_results
        
        # Mock document storage results
        mock_doc_storage.return_value = {
            "chunk_count": 300,
            "chunks_stored": 300,
            "total_word_count": 15000,
            "source_id": "source-123"
        }
        
        # Track all progress updates
        progress_updates = []
        
        def track_progress_updates(*args, **kwargs):
            # Store the current state whenever progress is updated
            if crawling_service.progress_tracker:
                progress_updates.append(crawling_service.progress_tracker.get_state().copy())
        
        # Patch the progress tracker update to capture calls
        original_update = crawling_service.progress_tracker.update
        async def tracked_update(*args, **kwargs):
            result = await original_update(*args, **kwargs)
            track_progress_updates()
            return result
        
        crawling_service.progress_tracker.update = tracked_update
        
        # Test data
        test_request = {
            "url": "https://example.com/sitemap.xml",
            "knowledge_type": "documentation",
            "tags": ["test"]
        }
        
        urls_to_crawl = [f"https://example.com/page{i}" for i in range(1, 61)]
        
        # Execute the crawl (using internal orchestration method would be ideal)
        # For now, test the document storage orchestration part
        crawl_results = mock_crawl_results
        
        # Mock the document storage callback to simulate realistic progress
        doc_storage_calls = []
        async def mock_doc_storage_with_progress(*args, **kwargs):
            # Get the progress callback
            progress_callback = kwargs.get('progress_callback')
            
            if progress_callback:
                # Simulate batch processing progress
                for batch in range(1, 7):  # 6 batches
                    await progress_callback(
                        "document_storage",
                        int(batch * 100 / 6),  # 0%, 16%, 33%, 50%, 66%, 83%, 100%
                        f"Processing batch {batch}/6 ({25} chunks)",
                        current_batch=batch,
                        total_batches=6,
                        completed_batches=batch - 1,
                        chunks_in_batch=25,
                        active_workers=4
                    )
                    doc_storage_calls.append(batch)
                    await asyncio.sleep(0.01)  # Small delay
            
            return {
                "chunk_count": 150,
                "chunks_stored": 150,
                "total_word_count": 7500,
                "source_id": "source-456"
            }
        
        mock_doc_storage.side_effect = mock_doc_storage_with_progress
        
        # Create the progress callback
        progress_callback = await crawling_service._create_crawl_progress_callback("document_storage")
        
        # Execute document storage operation
        await crawling_service.doc_storage_ops.process_and_store_documents(
            crawl_results=crawl_results,
            request=test_request,
            crawl_type="sitemap",
            original_source_id="source-456",
            progress_callback=progress_callback
        )
        
        # Verify progress updates were captured
        assert len(progress_updates) >= 6  # At least one per batch
        
        # Verify progress mapping worked correctly
        mapped_progresses = [update.get("progress", 0) for update in progress_updates]
        
        # Progress should generally increase (allowing for some mapping adjustments)
        for i in range(1, len(mapped_progresses)):
            assert mapped_progresses[i] >= mapped_progresses[i-1], f"Progress went backwards: {mapped_progresses[i-1]} -> {mapped_progresses[i]}"
        
        # Verify batch information is preserved
        batch_updates = [update for update in progress_updates if "current_batch" in update]
        assert len(batch_updates) >= 3  # Should have multiple batch updates
        
        for update in batch_updates:
            assert update["current_batch"] >= 1
            assert update["total_batches"] == 6
            assert "chunks_in_batch" in update

    @pytest.mark.asyncio
    async def test_progress_mapper_integration(self, crawling_service):
        """Test that progress mapper correctly maps different stages."""
        
        mapper = crawling_service.progress_mapper
        tracker = crawling_service.progress_tracker
        
        # Test sequence of stage progressions with mapping (updated for new ranges)
        test_stages = [
            ("analyzing", 100, 3),      # Should map to ~3%
            ("crawling", 100, 15),      # Should map to ~15% 
            ("processing", 100, 20),    # Should map to ~20%
            ("source_creation", 100, 25), # Should map to ~25%
            ("document_storage", 25, 29), # 25% of 25-40% = 29%
            ("document_storage", 50, 32), # 50% of 25-40% = 32.5% ≈ 32%
            ("document_storage", 100, 40), # 100% of 25-40% = 40%
            ("code_extraction", 50, 65),  # 50% of 40-90% = 65%
            ("code_extraction", 100, 90), # 100% of 40-90% = 90%
            ("finalization", 100, 100),   # Should map to 100%
        ]
        
        for stage, stage_progress, expected_overall in test_stages:
            mapped = mapper.map_progress(stage, stage_progress)
            
            # Update tracker with mapped progress
            await tracker.update(
                status=stage,
                progress=mapped,
                log=f"Stage {stage} at {stage_progress}% -> {mapped}%"
            )
            
            # Allow small tolerance for rounding
            assert abs(mapped - expected_overall) <= 1, f"Stage {stage} mapping: expected ~{expected_overall}%, got {mapped}%"
        
        # Verify final state
        final_state = tracker.get_state()
        assert final_state["progress"] == 100
        assert final_state["status"] == "finalization"

    @pytest.mark.asyncio
    async def test_cancellation_during_orchestration(self, crawling_service):
        """Test that cancellation is handled properly during orchestration."""
        
        # Set up cancellation after some progress
        progress_count = 0
        
        original_update = crawling_service.progress_tracker.update
        async def cancellation_update(*args, **kwargs):
            nonlocal progress_count
            progress_count += 1
            
            if progress_count > 3:  # Cancel after a few updates
                crawling_service.cancel()
            
            return await original_update(*args, **kwargs)
        
        crawling_service.progress_tracker.update = cancellation_update
        
        # Test that cancellation check works
        assert not crawling_service.is_cancelled()
        
        # Simulate some progress updates
        for i in range(5):
            if crawling_service.is_cancelled():
                break
            
            await crawling_service.progress_tracker.update(
                status="processing",
                progress=i * 20,
                log=f"Progress update {i}"
            )
        
        # Should have been cancelled
        assert crawling_service.is_cancelled()
        
        # Test that _check_cancellation raises exception
        with pytest.raises(asyncio.CancelledError):
            crawling_service._check_cancellation()

    @pytest.mark.asyncio
    async def test_progress_callback_signature_compatibility(self, crawling_service):
        """Test that progress callback signatures work correctly across components."""
        
        callback_calls = []
        
        # Create callback that logs all calls for inspection
        async def logging_callback(status: str, progress: int, message: str, **kwargs):
            callback_calls.append({
                'status': status,
                'progress': progress,
                'message': message,
                'kwargs': kwargs,
                'kwargs_keys': list(kwargs.keys())
            })
        
        # Create the progress callback
        progress_callback = await crawling_service._create_crawl_progress_callback("document_storage")
        
        # Test direct callback calls (simulating what document storage service does)
        await progress_callback(
            "document_storage",
            25,
            "Processing batch 2/6",
            current_batch=2,
            total_batches=6,
            completed_batches=1,
            chunks_in_batch=25,
            active_workers=4
        )
        
        # Verify the callback was processed correctly
        state = crawling_service.progress_tracker.get_state()
        
        assert state["status"] == "document_storage"
        assert state["log"] == "Processing batch 2/6"
        assert state["current_batch"] == 2
        assert state["total_batches"] == 6
        assert state["completed_batches"] == 1
        assert state["chunks_in_batch"] == 25
        assert state["active_workers"] == 4

    @pytest.mark.asyncio
    async def test_error_recovery_in_progress_tracking(self, crawling_service):
        """Test that progress tracking recovers gracefully from errors."""
        
        # Track error recovery
        error_count = 0
        success_count = 0
        
        original_update = crawling_service.progress_tracker.update
        
        async def error_prone_update(*args, **kwargs):
            nonlocal error_count, success_count
            
            # Fail every 3rd update to simulate intermittent errors
            if (error_count + success_count) % 3 == 2:
                error_count += 1
                raise Exception("Simulated progress tracking error")
            else:
                success_count += 1
                return await original_update(*args, **kwargs)
        
        crawling_service.progress_tracker.update = error_prone_update
        
        # Attempt multiple progress updates
        successful_updates = 0
        for i in range(10):
            try:
                mapper = crawling_service.progress_mapper
                mapped_progress = mapper.map_progress("document_storage", i * 10)
                
                await crawling_service.progress_tracker.update(
                    status="document_storage",
                    progress=mapped_progress,
                    log=f"Update {i}",
                    test_data=f"data_{i}"
                )
                successful_updates += 1
                
            except Exception:
                # Errors should be handled gracefully
                continue
        
        # Should have some successful updates despite errors
        assert successful_updates >= 6  # At least 6 out of 10 should succeed
        assert error_count > 0  # Should have encountered some errors
        
        # Final state should reflect the last successful update
        final_state = crawling_service.progress_tracker.get_state()
        assert final_state["status"] == "document_storage"
        assert "Update" in final_state.get("log", "")