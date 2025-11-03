"""Tests for State Manager"""

from datetime import datetime

import pytest

from src.agent_work_orders.models import (
    AgentWorkflowType,
    AgentWorkOrderState,
    AgentWorkOrderStatus,
    SandboxType,
    StepExecutionResult,
    StepHistory,
    WorkflowStep,
)
from src.agent_work_orders.state_manager.work_order_repository import (
    WorkOrderRepository,
)


@pytest.mark.asyncio
async def test_create_work_order():
    """Test creating a work order"""
    repo = WorkOrderRepository()

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )

    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "status": AgentWorkOrderStatus.PENDING,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }

    await repo.create(state, metadata)

    result = await repo.get("wo-test123")
    assert result is not None
    retrieved_state, retrieved_metadata = result
    assert retrieved_state.agent_work_order_id == "wo-test123"
    assert retrieved_metadata["status"] == AgentWorkOrderStatus.PENDING


@pytest.mark.asyncio
async def test_get_nonexistent_work_order():
    """Test getting a work order that doesn't exist"""
    repo = WorkOrderRepository()

    result = await repo.get("wo-nonexistent")
    assert result is None


@pytest.mark.asyncio
async def test_list_work_orders():
    """Test listing all work orders"""
    repo = WorkOrderRepository()

    # Create multiple work orders
    for i in range(3):
        state = AgentWorkOrderState(
            agent_work_order_id=f"wo-test{i}",
            repository_url="https://github.com/owner/repo",
            sandbox_identifier=f"sandbox-wo-test{i}",
            git_branch_name=None,
            agent_session_id=None,
        )
        metadata = {
            "workflow_type": AgentWorkflowType.PLAN,
            "sandbox_type": SandboxType.GIT_BRANCH,
            "status": AgentWorkOrderStatus.PENDING,
            "created_at": datetime.now(),
            "updated_at": datetime.now(),
        }
        await repo.create(state, metadata)

    results = await repo.list()
    assert len(results) == 3


@pytest.mark.asyncio
async def test_list_work_orders_with_status_filter():
    """Test listing work orders filtered by status"""
    repo = WorkOrderRepository()

    # Create work orders with different statuses
    for i, status in enumerate([AgentWorkOrderStatus.PENDING, AgentWorkOrderStatus.RUNNING, AgentWorkOrderStatus.COMPLETED]):
        state = AgentWorkOrderState(
            agent_work_order_id=f"wo-test{i}",
            repository_url="https://github.com/owner/repo",
            sandbox_identifier=f"sandbox-wo-test{i}",
            git_branch_name=None,
            agent_session_id=None,
        )
        metadata = {
            "workflow_type": AgentWorkflowType.PLAN,
            "sandbox_type": SandboxType.GIT_BRANCH,
            "status": status,
            "created_at": datetime.now(),
            "updated_at": datetime.now(),
        }
        await repo.create(state, metadata)

    # Filter by RUNNING
    results = await repo.list(status_filter=AgentWorkOrderStatus.RUNNING)
    assert len(results) == 1
    assert results[0][1]["status"] == AgentWorkOrderStatus.RUNNING


@pytest.mark.asyncio
async def test_update_status():
    """Test updating work order status"""
    repo = WorkOrderRepository()

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )
    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "status": AgentWorkOrderStatus.PENDING,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }
    await repo.create(state, metadata)

    # Update status
    await repo.update_status("wo-test123", AgentWorkOrderStatus.RUNNING)

    result = await repo.get("wo-test123")
    assert result is not None
    _, updated_metadata = result
    assert updated_metadata["status"] == AgentWorkOrderStatus.RUNNING


@pytest.mark.asyncio
async def test_update_status_with_additional_fields():
    """Test updating status with additional fields"""
    repo = WorkOrderRepository()

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )
    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "status": AgentWorkOrderStatus.PENDING,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }
    await repo.create(state, metadata)

    # Update with additional fields
    await repo.update_status(
        "wo-test123",
        AgentWorkOrderStatus.COMPLETED,
        github_pull_request_url="https://github.com/owner/repo/pull/1",
    )

    result = await repo.get("wo-test123")
    assert result is not None
    _, updated_metadata = result
    assert updated_metadata["status"] == AgentWorkOrderStatus.COMPLETED
    assert updated_metadata["github_pull_request_url"] == "https://github.com/owner/repo/pull/1"


@pytest.mark.asyncio
async def test_update_git_branch():
    """Test updating git branch name"""
    repo = WorkOrderRepository()

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )
    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "status": AgentWorkOrderStatus.PENDING,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }
    await repo.create(state, metadata)

    # Update git branch
    await repo.update_git_branch("wo-test123", "feat-wo-test123")

    result = await repo.get("wo-test123")
    assert result is not None
    updated_state, _ = result
    assert updated_state.git_branch_name == "feat-wo-test123"


@pytest.mark.asyncio
async def test_update_session_id():
    """Test updating agent session ID"""
    repo = WorkOrderRepository()

    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )
    metadata = {
        "workflow_type": AgentWorkflowType.PLAN,
        "sandbox_type": SandboxType.GIT_BRANCH,
        "status": AgentWorkOrderStatus.PENDING,
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
    }
    await repo.create(state, metadata)

    # Update session ID
    await repo.update_session_id("wo-test123", "session-abc123")

    result = await repo.get("wo-test123")
    assert result is not None
    updated_state, _ = result
    assert updated_state.agent_session_id == "session-abc123"


@pytest.mark.asyncio
async def test_save_and_get_step_history():
    """Test saving and retrieving step history"""
    repo = WorkOrderRepository()

    step1 = StepExecutionResult(
        step=WorkflowStep.CREATE_BRANCH,
        agent_name="BranchCreator",
        success=True,
        output="feat/test-feature",
        duration_seconds=1.0,
    )

    step2 = StepExecutionResult(
        step=WorkflowStep.PLANNING,
        agent_name="Planner",
        success=True,
        output="Plan created",
        duration_seconds=5.0,
    )

    history = StepHistory(agent_work_order_id="wo-test123", steps=[step1, step2])

    await repo.save_step_history("wo-test123", history)

    retrieved = await repo.get_step_history("wo-test123")
    assert retrieved is not None
    assert retrieved.agent_work_order_id == "wo-test123"
    assert len(retrieved.steps) == 2
    assert retrieved.steps[0].step == WorkflowStep.CREATE_BRANCH
    assert retrieved.steps[1].step == WorkflowStep.PLANNING


@pytest.mark.asyncio
async def test_get_nonexistent_step_history():
    """Test getting step history that doesn't exist"""
    repo = WorkOrderRepository()

    retrieved = await repo.get_step_history("wo-nonexistent")
    assert retrieved is None


@pytest.mark.asyncio
async def test_update_step_history():
    """Test updating step history with new steps"""
    repo = WorkOrderRepository()

    # Initial history
    step1 = StepExecutionResult(
        step=WorkflowStep.CREATE_BRANCH,
        agent_name="BranchCreator",
        success=True,
        output="feat/test-feature",
        duration_seconds=1.0,
    )

    history = StepHistory(agent_work_order_id="wo-test123", steps=[step1])
    await repo.save_step_history("wo-test123", history)

    # Add more steps
    step2 = StepExecutionResult(
        step=WorkflowStep.PLANNING,
        agent_name="Planner",
        success=True,
        output="Plan created",
        duration_seconds=5.0,
    )

    history.steps.append(step2)
    await repo.save_step_history("wo-test123", history)

    # Verify updated history
    retrieved = await repo.get_step_history("wo-test123")
    assert retrieved is not None
    assert len(retrieved.steps) == 2
