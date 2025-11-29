"""Unit tests for TaskService UUID validation.

Tests that invalid UUIDs are caught at the service layer
before reaching the database.
"""

import pytest
from unittest.mock import MagicMock, patch

from src.server.services.projects.task_service import TaskService


@pytest.fixture
def mock_supabase():
    """Create a mock Supabase client."""
    mock = MagicMock()
    mock_table = MagicMock()
    mock_update = MagicMock()
    mock_execute = MagicMock()

    # Setup chaining
    mock_execute.data = [
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "title": "Test Task",
            "status": "todo",
        }
    ]
    mock_update.execute.return_value = mock_execute
    mock_update.eq.return_value = mock_update
    mock_table.update.return_value = mock_update
    mock_table.select.return_value.execute.return_value.data = []
    mock.table.return_value = mock_table

    return mock


@pytest.fixture
def task_service(mock_supabase):
    """Create TaskService with mocked Supabase client."""
    return TaskService(supabase_client=mock_supabase)


class TestUpdateTaskUUIDValidation:
    """Test update_task method UUID validation."""

    @pytest.mark.asyncio
    async def test_update_with_valid_uuid(self, task_service, mock_supabase):
        """Test that valid UUID passes validation and reaches database."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"
        update_fields = {"title": "Updated Task"}

        success, result = await task_service.update_task(valid_uuid, update_fields)

        # Should succeed
        assert success is True
        # Database should be called
        mock_supabase.table.assert_called_with("archon_tasks")

    @pytest.mark.asyncio
    async def test_update_with_integer_string(self, task_service, mock_supabase):
        """Test that integer strings (from bug report) are rejected."""
        invalid_ids = ["12", "322", "61"]

        for invalid_id in invalid_ids:
            success, result = await task_service.update_task(
                invalid_id, {"title": "Test"}
            )

            # Should fail
            assert success is False, f"Should reject ID: {invalid_id}"

            # Should have error message
            assert "error" in result
            assert "UUID" in result["error"] or "uuid" in result["error"]

            # Database should NOT be called
            mock_supabase.table.assert_not_called()

            # Reset for next iteration
            mock_supabase.reset_mock()

    @pytest.mark.asyncio
    async def test_update_with_empty_string(self, task_service):
        """Test that empty string is rejected."""
        success, result = await task_service.update_task("", {"title": "Test"})

        assert success is False
        assert "error" in result

    @pytest.mark.asyncio
    async def test_update_with_none(self, task_service):
        """Test that None is rejected."""
        success, result = await task_service.update_task(None, {"title": "Test"})

        assert success is False
        assert "error" in result

    @pytest.mark.asyncio
    async def test_update_with_short_string(self, task_service):
        """Test that short strings are rejected."""
        short_ids = ["abc", "12345", "not-uuid"]

        for short_id in short_ids:
            success, result = await task_service.update_task(short_id, {"title": "Test"})

            assert success is False, f"Should reject: {short_id}"
            assert "error" in result

    @pytest.mark.asyncio
    async def test_update_with_malformed_uuid(self, task_service):
        """Test that malformed UUIDs are rejected."""
        # Note: UUIDs without hyphens ARE valid per Python's uuid.UUID()
        malformed_uuids = [
            "550e8400-e29b-41d4-a716-44665544000g",  # Invalid hex
            "this-is-exactly-36-characters-long!",  # Right length, wrong format
            "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",  # Invalid hex characters
        ]

        for malformed in malformed_uuids:
            success, result = await task_service.update_task(
                malformed, {"title": "Test"}
            )

            assert success is False, f"Should reject: {malformed}"
            assert "error" in result

    @pytest.mark.asyncio
    async def test_error_message_includes_invalid_value(self, task_service):
        """Test that error message includes the invalid value."""
        invalid_id = "12"
        success, result = await task_service.update_task(invalid_id, {"title": "Test"})

        assert success is False
        assert "error" in result
        # Error message should include the invalid ID
        assert invalid_id in result["error"]

    @pytest.mark.asyncio
    async def test_error_message_is_clear(self, task_service):
        """Test that error message is user-friendly."""
        invalid_id = "invalid"
        success, result = await task_service.update_task(invalid_id, {"title": "Test"})

        assert success is False
        error_msg = result["error"]

        # Should be a clear message (not just empty or generic)
        assert len(error_msg) > 10
        assert "UUID" in error_msg or "uuid" in error_msg
        assert "invalid" in error_msg.lower()


class TestUpdateTaskWithValidOperations:
    """Test that valid operations still work correctly after adding validation."""

    @pytest.mark.asyncio
    async def test_update_title(self, task_service, mock_supabase):
        """Test updating task title with valid UUID."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        success, result = await task_service.update_task(
            valid_uuid, {"title": "New Title"}
        )

        assert success is True
        assert "task" in result

    @pytest.mark.asyncio
    async def test_update_status(self, task_service, mock_supabase):
        """Test updating task status with valid UUID."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        success, result = await task_service.update_task(valid_uuid, {"status": "doing"})

        assert success is True

    @pytest.mark.asyncio
    async def test_update_multiple_fields(self, task_service, mock_supabase):
        """Test updating multiple fields with valid UUID."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"
        update_fields = {
            "title": "New Title",
            "status": "doing",
            "assignee": "User",
            "priority": "high",
        }

        success, result = await task_service.update_task(valid_uuid, update_fields)

        assert success is True

    @pytest.mark.asyncio
    async def test_update_with_different_uuid_formats(self, task_service, mock_supabase):
        """Test that different valid UUID formats all work."""
        valid_uuids = [
            "550e8400-e29b-41d4-a716-446655440000",  # UUID v4
            "6ba7b810-9dad-11d1-80b4-00c04fd430c8",  # UUID v1
            "00000000-0000-0000-0000-000000000000",  # Nil UUID
            "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",  # Max UUID (uppercase)
            "ffffffff-ffff-ffff-ffff-ffffffffffff",  # Max UUID (lowercase)
        ]

        for uuid_str in valid_uuids:
            success, result = await task_service.update_task(uuid_str, {"title": "Test"})

            assert success is True, f"Should accept UUID: {uuid_str}"

            # Reset mock for next iteration
            mock_supabase.reset_mock()


