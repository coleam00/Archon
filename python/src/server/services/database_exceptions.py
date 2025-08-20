"""
Database-specific exceptions for the credential service.

"""

import time
from datetime import datetime
from typing import Any


class DatabaseError(Exception):
    """Base exception for all database-related errors."""

    def __init__(
        self,
        message: str,
        context: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        **kwargs,
    ):
        """
        Initialize database error with context.

        Args:
            message: Error description
            context: Diagnostic context information
            correlation_id: Request correlation ID for tracing
            **kwargs: Additional metadata
        """
        self.context = context or {}
        self.correlation_id = correlation_id
        self.metadata = kwargs
        self.timestamp = datetime.now().isoformat()
        super().__init__(message)

    def to_dict(self) -> dict[str, Any]:
        """Convert exception to dictionary for JSON serialization."""
        return {
            "error_type": self.__class__.__name__,
            "message": str(self),
            "context": self.context,
            "correlation_id": self.correlation_id,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
        }


class DatabaseConnectionError(DatabaseError):
    """
    Raised for infrastructure database connection failures.

    These are unexpected failures that should fail fast with detailed context.
    Examples: Network issues, auth failures, server errors.
    """

    def __init__(
        self,
        message: str,
        context: dict[str, Any] | None = None,
        remediation: str | None = None,
        **kwargs,
    ):
        super().__init__(message, context, **kwargs)
        self.remediation = remediation
        if remediation:
            self.metadata["remediation"] = remediation


class DatabaseConfigurationError(DatabaseError):
    """
    Raised for configuration issues during database setup.

    These are expected during setup and should be handled gracefully
    with user guidance. Examples: Missing env vars, incomplete setup.
    """

    def __init__(
        self,
        message: str,
        missing_config: list[str] | None = None,
        setup_guide: str | None = None,
        **kwargs,
    ):
        super().__init__(message, **kwargs)
        self.missing_config = missing_config or []
        self.setup_guide = setup_guide
        if self.missing_config:
            self.metadata["missing_config"] = self.missing_config
        if setup_guide:
            self.metadata["setup_guide"] = setup_guide


class DatabaseNotInitializedException(DatabaseConfigurationError):
    """
    Raised when database tables don't exist yet.

    This is expected during initial setup and should be handled gracefully.
    """

    def __init__(self, message: str = "Database tables not found", **kwargs):
        super().__init__(
            message,
            setup_guide="Run the setup SQL in your Supabase SQL editor",
            **kwargs,
        )


class DatabaseValidationError(DatabaseError):
    """
    Raised when database data validation fails.

    This indicates data corruption and should fail fast.
    """

    def __init__(
        self,
        message: str,
        invalid_data_sample: dict[str, Any] | None = None,
        **kwargs,
    ):
        super().__init__(message, **kwargs)
        if invalid_data_sample:
            self.metadata["invalid_data_sample"] = invalid_data_sample


def gather_diagnostic_context() -> dict[str, Any]:
    """Gather comprehensive diagnostic context for database errors."""
    import os

    import requests

    context = {
        "timestamp": datetime.now().isoformat(),
        "supabase_url_configured": bool(os.getenv("SUPABASE_URL")),
        "service_key_configured": bool(os.getenv("SUPABASE_SERVICE_KEY")),
        "service_key_length": len(os.getenv("SUPABASE_SERVICE_KEY", "")),
    }

    supabase_url = os.getenv("SUPABASE_URL")
    if supabase_url:
        context["supabase_url"] = supabase_url
        try:
            start_time = time.time()
            response = requests.get(f"{supabase_url}/rest/v1/", timeout=5)
            context["network_latency"] = time.time() - start_time
            context["network_accessible"] = True
            context["http_status"] = response.status_code
        except Exception as e:
            context["network_accessible"] = False
            context["network_error"] = str(e)

    return context
