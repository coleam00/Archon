"""Tests for Agent Work Orders Models"""

from datetime import datetime

from src.agent_work_orders.models import (
    AgentWorkflowPhase,
    AgentWorkflowType,
    AgentWorkOrder,
    AgentWorkOrderState,
    AgentWorkOrderStatus,
    CommandExecutionResult,
    CreateAgentWorkOrderRequest,
    SandboxType,
    StepExecutionResult,
    StepHistory,
    WorkflowStep,
)


def test_agent_work_order_status_enum():
    """Test AgentWorkOrderStatus enum values"""
    assert AgentWorkOrderStatus.PENDING.value == "pending"
    assert AgentWorkOrderStatus.RUNNING.value == "running"
    assert AgentWorkOrderStatus.COMPLETED.value == "completed"
    assert AgentWorkOrderStatus.FAILED.value == "failed"


def test_agent_workflow_type_enum():
    """Test AgentWorkflowType enum values"""
    assert AgentWorkflowType.PLAN.value == "agent_workflow_plan"


def test_sandbox_type_enum():
    """Test SandboxType enum values"""
    assert SandboxType.GIT_BRANCH.value == "git_branch"
    assert SandboxType.GIT_WORKTREE.value == "git_worktree"
    assert SandboxType.E2B.value == "e2b"
    assert SandboxType.DAGGER.value == "dagger"


def test_agent_workflow_phase_enum():
    """Test AgentWorkflowPhase enum values"""
    assert AgentWorkflowPhase.PLANNING.value == "planning"
    assert AgentWorkflowPhase.COMPLETED.value == "completed"


def test_agent_work_order_state_creation():
    """Test creating AgentWorkOrderState"""
    state = AgentWorkOrderState(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name=None,
        agent_session_id=None,
    )

    assert state.agent_work_order_id == "wo-test123"
    assert state.repository_url == "https://github.com/owner/repo"
    assert state.sandbox_identifier == "sandbox-wo-test123"
    assert state.git_branch_name is None
    assert state.agent_session_id is None


def test_agent_work_order_creation():
    """Test creating complete AgentWorkOrder"""
    now = datetime.now()

    work_order = AgentWorkOrder(
        agent_work_order_id="wo-test123",
        repository_url="https://github.com/owner/repo",
        sandbox_identifier="sandbox-wo-test123",
        git_branch_name="feat-wo-test123",
        agent_session_id="session-123",
        sandbox_type=SandboxType.GIT_BRANCH,
        github_issue_number="42",
        status=AgentWorkOrderStatus.RUNNING,
        current_phase=AgentWorkflowPhase.PLANNING,
        created_at=now,
        updated_at=now,
        github_pull_request_url=None,
        git_commit_count=0,
        git_files_changed=0,
        error_message=None,
    )

    assert work_order.agent_work_order_id == "wo-test123"
    assert work_order.sandbox_type == SandboxType.GIT_BRANCH
    assert work_order.status == AgentWorkOrderStatus.RUNNING
    assert work_order.current_phase == AgentWorkflowPhase.PLANNING


def test_create_agent_work_order_request():
    """Test CreateAgentWorkOrderRequest validation"""
    request = CreateAgentWorkOrderRequest(
        repository_url="https://github.com/owner/repo",
        sandbox_type=SandboxType.GIT_BRANCH,
        user_request="Add user authentication feature",
        github_issue_number="42",
    )

    assert request.repository_url == "https://github.com/owner/repo"
    assert request.sandbox_type == SandboxType.GIT_BRANCH
    assert request.user_request == "Add user authentication feature"
    assert request.github_issue_number == "42"
    assert request.selected_commands == ["create-branch", "planning", "execute", "commit", "create-pr"]


def test_create_agent_work_order_request_optional_fields():
    """Test CreateAgentWorkOrderRequest with optional fields"""
    request = CreateAgentWorkOrderRequest(
        repository_url="https://github.com/owner/repo",
        sandbox_type=SandboxType.GIT_BRANCH,
        user_request="Fix the login bug",
    )

    assert request.user_request == "Fix the login bug"
    assert request.github_issue_number is None
    assert request.selected_commands == ["create-branch", "planning", "execute", "commit", "create-pr"]


def test_create_agent_work_order_request_with_user_request():
    """Test CreateAgentWorkOrderRequest with user_request field"""
    request = CreateAgentWorkOrderRequest(
        repository_url="https://github.com/owner/repo",
        sandbox_type=SandboxType.GIT_BRANCH,
        user_request="Add user authentication with JWT tokens",
    )

    assert request.user_request == "Add user authentication with JWT tokens"
    assert request.repository_url == "https://github.com/owner/repo"
    assert request.github_issue_number is None
    assert request.selected_commands == ["create-branch", "planning", "execute", "commit", "create-pr"]


