"""PRD-Compliant Pydantic Models

All models follow exact naming from the PRD specification.
"""

from datetime import UTC, datetime
from enum import Enum

from pydantic import BaseModel, Field, field_validator


class AgentWorkOrderStatus(str, Enum):
    """Work order execution status"""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class AgentWorkflowType(str, Enum):
    """Workflow types for agent execution"""

    PLAN = "agent_workflow_plan"


class SandboxType(str, Enum):
    """Sandbox environment types"""

    GIT_BRANCH = "git_branch"
    GIT_WORKTREE = "git_worktree"  # Fully implemented - recommended for concurrent execution
    E2B = "e2b"  # Placeholder for Phase 2+
    DAGGER = "dagger"  # Placeholder for Phase 2+


class AgentWorkflowPhase(str, Enum):
    """Workflow execution phases"""

    PLANNING = "planning"
    COMPLETED = "completed"


class WorkflowStep(str, Enum):
    """User-selectable workflow commands"""

    CREATE_BRANCH = "create-branch"
    PLANNING = "planning"
    EXECUTE = "execute"
    COMMIT = "commit"
    CREATE_PR = "create-pr"
    REVIEW = "prp-review"


class AgentWorkOrderState(BaseModel):
    """Minimal state model (5 core fields)

    This represents the minimal persistent state stored in the database.
    All other fields are computed from git or metadata.
    """

    agent_work_order_id: str = Field(..., description="Unique work order identifier")
    repository_url: str = Field(..., description="Git repository URL")
    sandbox_identifier: str = Field(..., description="Sandbox identifier")
    git_branch_name: str | None = Field(None, description="Git branch created by agent")
    agent_session_id: str | None = Field(None, description="Claude CLI session ID")


class AgentWorkOrder(BaseModel):
    """Complete agent work order model

    Combines core state with metadata and computed fields from git.
    """

    # Core fields (from AgentWorkOrderState)
    agent_work_order_id: str
    repository_url: str
    sandbox_identifier: str
    git_branch_name: str | None = None
    agent_session_id: str | None = None

    # Metadata fields
    sandbox_type: SandboxType
    github_issue_number: str | None = None
    status: AgentWorkOrderStatus
    current_phase: AgentWorkflowPhase | None = None
    created_at: datetime
    updated_at: datetime

    # Computed fields (from git inspection)
    github_pull_request_url: str | None = None
    git_commit_count: int = 0
    git_files_changed: int = 0
    error_message: str | None = None


class CreateAgentWorkOrderRequest(BaseModel):
    """Request to create a new agent work order

    The user_request field is the primary input describing the work to be done.
    If a GitHub issue reference is mentioned (e.g., "issue #42"), the system will
    automatically detect and fetch the issue details.
    """

    repository_url: str = Field(..., description="Git repository URL")
    sandbox_type: SandboxType = Field(
        default=SandboxType.GIT_WORKTREE,
        description="Sandbox environment type (defaults to git_worktree for efficient concurrent execution)"
    )
    user_request: str = Field(..., description="User's description of the work to be done")
    selected_commands: list[str] = Field(
        default=["create-branch", "planning", "execute", "commit", "create-pr"],
        description="Commands to run in sequence"
    )
    github_issue_number: str | None = Field(None, description="Optional explicit GitHub issue number for reference")

    @field_validator('selected_commands')
    @classmethod
    def validate_commands(cls, v: list[str]) -> list[str]:
        """Validate that all commands are valid WorkflowStep values"""
        valid = {step.value for step in WorkflowStep}
        for cmd in v:
            if cmd not in valid:
                raise ValueError(f"Invalid command: {cmd}. Must be one of {valid}")
        return v


class AgentWorkOrderResponse(BaseModel):
    """Response after creating an agent work order"""

    agent_work_order_id: str
    status: AgentWorkOrderStatus
    message: str


class AgentPromptRequest(BaseModel):
    """Request to send a prompt to a running agent"""

    agent_work_order_id: str
    prompt_text: str


class GitProgressSnapshot(BaseModel):
    """Git progress information for UI display"""

    agent_work_order_id: str
    current_phase: AgentWorkflowPhase
    git_commit_count: int
    git_files_changed: int
    latest_commit_message: str | None = None
    git_branch_name: str | None = None


class GitHubRepositoryVerificationRequest(BaseModel):
    """Request to verify GitHub repository access"""

    repository_url: str


class GitHubRepositoryVerificationResponse(BaseModel):
    """Response from repository verification"""

    is_accessible: bool
    repository_name: str | None = None
    repository_owner: str | None = None
    default_branch: str | None = None
    error_message: str | None = None


