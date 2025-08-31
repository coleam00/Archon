"""
Comprehensive Tests for Async Background Task Manager

Tests the pure async background task manager after removal of ThreadPoolExecutor.
Focuses on async task execution, concurrency control, and progress tracking.
"""

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from src.server.services.background_task_manager import (
    BackgroundTaskManager,
    cleanup_task_manager,
    get_task_manager,
)


class TestAsyncBackgroundTaskManager:
    """Test suite for async background task manager"""

    @pytest.fixture
    def task_manager(self):
        """Create a fresh task manager instance for each test"""
        return BackgroundTaskManager(max_concurrent_tasks=5)

    @pytest.fixture
    def mock_progress_callback(self):
        """Mock progress callback function"""
        return AsyncMock()

    @pytest.mark.asyncio
    async def test_task_manager_initialization(self, task_manager):
        """Test task manager initialization"""
        assert task_manager.max_concurrent_tasks == 5
        assert len(task_manager.active_tasks) == 0
        assert len(task_manager.task_metadata) == 0
        assert task_manager._task_semaphore._value == 5

    @pytest.mark.asyncio
    async def test_simple_async_task_execution(self, task_manager, mock_progress_callback):
        """Test execution of a simple async task"""

        async def simple_task(message: str):
            await asyncio.sleep(0.01)  # Simulate async work
            return f"Task completed: {message}"

        task_id = await task_manager.submit_task(
            simple_task, ("Hello World",), progress_callback=mock_progress_callback
        )

        # Wait for task completion
        await asyncio.sleep(0.05)

        # Check task status
        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "complete"
        assert status["progress"] == 100
        assert status["result"] == "Task completed: Hello World"

        # Verify progress callback was called
        assert mock_progress_callback.call_count >= 1

    @pytest.mark.asyncio
    async def test_task_with_error(self, task_manager, mock_progress_callback):
        """Test handling of task that raises an exception"""

        async def failing_task():
            await asyncio.sleep(0.01)
            raise ValueError("Task failed intentionally")

        task_id = await task_manager.submit_task(
            failing_task, (), progress_callback=mock_progress_callback
        )

        # Wait for task to fail
        await asyncio.sleep(0.05)

        # Check task status
        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "error"
        assert status["progress"] == -1
        assert "error" in status
        assert "Task failed intentionally" in status["error"]

        # Verify error was reported via progress callback
        error_call = None
        for call in mock_progress_callback.call_args_list:
            if len(call[0]) >= 2 and call[0][1].get("status") == "error":
                error_call = call
                break

        assert error_call is not None
        assert "Task failed intentionally" in error_call[0][1]["error"]

    @pytest.mark.asyncio
    async def test_concurrent_task_execution(self, task_manager):
        """Test execution of multiple concurrent tasks"""

        async def numbered_task(number: int):
            await asyncio.sleep(0.01)
            return f"Task {number} completed"

        # Submit 5 tasks simultaneously
        task_ids = []
        for i in range(5):
            task_id = await task_manager.submit_task(numbered_task, (i,), task_id=f"task-{i}")
            task_ids.append(task_id)

        # Wait for all tasks to complete
        await asyncio.sleep(0.05)

        # Check all tasks completed successfully
        for i, task_id in enumerate(task_ids):
            status = await task_manager.get_task_status(task_id)
            assert status["status"] == "complete"
            assert status["result"] == f"Task {i} completed"

    @pytest.mark.asyncio
    async def test_concurrency_limit(self, task_manager):
        """Test that concurrency is limited by semaphore"""
        # Use a task manager with limit of 2
        limited_manager = BackgroundTaskManager(max_concurrent_tasks=2)

        running_tasks = []
        completed_tasks = []

        async def long_running_task(task_id: int):
            running_tasks.append(task_id)
            await asyncio.sleep(0.05)  # Long enough to test concurrency
            completed_tasks.append(task_id)
            return f"Task {task_id} completed"

        # Submit 4 tasks
        task_ids = []
        for i in range(4):
            task_id = await limited_manager.submit_task(
                long_running_task, (i,), task_id=f"concurrent-task-{i}"
            )
            task_ids.append(task_id)

        # Wait a bit and check that only 2 tasks are running
        await asyncio.sleep(0.01)
        assert len(running_tasks) <= 2

        # Wait for all to complete
        await asyncio.sleep(0.3)
        assert len(completed_tasks) == 4

        # Clean up
        await limited_manager.cleanup()

    @pytest.mark.asyncio
    async def test_task_cancellation(self, task_manager):
        """Test cancellation of running task"""

        async def long_task():
            try:
                await asyncio.sleep(1.0)  # Long enough to be cancelled
                return "Should not complete"
            except asyncio.CancelledError:
                raise  # Re-raise to properly handle cancellation

        task_id = await task_manager.submit_task(long_task, (), task_id="cancellable-task")

        # Wait a bit, then cancel
        await asyncio.sleep(0.01)
        cancelled = await task_manager.cancel_task(task_id)
        assert cancelled is True

        # Check task status
        await asyncio.sleep(0.01)
        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "cancelled"

    @pytest.mark.asyncio
    async def test_task_not_found(self, task_manager):
        """Test getting status of non-existent task"""
        status = await task_manager.get_task_status("non-existent-task")
        assert status["error"] == "Task not found"

    @pytest.mark.asyncio
    async def test_cancel_non_existent_task(self, task_manager):
        """Test cancelling non-existent task"""
        cancelled = await task_manager.cancel_task("non-existent-task")
        assert cancelled is False

    @pytest.mark.asyncio
    async def test_progress_callback_execution(self, task_manager):
        """Test that progress callback is properly executed"""
        progress_updates = []

        async def mock_progress_callback(task_id: str, update: dict[str, Any]):
            progress_updates.append((task_id, update))

        async def simple_task():
            await asyncio.sleep(0.01)
            return "completed"

        task_id = await task_manager.submit_task(
            simple_task, (), task_id="progress-test-task", progress_callback=mock_progress_callback
        )

        # Wait for completion
        await asyncio.sleep(0.05)

        # Should have at least one progress update (completion)
        assert len(progress_updates) >= 1

        # Check that task_id matches
        assert all(update[0] == task_id for update in progress_updates)

        # Check for completion update
        completion_updates = [
            update for update in progress_updates if update[1].get("status") == "complete"
        ]
        assert len(completion_updates) >= 1
        assert completion_updates[0][1]["percentage"] == 100

    @pytest.mark.asyncio
    async def test_progress_callback_error_handling(self, task_manager):
        """Test that task continues even if progress callback fails"""

        async def failing_progress_callback(task_id: str, update: dict[str, Any]):
            raise Exception("Progress callback failed")

        async def simple_task():
            await asyncio.sleep(0.01)
            return "Task completed despite callback failure"

        task_id = await task_manager.submit_task(
            simple_task, (), progress_callback=failing_progress_callback
        )

        # Wait for completion
        await asyncio.sleep(0.05)

        # Task should still complete successfully
        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "complete"
        assert status["result"] == "Task completed despite callback failure"

    @pytest.mark.asyncio
    async def test_task_metadata_tracking(self, task_manager):
        """Test that task metadata is properly tracked"""

        async def simple_task():
            await asyncio.sleep(0.01)
            return "result"

        task_id = await task_manager.submit_task(simple_task, (), task_id="metadata-test")

        # Check initial metadata
        initial_status = await task_manager.get_task_status(task_id)
        assert initial_status["status"] == "running"
        assert "created_at" in initial_status
        assert initial_status["progress"] == 0

        # Wait for completion
        await asyncio.sleep(0.05)

        # Check final metadata
        final_status = await task_manager.get_task_status(task_id)
        assert final_status["status"] == "complete"
        assert final_status["progress"] == 100
        assert final_status["result"] == "result"

    @pytest.mark.asyncio
    async def test_cleanup_active_tasks(self, task_manager):
        """Test cleanup cancels active tasks"""

        async def long_running_task():
            try:
                await asyncio.sleep(1.0)
                return "Should not complete"
            except asyncio.CancelledError:
                raise

        # Submit multiple long-running tasks
        task_ids = []
        for i in range(3):
            task_id = await task_manager.submit_task(
                long_running_task, (), task_id=f"cleanup-test-{i}"
            )
            task_ids.append(task_id)

        # Verify tasks are active
        await asyncio.sleep(0.01)
        assert len(task_manager.active_tasks) == 3

        # Cleanup
        await task_manager.cleanup()

        # Verify all tasks were cancelled and cleaned up
        assert len(task_manager.active_tasks) == 0
        assert len(task_manager.task_metadata) == 0

    @pytest.mark.asyncio
    async def test_completed_task_status_after_removal(self, task_manager):
        """Test getting status of completed task after it's removed from active_tasks"""

        async def quick_task():
            return "quick result"

        task_id = await task_manager.submit_task(quick_task, (), task_id="quick-test")

        # Wait for completion and removal from active_tasks
        await asyncio.sleep(0.05)

        # Should still be able to get status from metadata
        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "complete"
        assert status["result"] == "quick result"

    def test_set_main_loop_deprecated(self, task_manager):
        """Test that set_main_loop is deprecated but doesn't break"""
        # Should not raise an exception but may log a warning
        import asyncio

        loop = asyncio.new_event_loop()
        task_manager.set_main_loop(loop)
        loop.close()


