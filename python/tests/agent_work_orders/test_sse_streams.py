"""Unit tests for SSE Streaming Module

Tests SSE event formatting, streaming logic, filtering, and disconnect handling.
"""

import asyncio
import json
from datetime import UTC

import pytest

from src.agent_work_orders.api.sse_streams import (
    format_log_event,
    get_current_timestamp,
    stream_work_order_logs,
)
from src.agent_work_orders.utils.log_buffer import WorkOrderLogBuffer


@pytest.mark.unit
def test_format_log_event():
    """Test formatting log dictionary as SSE event"""
    log_dict = {
        "timestamp": "2025-10-23T12:00:00Z",
        "level": "info",
        "event": "step_started",
        "work_order_id": "wo-123",
        "step": "planning",
    }

    event = format_log_event(log_dict)

    assert "data" in event
    # Data should be JSON string
    parsed = json.loads(event["data"])
    assert parsed["timestamp"] == "2025-10-23T12:00:00Z"
    assert parsed["level"] == "info"
    assert parsed["event"] == "step_started"
    assert parsed["work_order_id"] == "wo-123"
    assert parsed["step"] == "planning"


@pytest.mark.unit
def test_get_current_timestamp():
    """Test timestamp generation in ISO format"""
    timestamp = get_current_timestamp()

    # Should be valid ISO format
    assert isinstance(timestamp, str)
    assert "T" in timestamp
    # Should be recent (within last second)
    from datetime import datetime

    parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    now = datetime.now(UTC)
    assert (now - parsed).total_seconds() < 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_empty_buffer():
    """Test streaming when buffer is empty"""
    buffer = WorkOrderLogBuffer()

    events = []
    async for event in stream_work_order_logs("wo-123", buffer):
        events.append(event)
        # Break after heartbeat to avoid infinite loop
        if "comment" in event:
            break

    # Should receive at least one heartbeat
    assert len(events) >= 1
    assert events[-1] == {"comment": "keepalive"}


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_with_existing_logs():
    """Test streaming existing buffered logs first"""
    buffer = WorkOrderLogBuffer()

    # Add existing logs
    buffer.add_log("wo-123", "info", "event1", step="planning")
    buffer.add_log("wo-123", "info", "event2", step="execute")

    events = []
    async for event in stream_work_order_logs("wo-123", buffer):
        events.append(event)
        # Stop after receiving both events
        if len(events) >= 2:
            break

    assert len(events) == 2
    # Both should be data events
    assert "data" in events[0]
    assert "data" in events[1]

    # Parse and verify content
    log1 = json.loads(events[0]["data"])
    log2 = json.loads(events[1]["data"])
    assert log1["event"] == "event1"
    assert log2["event"] == "event2"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_with_level_filter():
    """Test streaming with log level filter"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "info_event")
    buffer.add_log("wo-123", "error", "error_event")
    buffer.add_log("wo-123", "info", "another_info_event")

    events = []
    async for event in stream_work_order_logs("wo-123", buffer, level_filter="error"):
        events.append(event)
        if "data" in event:
            break

    # Should only get error event
    assert len(events) == 1
    log = json.loads(events[0]["data"])
    assert log["level"] == "error"
    assert log["event"] == "error_event"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_with_step_filter():
    """Test streaming with step filter"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "event1", step="planning")
    buffer.add_log("wo-123", "info", "event2", step="execute")
    buffer.add_log("wo-123", "info", "event3", step="planning")

    events = []
    async for event in stream_work_order_logs("wo-123", buffer, step_filter="planning"):
        events.append(event)
        if len(events) >= 2:
            break

    assert len(events) == 2
    log1 = json.loads(events[0]["data"])
    log2 = json.loads(events[1]["data"])
    assert log1["step"] == "planning"
    assert log2["step"] == "planning"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_with_since_timestamp():
    """Test streaming logs after specific timestamp"""
    buffer = WorkOrderLogBuffer()

    ts1 = "2025-10-23T10:00:00Z"
    ts2 = "2025-10-23T11:00:00Z"
    ts3 = "2025-10-23T12:00:00Z"

    buffer.add_log("wo-123", "info", "event1", timestamp=ts1)
    buffer.add_log("wo-123", "info", "event2", timestamp=ts2)
    buffer.add_log("wo-123", "info", "event3", timestamp=ts3)

    events = []
    async for event in stream_work_order_logs("wo-123", buffer, since_timestamp=ts2):
        events.append(event)
        if "data" in event:
            break

    # Should only get event3 (after ts2)
    assert len(events) == 1
    log = json.loads(events[0]["data"])
    assert log["event"] == "event3"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_heartbeat():
    """Test that heartbeat comments are sent periodically"""
    buffer = WorkOrderLogBuffer()

    heartbeat_count = 0
    event_count = 0

    async for event in stream_work_order_logs("wo-123", buffer):
        if "comment" in event:
            heartbeat_count += 1
            if heartbeat_count >= 2:
                break
        if "data" in event:
            event_count += 1

    # Should have received at least 2 heartbeats
    assert heartbeat_count >= 2


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_disconnect():
    """Test handling of client disconnect (CancelledError)"""
    buffer = WorkOrderLogBuffer()

    async def stream_with_cancel():
        events = []
        try:
            async for event in stream_work_order_logs("wo-123", buffer):
                events.append(event)
                # Simulate disconnect after first event
                if len(events) >= 1:
                    raise asyncio.CancelledError()
        except asyncio.CancelledError:
            # Should be caught and handled gracefully
            pass
        return events

    events = await stream_with_cancel()
    # Should have at least one event before cancel
    assert len(events) >= 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_yields_new_logs():
    """Test that stream yields new logs as they arrive"""
    buffer = WorkOrderLogBuffer()

    # Add initial log
    buffer.add_log("wo-123", "info", "initial_event")

    events = []

    async def consume_stream():
        async for event in stream_work_order_logs("wo-123", buffer):
            events.append(event)
            if len(events) >= 2 and "data" in events[1]:
                break

    async def add_new_log():
        # Wait a bit then add new log
        await asyncio.sleep(0.6)
        buffer.add_log("wo-123", "info", "new_event")

    # Run both concurrently
    await asyncio.gather(consume_stream(), add_new_log())

    # Should have received both events
    data_events = [e for e in events if "data" in e]
    assert len(data_events) >= 2

    log1 = json.loads(data_events[0]["data"])
    log2 = json.loads(data_events[1]["data"])
    assert log1["event"] == "initial_event"
    assert log2["event"] == "new_event"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_combined_filters():
    """Test streaming with multiple filters combined"""
    buffer = WorkOrderLogBuffer()

    ts1 = "2025-10-23T10:00:00Z"
    ts2 = "2025-10-23T11:00:00Z"

    buffer.add_log("wo-123", "info", "event1", timestamp=ts1, step="planning")
    buffer.add_log("wo-123", "error", "event2", timestamp=ts2, step="planning")
    buffer.add_log("wo-123", "info", "event3", timestamp=ts2, step="execute")

    events = []
    async for event in stream_work_order_logs(
        "wo-123",
        buffer,
        level_filter="info",
        step_filter="execute",
        since_timestamp=ts1,
    ):
        events.append(event)
        if "data" in event:
            break

    # Should only get event3
    assert len(events) == 1
    log = json.loads(events[0]["data"])
    assert log["event"] == "event3"
    assert log["level"] == "info"
    assert log["step"] == "execute"


