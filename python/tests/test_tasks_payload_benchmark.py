import json
from unittest.mock import MagicMock

import pytest


def _make_task(i: int):
    return {
        "id": f"t-{i}",
        "project_id": "p-1",
        "title": f"Task {i}",
        # Intentionally omit large fields like description, sources, code_examples
        "status": "todo",
        "assignee": "User",
        "task_order": i,
        "feature": "",
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z",
    }


def _mock_projects_api_services(monkeypatch, tasks):
    # Patch ProjectService.get_project to return existing project
    from src.server.api_routes import projects_api

    mock_project_service = MagicMock()
    mock_project_service.get_project.return_value = (True, {"id": "p-1"})
    monkeypatch.setattr(projects_api, "ProjectService", lambda supabase_client=None: mock_project_service)

    # Patch TaskService.list_tasks to return our tasks
    mock_task_service = MagicMock()
    mock_task_service.list_tasks.return_value = (True, {"tasks": tasks})
    monkeypatch.setattr(projects_api, "TaskService", lambda supabase_client=None: mock_task_service)


def test_list_payload_50_tasks_under_30kb(client, monkeypatch):
    # Prepare 50 lightweight tasks
    tasks = [_make_task(i) for i in range(1, 51)]

    # Ensure the projects_api uses our mocks
    _mock_projects_api_services(monkeypatch, tasks)

    # Call the real HTTP endpoint through FastAPI TestClient
    resp = client.get("/api/projects/p-1/tasks?exclude_large_fields=true")
    assert resp.status_code == 200

    # Measure payload size in bytes (raw content)
    raw_size = len(resp.content)

    # Also validate JSON structure and compute stringified size as a secondary measure
    body = resp.json()
    json_size = len(json.dumps(body))

    # Benchmark/Guardrail: 50 tasks list payload must be <= 30 KB
    limit_bytes = 30_000
    assert raw_size <= limit_bytes, f"Payload too large: {raw_size} bytes (> {limit_bytes})"
    assert json_size <= limit_bytes, f"JSON stringified payload too large: {json_size} bytes (> {limit_bytes})"

    # Sanity: ensure that response is a list of tasks and count is 50
    assert isinstance(body, list)
    assert len(body) == 50

