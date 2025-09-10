"""Standardized API error handling utilities."""

import uuid
from typing import Optional, Dict, Any
from fastapi import HTTPException, status
import logging

logger = logging.getLogger(__name__)


class APIError(HTTPException):
    """Standardized API error with consistent format."""
    
    def __init__(
        self,
        status_code: int,
        error_code: str,
        detail: str,
        context: Optional[Dict[str, Any]] = None
    ):
        """Initialize API error with standard format.
        
        Args:
            status_code: HTTP status code
            error_code: Machine-readable error code (e.g., "TASK_NOT_FOUND")
            detail: Human-readable error message
            context: Optional additional context data
        """
        super().__init__(
            status_code=status_code,
            detail={
                "detail": detail,
                "error_code": error_code,
                "context": context or {}
            }
        )


def not_found_error(resource: str = "Resource") -> APIError:
    """Create standardized 404 error."""
    return APIError(
        status_code=status.HTTP_404_NOT_FOUND,
        error_code=f"{resource.upper()}_NOT_FOUND",
        detail=f"{resource} not found"
    )


def validation_error(
    field: str,
    message: str,
    error_code: Optional[str] = None,
    context: Optional[Dict[str, Any]] = None
) -> APIError:
    """Create standardized 422 validation error."""
    ctx = {"field": field}
    if context:
        ctx.update(context)
    
    return APIError(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        error_code=error_code or "VALIDATION_ERROR",
        detail=message,
        context=ctx
    )


def internal_error(
    exc: Optional[Exception] = None,
    correlation_id: Optional[str] = None
) -> APIError:
    """Create standardized 500 error without exposing internals.
    
    Args:
        exc: Optional exception to log (not exposed to client)
        correlation_id: Optional correlation ID for support
    
    Returns:
        APIError with generic message and correlation ID
    """
    request_id = correlation_id or str(uuid.uuid4())
    
    # Log full details server-side
    if exc:
        logger.error(
            f"Internal server error | request_id={request_id}",
            exc_info=exc,
            extra={"request_id": request_id}
        )
    else:
        logger.error(
            f"Internal server error | request_id={request_id}",
            extra={"request_id": request_id}
        )
    
    return APIError(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        error_code="INTERNAL_ERROR",
        detail="Internal server error",
        context={"request_id": request_id}
    )


def forbidden_error(message: str = "Insufficient permissions") -> APIError:
    """Create standardized 403 error."""
    return APIError(
        status_code=status.HTTP_403_FORBIDDEN,
        error_code="PERMISSION_DENIED",
        detail=message
    )


def bad_request_error(
    message: str,
    error_code: str = "INVALID_REQUEST",
    context: Optional[Dict[str, Any]] = None
) -> APIError:
    """Create standardized 400 error."""
    return APIError(
        status_code=status.HTTP_400_BAD_REQUEST,
        error_code=error_code,
        detail=message,
        context=context
    )