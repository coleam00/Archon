import types
from unittest.mock import MagicMock

import pytest


def test_get_task_details_found(client, mock_supabase_client):
    task_id = "task-123"
    task = {
        "id": task_id,
        "project_id": "proj-1",
        "title": "Test",
        "description": "Full description",
        "status": "todo",
    }

    mock_table = mock_supabase_client.table.return_value
    mock_select = mock_table.select.return_value
    mock_select.eq.return_value = mock_select
    mock_select.execute.return_value.data = [task]

    resp = client.get(f"/api/tasks/{task_id}/details")
    assert resp.status_code == 200
    body = resp.json()
    assert "task" in body
    assert body["task"]["id"] == task_id


def test_get_task_details_not_found(client, mock_supabase_client):
    task_id = "missing-999"

    mock_table = mock_supabase_client.table.return_value
    mock_select = mock_table.select.return_value
    mock_select.eq.return_value = mock_select
    mock_select.execute.return_value.data = []

    resp = client.get(f"/api/tasks/{task_id}/details")
    assert resp.status_code == 404


def test_get_task_details_error_logging(client, mock_supabase_client, monkeypatch):
    # Force DB layer to raise to trigger 500 path
    mock_table = mock_supabase_client.table.return_value
    mock_select = mock_table.select.return_value
    mock_select.eq.return_value = mock_select
    mock_select.execute.side_effect = Exception("boom")

    # Patch tasks_api.logfire to capture error call
    import src.server.api_routes.tasks_api as tasks_api

    dummy_logfire = types.SimpleNamespace()
    dummy_logfire.error = MagicMock()
    monkeypatch.setattr(tasks_api, "logfire", dummy_logfire, raising=False)

    resp = client.get("/api/tasks/any-id/details")
    assert resp.status_code == 500

    # Verify error logging was called
    assert dummy_logfire.error.called
    
    # The service catches the exception and returns an error tuple,
    # so the API logs "Task service error" without exc_info
    # Check that error was logged with task_id in extra data
    args, kwargs = dummy_logfire.error.call_args
    assert "Task service error" in args[0]
    assert kwargs.get("extra", {}).get("task_id") == "any-id"
    assert "error" in kwargs.get("extra", {})

