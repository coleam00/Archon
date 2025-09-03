"""
Centralized error handling utilities for MCP Server.

Provides consistent error formatting and helpful context for clients.
"""

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MCPErrorFormatter:
    """Formats errors consistently for MCP clients."""

    @staticmethod
    def format_error(
        error_type: str,
        message: str,
        details: dict[str, Any] | None = None,
        suggestion: str | None = None,
        http_status: int | None = None,
    ) -> str:
        """
        Format an error response with consistent structure.

        Args:
            error_type: Category of error (e.g., "connection_error", "validation_error")
            message: User-friendly error message
            details: Additional context about the error
            suggestion: Actionable suggestion for resolving the error
            http_status: HTTP status code if applicable

        Returns:
            JSON string with structured error information
        """
        error_response: dict[str, Any] = {
            "success": False,
            "error": {
                "type": error_type,
                "message": message,
            },
        }

        if details:
            error_response["error"]["details"] = details

        if suggestion:
            error_response["error"]["suggestion"] = suggestion

        if http_status:
            error_response["error"]["http_status"] = http_status

        return json.dumps(error_response)

    @staticmethod
    def from_http_error(response: httpx.Response, operation: str) -> str:
        """
        Format error from HTTP response.

        Args:
            response: The HTTP response object
            operation: Description of what operation was being performed

        Returns:
            Formatted error JSON string
        """
        # Try to extract error from response body
        try:
            body = response.json()
            if isinstance(body, dict):
                # Look for common error fields
                error_message = (
                    body.get("detail", {}).get("error")
                    or body.get("error")
                    or body.get("message")
                    or body.get("detail")
                )
                if error_message:
                    return MCPErrorFormatter.format_error(
                        error_type="api_error",
                        message=f"Failed to {operation}: {error_message}",
                        details={"response_body": body},
                        http_status=response.status_code,
                        suggestion=_get_suggestion_for_status(response.status_code),
                    )
        except Exception:
            pass  # Fall through to generic error

        # Generic error based on status code
        return MCPErrorFormatter.format_error(
            error_type="http_error",
            message=f"Failed to {operation}: HTTP {response.status_code}",
            details={"response_text": response.text[:500]},  # Limit response text
            http_status=response.status_code,
            suggestion=_get_suggestion_for_status(response.status_code),
        )

    @staticmethod
    def from_exception(exception: Exception, operation: str, context: dict[str, Any] | None = None) -> str:
        """
        Format error from exception.

        Args:
            exception: The exception that occurred
            operation: Description of what operation was being performed
            context: Additional context about when the error occurred

        Returns:
            Formatted error JSON string
        """
        error_type = "unknown_error"
        suggestion = None

        # Categorize common exceptions
        if isinstance(exception, httpx.ConnectTimeout):
            error_type = "connection_timeout"
            suggestion = "Check if the Archon server is running and accessible at the configured URL"
        elif isinstance(exception, httpx.ReadTimeout):
            error_type = "read_timeout"
            suggestion = "The operation is taking longer than expected. Try again or check server logs"
        elif isinstance(exception, httpx.ConnectError):
            error_type = "connection_error"
            suggestion = "Ensure the Archon server is running on the correct port"
        elif isinstance(exception, httpx.RequestError):
            error_type = "request_error"
            suggestion = "Check network connectivity and server configuration"
        elif isinstance(exception, ValueError):
            error_type = "validation_error"
            suggestion = "Check that all input parameters are valid"
        elif isinstance(exception, KeyError):
            error_type = "missing_data"
            suggestion = "The response format may have changed. Check for API updates"

        details: dict[str, Any] = {"exception_type": type(exception).__name__, "exception_message": str(exception)}

        if context:
            details["context"] = context

        return MCPErrorFormatter.format_error(
            error_type=error_type,
            message=f"Failed to {operation}: {str(exception)}",
            details=details,
            suggestion=suggestion,
        )


def _get_suggestion_for_status(status_code: int) -> str | None:
    """Get helpful suggestion based on HTTP status code."""
    suggestions = {
        400: "Check that all required parameters are provided and valid",
        401: "Authentication may be required. Check API credentials",
        403: "You may not have permission for this operation",
        404: "The requested resource was not found. Verify the ID is correct",
        409: "There's a conflict with the current state. The resource may already exist",
        422: "The request format is correct but the data is invalid",
        429: "Too many requests. Please wait before retrying",
        500: "Server error. Check server logs for details",
        502: "The backend service may be down. Check if all services are running",
        503: "Service temporarily unavailable. Try again later",
        504: "The operation timed out. The server may be overloaded",
    }
    return suggestions.get(status_code)