def test_create_agent_work_order_request_with_github_issue():
    """Test CreateAgentWorkOrderRequest with both user_request and issue number"""
    request = CreateAgentWorkOrderRequest(
        repository_url="https://github.com/owner/repo",
        sandbox_type=SandboxType.GIT_BRANCH,
        user_request="Implement the feature described in issue #42",
        github_issue_number="42",
    )

    assert request.user_request == "Implement the feature described in issue #42"
    assert request.github_issue_number == "42"
    assert request.selected_commands == ["create-branch", "planning", "execute", "commit", "create-pr"]


def test_workflow_step_enum():
    """Test WorkflowStep enum values"""
    assert WorkflowStep.CREATE_BRANCH.value == "create-branch"
    assert WorkflowStep.PLANNING.value == "planning"
    assert WorkflowStep.EXECUTE.value == "execute"
    assert WorkflowStep.COMMIT.value == "commit"
    assert WorkflowStep.CREATE_PR.value == "create-pr"
    assert WorkflowStep.REVIEW.value == "prp-review"


def test_step_execution_result_success():
    """Test creating successful StepExecutionResult"""
    result = StepExecutionResult(
        step=WorkflowStep.CREATE_BRANCH,
        agent_name="BranchCreator",
        success=True,
        output="feat/add-feature",
        duration_seconds=1.5,
        session_id="session-123",
    )

    assert result.step == WorkflowStep.CREATE_BRANCH
    assert result.agent_name == "BranchCreator"
    assert result.success is True
    assert result.output == "feat/add-feature"
    assert result.error_message is None
    assert result.duration_seconds == 1.5
    assert result.session_id == "session-123"
    assert isinstance(result.timestamp, datetime)


def test_step_execution_result_failure():
    """Test creating failed StepExecutionResult"""
    result = StepExecutionResult(
        step=WorkflowStep.PLANNING,
        agent_name="Planner",
        success=False,
        error_message="Planning failed: timeout",
        duration_seconds=30.0,
    )

    assert result.step == WorkflowStep.PLANNING
    assert result.agent_name == "Planner"
    assert result.success is False
    assert result.output is None
    assert result.error_message == "Planning failed: timeout"
    assert result.duration_seconds == 30.0
    assert result.session_id is None


def test_step_history_creation():
    """Test creating StepHistory"""
    history = StepHistory(agent_work_order_id="wo-test123", steps=[])

    assert history.agent_work_order_id == "wo-test123"
    assert len(history.steps) == 0


def test_step_history_with_steps():
    """Test StepHistory with multiple steps"""
    step1 = StepExecutionResult(
        step=WorkflowStep.CREATE_BRANCH,
        agent_name="BranchCreator",
        success=True,
        output="feat/add-feature",
        duration_seconds=1.0,
    )

    step2 = StepExecutionResult(
        step=WorkflowStep.PLANNING,
        agent_name="Planner",
        success=True,
        output="PRPs/features/add-feature.md",
        duration_seconds=5.0,
    )

    history = StepHistory(agent_work_order_id="wo-test123", steps=[step1, step2])

    assert history.agent_work_order_id == "wo-test123"
    assert len(history.steps) == 2
    assert history.steps[0].step == WorkflowStep.CREATE_BRANCH
    assert history.steps[1].step == WorkflowStep.PLANNING


def test_step_history_get_current_step_initial():
    """Test get_current_step returns CREATE_BRANCH when no steps"""
    history = StepHistory(agent_work_order_id="wo-test123", steps=[])

    assert history.get_current_step() == WorkflowStep.CREATE_BRANCH


def test_step_history_get_current_step_retry_failed():
    """Test get_current_step returns same step when failed"""
    failed_step = StepExecutionResult(
        step=WorkflowStep.PLANNING,
        agent_name="Planner",
        success=False,
        error_message="Planning failed",
        duration_seconds=5.0,
    )

    history = StepHistory(agent_work_order_id="wo-test123", steps=[failed_step])

    assert history.get_current_step() == WorkflowStep.PLANNING


def test_step_history_get_current_step_next():
    """Test get_current_step returns next step after success"""
    branch_step = StepExecutionResult(
        step=WorkflowStep.CREATE_BRANCH,
        agent_name="BranchCreator",
        success=True,
        output="feat/add-feature",
        duration_seconds=1.0,
    )

    history = StepHistory(agent_work_order_id="wo-test123", steps=[branch_step])

    assert history.get_current_step() == WorkflowStep.PLANNING


def test_command_execution_result_with_result_text():
    """Test CommandExecutionResult includes result_text field"""
    result = CommandExecutionResult(
        success=True,
        stdout='{"type":"result","result":"/feature"}',
        result_text="/feature",
        stderr=None,
        exit_code=0,
        session_id="session-123",
    )
    assert result.result_text == "/feature"
    assert result.stdout == '{"type":"result","result":"/feature"}'
    assert result.success is True


def test_command_execution_result_without_result_text():
    """Test CommandExecutionResult works without result_text (backward compatibility)"""
    result = CommandExecutionResult(
        success=True,
        stdout="raw output",
        stderr=None,
        exit_code=0,
    )
    assert result.result_text is None
    assert result.stdout == "raw output"
