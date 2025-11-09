"""Integration Tests for API Endpoints"""

from datetime import datetime
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from src.agent_work_orders.models import (
    AgentWorkflowType,
    AgentWorkOrderStatus,
    SandboxType,
)
from src.agent_work_orders.server import app

client = TestClient(app)


def test_health_endpoint():
    """Test health check endpoint - should be healthy when feature is disabled"""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    # When feature is disabled (default), health check returns healthy
    # When feature is enabled but dependencies missing, returns degraded
    # We accept both as valid test outcomes
    assert data["status"] in ["healthy", "degraded"]
    assert data["service"] == "agent-work-orders"
    assert "enabled" in data

    # If disabled, should have explanatory message
    if not data.get("enabled"):
        assert "message" in data


def test_create_agent_work_order():
    """Test creating an agent work order"""
    with patch("src.agent_work_orders.api.routes.orchestrator") as mock_orchestrator:
        mock_orchestrator.execute_workflow = AsyncMock()

        request_data = {
            "repository_url": "https://github.com/owner/repo",
            "sandbox_type": "git_branch",
            "workflow_type": "agent_workflow_plan",
            "user_request": "Add user authentication feature",
            "github_issue_number": "42",
        }

        response = client.post("/api/agent-work-orders/", json=request_data)

        assert response.status_code == 201
        data = response.json()
        assert "agent_work_order_id" in data
        assert data["status"] == "pending"
        assert data["agent_work_order_id"].startswith("wo-")


def test_create_agent_work_order_without_issue():
    """Test creating work order without issue number"""
    with patch("src.agent_work_orders.api.routes.orchestrator") as mock_orchestrator:
        mock_orchestrator.execute_workflow = AsyncMock()

        request_data = {
            "repository_url": "https://github.com/owner/repo",
            "sandbox_type": "git_branch",
            "workflow_type": "agent_workflow_plan",
            "user_request": "Fix the login bug where users can't sign in",
        }

        response = client.post("/api/agent-work-orders/", json=request_data)

        assert response.status_code == 201
        data = response.json()
        assert "agent_work_order_id" in data


def test_create_agent_work_order_invalid_data():
    """Test creating work order with invalid data"""
    request_data = {
        "repository_url": "https://github.com/owner/repo",
        # Missing required fields
    }

    response = client.post("/api/agent-work-orders/", json=request_data)

    assert response.status_code == 422  # Validation error


def test_list_agent_work_orders_empty():
    """Test listing work orders when none exist"""
    # Reset state repository
    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.list = AsyncMock(return_value=[])

        response = client.get("/api/agent-work-orders/")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 0


def test_list_agent_work_orders_with_data():
    """Test listing work orders with data"""
    from src.agent_work_orders.models import AgentWorkOrderState

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name="feat-wo-test123",
        agent_session_id="session-123",
    )

    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "github_issue_number": "42",
        "status": AgentWorkOrderStatus.RUNNING,
        "current_phase": None,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }

    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.list = AsyncMock(return_value=[(state, metadata)])

        response = client.get("/api/agent-work-orders/")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["agent_work_order_id"] == "wo-test123"
        assert data[0]["status"] == "running"


def test_list_agent_work_orders_with_status_filter():
    """Test listing work orders with status filter"""
    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.list = AsyncMock(return_value=[])

        response = client.get("/api/agent-work-orders/?status=running")

        assert response.status_code == 200
        mock_repo.list.assert_called_once()


def test_get_agent_work_order():
    """Test getting a specific work order"""
    from src.agent_work_orders.models import AgentWorkOrderState

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name="feat-wo-test123",
        agent_session_id="session-123",
    )

    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "github_issue_number": "42",
        "status": AgentWorkOrderStatus.COMPLETED,
        "current_phase": None,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
        "github_pull_request_url": "https://github.com/owner/repo/pull/42",
        "git_commit_count": 5,
        "git_files_changed": 10,
        "error_message": None,
    }

    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=(state, metadata))

        response = client.get("/api/agent-work-orders/wo-test123")

        assert response.status_code == 200
        data = response.json()
        assert data["agent_work_order_id"] == "wo-test123"
        assert data["status"] == "completed"
        assert data["git_branch_name"] == "feat-wo-test123"
        assert data["github_pull_request_url"] == "https://github.com/owner/repo/pull/42"


def test_get_agent_work_order_not_found():
    """Test getting a non-existent work order"""
    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=None)

        response = client.get("/api/agent-work-orders/wo-nonexistent")

        assert response.status_code == 404


def test_get_git_progress():
    """Test getting git progress"""
    from src.agent_work_orders.models import AgentWorkOrderState

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name="feat-wo-test123",
        agent_session_id="session-123",
    )

    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "status": AgentWorkOrderStatus.RUNNING,
        "current_phase": None,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
        "git_commit_count": 3,
        "git_files_changed": 7,
    }

    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=(state, metadata))

        response = client.get("/api/agent-work-orders/wo-test123/git-progress")

        assert response.status_code == 200
        data = response.json()
        assert data["agent_work_order_id"] == "wo-test123"
        assert data["git_commit_count"] == 3
        assert data["git_files_changed"] == 7
        assert data["git_branch_name"] == "feat-wo-test123"


