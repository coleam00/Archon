"""Unit tests for WorkOrderLogBuffer

Tests circular buffer behavior, filtering, thread safety, and cleanup.
"""

import threading
import time
from datetime import datetime

import pytest

from src.agent_work_orders.utils.log_buffer import WorkOrderLogBuffer


@pytest.mark.unit
def test_add_and_get_logs():
    """Test adding and retrieving logs"""
    buffer = WorkOrderLogBuffer()

    # Add logs
    buffer.add_log("wo-123", "info", "step_started", step="planning")
    buffer.add_log("wo-123", "info", "step_completed", step="planning", duration=12.5)

    # Get all logs
    logs = buffer.get_logs("wo-123")

    assert len(logs) == 2
    assert logs[0]["event"] == "step_started"
    assert logs[0]["step"] == "planning"
    assert logs[1]["event"] == "step_completed"
    assert logs[1]["duration"] == 12.5


@pytest.mark.unit
def test_circular_buffer_overflow():
    """Test that buffer keeps only last MAX_LOGS_PER_WORK_ORDER logs"""
    buffer = WorkOrderLogBuffer()

    # Add more logs than max capacity
    for i in range(1500):
        buffer.add_log("wo-123", "info", f"event_{i}", index=i)

    logs = buffer.get_logs("wo-123")

    # Should only have last 1000
    assert len(logs) == buffer.MAX_LOGS_PER_WORK_ORDER
    # First log should be index 500 (1500 - 1000)
    assert logs[0]["index"] == 500
    # Last log should be index 1499
    assert logs[-1]["index"] == 1499


@pytest.mark.unit
def test_filter_by_level():
    """Test filtering logs by log level"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "info_event")
    buffer.add_log("wo-123", "warning", "warning_event")
    buffer.add_log("wo-123", "error", "error_event")
    buffer.add_log("wo-123", "info", "another_info_event")

    # Filter by level (case-insensitive)
    info_logs = buffer.get_logs("wo-123", level="info")
    assert len(info_logs) == 2
    assert all(log["level"] == "info" for log in info_logs)

    error_logs = buffer.get_logs("wo-123", level="error")
    assert len(error_logs) == 1
    assert error_logs[0]["event"] == "error_event"

    # Test case insensitivity
    warning_logs = buffer.get_logs("wo-123", level="WARNING")
    assert len(warning_logs) == 1


@pytest.mark.unit
def test_filter_by_step():
    """Test filtering logs by step name"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "event1", step="planning")
    buffer.add_log("wo-123", "info", "event2", step="execute")
    buffer.add_log("wo-123", "info", "event3", step="planning")

    planning_logs = buffer.get_logs("wo-123", step="planning")
    assert len(planning_logs) == 2
    assert all(log["step"] == "planning" for log in planning_logs)

    execute_logs = buffer.get_logs("wo-123", step="execute")
    assert len(execute_logs) == 1


@pytest.mark.unit
def test_filter_by_timestamp():
    """Test filtering logs by timestamp"""
    buffer = WorkOrderLogBuffer()

    # Add logs with explicit timestamps
    ts1 = "2025-10-23T10:00:00Z"
    ts2 = "2025-10-23T11:00:00Z"
    ts3 = "2025-10-23T12:00:00Z"

    buffer.add_log("wo-123", "info", "event1", timestamp=ts1)
    buffer.add_log("wo-123", "info", "event2", timestamp=ts2)
    buffer.add_log("wo-123", "info", "event3", timestamp=ts3)

    # Get logs since 11:00
    recent_logs = buffer.get_logs("wo-123", since=ts2)
    assert len(recent_logs) == 1  # Only ts3 is after ts2
    assert recent_logs[0]["event"] == "event3"


@pytest.mark.unit
def test_multiple_work_orders():
    """Test that logs from different work orders are isolated"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "event1")
    buffer.add_log("wo-456", "info", "event2")
    buffer.add_log("wo-123", "info", "event3")

    logs_123 = buffer.get_logs("wo-123")
    logs_456 = buffer.get_logs("wo-456")

    assert len(logs_123) == 2
    assert len(logs_456) == 1
    assert all(log["work_order_id"] == "wo-123" for log in logs_123)
    assert all(log["work_order_id"] == "wo-456" for log in logs_456)


@pytest.mark.unit
def test_clear_work_order():
    """Test clearing logs for a specific work order"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "event1")
    buffer.add_log("wo-456", "info", "event2")

    assert buffer.get_log_count("wo-123") == 1
    assert buffer.get_log_count("wo-456") == 1

    buffer.clear_work_order("wo-123")

    assert buffer.get_log_count("wo-123") == 0
    assert buffer.get_log_count("wo-456") == 1  # Other work order unaffected


