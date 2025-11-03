"""Tests for Workflow Orchestrator - Command Stitching Architecture"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agent_work_orders.models import (
    AgentWorkOrderStatus,
    SandboxType,
    StepExecutionResult,
    WorkflowStep,
)
from src.agent_work_orders.workflow_engine.workflow_orchestrator import WorkflowOrchestrator


@pytest.fixture
def mock_dependencies():
    """Create mocked dependencies for orchestrator"""
    mock_executor = MagicMock()
    mock_sandbox_factory = MagicMock()
    mock_github_client = MagicMock()
    mock_command_loader = MagicMock()
    mock_state_repository = MagicMock()

    # Mock sandbox
    mock_sandbox = MagicMock()
    mock_sandbox.working_dir = "/tmp/test-sandbox"
    mock_sandbox.setup = AsyncMock()
    mock_sandbox.cleanup = AsyncMock()
    mock_sandbox_factory.create_sandbox.return_value = mock_sandbox

    # Mock state repository
    mock_state_repository.update_status = AsyncMock()
    mock_state_repository.save_step_history = AsyncMock()
    mock_state_repository.update_git_branch = AsyncMock()

    orchestrator = WorkflowOrchestrator(
        agent_executor=mock_executor,
        sandbox_factory=mock_sandbox_factory,
        github_client=mock_github_client,
        command_loader=mock_command_loader,
        state_repository=mock_state_repository,
    )

    return orchestrator, {
        "executor": mock_executor,
        "sandbox_factory": mock_sandbox_factory,
        "github_client": mock_github_client,
        "command_loader": mock_command_loader,
        "state_repository": mock_state_repository,
        "sandbox": mock_sandbox,
    }


@pytest.mark.asyncio
async def test_execute_workflow_default_commands(mock_dependencies):
    """Test workflow with default command selection"""
    orchestrator, mocks = mock_dependencies

    # Mock all command steps to succeed
    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step") as mock_branch, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_planning_step") as mock_plan, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_execute_step") as mock_execute, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_review_step") as mock_review, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_commit_step") as mock_commit, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_pr_step") as mock_pr:

        # Set up mock returns
        mock_branch.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=True,
            output="feat/test-feature",
            duration_seconds=1.0,
        )

        mock_plan.return_value = StepExecutionResult(
            step=WorkflowStep.PLANNING,
            agent_name="Planner",
            success=True,
            output="PRPs/features/test.md",
            duration_seconds=5.0,
        )

        mock_execute.return_value = StepExecutionResult(
            step=WorkflowStep.EXECUTE,
            agent_name="Implementor",
            success=True,
            output="Implementation completed",
            duration_seconds=30.0,
        )

        mock_review.return_value = StepExecutionResult(
            step=WorkflowStep.REVIEW,
            agent_name="Reviewer",
            success=True,
            output="Review completed, all checks passed",
            duration_seconds=10.0,
        )

        mock_commit.return_value = StepExecutionResult(
            step=WorkflowStep.COMMIT,
            agent_name="Committer",
            success=True,
            output="Commit: abc123",
            duration_seconds=2.0,
        )

        mock_pr.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_PR,
            agent_name="PrCreator",
            success=True,
            output="https://github.com/owner/repo/pull/1",
            duration_seconds=3.0,
        )

        # Execute workflow with default commands (None = default)
        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=None,  # Should use default
        )

        # Verify all 6 default commands were executed in order
        assert mock_branch.called
        assert mock_plan.called
        assert mock_execute.called
        assert mock_review.called
        assert mock_commit.called
        assert mock_pr.called

        # Verify status updates
        assert mocks["state_repository"].update_status.call_count >= 2


@pytest.mark.asyncio
async def test_execute_workflow_custom_commands(mock_dependencies):
    """Test workflow with custom command selection"""
    orchestrator, mocks = mock_dependencies

    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step") as mock_branch, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_planning_step") as mock_plan:

        mock_branch.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=True,
            output="feat/test",
            duration_seconds=1.0,
        )

        mock_plan.return_value = StepExecutionResult(
            step=WorkflowStep.PLANNING,
            agent_name="Planner",
            success=True,
            output="PRPs/features/test.md",
            duration_seconds=5.0,
        )

        # Execute with only 2 commands
        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=["create-branch", "planning"],
        )

        # Verify only 2 commands were executed
        assert mock_branch.called
        assert mock_plan.called


@pytest.mark.asyncio
async def test_execute_workflow_stop_on_failure(mock_dependencies):
    """Test workflow stops on first failure"""
    orchestrator, mocks = mock_dependencies

    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step") as mock_branch, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_planning_step") as mock_plan, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_execute_step") as mock_execute:

        # First command succeeds
        mock_branch.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=True,
            output="feat/test",
            duration_seconds=1.0,
        )

        # Second command fails
        mock_plan.return_value = StepExecutionResult(
            step=WorkflowStep.PLANNING,
            agent_name="Planner",
            success=False,
            error_message="Planning failed: timeout",
            duration_seconds=5.0,
        )

        # Execute workflow - should stop at planning and save error to state
        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=["create-branch", "planning", "execute"],
        )

        # Verify only first 2 commands executed, not the third
        assert mock_branch.called
        assert mock_plan.called
        assert not mock_execute.called

        # Verify failure status was set
        calls = [call for call in mocks["state_repository"].update_status.call_args_list
                if call[0][1] == AgentWorkOrderStatus.FAILED]
        assert len(calls) > 0


@pytest.mark.asyncio
async def test_execute_workflow_context_passing(mock_dependencies):
    """Test context is passed correctly between commands"""
    orchestrator, mocks = mock_dependencies

    captured_contexts = []

    async def capture_branch_context(executor, command_loader, work_order_id, working_dir, context):
        captured_contexts.append(("branch", dict(context)))
        return StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=True,
            output="feat/test",
            duration_seconds=1.0,
        )

    async def capture_plan_context(executor, command_loader, work_order_id, working_dir, context):
        captured_contexts.append(("planning", dict(context)))
        return StepExecutionResult(
            step=WorkflowStep.PLANNING,
            agent_name="Planner",
            success=True,
            output="PRPs/features/test.md",
            duration_seconds=5.0,
        )

    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step", side_effect=capture_branch_context), \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_planning_step", side_effect=capture_plan_context):

        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=["create-branch", "planning"],
        )

        # Verify context was passed correctly
        assert len(captured_contexts) == 2

        # First command should have initial context
        branch_context = captured_contexts[0][1]
        assert "user_request" in branch_context
        assert branch_context["user_request"] == "Test feature"

        # Second command should have previous command's output
        planning_context = captured_contexts[1][1]
        assert "user_request" in planning_context
        assert "create-branch" in planning_context
        assert planning_context["create-branch"] == "feat/test"


@pytest.mark.asyncio
async def test_execute_workflow_updates_git_branch(mock_dependencies):
    """Test that git branch name is updated after create-branch"""
    orchestrator, mocks = mock_dependencies

    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step") as mock_branch:

        mock_branch.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=True,
            output="feat/awesome-feature",
            duration_seconds=1.0,
        )

        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=["create-branch"],
        )

        # Verify git branch was updated
        mocks["state_repository"].update_git_branch.assert_called_once_with(
            "wo-test", "feat/awesome-feature"
        )


@pytest.mark.asyncio
async def test_execute_workflow_updates_pr_url(mock_dependencies):
    """Test that PR URL is saved after create-pr"""
    orchestrator, mocks = mock_dependencies

    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step") as mock_branch, \
         patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_pr_step") as mock_pr:

        mock_branch.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=True,
            output="feat/test",
            duration_seconds=1.0,
        )

        mock_pr.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_PR,
            agent_name="PrCreator",
            success=True,
            output="https://github.com/owner/repo/pull/42",
            duration_seconds=3.0,
        )

        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=["create-branch", "create-pr"],
        )

        # Verify PR URL was saved with COMPLETED status
        status_calls = [call for call in mocks["state_repository"].update_status.call_args_list
                       if call[0][1] == AgentWorkOrderStatus.COMPLETED]
        assert any("github_pull_request_url" in str(call) for call in status_calls)


@pytest.mark.asyncio
async def test_execute_workflow_unknown_command(mock_dependencies):
    """Test that unknown commands save error to state"""
    orchestrator, mocks = mock_dependencies

    await orchestrator.execute_workflow(
        agent_work_order_id="wo-test",
        repository_url="https://github.com/owner/repo",
        sandbox_type=SandboxType.GIT_BRANCH,
        user_request="Test feature",
        selected_commands=["invalid-command"],
    )

    # Verify error was saved to state
    status_calls = [call for call in mocks["state_repository"].update_status.call_args_list
                   if call[0][1] == AgentWorkOrderStatus.FAILED]
    assert len(status_calls) > 0
    # Check that error message contains "Unknown command"
    error_messages = [call.kwargs.get("error_message", "") for call in status_calls]
    assert any("Unknown command" in msg for msg in error_messages)


@pytest.mark.asyncio
async def test_execute_workflow_sandbox_cleanup(mock_dependencies):
    """Test that sandbox is cleaned up even on failure"""
    orchestrator, mocks = mock_dependencies

    with patch("src.agent_work_orders.workflow_engine.workflow_operations.run_create_branch_step") as mock_branch:

        mock_branch.return_value = StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name="BranchCreator",
            success=False,
            error_message="Failed",
            duration_seconds=1.0,
        )

        await orchestrator.execute_workflow(
            agent_work_order_id="wo-test",
            repository_url="https://github.com/owner/repo",
            sandbox_type=SandboxType.GIT_BRANCH,
            user_request="Test feature",
            selected_commands=["create-branch"],
        )

        # Verify sandbox cleanup was called even on failure
        assert mocks["sandbox"].cleanup.called