def test_get_git_progress_not_found():
    """Test getting git progress for non-existent work order"""
    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=None)

        response = client.get("/api/agent-work-orders/wo-nonexistent/git-progress")

        assert response.status_code == 404


def test_send_prompt_to_agent():
    """Test sending prompt to agent (placeholder)"""
    request_data = {
        "agent_work_order_id": "wo-test123",
        "prompt_text": "Continue with the next step",
    }

    response = client.post("/api/agent-work-orders/wo-test123/prompt", json=request_data)

    # Currently returns success but doesn't actually send (Phase 2+)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True


def test_get_logs():
    """Test getting logs from log buffer"""
    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        # Mock work order exists
        mock_repo.get = AsyncMock(return_value=({"id": "wo-test123"}, {}))

        response = client.get("/api/agent-work-orders/wo-test123/logs")

        assert response.status_code == 200
        data = response.json()
        assert "log_entries" in data
        assert "total" in data
        assert "limit" in data
        assert "offset" in data


def test_verify_repository_success():
    """Test repository verification success"""
    from src.agent_work_orders.models import GitHubRepository

    mock_repo_info = GitHubRepository(
        name="repo",
        owner="owner",
        default_branch="main",
        url="https://github.com/owner/repo",
    )

    with patch("src.agent_work_orders.api.routes.github_client") as mock_client:
        mock_client.verify_repository_access = AsyncMock(return_value=True)
        mock_client.get_repository_info = AsyncMock(return_value=mock_repo_info)

        request_data = {"repository_url": "https://github.com/owner/repo"}

        response = client.post("/api/agent-work-orders/github/verify-repository", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["is_accessible"] is True
        assert data["repository_name"] == "repo"
        assert data["repository_owner"] == "owner"
        assert data["default_branch"] == "main"


def test_verify_repository_failure():
    """Test repository verification failure"""
    with patch("src.agent_work_orders.api.routes.github_client") as mock_client:
        mock_client.verify_repository_access = AsyncMock(return_value=False)

        request_data = {"repository_url": "https://github.com/owner/nonexistent"}

        response = client.post("/api/agent-work-orders/github/verify-repository", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["is_accessible"] is False
        assert data["error_message"] is not None


def test_get_agent_work_order_steps():
    """Test getting step history for a work order"""
    from src.agent_work_orders.models import AgentWorkOrderState, StepExecutionResult, StepHistory, WorkflowStep

    # Create step history
    step_history = StepHistory(
        agent_work_order_id="wo-test123",
        steps=[
            StepExecutionResult(
                step=WorkflowStep.CREATE_BRANCH,
                agent_name="BranchCreator",
                success=True,
                output="feat/test-feature",
                duration_seconds=1.0,
            ),
            StepExecutionResult(
                step=WorkflowStep.PLANNING,
                agent_name="Planner",
                success=True,
                output="Plan created",
                duration_seconds=5.0,
            ),
        ],
    )

    # Mock state for get() call
    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name="feat-wo-test123",
        agent_session_id="session-123",
    )
    metadata = {
        "sandbox_type": SandboxType.GIT_BRANCH,
        "github_issue_number": None,
        "status": AgentWorkOrderStatus.RUNNING,
        "current_phase": None,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }

    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=(state, metadata))
        mock_repo.get_step_history = AsyncMock(return_value=step_history)

        response = client.get("/api/agent-work-orders/wo-test123/steps")

        assert response.status_code == 200
        data = response.json()
        assert data["agent_work_order_id"] == "wo-test123"
        assert len(data["steps"]) == 2
        assert data["steps"][0]["step"] == "create-branch"
        assert data["steps"][0]["agent_name"] == "BranchCreator"
        assert data["steps"][0]["success"] is True
        assert data["steps"][1]["step"] == "planning"
        assert data["steps"][1]["agent_name"] == "Planner"


def test_get_agent_work_order_steps_not_found():
    """Test getting step history for non-existent work order"""
    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=None)
        mock_repo.get_step_history = AsyncMock(return_value=None)

        response = client.get("/api/agent-work-orders/wo-nonexistent/steps")

        assert response.status_code == 404
        data = response.json()
        assert "not found" in data["detail"].lower()


def test_get_agent_work_order_steps_empty():
    """Test getting empty step history"""
    from src.agent_work_orders.models import AgentWorkOrderState, StepHistory

    step_history = StepHistory(agent_work_order_id="wo-test123", steps=[])

    # Mock state for get() call
    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )
    metadata = {
        "sandbox_type": SandboxType.GIT_BRANCH,
        "github_issue_number": None,
        "status": AgentWorkOrderStatus.PENDING,
        "current_phase": None,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }

    with patch("src.agent_work_orders.api.routes.state_repository") as mock_repo:
        mock_repo.get = AsyncMock(return_value=(state, metadata))
        mock_repo.get_step_history = AsyncMock(return_value=step_history)

        response = client.get("/api/agent-work-orders/wo-test123/steps")

        assert response.status_code == 200
        data = response.json()
        assert data["agent_work_order_id"] == "wo-test123"
        assert len(data["steps"]) == 0