@pytest.mark.unit
def test_format_log_event_with_extra_fields():
    """Test that format_log_event preserves all fields"""
    log_dict = {
        "timestamp": "2025-10-23T12:00:00Z",
        "level": "info",
        "event": "step_completed",
        "work_order_id": "wo-123",
        "step": "planning",
        "duration_seconds": 45.2,
        "custom_field": "custom_value",
    }

    event = format_log_event(log_dict)
    parsed = json.loads(event["data"])

    # All fields should be preserved
    assert parsed["duration_seconds"] == 45.2
    assert parsed["custom_field"] == "custom_value"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stream_no_duplicate_events():
    """Test that streaming doesn't yield duplicate events"""
    buffer = WorkOrderLogBuffer()

    buffer.add_log("wo-123", "info", "event1", timestamp="2025-10-23T10:00:00Z")
    buffer.add_log("wo-123", "info", "event2", timestamp="2025-10-23T11:00:00Z")

    events = []
    async for event in stream_work_order_logs("wo-123", buffer):
        if "data" in event:
            events.append(event)
        if len(events) >= 2:
            # Stop after receiving initial logs
            break

    # Should have exactly 2 events, no duplicates
    assert len(events) == 2
    log1 = json.loads(events[0]["data"])
    log2 = json.loads(events[1]["data"])
    assert log1["event"] == "event1"
    assert log2["event"] == "event2"
