"""Integration tests for task API UUID validation.

Tests that invalid UUIDs are properly caught at API boundaries
and return HTTP 400 errors with clear messages.
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import MagicMock, AsyncMock, patch


@pytest.fixture
def mock_task_service():
    """Mock TaskService for testing."""
    with patch("src.server.api_routes.projects_api.TaskService") as mock_service:
        service_instance = MagicMock()
        mock_service.return_value = service_instance
        yield service_instance


class TestGetTaskUUIDValidation:
    """Test GET /api/tasks/{task_id} UUID validation."""

    def test_get_task_with_valid_uuid(self, client, mock_task_service):
        """Test that valid UUID passes validation and calls service."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Mock successful service response
        mock_task_service.get_task.return_value = (
            True,
            {
                "task": {
                    "id": valid_uuid,
                    "title": "Test Task",
                    "status": "todo",
                }
            },
        )

        response = client.get(f"/api/tasks/{valid_uuid}")

        # Should succeed
        assert response.status_code == 200
        # Service should be called with the UUID
        mock_task_service.get_task.assert_called_once_with(valid_uuid)

    def test_get_task_with_integer_string(self, client, mock_task_service):
        """Test that integer strings (from bug report) return 400."""
        invalid_ids = ["12", "322", "61"]

        for invalid_id in invalid_ids:
            response = client.get(f"/api/tasks/{invalid_id}")

            # Should return 400 Bad Request
            assert response.status_code == 400, f"Failed for ID: {invalid_id}"

            # Should have error message
            data = response.json()
            assert "error" in data or "detail" in data

            # Service should NOT be called
            mock_task_service.get_task.assert_not_called()

            # Reset mock for next iteration
            mock_task_service.reset_mock()

    def test_get_task_with_empty_string(self, client, mock_task_service):
        """Test that empty string in path is rejected."""
        # FastAPI will reject empty path parameter - no matching route
        response = client.get("/api/tasks/")

        # Should return 404 (no route matches), 400, or 500
        assert response.status_code in [404, 400, 500]

    def test_get_task_with_short_string(self, client, mock_task_service):
        """Test that short strings return 400."""
        short_ids = ["abc", "12345", "not-a-uuid"]

        for short_id in short_ids:
            response = client.get(f"/api/tasks/{short_id}")

            # Should return 400
            assert response.status_code == 400, f"Failed for ID: {short_id}"

            # Service should NOT be called
            mock_task_service.get_task.assert_not_called()
            mock_task_service.reset_mock()

    def test_get_task_with_malformed_uuid(self, client, mock_task_service):
        """Test that malformed UUIDs return 400."""
        # Note: UUIDs without hyphens ARE valid per Python's uuid.UUID()
        malformed_uuids = [
            "550e8400-e29b-41d4-a716-44665544000g",  # Invalid char
            "this-is-exactly-36-characters-long!",  # Wrong format
            "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",  # Invalid hex
        ]

        for malformed in malformed_uuids:
            response = client.get(f"/api/tasks/{malformed}")

            # Should return 400
            assert response.status_code == 400, f"Failed for: {malformed}"

            # Service should NOT be called
            mock_task_service.get_task.assert_not_called()
            mock_task_service.reset_mock()

    def test_error_message_includes_invalid_value(self, client):
        """Test that error message includes the invalid value."""
        invalid_id = "12"
        response = client.get(f"/api/tasks/{invalid_id}")

        assert response.status_code == 400
        data = response.json()

        # Error message should mention the invalid value
        error_text = str(data)
        assert "12" in error_text or invalid_id in error_text


class TestUpdateTaskUUIDValidation:
    """Test PUT /api/tasks/{task_id} UUID validation."""

    @pytest.mark.asyncio
    async def test_update_task_with_valid_uuid(self, client, mock_task_service):
        """Test that valid UUID passes validation."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Mock successful async service response
        mock_task_service.update_task = AsyncMock(
            return_value=(
                True,
                {
                    "task": {
                        "id": valid_uuid,
                        "title": "Updated Task",
                        "status": "doing",
                    },
                    "message": "Task updated successfully",
                },
            )
        )

        response = client.put(
            f"/api/tasks/{valid_uuid}", json={"title": "Updated Task"}
        )

        # Should succeed
        assert response.status_code == 200
        # Service should be called
        mock_task_service.update_task.assert_called_once()

    def test_update_task_with_invalid_uuid(self, client, mock_task_service):
        """Test that invalid UUID returns 400."""
        invalid_id = "322"

        response = client.put(f"/api/tasks/{invalid_id}", json={"title": "Test"})

        # Should return 400
        assert response.status_code == 400

        # Service should NOT be called
        mock_task_service.update_task.assert_not_called()


class TestDeleteTaskUUIDValidation:
    """Test DELETE /api/tasks/{task_id} UUID validation."""

    @pytest.mark.asyncio
    async def test_delete_task_with_valid_uuid(self, client, mock_task_service):
        """Test that valid UUID passes validation."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Mock successful async service response
        mock_task_service.archive_task = AsyncMock(
            return_value=(True, {"message": "Task archived successfully"})
        )

        response = client.delete(f"/api/tasks/{valid_uuid}")

        # Should succeed
        assert response.status_code == 200
        # Service should be called
        mock_task_service.archive_task.assert_called_once()

    def test_delete_task_with_invalid_uuid(self, client, mock_task_service):
        """Test that invalid UUID returns 400."""
        invalid_id = "61"

        response = client.delete(f"/api/tasks/{invalid_id}")

        # Should return 400
        assert response.status_code == 400

        # Service should NOT be called
        mock_task_service.archive_task.assert_not_called()


