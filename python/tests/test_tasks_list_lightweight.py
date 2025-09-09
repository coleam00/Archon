"""Tests for lightweight task listing (exclude_large_fields default & behavior)."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI, Request, Response


def make_supabase_mock_with_tasks(tasks):
    """Create a minimal supabase client mock that returns given tasks for select().execute()."""
    mock_client = MagicMock()
    mock_table = MagicMock()
    mock_select = MagicMock()

    # Chain: select -> (eq/neq/or_/order)* -> execute -> .data
    mock_select.eq.return_value = mock_select
    mock_select.neq.return_value = mock_select
    mock_select.or_.return_value = mock_select
    mock_select.order.return_value = mock_select
    mock_execute = MagicMock()
    mock_execute.data = tasks
    mock_select.execute.return_value = mock_execute

    mock_table.select.return_value = mock_select
    mock_client.table.return_value = mock_table
    return mock_client


class TestTaskServiceLightweight:
    @pytest.mark.asyncio
    async def test_service_excludes_large_fields_when_flag_true(self):
        from src.server.services.projects.task_service import TaskService

        tasks = [
            {
                "id": "t1",
                "project_id": "p1",
                "title": "Task 1",
                "description": "Long description",
                "status": "todo",
                "assignee": "User",
                "task_order": 1,
                "feature": None,
                "created_at": "2025-01-01T00:00:00",
                "updated_at": "2025-01-01T00:00:00",
                "archived": False,
                "sources": [{"a": 1}],
                "code_examples": [{"b": 2}],
            }
        ]
        mock_client = make_supabase_mock_with_tasks(tasks)
        service = TaskService(supabase_client=mock_client)

        ok, result = service.list_tasks(project_id="p1", include_closed=True, exclude_large_fields=True)
        assert ok
        assert len(result["tasks"]) == 1
        t = result["tasks"][0]
        assert "description" not in t
        assert "sources" not in t
        assert "code_examples" not in t
        # Basic fields still present
        assert t["title"] == "Task 1"
        assert t["status"] == "todo"

    @pytest.mark.asyncio
    async def test_service_includes_large_fields_when_flag_false(self):
        from src.server.services.projects.task_service import TaskService

        tasks = [
            {
                "id": "t1",
                "project_id": "p1",
                "title": "Task 1",
                "description": "Long description",
                "status": "todo",
                "assignee": "User",
                "task_order": 1,
                "feature": None,
                "created_at": "2025-01-01T00:00:00",
                "updated_at": "2025-01-01T00:00:00",
                "archived": False,
                "sources": [{"a": 1}],
                "code_examples": [{"b": 2}],
            }
        ]
        mock_client = make_supabase_mock_with_tasks(tasks)
        service = TaskService(supabase_client=mock_client)

        ok, result = service.list_tasks(project_id="p1", include_closed=True, exclude_large_fields=False)
        assert ok
        t = result["tasks"][0]
        assert t["description"] == "Long description"
        assert t["sources"] == [{"a": 1}]
        assert t["code_examples"] == [{"b": 2}]


class TestProjectsApiLightweightDefault:
    def _call_list_project_tasks(self, project_id: str, exclude_large_fields=None):
        # Avoid importing heavy/missing deps via package __init__ by stubbing mcp_api
        import sys
        import types
        from fastapi import APIRouter
        if "src.server.api_routes.mcp_api" not in sys.modules:
            stub = types.ModuleType("src.server.api_routes.mcp_api")
            stub.router = APIRouter()
            sys.modules["src.server.api_routes.mcp_api"] = stub

        from src.server.api_routes.projects_api import list_project_tasks

        # Build minimal request/response
        scope = {"type": "http", "headers": []}
        request = Request(scope)
        response = Response()

        if exclude_large_fields is None:
            # Call with default param (should be True)
            return list_project_tasks(project_id=project_id, request=request, response=response)
        else:
            return list_project_tasks(
                project_id=project_id,
                request=request,
                response=response,
                exclude_large_fields=exclude_large_fields,
            )

    @pytest.mark.anyio
    async def test_api_default_param_exclude_large_fields_true(self):
        import importlib, sys, types
        from fastapi import APIRouter
        if "src.server.api_routes.mcp_api" not in sys.modules:
            stub = types.ModuleType("src.server.api_routes.mcp_api")
            stub.router = APIRouter()
            sys.modules["src.server.api_routes.mcp_api"] = stub
        importlib.import_module("src.server.api_routes.projects_api")
        with patch("src.server.api_routes.projects_api.TaskService") as mock_task_class, \
             patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.logfire") as mock_logfire:
            # Project exists
            mock_proj_instance = MagicMock()
            mock_proj_class.return_value = mock_proj_instance
            mock_proj_instance.get_project.return_value = (True, {"id": "p1"})

            # TaskService expectations
            mock_task_instance = MagicMock()
            mock_task_class.return_value = mock_task_instance
            mock_task_instance.list_tasks.return_value = (True, {"tasks": []})

            # Invoke endpoint with default params
            await self._call_list_project_tasks("p1")

            # Verify default exclude_large_fields=True was passed
            kwargs = mock_task_instance.list_tasks.call_args.kwargs
            assert kwargs["exclude_large_fields"] is True

    @pytest.mark.anyio
    async def test_api_can_disable_exclude_large_fields_via_query_param(self):
        import importlib, sys, types
        from fastapi import APIRouter
        if "src.server.api_routes.mcp_api" not in sys.modules:
            stub = types.ModuleType("src.server.api_routes.mcp_api")
            stub.router = APIRouter()
            sys.modules["src.server.api_routes.mcp_api"] = stub
        importlib.import_module("src.server.api_routes.projects_api")
        with patch("src.server.api_routes.projects_api.TaskService") as mock_task_class, \
             patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.logfire") as mock_logfire:
            mock_proj_instance = MagicMock()
            mock_proj_class.return_value = mock_proj_instance
            mock_proj_instance.get_project.return_value = (True, {"id": "p1"})

            mock_task_instance = MagicMock()
            mock_task_class.return_value = mock_task_instance
            mock_task_instance.list_tasks.return_value = (True, {"tasks": []})

            # Explicitly pass False to simulate query param override
            await self._call_list_project_tasks("p1", exclude_large_fields=False)

            kwargs = mock_task_instance.list_tasks.call_args.kwargs
            assert kwargs["exclude_large_fields"] is False

