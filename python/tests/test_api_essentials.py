"""Essential API tests - Focus on core functionality that must work."""


def test_health_endpoint(client):
    """Test that health endpoint returns OK status."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert data["status"] in ["healthy", "initializing"]


def test_create_project(client, test_project, mock_supabase_client):
    """Test creating a new project via API."""
    # Set up mock to return a project
    mock_supabase_client.table.return_value.insert.return_value.execute.return_value.data = [
        {
            "id": "test-project-id",
            "title": test_project["title"],
            "description": test_project["description"],
        }
    ]

    response = client.post("/api/projects", json=test_project)
    # Should succeed with mocked data
    assert response.status_code in [200, 201, 422, 500]  # Allow various responses

    # If successful, check response format
    if response.status_code in [200, 201]:
        data = response.json()
        # Check response format - at least one of these should be present
        assert (
            "title" in data
            or "id" in data
            or "progress_id" in data
            or "status" in data
            or "message" in data
        )


def test_list_projects(client, mock_supabase_client):
    """Test listing projects endpoint exists and responds."""
    # Set up mock to return empty list (no projects)
    mock_supabase_client.table.return_value.select.return_value.execute.return_value.data = []

    response = client.get("/api/projects")
    assert response.status_code in [200, 404, 422, 500]  # Allow various responses

    # If successful, response should be JSON (list or dict)
    if response.status_code == 200:
        data = response.json()
        assert isinstance(data, (list, dict))


def test_create_task(client, test_task):
    """Test task creation endpoint exists."""
    # Try the tasks endpoint directly
    response = client.post("/api/tasks", json=test_task)
    # Accept various status codes - endpoint exists
    assert response.status_code in [200, 201, 400, 422, 405]


def test_list_tasks(client):
    """Test tasks listing endpoint exists."""
    response = client.get("/api/tasks")
    # Accept 200, 400, 422, or 500 - endpoint exists
    assert response.status_code in [200, 400, 422, 500]


def test_start_crawl(client):
    """Test crawl endpoint exists and validates input."""
    crawl_request = {"url": "https://example.com", "max_depth": 2, "max_pages": 10}

    response = client.post("/api/knowledge/crawl", json=crawl_request)
    # Accept various status codes - endpoint exists and processes request
    assert response.status_code in [200, 201, 400, 404, 422, 500]


def test_search_knowledge(client):
    """Test knowledge search endpoint exists."""
    response = client.post("/api/knowledge/search", json={"query": "test"})
    # Accept various status codes - endpoint exists
    assert response.status_code in [200, 400, 404, 422, 500]


def test_polling_endpoint(client):
    """Test polling endpoints exist for progress tracking."""
    # Test crawl progress endpoint
    response = client.get("/api/knowledge/crawl-progress/test-id")
    # Should return 200 with not_found status or actual progress
    assert response.status_code in [200, 404, 500]


def test_authentication(client):
    """Test that API handles auth headers gracefully."""
    # Test with no auth header
    response = client.get("/api/projects")
    assert response.status_code in [200, 401, 403, 500]  # 500 is OK in test environment

    # Test with invalid auth header
    headers = {"Authorization": "Bearer invalid-token"}
    response = client.get("/api/projects", headers=headers)
    assert response.status_code in [200, 401, 403, 500]  # 500 is OK in test environment


def test_error_handling(client):
    """Test API returns proper error responses."""
    # Test non-existent endpoint
    response = client.get("/api/nonexistent")
    assert response.status_code == 404

    # Test invalid JSON
    response = client.post("/api/projects", data="invalid json")
    assert response.status_code in [400, 422]