class TestGlobalTaskManager:
    """Test the global task manager functions"""

    def test_get_task_manager_singleton(self):
        """Test that get_task_manager returns singleton"""
        manager1 = get_task_manager()
        manager2 = get_task_manager()
        assert manager1 is manager2

    @pytest.mark.asyncio
    async def test_cleanup_task_manager(self):
        """Test cleanup of global task manager"""
        # Get the global manager
        manager = get_task_manager()
        assert manager is not None

        # Add a task to make it interesting
        async def test_task():
            return "test"

        task_id = await manager.submit_task(test_task, ())
        await asyncio.sleep(0.01)

        # Cleanup
        await cleanup_task_manager()

        # Verify it was cleaned up - getting a new one should be different
        new_manager = get_task_manager()
        assert new_manager is not manager


class TestAsyncTaskPatterns:
    """Test various async task patterns and edge cases"""

    @pytest.fixture
    def task_manager(self):
        return BackgroundTaskManager(max_concurrent_tasks=3)

    @pytest.mark.asyncio
    async def test_nested_async_calls(self, task_manager):
        """Test tasks that make nested async calls"""

        async def nested_task():
            async def inner_task():
                await asyncio.sleep(0.01)
                return "inner result"

            result = await inner_task()
            return f"outer: {result}"

        task_id = await task_manager.submit_task(nested_task, ())
        await asyncio.sleep(0.05)

        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "complete"
        assert status["result"] == "outer: inner result"

    @pytest.mark.asyncio
    async def test_task_with_async_context_manager(self, task_manager):
        """Test tasks that use async context managers"""

        class AsyncResource:
            def __init__(self):
                self.entered = False
                self.exited = False

            async def __aenter__(self):
                await asyncio.sleep(0.001)
                self.entered = True
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                await asyncio.sleep(0.001)
                self.exited = True

        resource = AsyncResource()

        async def context_manager_task():
            async with resource:
                await asyncio.sleep(0.01)
                return "context manager used"

        task_id = await task_manager.submit_task(context_manager_task, ())
        await asyncio.sleep(0.05)

        status = await task_manager.get_task_status(task_id)
        assert status["status"] == "complete"
        assert status["result"] == "context manager used"
        assert resource.entered
        assert resource.exited

    @pytest.mark.asyncio
    async def test_task_cancellation_propagation(self, task_manager):
        """Test that cancellation properly propagates through nested calls"""
        cancelled_flags = []

        async def cancellable_inner():
            try:
                await asyncio.sleep(1.0)
                return "should not complete"
            except asyncio.CancelledError:
                cancelled_flags.append("inner")
                raise

        async def cancellable_outer():
            try:
                result = await cancellable_inner()
                return f"outer: {result}"
            except asyncio.CancelledError:
                cancelled_flags.append("outer")
                raise

        task_id = await task_manager.submit_task(cancellable_outer, ())
        await asyncio.sleep(0.01)

        # Cancel the task
        cancelled = await task_manager.cancel_task(task_id)
        assert cancelled

        await asyncio.sleep(0.01)

        # Both inner and outer should have been cancelled
        assert "inner" in cancelled_flags
        assert "outer" in cancelled_flags

    @pytest.mark.asyncio
    async def test_high_concurrency_stress_test(self, task_manager):
        """Stress test with many concurrent tasks"""

        async def stress_task(task_num: int):
            await asyncio.sleep(0.001 * (task_num % 10))  # Vary sleep time
            return f"stress-{task_num}"

        # Submit many tasks
        task_ids = []
        num_tasks = 20

        for i in range(num_tasks):
            task_id = await task_manager.submit_task(stress_task, (i,), task_id=f"stress-{i}")
            task_ids.append(task_id)

        # Wait for all to complete
        await asyncio.sleep(0.5)

        # Verify all completed successfully
        for i, task_id in enumerate(task_ids):
            status = await task_manager.get_task_status(task_id)
            assert status["status"] == "complete"
            assert status["result"] == f"stress-{i}"

    @pytest.mark.asyncio
    async def test_task_execution_order_with_semaphore(self, task_manager):
        """Test that semaphore properly controls execution order"""
        # Use manager with limit of 2
        limited_manager = BackgroundTaskManager(max_concurrent_tasks=2)
        execution_order = []

        async def ordered_task(task_id: int):
            execution_order.append(f"start-{task_id}")
            await asyncio.sleep(0.02)
            execution_order.append(f"end-{task_id}")
            return task_id

        # Submit 4 tasks
        task_ids = []
        for i in range(4):
            task_id = await limited_manager.submit_task(ordered_task, (i,), task_id=f"order-{i}")
            task_ids.append(task_id)

        # Wait for completion
        await asyncio.sleep(0.2)

        # Verify execution pattern - should see at most 2 concurrent executions
        starts_before_ends = 0
        for i, event in enumerate(execution_order):
            if event.startswith("start-"):
                # Count how many starts we've seen before the first end
                starts_seen = sum(1 for e in execution_order[: i + 1] if e.startswith("start-"))
                ends_seen = sum(1 for e in execution_order[: i + 1] if e.startswith("end-"))
                concurrent = starts_seen - ends_seen
                assert concurrent <= 2  # Should never exceed semaphore limit

        await limited_manager.cleanup()