class GitHubRepository(BaseModel):
    """GitHub repository information"""

    name: str
    owner: str
    default_branch: str
    url: str


class ConfiguredRepository(BaseModel):
    """Configured repository with metadata and preferences

    Stores GitHub repository configuration for Agent Work Orders, including
    verification status, metadata extracted from GitHub API, and per-repository
    preferences for sandbox type and workflow commands.
    """

    id: str = Field(..., description="Unique UUID identifier for the configured repository")
    repository_url: str = Field(..., description="GitHub repository URL (https://github.com/owner/repo format)")
    display_name: str | None = Field(None, description="Human-readable repository name (e.g., 'owner/repo-name')")
    owner: str | None = Field(None, description="Repository owner/organization name")
    default_branch: str | None = Field(None, description="Default branch name (e.g., 'main' or 'master')")
    is_verified: bool = Field(default=False, description="Boolean flag indicating if repository access has been verified")
    last_verified_at: datetime | None = Field(None, description="Timestamp of last successful repository verification")
    default_sandbox_type: SandboxType = Field(
        default=SandboxType.GIT_WORKTREE,
        description="Default sandbox type for work orders: git_worktree (default), full_clone, or tmp_dir"
    )
    default_commands: list[WorkflowStep] = Field(
        default=[
            WorkflowStep.CREATE_BRANCH,
            WorkflowStep.PLANNING,
            WorkflowStep.EXECUTE,
            WorkflowStep.COMMIT,
            WorkflowStep.CREATE_PR,
        ],
        description="Default workflow commands for work orders"
    )
    created_at: datetime = Field(..., description="Timestamp when repository configuration was created")
    updated_at: datetime = Field(..., description="Timestamp when repository configuration was last updated")


class CreateRepositoryRequest(BaseModel):
    """Request to create a new configured repository

    Creates a new repository configuration. If verify=True, the system will
    call the GitHub API to validate repository access and extract metadata
    (display_name, owner, default_branch) before storing.
    """

    repository_url: str = Field(..., description="GitHub repository URL to configure")
    verify: bool = Field(
        default=True,
        description="Whether to verify repository access via GitHub API and extract metadata"
    )


class UpdateRepositoryRequest(BaseModel):
    """Request to update an existing configured repository

    All fields are optional for partial updates. Only provided fields will be
    updated in the database.
    """

    default_sandbox_type: SandboxType | None = Field(
        None,
        description="Update the default sandbox type for this repository"
    )
    default_commands: list[WorkflowStep] | None = Field(
        None,
        description="Update the default workflow commands for this repository"
    )


class GitHubPullRequest(BaseModel):
    """GitHub pull request information"""

    pull_request_url: str
    pull_request_number: int
    title: str
    head_branch: str
    base_branch: str


class GitHubIssue(BaseModel):
    """GitHub issue information"""

    number: int
    title: str
    body: str | None = None
    state: str
    html_url: str


class CommandExecutionResult(BaseModel):
    """Result from command execution"""

    success: bool
    stdout: str | None = None
    # Extracted result text from JSONL "result" field (if available)
    result_text: str | None = None
    stderr: str | None = None
    exit_code: int
    session_id: str | None = None
    error_message: str | None = None
    duration_seconds: float | None = None


class StepExecutionResult(BaseModel):
    """Result of executing a single workflow step"""

    step: WorkflowStep
    agent_name: str
    success: bool
    output: str | None = None
    error_message: str | None = None
    duration_seconds: float
    session_id: str | None = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))


class StepHistory(BaseModel):
    """History of all step executions for a work order"""

    agent_work_order_id: str
    steps: list[StepExecutionResult] = []

    def get_current_step(self) -> WorkflowStep | None:
        """Get next step to execute"""
        if not self.steps:
            return WorkflowStep.CREATE_BRANCH

        last_step = self.steps[-1]
        if not last_step.success:
            return last_step.step  # Retry failed step

        step_sequence = [
            WorkflowStep.CREATE_BRANCH,
            WorkflowStep.PLANNING,
            WorkflowStep.EXECUTE,
            WorkflowStep.COMMIT,
            WorkflowStep.CREATE_PR,
        ]

        try:
            current_index = step_sequence.index(last_step.step)
            if current_index < len(step_sequence) - 1:
                return step_sequence[current_index + 1]
        except ValueError:
            pass

        return None  # All steps complete


class CommandNotFoundError(Exception):
    """Raised when a command file is not found"""

    pass


class WorkflowExecutionError(Exception):
    """Raised when workflow execution fails"""

    pass


class SandboxSetupError(Exception):
    """Raised when sandbox setup fails"""

    pass


class GitHubOperationError(Exception):
    """Raised when GitHub operation fails"""

    pass