class TestMCPTaskStatusUUIDValidation:
    """Test PUT /api/mcp/tasks/{task_id}/status UUID validation."""

    def test_mcp_update_status_with_valid_uuid(self, client, mock_task_service):
        """Test that valid UUID passes validation."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Mock successful async service response
        mock_task_service.update_task = AsyncMock(
            return_value=(
                True,
                {
                    "task": {
                        "id": valid_uuid,
                        "status": "doing",
                    },
                    "message": "Task updated successfully",
                },
            )
        )

        response = client.put(f"/api/mcp/tasks/{valid_uuid}/status?status=doing")

        # Should succeed or have validation issues unrelated to UUID
        # (Other validations like status values might fail)
        assert response.status_code in [200, 422, 500]
        # If it's not a UUID error (400), that's what we're testing
        if response.status_code == 400:
            # Should NOT be a UUID validation error
            data = response.json()
            error_text = str(data).lower()
            assert "uuid" not in error_text

    def test_mcp_update_status_with_invalid_uuid(self, client, mock_task_service):
        """Test that invalid UUID returns 400."""
        invalid_id = "12"

        response = client.put(f"/api/mcp/tasks/{invalid_id}/status?status=doing")

        # Should return 400
        assert response.status_code == 400

        # Service should NOT be called
        mock_task_service.update_task.assert_not_called()


class TestMultipleInvalidFormats:
    """Test various invalid UUID formats across all endpoints."""

    @pytest.fixture
    def endpoints(self):
        """Provide list of endpoint templates for testing."""
        return [
            ("GET", "/api/tasks/{task_id}", None),
            ("PUT", "/api/tasks/{task_id}", {"title": "Test"}),
            ("DELETE", "/api/tasks/{task_id}", None),
            ("PUT", "/api/mcp/tasks/{task_id}/status?status=doing", None),
        ]

    def test_all_endpoints_reject_integers(self, client, endpoints, mock_task_service):
        """Test that all endpoints reject integer strings."""
        invalid_ids = ["12", "322", "61", "0"]

        for method, url_template, json_data in endpoints:
            for invalid_id in invalid_ids:
                url = url_template.format(task_id=invalid_id)

                if method == "GET":
                    response = client.get(url)
                elif method == "PUT":
                    response = client.put(url, json=json_data)
                elif method == "DELETE":
                    response = client.delete(url)

                assert response.status_code == 400, (
                    f"Failed for {method} {url} with ID: {invalid_id}"
                )

    def test_all_endpoints_accept_valid_uuids(self, client, endpoints, mock_task_service):
        """Test that all endpoints accept valid UUIDs."""
        valid_uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Setup mocks for all service methods
        mock_task_service.get_task.return_value = (True, {"task": {"id": valid_uuid}})
        mock_task_service.update_task = AsyncMock(
            return_value=(True, {"task": {"id": valid_uuid}})
        )
        mock_task_service.archive_task = AsyncMock(
            return_value=(True, {"message": "Success"})
        )

        for method, url_template, json_data in endpoints:
            url = url_template.format(task_id=valid_uuid)

            if method == "GET":
                response = client.get(url)
            elif method == "PUT":
                response = client.put(url, json=json_data)
            elif method == "DELETE":
                response = client.delete(url)

            # Should succeed (200) or fail for other reasons (not 400)
            assert response.status_code != 400, (
                f"Valid UUID rejected for {method} {url}"
            )


class TestErrorMessageQuality:
    """Test that error messages are clear and actionable."""

    def test_error_message_is_json(self, client):
        """Test that error responses are JSON formatted."""
        response = client.get("/api/tasks/12")

        assert response.status_code == 400
        assert response.headers["content-type"] == "application/json"

    def test_error_message_mentions_uuid(self, client):
        """Test that error message mentions UUID requirement."""
        response = client.get("/api/tasks/12")

        assert response.status_code == 400
        data = response.json()
        error_text = str(data).lower()

        # Should mention UUID
        assert "uuid" in error_text

    def test_error_message_is_user_friendly(self, client):
        """Test that error messages are understandable."""
        response = client.get("/api/tasks/invalid-id")

        assert response.status_code == 400
        data = response.json()

        # Should have either 'error' or 'detail' key
        assert "error" in data or "detail" in data

        # Message should be a string (not just a code)
        if "error" in data:
            assert isinstance(data["error"], (str, dict))
        if "detail" in data:
            assert isinstance(data["detail"], (str, dict))