class TestValidationHappensBeforeDatabase:
    """Test that validation happens before any database operations."""

    @pytest.mark.asyncio
    async def test_invalid_uuid_does_not_call_database(self, task_service, mock_supabase):
        """Test that database is never called for invalid UUIDs."""
        invalid_id = "12"

        success, result = await task_service.update_task(invalid_id, {"title": "Test"})

        # Should fail validation
        assert success is False

        # Database table should NEVER be accessed
        mock_supabase.table.assert_not_called()

    @pytest.mark.asyncio
    async def test_validation_prevents_database_errors(self, task_service, mock_supabase):
        """Test that validation prevents PostgreSQL UUID errors."""
        # These are the exact invalid IDs from the bug report
        invalid_ids_from_bug = ["12", "322", "61"]

        for invalid_id in invalid_ids_from_bug:
            success, result = await task_service.update_task(
                invalid_id, {"title": "Test"}
            )

            # Should be caught by validation (not reach database)
            assert success is False
            assert "UUID" in result["error"] or "uuid" in result["error"]

            # The old error was: 'invalid input syntax for type uuid: "12"'
            # Now it should be caught before reaching PostgreSQL
            assert "invalid input syntax" not in result["error"]

            mock_supabase.reset_mock()


class TestDatabaseErrorsStillPropagated:
    """Test that actual database errors (not validation) are still properly handled."""

    @pytest.mark.asyncio
    async def test_database_connection_error_is_handled(self, mock_supabase):
        """Test that database connection errors are caught and logged."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Setup mock to raise exception (simulating database error)
        mock_supabase.table.side_effect = Exception("Database connection failed")

        task_service = TaskService(supabase_client=mock_supabase)

        success, result = await task_service.update_task(valid_uuid, {"title": "Test"})

        # Should catch the exception
        assert success is False
        assert "error" in result
        # Should mention the actual database error
        assert "Database connection failed" in result["error"]

    @pytest.mark.asyncio
    async def test_task_not_found_error(self, mock_supabase):
        """Test that 'task not found' errors are properly returned."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Setup mock to return empty data (task not found)
        mock_execute = MagicMock()
        mock_execute.data = []  # Empty = not found
        mock_update = MagicMock()
        mock_update.execute.return_value = mock_execute
        mock_update.eq.return_value = mock_update
        mock_table = MagicMock()
        mock_table.update.return_value = mock_update
        mock_supabase.table.return_value = mock_table

        task_service = TaskService(supabase_client=mock_supabase)

        success, result = await task_service.update_task(valid_uuid, {"title": "Test"})

        # Should fail
        assert success is False
        assert "not found" in result["error"].lower()


class TestValidationPerformance:
    """Test that UUID validation doesn't significantly impact performance."""

    @pytest.mark.asyncio
    async def test_validation_is_fast(self, task_service):
        """Test that validation completes quickly."""
        import time

        invalid_id = "12"
        start = time.time()

        for _ in range(100):
            await task_service.update_task(invalid_id, {"title": "Test"})

        elapsed = time.time() - start

        # 100 validations should complete in less than 1 second
        assert elapsed < 1.0, f"Validation took {elapsed}s for 100 calls"

    @pytest.mark.asyncio
    async def test_validation_does_not_use_traceback(self, task_service):
        """Test that validation doesn't use expensive traceback operations."""
        # The old implementation used traceback.format_stack() which is expensive
        # We should not see traceback module being imported during normal validation

        with patch("traceback.format_stack") as mock_traceback:
            invalid_id = "12"
            await task_service.update_task(invalid_id, {"title": "Test"})

            # traceback.format_stack should NOT be called for simple validation
            mock_traceback.assert_not_called()

