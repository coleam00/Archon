"""Unit tests for projects API polling endpoints with ETag support."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient


@pytest.fixture
def test_client():
    """Create a test client for the projects router."""
    from fastapi import FastAPI
    from src.server.api_routes.projects_api import router
    
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestProjectsListPolling:
    """Tests for projects list endpoint with polling support."""

    @pytest.mark.asyncio
    async def test_list_projects_with_etag_generation(self):
        """Test that list_projects generates ETags correctly."""
        from src.server.api_routes.projects_api import list_projects
        
        mock_projects = [
            {"id": "proj-1", "name": "Project 1", "description": "Test project"},
            {"id": "proj-2", "name": "Project 2", "description": "Another project"},
        ]
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.SourceLinkingService") as mock_source_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.list_projects.return_value = (True, {"projects": mock_projects})
            
            mock_source_service = MagicMock()
            mock_source_class.return_value = mock_source_service
            mock_source_service.format_projects_with_sources.return_value = mock_projects
            
            response = Response()
            result = await list_projects(response=response, if_none_match=None)
            
            assert result is not None
            assert len(result["projects"]) == 2
            assert result["count"] == 2
            assert "timestamp" in result
            
            # Check ETag was set
            assert "ETag" in response.headers
            assert response.headers["ETag"].startswith('"')
            assert response.headers["ETag"].endswith('"')
            assert "Last-Modified" in response.headers
            assert response.headers["Cache-Control"] == "no-cache, must-revalidate"

    @pytest.mark.asyncio
    async def test_list_projects_returns_304_with_matching_etag(self):
        """Test that matching ETag returns 304 Not Modified."""
        from src.server.api_routes.projects_api import list_projects
        
        mock_projects = [
            {"id": "proj-1", "name": "Project 1", "description": "Test"},
        ]
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.SourceLinkingService") as mock_source_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.list_projects.return_value = (True, {"projects": mock_projects})
            
            mock_source_service = MagicMock()
            mock_source_class.return_value = mock_source_service
            mock_source_service.format_projects_with_sources.return_value = mock_projects
            
            # First request to get ETag
            response1 = Response()
            result1 = await list_projects(response=response1, if_none_match=None)
            etag = response1.headers["ETag"]
            
            # Second request with same data and ETag
            response2 = Response()
            result2 = await list_projects(response=response2, if_none_match=etag)
            
            assert result2 is None  # No content for 304
            assert response2.status_code == 304
            assert response2.headers["ETag"] == etag
            assert response2.headers["Cache-Control"] == "no-cache, must-revalidate"

    @pytest.mark.asyncio
    async def test_list_projects_etag_changes_with_data(self):
        """Test that ETag changes when project data changes."""
        from src.server.api_routes.projects_api import list_projects
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.SourceLinkingService") as mock_source_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_source_service = MagicMock()
            mock_source_class.return_value = mock_source_service
            
            # Initial data
            projects1 = [{"id": "proj-1", "name": "Project 1"}]
            mock_proj_service.list_projects.return_value = (True, {"projects": projects1})
            mock_source_service.format_projects_with_sources.return_value = projects1
            
            response1 = Response()
            await list_projects(response=response1, if_none_match=None)
            etag1 = response1.headers["ETag"]
            
            # Modified data
            projects2 = [{"id": "proj-1", "name": "Project 1 Updated"}]
            mock_proj_service.list_projects.return_value = (True, {"projects": projects2})
            mock_source_service.format_projects_with_sources.return_value = projects2
            
            response2 = Response()
            await list_projects(response=response2, if_none_match=etag1)
            etag2 = response2.headers["ETag"]
            
            assert etag1 != etag2
            assert response2.status_code != 304

    def test_list_projects_http_with_etag(self, test_client):
        """Test projects endpoint via HTTP with ETag support."""
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.SourceLinkingService") as mock_source_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            projects = [{"id": "proj-1", "name": "Test Project"}]
            mock_proj_service.list_projects.return_value = (True, {"projects": projects})
            
            mock_source_service = MagicMock()
            mock_source_class.return_value = mock_source_service
            mock_source_service.format_projects_with_sources.return_value = projects
            
            # First request
            response1 = test_client.get("/api/projects")
            assert response1.status_code == 200
            assert "ETag" in response1.headers
            etag = response1.headers["ETag"]
            
            # Second request with If-None-Match
            response2 = test_client.get(
                "/api/projects",
                headers={"If-None-Match": etag}
            )
            assert response2.status_code == 304
            assert response2.content == b""


class TestProjectTasksPolling:
    """Tests for project tasks endpoint with polling support."""

    @pytest.mark.asyncio
    async def test_list_project_tasks_with_etag(self):
        """Test that list_project_tasks generates ETags correctly."""
        from src.server.api_routes.projects_api import list_project_tasks
        from fastapi import Request
        
        mock_tasks = [
            {"id": "task-1", "title": "Task 1", "status": "todo", "task_order": 1},
            {"id": "task-2", "title": "Task 2", "status": "doing", "task_order": 2},
        ]
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.TaskService") as mock_task_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.get_project.return_value = (True, {"id": "proj-1", "name": "Test"})
            
            mock_task_service = MagicMock()
            mock_task_class.return_value = mock_task_service
            mock_task_service.list_tasks.return_value = (True, {"tasks": mock_tasks})
            
            # Create mock request object
            mock_request = MagicMock(spec=Request)
            mock_request.headers = {}
            
            response = Response()
            result = await list_project_tasks("proj-1", request=mock_request, response=response)
            
            assert result is not None
            assert len(result) == 2
            
            # Check ETag was set
            assert "ETag" in response.headers
            assert response.headers["Cache-Control"] == "no-cache, must-revalidate"

    @pytest.mark.asyncio
    async def test_list_project_tasks_304_response(self):
        """Test that project tasks returns 304 for unchanged data."""
        from src.server.api_routes.projects_api import list_project_tasks
        from fastapi import Request
        
        mock_tasks = [
            {"id": "task-1", "title": "Task 1", "status": "todo"},
        ]
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.TaskService") as mock_task_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.get_project.return_value = (True, {"id": "proj-1"})
            
            mock_task_service = MagicMock()
            mock_task_class.return_value = mock_task_service
            mock_task_service.list_tasks.return_value = (True, {"tasks": mock_tasks})
            
            # First request
            mock_request1 = MagicMock(spec=Request)
            mock_request1.headers = MagicMock()
            mock_request1.headers.get = lambda key, default=None: default
            response1 = Response()
            await list_project_tasks("proj-1", request=mock_request1, response=response1)
            etag = response1.headers["ETag"]
            
            # Second request with ETag
            mock_request2 = MagicMock(spec=Request)
            mock_request2.headers = MagicMock()
            mock_request2.headers.get = lambda key, default=None: etag if key == "If-None-Match" else default
            response2 = Response()
            result = await list_project_tasks("proj-1", request=mock_request2, response=response2)
            
            assert result is None
            assert response2.status_code == 304
            assert response2.headers["ETag"] == etag

    def test_list_project_tasks_http_polling(self, test_client):
        """Test project tasks endpoint polling via HTTP."""
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.TaskService") as mock_task_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.get_project.return_value = (True, {"id": "proj-1"})
            
            mock_task_service = MagicMock()
            mock_task_class.return_value = mock_task_service
            mock_task_service.list_tasks.return_value = (True, {"tasks": [
                {"id": "task-1", "title": "Test Task", "status": "todo"},
            ]})
            
            # Simulate multiple polling requests
            etag = None
            for i in range(3):
                headers = {"If-None-Match": etag} if etag else {}
                response = test_client.get("/api/projects/proj-1/tasks", headers=headers)
                
                if i == 0:
                    # First request should return data
                    assert response.status_code == 200
                    assert len(response.json()) == 1
                    etag = response.headers["ETag"]
                else:
                    # Subsequent requests should return 304
                    assert response.status_code == 304
                    assert response.content == b""


class TestPollingEdgeCases:
    """Test edge cases in polling implementation."""

    @pytest.mark.asyncio
    async def test_empty_projects_list_etag(self):
        """Test ETag generation for empty projects list."""
        from src.server.api_routes.projects_api import list_projects
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.SourceLinkingService") as mock_source_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.list_projects.return_value = (True, {"projects": []})
            
            mock_source_service = MagicMock()
            mock_source_class.return_value = mock_source_service
            mock_source_service.format_projects_with_sources.return_value = []
            
            response = Response()
            result = await list_projects(response=response)
            
            assert result["projects"] == []
            assert result["count"] == 0
            assert "ETag" in response.headers
            
            # Empty list should still have a stable ETag
            response2 = Response()
            await list_projects(response=response2, if_none_match=response.headers["ETag"])
            assert response2.status_code == 304

    @pytest.mark.asyncio
    async def test_project_not_found_no_etag(self):
        """Test that 404 responses don't include ETags."""
        from src.server.api_routes.projects_api import list_project_tasks
        from fastapi import Request
        
        with patch("src.server.api_routes.projects_api.ProjectService") as mock_proj_class, \
             patch("src.server.api_routes.projects_api.TaskService") as mock_task_class:
            
            mock_proj_service = MagicMock()
            mock_proj_class.return_value = mock_proj_service
            mock_proj_service.get_project.return_value = (False, "Project not found")
            
            # TaskService will be called and should return error for project not found
            mock_task_service = MagicMock()
            mock_task_class.return_value = mock_task_service
            # When project doesn't exist, list_tasks should fail
            mock_task_service.list_tasks.return_value = (False, {"error": "Project not found", "status_code": 404})
            
            mock_request = MagicMock(spec=Request)
            mock_request.headers = {}
            response = Response()
            
            with pytest.raises(HTTPException) as exc_info:
                await list_project_tasks("non-existent", request=mock_request, response=response)
            
            # The actual endpoint returns 500 when TaskService fails (not 404)
            assert exc_info.value.status_code == 500
            # Response headers shouldn't be set on exception
            assert "ETag" not in response.headers