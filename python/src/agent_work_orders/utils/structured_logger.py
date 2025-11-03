"""Structured Logging Setup

Configures structlog for PRD-compliant event logging with SSE streaming support.
Event naming follows: {module}_{noun}_{verb_past_tense}
"""

from collections.abc import MutableMapping
from typing import Any

import structlog
from structlog.contextvars import bind_contextvars, clear_contextvars

from .log_buffer import WorkOrderLogBuffer


class BufferProcessor:
    """Custom structlog processor to route logs to WorkOrderLogBuffer.

    Only buffers logs that have 'work_order_id' in their context.
    This ensures we only store logs for active work orders.
    """

    def __init__(self, buffer: WorkOrderLogBuffer) -> None:
        """Initialize processor with a log buffer.

        Args:
            buffer: The WorkOrderLogBuffer instance to write logs to
        """
        self.buffer = buffer

    def __call__(
        self, logger: Any, method_name: str, event_dict: MutableMapping[str, Any]
    ) -> MutableMapping[str, Any]:
        """Process log event and add to buffer if it has work_order_id.

        Args:
            logger: The logger instance
            method_name: The log level method name
            event_dict: Dictionary containing log event data

        Returns:
            Unmodified event_dict (pass-through processor)
        """
        work_order_id = event_dict.get("work_order_id")
        if work_order_id:
            # Extract core fields
            level = event_dict.get("level", method_name)
            event = event_dict.get("event", "")
            timestamp = event_dict.get("timestamp", "")

            # Get all extra fields (everything except core fields)
            extra = {
                k: v
                for k, v in event_dict.items()
                if k not in ("work_order_id", "level", "event", "timestamp")
            }

            # Add to buffer
            self.buffer.add_log(
                work_order_id=work_order_id,
                level=level,
                event=event,
                timestamp=timestamp,
                **extra,
            )

        return event_dict


def configure_structured_logging(log_level: str = "INFO") -> None:
    """Configure structlog with console rendering.

    Event naming convention: {module}_{noun}_{verb_past_tense}
    Examples:
        - agent_work_order_created
        - git_branch_created
        - workflow_phase_started
        - sandbox_cleanup_completed

    Args:
        log_level: Minimum log level (DEBUG, INFO, WARNING, ERROR)
    """
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def configure_structured_logging_with_buffer(
    log_level: str, buffer: WorkOrderLogBuffer
) -> None:
    """Configure structlog with both console rendering and log buffering.

    This configuration enables SSE streaming by routing logs to the buffer
    while maintaining console output for local development.

    Args:
        log_level: Minimum log level (DEBUG, INFO, WARNING, ERROR)
        buffer: WorkOrderLogBuffer instance to store logs for streaming

    Examples:
        buffer = WorkOrderLogBuffer()
        configure_structured_logging_with_buffer("INFO", buffer)
    """
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            BufferProcessor(buffer),
            structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def bind_work_order_context(work_order_id: str) -> None:
    """Bind work order ID to the current context.

    All logs in this context will include the work_order_id automatically.
    Convenience wrapper around structlog.contextvars.bind_contextvars.

    Args:
        work_order_id: The work order ID to bind to the context

    Examples:
        bind_work_order_context("wo-abc123")
        logger.info("step_started", step="planning")
        # Log will include work_order_id="wo-abc123" automatically
    """
    bind_contextvars(work_order_id=work_order_id)


def clear_work_order_context() -> None:
    """Clear the work order context.

    Should be called when work order execution completes to prevent
    context leakage to other work orders.
    Convenience wrapper around structlog.contextvars.clear_contextvars.

    Examples:
        try:
            bind_work_order_context("wo-abc123")
            # ... execute work order ...
        finally:
            clear_work_order_context()
    """
    clear_contextvars()


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Get a structured logger instance.

    Args:
        name: Optional name for the logger

    Returns:
        Configured structlog logger

    Examples:
        logger = get_logger(__name__)
        logger.info("operation_completed", duration_ms=123)
    """
    return structlog.get_logger(name)  # type: ignore[no-any-return]
