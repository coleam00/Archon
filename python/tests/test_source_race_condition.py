"""
Test race condition handling in source creation.

This test ensures that concurrent source creation attempts
don't fail with PRIMARY KEY violations.
"""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
import pytest

from src.server.services.source_management_service import update_source_info


class TestSourceRaceCondition:
    """Test that concurrent source creation handles race conditions properly."""

    def test_concurrent_source_creation_no_race(self):
        """Test that concurrent attempts to create the same source don't fail."""
        # Track successful operations
        successful_creates = []
        failed_creates = []
        
        def mock_execute():
            """Mock execute that simulates database operation."""
            return Mock(data=[])
        
        def track_upsert(data):
            """Track upsert calls."""
            successful_creates.append(data["source_id"])
            return Mock(execute=mock_execute)
        
        # Mock Supabase client
        mock_client = Mock()
        
        # Mock the SELECT (existing source check) - always returns empty
        mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        
        # Mock the UPSERT operation
        mock_client.table.return_value.upsert = track_upsert
        
        def create_source(thread_id):
            """Simulate creating a source from a thread."""
            try:
                # Run async function in new event loop for each thread
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                loop.run_until_complete(update_source_info(
                    client=mock_client,
                    source_id="test_source_123",
                    summary=f"Summary from thread {thread_id}",
                    word_count=100,
                    content=f"Content from thread {thread_id}",
                    knowledge_type="documentation",
                    tags=["test"],
                    update_frequency=0,
                    source_url="https://example.com",
                    source_display_name=f"Example Site {thread_id}"  # Will be used as title
                ))
                loop.close()
            except Exception as e:
                failed_creates.append((thread_id, str(e)))
        
        # Run 5 threads concurrently trying to create the same source
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = []
            for i in range(5):
                futures.append(executor.submit(create_source, i))
            
            # Wait for all to complete
            for future in futures:
                future.result()
        
        # All should succeed (no failures due to PRIMARY KEY violation)
        assert len(failed_creates) == 0, f"Some creates failed: {failed_creates}"
        assert len(successful_creates) == 5, "All 5 attempts should succeed"
        assert all(sid == "test_source_123" for sid in successful_creates)

    def test_upsert_vs_insert_behavior(self):
        """Test that upsert is used instead of insert for new sources."""
        mock_client = Mock()
        
        # Track which method is called
        methods_called = []
        
        def track_insert(data):
            methods_called.append("insert")
            # Simulate PRIMARY KEY violation
            raise Exception("duplicate key value violates unique constraint")
        
        def track_upsert(data):
            methods_called.append("upsert")
            return Mock(execute=Mock(return_value=Mock(data=[])))
        
        # Source doesn't exist
        mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        
        # Set up mocks
        mock_client.table.return_value.insert = track_insert
        mock_client.table.return_value.upsert = track_upsert
        
        # Run async function in sync context
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(update_source_info(
            client=mock_client,
            source_id="new_source",
            summary="Test summary",
            word_count=100,
            content="Test content",
            knowledge_type="documentation",
            source_display_name="Test Display Name"  # Will be used as title
        ))
        loop.close()
        
        # Should use upsert, not insert
        assert "upsert" in methods_called, "Should use upsert for new sources"
        assert "insert" not in methods_called, "Should not use insert to avoid race conditions"

    def test_existing_source_uses_update(self):
        """Test that existing sources still use UPDATE (not affected by change)."""
        mock_client = Mock()
        
        methods_called = []
        
        def track_update(data):
            methods_called.append("update")
            return Mock(eq=Mock(return_value=Mock(execute=Mock(return_value=Mock(data=[])))))
        
        def track_upsert(data):
            methods_called.append("upsert")
            return Mock(execute=Mock(return_value=Mock(data=[])))
        
        # Source exists
        existing_source = {
            "source_id": "existing_source",
            "title": "Existing Title",
            "metadata": {"knowledge_type": "api"}
        }
        mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [existing_source]
        
        # Set up mocks
        mock_client.table.return_value.update = track_update
        mock_client.table.return_value.upsert = track_upsert
        
        # Run async function in sync context
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(update_source_info(
            client=mock_client,
            source_id="existing_source",
            summary="Updated summary",
            word_count=200,
            content="Updated content",
            knowledge_type="documentation"
        ))
        loop.close()
        
        # Should use update for existing sources
        assert "update" in methods_called, "Should use update for existing sources"
        assert "upsert" not in methods_called, "Should not use upsert for existing sources"

    @pytest.mark.asyncio
    async def test_async_concurrent_creation(self):
        """Test concurrent source creation in async context."""
        mock_client = Mock()
        
        # Track operations
        operations = []
        
        def track_upsert(data):
            operations.append(("upsert", data["source_id"]))
            return Mock(execute=Mock(return_value=Mock(data=[])))
        
        # No existing sources
        mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        mock_client.table.return_value.upsert = track_upsert
        
        async def create_source_async(task_id):
            """Async wrapper for source creation."""
            await update_source_info(
                client=mock_client,
                source_id=f"async_source_{task_id % 2}",  # Only 2 unique sources
                summary=f"Summary {task_id}",
                word_count=100,
                content=f"Content {task_id}",
                knowledge_type="documentation"
            )
        
        # Create 10 tasks, but only 2 unique source_ids
        tasks = [create_source_async(i) for i in range(10)]
        await asyncio.gather(*tasks)
        
        # All operations should succeed
        assert len(operations) == 10, "All 10 operations should complete"
        
        # Check that we tried to upsert the two sources multiple times
        source_0_count = sum(1 for op, sid in operations if sid == "async_source_0")
        source_1_count = sum(1 for op, sid in operations if sid == "async_source_1")
        
        assert source_0_count == 5, "async_source_0 should be upserted 5 times"
        assert source_1_count == 5, "async_source_1 should be upserted 5 times"

    def test_race_condition_with_delay(self):
        """Test race condition with simulated delay between check and create."""
        import time
        
        mock_client = Mock()
        
        # Track timing of operations
        check_times = []
        create_times = []
        source_created = threading.Event()
        
        def delayed_select(*args):
            """Return a mock that simulates SELECT with delay."""
            mock_select = Mock()
            
            def eq_mock(*args):
                mock_eq = Mock()
                mock_eq.execute = lambda: delayed_check()
                return mock_eq
            
            mock_select.eq = eq_mock
            return mock_select
        
        def delayed_check():
            """Simulate SELECT execution with delay."""
            check_times.append(time.time())
            result = Mock()
            # First thread doesn't see the source
            if not source_created.is_set():
                time.sleep(0.01)  # Small delay to let both threads check
                result.data = []
            else:
                # Subsequent checks would see it (but we use upsert so this doesn't matter)
                result.data = [{"source_id": "race_source", "title": "Existing", "metadata": {}}]
            return result
        
        def track_upsert(data):
            """Track upsert and set event."""
            create_times.append(time.time())
            source_created.set()
            return Mock(execute=Mock(return_value=Mock(data=[])))
        
        # Set up table mock to return our custom select mock
        mock_client.table.return_value.select = delayed_select
        mock_client.table.return_value.upsert = track_upsert
        
        errors = []
        
        def create_with_error_tracking(thread_id):
            try:
                # Run async function in new event loop for each thread
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                loop.run_until_complete(update_source_info(
                    client=mock_client,
                    source_id="race_source",
                    summary="Race summary",
                    word_count=100,
                    content="Race content",
                    knowledge_type="documentation",
                    source_display_name="Race Display Name"  # Will be used as title
                ))
                loop.close()
            except Exception as e:
                errors.append((thread_id, str(e)))
        
        # Run 2 threads that will both check before either creates
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(create_with_error_tracking, 1),
                executor.submit(create_with_error_tracking, 2)
            ]
            for future in futures:
                future.result()
        
        # Both should succeed with upsert (no errors)
        assert len(errors) == 0, f"No errors should occur with upsert: {errors}"
        assert len(check_times) == 2, "Both threads should check"
        assert len(create_times) == 2, "Both threads should attempt create/upsert"