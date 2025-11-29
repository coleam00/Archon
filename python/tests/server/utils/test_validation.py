"""Unit tests for validation utilities."""

import pytest

from src.server.utils.validation import is_valid_uuid, validate_uuid_or_raise


class TestIsValidUUID:
    """Tests for is_valid_uuid() function."""

    def test_valid_uuid_v4(self):
        """Test that valid UUID v4 strings are accepted."""
        valid_uuids = [
            "550e8400-e29b-41d4-a716-446655440000",
            "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            "123e4567-e89b-12d3-a456-426614174000",
        ]
        for uuid_str in valid_uuids:
            assert is_valid_uuid(uuid_str), f"Failed to validate: {uuid_str}"

    def test_valid_uuid_mixed_case(self):
        """Test that UUIDs with mixed case are accepted."""
        assert is_valid_uuid("550E8400-E29B-41D4-A716-446655440000")
        assert is_valid_uuid("550e8400-E29B-41d4-A716-446655440000")

    def test_invalid_uuid_integers(self):
        """Test that integer strings (from bug report) are rejected."""
        invalid_values = ["12", "322", "61", "0", "999999"]
        for value in invalid_values:
            assert not is_valid_uuid(value), f"Should reject: {value}"

    def test_invalid_uuid_short_strings(self):
        """Test that strings shorter than 36 characters are rejected."""
        invalid_values = [
            "550e8400-e29b-41d4-a716",  # Too short
            "550e8400",  # Way too short
            "abc-def-ghi",  # Wrong format
        ]
        for value in invalid_values:
            assert not is_valid_uuid(value), f"Should reject: {value}"

    def test_invalid_uuid_wrong_format(self):
        """Test that strings with truly invalid formats are rejected."""
        # Note: Python's uuid.UUID() is very flexible - it accepts many formats
        # including no hyphens, wrong hyphen positions, etc.
        # We only test strings that are genuinely invalid
        invalid_values = [
            "this-is-exactly-36-characters-long!",  # Right length, invalid chars
            "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",  # Invalid hex characters
            "not-a-uuid-at-all",  # Completely wrong
        ]
        for value in invalid_values:
            assert not is_valid_uuid(value), f"Should reject: {value}"

    def test_invalid_uuid_special_characters(self):
        """Test that UUIDs with invalid characters are rejected."""
        invalid_values = [
            "550e8400-e29b-41d4-a716-44665544000g",  # 'g' is not hex
            "550e8400-e29b-41d4-a716-44665544000z",  # 'z' is not hex
            "550e8400-e29b-41d4-a716-446655440!0",  # Special char
        ]
        for value in invalid_values:
            assert not is_valid_uuid(value), f"Should reject: {value}"

    def test_invalid_uuid_none(self):
        """Test that None is rejected."""
        assert not is_valid_uuid(None)

    def test_invalid_uuid_empty_string(self):
        """Test that empty string is rejected."""
        assert not is_valid_uuid("")
        assert not is_valid_uuid("   ")  # Whitespace

    def test_invalid_uuid_wrong_type(self):
        """Test that non-string types are rejected."""
        assert not is_valid_uuid(12345)  # Integer
        assert not is_valid_uuid(12.34)  # Float
        assert not is_valid_uuid([])  # List
        assert not is_valid_uuid({})  # Dict


class TestValidateUuidOrRaise:
    """Tests for validate_uuid_or_raise() function."""

    def test_valid_uuid_does_not_raise(self):
        """Test that valid UUIDs don't raise exceptions."""
        try:
            validate_uuid_or_raise("550e8400-e29b-41d4-a716-446655440000", "test_id")
        except ValueError:
            pytest.fail("validate_uuid_or_raise raised ValueError for valid UUID")

    def test_invalid_uuid_raises_value_error(self):
        """Test that invalid UUIDs raise ValueError."""
        with pytest.raises(ValueError) as exc_info:
            validate_uuid_or_raise("12", "task_id")

        error_message = str(exc_info.value)
        assert "Invalid task_id format" in error_message
        assert "'12'" in error_message
        assert "Must be a valid UUID" in error_message

    def test_error_message_includes_field_name(self):
        """Test that error message includes the field name."""
        with pytest.raises(ValueError) as exc_info:
            validate_uuid_or_raise("invalid", "project_id")

        assert "project_id" in str(exc_info.value)

    def test_error_message_includes_invalid_value(self):
        """Test that error message includes the invalid value."""
        invalid_value = "not-a-uuid"
        with pytest.raises(ValueError) as exc_info:
            validate_uuid_or_raise(invalid_value, "test_id")

        assert invalid_value in str(exc_info.value)

    def test_default_field_name(self):
        """Test that default field name is used when not specified."""
        with pytest.raises(ValueError) as exc_info:
            validate_uuid_or_raise("12")

        # Default field name is "ID"
        assert "Invalid ID format" in str(exc_info.value)


class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_uuid_with_leading_trailing_whitespace(self):
        """Test UUIDs with whitespace are rejected."""
        uuid_with_space = " 550e8400-e29b-41d4-a716-446655440000 "
        assert not is_valid_uuid(uuid_with_space)

    def test_uuid_v1_format(self):
        """Test that UUID v1 format is also accepted."""
        # UUID v1 has different version bits but same structure
        uuid_v1 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
        assert is_valid_uuid(uuid_v1)

    def test_uuid_v3_format(self):
        """Test that UUID v3 format is also accepted."""
        uuid_v3 = "6fa459ea-ee8a-3ca4-894e-db77e160355e"
        assert is_valid_uuid(uuid_v3)

    def test_uuid_v5_format(self):
        """Test that UUID v5 format is also accepted."""
        uuid_v5 = "886313e1-3b8a-5372-9b90-0c9aee199e5d"
        assert is_valid_uuid(uuid_v5)

    def test_nil_uuid(self):
        """Test that nil UUID (all zeros) is accepted."""
        nil_uuid = "00000000-0000-0000-0000-000000000000"
        assert is_valid_uuid(nil_uuid)

    def test_max_uuid(self):
        """Test that max UUID (all F's) is accepted."""
        max_uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        assert is_valid_uuid(max_uuid)
        # Also test uppercase
        max_uuid_upper = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"
        assert is_valid_uuid(max_uuid_upper)

    def test_uuid_without_hyphens_is_valid(self):
        """Test that UUIDs without hyphens are accepted (Python uuid.UUID() behavior)."""
        # Python's uuid.UUID() accepts hex strings without hyphens
        uuid_no_hyphens = "550e8400e29b41d4a716446655440000"
        assert is_valid_uuid(uuid_no_hyphens)

        # This is documented behavior and considered valid
        # See: https://docs.python.org/3/library/uuid.html

