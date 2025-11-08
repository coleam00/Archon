"""Structured logging configuration."""

import logging
import os
import sys

from pythonjsonlogger import jsonlogger


def setup_logging() -> logging.Logger:
    """
    Configure structured JSON logging for the application.

    This function sets up the root logger to output JSON-formatted logs,
    which are easier to parse and analyze in production environments.

    Returns:
        Configured root logger instance

    Environment Variables:
        LOG_LEVEL: Logging level (default: "INFO")
            Valid values: DEBUG, INFO, WARNING, ERROR, CRITICAL

    JSON Log Format:
        Each log entry includes:
        - timestamp: ISO 8601 formatted timestamp
        - logger: Logger name
        - level: Log level (DEBUG, INFO, etc.)
        - message: Log message
        - Additional fields as provided
    """
    log_level = os.getenv("LOG_LEVEL", "INFO")

    formatter = jsonlogger.JsonFormatter(
        "%(asctime)s %(name)s %(levelname)s %(message)s",
        rename_fields={
            "asctime": "timestamp",
            "name": "logger",
            "levelname": "level",
        },
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    return root_logger
