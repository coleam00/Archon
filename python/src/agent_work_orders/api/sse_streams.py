"""Server-Sent Events (SSE) Streaming for Work Order Logs

Implements SSE streaming endpoint for real-time log delivery.
Uses sse-starlette for W3C SSE specification compliance.
"""

import asyncio
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import Any

from ..utils.log_buffer import WorkOrderLogBuffer


async def stream_work_order_logs(
    work_order_id: str,
    log_buffer: WorkOrderLogBuffer,
    level_filter: str | None = None,
    step_filter: str | None = None,
    since_timestamp: str | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """Stream work order logs via Server-Sent Events.

    Yields existing buffered logs first, then new logs as they arrive.
    Sends heartbeat comments every 15 seconds to prevent connection timeout.

    Args:
        work_order_id: ID of the work order to stream logs for
        log_buffer: The WorkOrderLogBuffer instance to read from
        level_filter: Optional log level filter (info, warning, error, debug)
        step_filter: Optional step name filter (exact match)
        since_timestamp: Optional ISO timestamp - only return logs after this time

    Yields:
        SSE event dictionaries with "data" key containing JSON log entry

    Examples:
        async for event in stream_work_order_logs("wo-123", buffer):
            # event = {"data": '{"timestamp": "...", "level": "info", ...}'}
            print(event)

    Notes:
        - Generator automatically handles client disconnects via CancelledError
        - Heartbeat comments prevent proxy/load balancer timeouts
        - Non-blocking polling with 0.5s interval
    """
    # Get existing buffered logs first
    existing_logs = log_buffer.get_logs(
        work_order_id=work_order_id,
        level=level_filter,
        step=step_filter,
        since=since_timestamp,
    )

    # Yield existing logs as SSE events
    for log_entry in existing_logs:
        yield format_log_event(log_entry)

    # Track last seen timestamp to avoid duplicates
    last_timestamp = (
        existing_logs[-1]["timestamp"] if existing_logs else since_timestamp or ""
    )

    # Stream new logs as they arrive
    heartbeat_counter = 0
    heartbeat_interval = 30  # 30 iterations * 0.5s = 15 seconds

    try:
        while True:
            # Poll for new logs
            new_logs = log_buffer.get_logs_since(
                work_order_id=work_order_id,
                since_timestamp=last_timestamp,
                level=level_filter,
                step=step_filter,
            )

            # Yield new logs
            for log_entry in new_logs:
                yield format_log_event(log_entry)
                last_timestamp = log_entry["timestamp"]

            # Send heartbeat comment every 15 seconds to keep connection alive
            heartbeat_counter += 1
            if heartbeat_counter >= heartbeat_interval:
                yield {"comment": "keepalive"}
                heartbeat_counter = 0

            # Non-blocking sleep before next poll
            await asyncio.sleep(0.5)

    except asyncio.CancelledError:
        # Client disconnected - clean exit
        pass


def format_log_event(log_dict: dict[str, Any]) -> dict[str, str]:
    """Format a log dictionary as an SSE event.

    Args:
        log_dict: Dictionary containing log entry data

    Returns:
        SSE event dictionary with "data" key containing JSON string

    Examples:
        event = format_log_event({
            "timestamp": "2025-10-23T12:00:00Z",
            "level": "info",
            "event": "step_started",
            "work_order_id": "wo-123",
            "step": "planning"
        })
        # Returns: {"data": '{"timestamp": "...", "level": "info", ...}'}

    Notes:
        - JSON serialization handles datetime conversion
        - Event format follows SSE specification: data: {json}
    """
    return {"data": json.dumps(log_dict)}


def get_current_timestamp() -> str:
    """Get current timestamp in ISO format with timezone.

    Returns:
        ISO format timestamp string (e.g., "2025-10-23T12:34:56.789Z")

    Examples:
        timestamp = get_current_timestamp()
        # "2025-10-23T12:34:56.789123Z"
    """
    return datetime.now(UTC).isoformat()
