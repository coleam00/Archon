"""
Unified Logging Configuration for Archon (2025 Best Practices)

This module provides a clean, unified logging setup with optional Pydantic Logfire integration.
Simple toggle: LOGFIRE_ENABLED=true/false controls all logging behavior.

Usage:
    from .config.logfire_config import get_logger, safe_span, safe_set_attribute

    logger = get_logger(__name__)
    logger.info("This works with or without Logfire")

    with safe_span("operation_name") as span:
        logger.info("Processing data")
        safe_set_attribute(span, "key", "value")
"""

import logging
import os
from contextlib import contextmanager
from typing import Any

# Try to import logfire (optional dependency)
LOGFIRE_AVAILABLE = False
logfire = None

try:
    import logfire

    LOGFIRE_AVAILABLE = True
except ImportError:
    logfire = None

# Global state
_logfire_configured = False
_logfire_enabled = False


def is_logfire_enabled() -> bool:
    """Check if Logfire should be enabled based on environment variables."""
    global _logfire_enabled

    # Check environment variable (master switch)
    env_enabled = os.getenv("LOGFIRE_ENABLED", "false").lower()
    if env_enabled in ("true", "1", "yes", "on"):
        _logfire_enabled = True
    else:
        _logfire_enabled = False

    return _logfire_enabled and LOGFIRE_AVAILABLE


def setup_logfire(
    token: str | None = None, environment: str = "development", service_name: str = "archon-server"
) -> None:
    """
    Configure logging with optional Logfire integration.

    Simple behavior:
    - If LOGFIRE_ENABLED=true and token available: Enable Logfire + unified logging
    - If LOGFIRE_ENABLED=false or no token: Standard Python logging only

    Args:
        token: Logfire token (reads from LOGFIRE_TOKEN env if not provided)
        environment: Environment name (development, staging, production)
        service_name: Service name for Logfire
    """
    global _logfire_configured, _logfire_enabled

    if _logfire_configured:
        return

    _logfire_enabled = is_logfire_enabled()
    handlers = []

    if _logfire_enabled:
        # Get logfire token
        logfire_token = token or os.getenv("LOGFIRE_TOKEN")

        if logfire_token:
            try:
                # Configure logfire
                logfire.configure(
                    token=logfire_token,
                    service_name=service_name,
                    environment=environment,
                    send_to_logfire=True,
                )

                # Add LogfireLoggingHandler to capture all standard logging
                handlers.append(logfire.LogfireLoggingHandler())
                logging.info(f"✅ Logfire enabled for {service_name}")

            except Exception as e:
                logging.error(f"❌ Failed to configure Logfire: {e}. Using standard logging.")
                _logfire_enabled = False
        else:
            logging.info("❌ LOGFIRE_TOKEN not found. Using standard logging.")
            _logfire_enabled = False

    if not _logfire_enabled and LOGFIRE_AVAILABLE:
        try:
            # Configure logfire but disable sending to remote
            logfire.configure(send_to_logfire=False)
            logging.info("📝 Logfire configured but disabled (send_to_logfire=False)")
        except Exception as e:
            logging.warning(f"⚠️  Warning: Could not configure Logfire in disabled mode: {e}")

    # Set up standard Python logging (always)
    if not handlers:
        handlers.append(logging.StreamHandler())

    # Read LOG_LEVEL from environment
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()

    # Configure root logging
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )

    # Suppress noisy third-party library logs
    # These libraries log low-level details that are rarely useful
    logging.getLogger("hpack").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)

    _logfire_configured = True
    logging.info(
        f"📋 Logging configured (Logfire: {'enabled' if _logfire_enabled else 'disabled'})"
    )


def get_logger(name: str) -> logging.Logger:
    """
    Get a standard Python logger that works with or without Logfire.

    Args:
        name: Logger name (typically __name__)

    Returns:
        Standard Python Logger instance
    """
    return logging.getLogger(name)


@contextmanager
def safe_span(name: str, **kwargs):
    """
    Safe span context manager that works with or without Logfire.

    Args:
        name: Span name
        **kwargs: Additional span attributes

    Usage:
        with safe_span("operation_name", key="value") as span:
            # Your code here
            safe_set_attribute(span, "result", "success")
    """
    if _logfire_enabled and logfire:
        try:
            with logfire.span(name, **kwargs) as span:
                yield span
        except Exception:
            # Fallback to no-op if logfire fails
            yield NoOpSpan()
    else:
        yield NoOpSpan()


class NoOpSpan:
    """No-operation span for when Logfire is disabled."""

    def set_attribute(self, key: str, value: Any) -> None:
        """No-op set_attribute method."""
        pass

    def record_exception(self, exception: Exception) -> None:
        """No-op record_exception method."""
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


def safe_set_attribute(span: Any, key: str, value: Any) -> None:
    """
    Safely set a span attribute.

    Args:
        span: Span object (from safe_span or logfire.span)
        key: Attribute key
        value: Attribute value
    """
    if hasattr(span, "set_attribute"):
        try:
            span.set_attribute(key, value)
        except Exception:
            pass


def safe_record_exception(span: Any, exception: Exception) -> None:
    """
    Safely record an exception on a span.

    Args:
        span: Span object
        exception: Exception to record
    """
    if hasattr(span, "record_exception"):
        try:
            span.record_exception(exception)
        except Exception:
            pass


def safe_logfire_info(message: str, **kwargs) -> None:
    """
    Safely call logfire.info if available.

    Args:
        message: Log message
        **kwargs: Additional log data
    """
    if _logfire_enabled and logfire:
        try:
            logfire.info(message, **kwargs)
        except Exception:
            pass


def safe_logfire_error(message: str, **kwargs) -> None:
    """
    Safely call logfire.error if available.

    Args:
        message: Log message
        **kwargs: Additional log data
    """
    if _logfire_enabled and logfire:
        try:
            logfire.error(message, **kwargs)
        except Exception:
            pass


def safe_logfire_warning(message: str, **kwargs) -> None:
    """
    Safely call logfire.warning if available.

    Args:
        message: Log message
        **kwargs: Additional log data
    """
    if _logfire_enabled and logfire:
        try:
            logfire.warning(message, **kwargs)
        except Exception:
            pass


def safe_logfire_debug(message: str, **kwargs) -> None:
    """
    Safely call logfire.debug if available.

    Args:
        message: Log message
        **kwargs: Additional log data
    """
    if _logfire_enabled and logfire:
        try:
            logfire.debug(message, **kwargs)
        except Exception:
            pass


# Pre-configured loggers for different components
api_logger = get_logger("api")
mcp_logger = get_logger("mcp")
rag_logger = get_logger("rag")
search_logger = get_logger("search")
crawl_logger = get_logger("crawl")
project_logger = get_logger("project")
storage_logger = get_logger("storage")
embedding_logger = get_logger("embedding")


# Export everything needed
__all__ = [
    "setup_logfire",
    "get_logger",
    "safe_span",
    "safe_set_attribute",
    "safe_record_exception",
    "safe_logfire_info",
    "safe_logfire_error",
    "safe_logfire_warning",
    "safe_logfire_debug",
    "is_logfire_enabled",
    "api_logger",
    "mcp_logger",
    "rag_logger",
    "search_logger",
    "crawl_logger",
    "project_logger",
    "storage_logger",
    "embedding_logger",
    "NoOpSpan",
    "LOGFIRE_AVAILABLE",
]
