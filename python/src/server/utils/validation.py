"""Validation utilities for Archon."""

import uuid
from typing import Optional


def is_valid_uuid(value: Optional[str]) -> bool:
    """
    Validate if a string is a valid UUID format.

    Args:
        value: String to validate

    Returns:
        True if valid UUID, False otherwise

    Examples:
        >>> is_valid_uuid("550e8400-e29b-41d4-a716-446655440000")
        True
        >>> is_valid_uuid("12")
        False
        >>> is_valid_uuid(None)
        False
    """
    if not value or not isinstance(value, str):
        return False

    try:
        uuid.UUID(value)
        return True
    except (ValueError, AttributeError):
        return False


def validate_uuid_or_raise(value: str, field_name: str = "ID") -> None:
    """
    Validate UUID format and raise ValueError with clear message if invalid.

    Args:
        value: UUID string to validate
        field_name: Name of the field being validated (for error message)

    Raises:
        ValueError: If value is not a valid UUID format

    Examples:
        >>> validate_uuid_or_raise("550e8400-e29b-41d4-a716-446655440000", "task_id")
        # Returns None (success)
        >>> validate_uuid_or_raise("12", "task_id")
        ValueError: Invalid task_id format: '12'. Must be a valid UUID.
    """
    if not is_valid_uuid(value):
        raise ValueError(
            f"Invalid {field_name} format: '{value}'. Must be a valid UUID "
            f"(e.g., '550e8400-e29b-41d4-a716-446655440000')"
        )

