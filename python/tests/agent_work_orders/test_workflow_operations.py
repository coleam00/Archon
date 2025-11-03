"""Tests for Workflow Operations - Refactored Command Stitching Architecture"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.agent_work_orders.models import (
    CommandExecutionResult,
    WorkflowStep,
)
from src.agent_work_orders.workflow_engine import workflow_operations
from src.agent_work_orders.workflow_engine.agent_names import (
    BRANCH_CREATOR,
    COMMITTER,
    IMPLEMENTOR,
    PLANNER,
    PR_CREATOR,
    REVIEWER,
)


@pytest.mark.asyncio
async def test_run_create_branch_step_success():
    """Test successful branch creation"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="feat/add-feature",
            stdout="feat/add-feature",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock(file_path="create-branch.md"))

    context = {"user_request": "Add new feature"}

    result = await workflow_operations.run_create_branch_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    assert result.step == WorkflowStep.CREATE_BRANCH
    assert result.agent_name == BRANCH_CREATOR
    assert result.output == "feat/add-feature"
    mock_command_loader.load_command.assert_called_once_with("create-branch")
    mock_executor.build_command.assert_called_once()


@pytest.mark.asyncio
async def test_run_create_branch_step_failure():
    """Test branch creation failure"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=False,
            error_message="Branch creation failed",
            exit_code=1,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {"user_request": "Add new feature"}

    result = await workflow_operations.run_create_branch_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is False
    assert result.error_message == "Branch creation failed"
    assert result.step == WorkflowStep.CREATE_BRANCH


@pytest.mark.asyncio
async def test_run_planning_step_success():
    """Test successful planning step"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="PRPs/features/add-feature.md",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {
        "user_request": "Add authentication",
        "github_issue_number": "123"
    }

    result = await workflow_operations.run_planning_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    assert result.step == WorkflowStep.PLANNING
    assert result.agent_name == PLANNER
    assert result.output == "PRPs/features/add-feature.md"
    mock_command_loader.load_command.assert_called_once_with("planning")


@pytest.mark.asyncio
async def test_run_planning_step_with_none_issue_number():
    """Test planning step handles None issue number"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="PRPs/features/add-feature.md",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {
        "user_request": "Add authentication",
        "github_issue_number": None  # None should be converted to ""
    }

    result = await workflow_operations.run_planning_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    # Verify build_command was called with ["user_request", ""] not None
    args_used = mock_executor.build_command.call_args[1]["args"]
    assert args_used[1] == ""  # github_issue_number should be empty string


@pytest.mark.asyncio
async def test_run_execute_step_success():
    """Test successful execute step"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="Implementation completed",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {"planning": "PRPs/features/add-feature.md"}

    result = await workflow_operations.run_execute_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    assert result.step == WorkflowStep.EXECUTE
    assert result.agent_name == IMPLEMENTOR
    assert "completed" in result.output.lower()
    mock_command_loader.load_command.assert_called_once_with("execute")


@pytest.mark.asyncio
async def test_run_execute_step_missing_plan_file():
    """Test execute step fails when plan file missing from context"""
    mock_executor = MagicMock()
    mock_command_loader = MagicMock()

    context = {}  # No plan file

    result = await workflow_operations.run_execute_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is False
    assert "No plan file" in result.error_message


@pytest.mark.asyncio
async def test_run_commit_step_success():
    """Test successful commit step"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="Commit: abc123\nBranch: feat/add-feature\nPushed: Yes",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {}

    result = await workflow_operations.run_commit_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    assert result.step == WorkflowStep.COMMIT
    assert result.agent_name == COMMITTER
    mock_command_loader.load_command.assert_called_once_with("commit")


@pytest.mark.asyncio
async def test_run_create_pr_step_success():
    """Test successful PR creation"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="https://github.com/owner/repo/pull/123",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {
        "create-branch": "feat/add-feature",
        "planning": "PRPs/features/add-feature.md"
    }

    result = await workflow_operations.run_create_pr_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    assert result.step == WorkflowStep.CREATE_PR
    assert result.agent_name == PR_CREATOR
    assert "github.com" in result.output
    mock_command_loader.load_command.assert_called_once_with("create-pr")


@pytest.mark.asyncio
async def test_run_create_pr_step_missing_branch():
    """Test PR creation fails when branch name missing"""
    mock_executor = MagicMock()
    mock_command_loader = MagicMock()

    context = {"planning": "PRPs/features/add-feature.md"}  # No branch name

    result = await workflow_operations.run_create_pr_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is False
    assert "No branch name" in result.error_message


@pytest.mark.asyncio
async def test_run_review_step_success():
    """Test successful review step"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text='{"blockers": [], "tech_debt": []}',
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    context = {"planning": "PRPs/features/add-feature.md"}

    result = await workflow_operations.run_review_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is True
    assert result.step == WorkflowStep.REVIEW
    assert result.agent_name == REVIEWER
    mock_command_loader.load_command.assert_called_once_with("prp-review")


@pytest.mark.asyncio
async def test_run_review_step_missing_plan():
    """Test review step fails when plan file missing"""
    mock_executor = MagicMock()
    mock_command_loader = MagicMock()

    context = {}  # No plan file

    result = await workflow_operations.run_review_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert result.success is False
    assert "No plan file" in result.error_message


@pytest.mark.asyncio
async def test_context_passing_between_steps():
    """Test that context is properly used across steps"""
    mock_executor = MagicMock()
    mock_executor.build_command = MagicMock(return_value=("cli command", "prompt"))
    mock_executor.execute_async = AsyncMock(
        return_value=CommandExecutionResult(
            success=True,
            result_text="output",
            exit_code=0,
        )
    )

    mock_command_loader = MagicMock()
    mock_command_loader.load_command = MagicMock(return_value=MagicMock())

    # Test context flow: create-branch -> planning
    context = {"user_request": "Test feature"}

    # Step 1: Create branch
    branch_result = await workflow_operations.run_create_branch_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    # Simulate orchestrator storing output
    context["create-branch"] = "feat/test-feature"

    # Step 2: Planning should have access to branch name via context
    planning_result = await workflow_operations.run_planning_step(
        executor=mock_executor,
        command_loader=mock_command_loader,
        work_order_id="wo-test",
        working_dir="/tmp/test",
        context=context,
    )

    assert branch_result.success is True
    assert planning_result.success is True
    assert "create-branch" in context