@pytest.mark.unit
def test_thread_safety():
    """Test concurrent adds from multiple threads"""
    buffer = WorkOrderLogBuffer()
    num_threads = 10
    logs_per_thread = 100

    def add_logs(thread_id):
        for i in range(logs_per_thread):
            buffer.add_log("wo-123", "info", f"thread_{thread_id}_event_{i}")

    threads = [threading.Thread(target=add_logs, args=(i,)) for i in range(num_threads)]

    for thread in threads:
        thread.start()

    for thread in threads:
        thread.join()

    # Should have all logs (or max capacity if exceeded)
    logs = buffer.get_logs("wo-123")
    expected = min(num_threads * logs_per_thread, buffer.MAX_LOGS_PER_WORK_ORDER)
    assert len(logs) == expected


@pytest.mark.unit
def test_cleanup_old_work_orders():
    """Test automatic cleanup of old work orders"""
    buffer = WorkOrderLogBuffer()

    # Add logs for work orders
    buffer.add_log("wo-old", "info", "event1")
    buffer.add_log("wo-new", "info", "event2")

    # Manually set old work order's last activity to past threshold
    threshold_time = time.time() - (buffer.CLEANUP_THRESHOLD_HOURS * 3600 + 100)
    buffer._last_activity["wo-old"] = threshold_time

    # Run cleanup
    removed = buffer.cleanup_old_work_orders()

    assert removed == 1
    assert buffer.get_log_count("wo-old") == 0
    assert buffer.get_log_count("wo-new") == 1


@pytest.mark.unit
def test_get_logs_with_pagination():
    """Test pagination with limit and offset"""
    buffer = WorkOrderLogBuffer()

    for i in range(50):
        buffer.add_log("wo-123", "info", f"event_{i}", index=i)

    # Get first page
    page1 = buffer.get_logs("wo-123", limit=10, offset=0)
    assert len(page1) == 10
    assert page1[0]["index"] == 0

    # Get second page
    page2 = buffer.get_logs("wo-123", limit=10, offset=10)
    assert len(page2) == 10
    assert page2[0]["index"] == 10

    # Get partial last page
    page_last = buffer.get_logs("wo-123", limit=10, offset=45)
    assert len(page_last) == 5


@pytest.mark.unit
def test_get_logs_since_convenience_method():
    """Test get_logs_since convenience method"""
    buffer = WorkOrderLogBuffer()

    ts1 = "2025-10-23T10:00:00Z"
    ts2 = "2025-10-23T11:00:00Z"

    buffer.add_log("wo-123", "info", "event1", timestamp=ts1, step="planning")
    buffer.add_log("wo-123", "info", "event2", timestamp=ts2, step="execute")

    logs = buffer.get_logs_since("wo-123", ts1, step="execute")
    assert len(logs) == 1
    assert logs[0]["event"] == "event2"


@pytest.mark.unit
def test_get_work_order_count():
    """Test getting count of tracked work orders"""
    buffer = WorkOrderLogBuffer()

    assert buffer.get_work_order_count() == 0

    buffer.add_log("wo-123", "info", "event1")
    assert buffer.get_work_order_count() == 1

    buffer.add_log("wo-456", "info", "event2")
    assert buffer.get_work_order_count() == 2

    buffer.clear_work_order("wo-123")
    assert buffer.get_work_order_count() == 1


@pytest.mark.unit
def test_empty_buffer_returns_empty_list():
    """Test that getting logs from empty buffer returns empty list"""
    buffer = WorkOrderLogBuffer()

    logs = buffer.get_logs("wo-nonexistent")
    assert logs == []
    assert buffer.get_log_count("wo-nonexistent") == 0


@pytest.mark.unit
def test_timestamp_auto_generation():
    """Test that timestamps are auto-generated if not provided"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "event1")

    logs = buffer.get_logs("wo-123")
    assert len(logs) == 1
    assert "timestamp" in logs[0]
    # Verify it's a valid ISO format timestamp
    datetime.fromisoformat(logs[0]["timestamp"].replace("Z", "+00:00"))


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_task_lifecycle():
    """Test starting and stopping cleanup task"""
    buffer = WorkOrderLogBuffer()

    # Start cleanup task
    await buffer.start_cleanup_task(interval_seconds=1)
    assert buffer._cleanup_task is not None

    # Starting again should be idempotent
    await buffer.start_cleanup_task()
    assert buffer._cleanup_task is not None

    # Stop cleanup task
    await buffer.stop_cleanup_task()
    assert buffer._cleanup_task is None


@pytest.mark.unit
def test_combined_filters():
    """Test using multiple filters together"""
    buffer = WorkOrderLogBuffer()

    ts1 = "2025-10-23T10:00:00Z"
    ts2 = "2025-10-23T11:00:00Z"

    buffer.add_log("wo-123", "info", "event1", timestamp=ts1, step="planning")
    buffer.add_log("wo-123", "error", "event2", timestamp=ts2, step="planning")
    buffer.add_log("wo-123", "info", "event3", timestamp=ts2, step="execute")

    # Filter by level AND step AND timestamp
    logs = buffer.get_logs("wo-123", level="info", step="execute", since=ts1)
    assert len(logs) == 1
    assert logs[0]["event"] == "event3"
