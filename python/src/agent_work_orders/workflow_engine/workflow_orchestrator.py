"""Workflow Orchestrator

Main orchestration logic for workflow execution.
"""

import time

from ..agent_executor.agent_cli_executor import AgentCLIExecutor
from ..command_loader.claude_command_loader import ClaudeCommandLoader
from ..github_integration.github_client import GitHubClient
from ..models import (
    AgentWorkOrderStatus,
    SandboxType,
    StepHistory,
    WorkflowExecutionError,
)
from ..sandbox_manager.sandbox_factory import SandboxFactory
from ..state_manager.file_state_repository import FileStateRepository
from ..state_manager.work_order_repository import WorkOrderRepository
from ..utils.git_operations import get_commit_count, get_files_changed
from ..utils.id_generator import generate_sandbox_identifier
from ..utils.structured_logger import (
    bind_work_order_context,
    clear_work_order_context,
    get_logger,
)
from . import workflow_operations

logger = get_logger(__name__)


class WorkflowOrchestrator:
    """Orchestrates workflow execution"""

    def __init__(
        self,
        agent_executor: AgentCLIExecutor,
        sandbox_factory: SandboxFactory,
        github_client: GitHubClient,
        command_loader: ClaudeCommandLoader,
        state_repository: WorkOrderRepository | FileStateRepository,
    ):
        self.agent_executor = agent_executor
        self.sandbox_factory = sandbox_factory
        self.github_client = github_client
        self.command_loader = command_loader
        self.state_repository = state_repository
        self._logger = logger

    async def execute_workflow(
        self,
        agent_work_order_id: str,
        repository_url: str,
        sandbox_type: SandboxType,
        user_request: str,
        selected_commands: list[str] | None = None,
        github_issue_number: str | None = None,
    ) -> None:
        """Execute user-selected commands in sequence

        This runs in the background and updates state as it progresses.

        Args:
            agent_work_order_id: Work order ID
            repository_url: Git repository URL
            sandbox_type: Sandbox environment type
            user_request: User's description of the work to be done
            selected_commands: Commands to run in sequence (default: full workflow)
            github_issue_number: Optional GitHub issue number
        """
        # Default commands if not provided
        if selected_commands is None:
            selected_commands = ["create-branch", "planning", "execute", "prp-review", "commit", "create-pr"]

        # Bind work order context for structured logging
        bind_work_order_context(agent_work_order_id)

        bound_logger = self._logger.bind(
            agent_work_order_id=agent_work_order_id,
            sandbox_type=sandbox_type.value,
            selected_commands=selected_commands,
        )

        # Track workflow start time
        workflow_start_time = time.time()
        total_steps = len(selected_commands)

        bound_logger.info(
            "workflow_started",
            total_steps=total_steps,
            repository_url=repository_url,
        )

        # Initialize step history and context
        step_history = StepHistory(agent_work_order_id=agent_work_order_id)
        context = {
            "user_request": user_request,
            "github_issue_number": github_issue_number,
        }

        sandbox = None

        try:
            # Update status to RUNNING
            await self.state_repository.update_status(
                agent_work_order_id, AgentWorkOrderStatus.RUNNING
            )

            # Create sandbox
            bound_logger.info("sandbox_setup_started", repository_url=repository_url)
            sandbox_identifier = generate_sandbox_identifier(agent_work_order_id)
            sandbox = self.sandbox_factory.create_sandbox(
                sandbox_type, repository_url, sandbox_identifier
            )
            await sandbox.setup()
            bound_logger.info(
                "sandbox_setup_completed",
                sandbox_identifier=sandbox_identifier,
                working_dir=sandbox.working_dir,
            )

            # Command mapping
            command_map = {
                "create-branch": workflow_operations.run_create_branch_step,
                "planning": workflow_operations.run_planning_step,
                "execute": workflow_operations.run_execute_step,
                "commit": workflow_operations.run_commit_step,
                "create-pr": workflow_operations.run_create_pr_step,
                "prp-review": workflow_operations.run_review_step,
            }

            # Execute each command in sequence
            for index, command_name in enumerate(selected_commands):
                if command_name not in command_map:
                    raise WorkflowExecutionError(f"Unknown command: {command_name}")

                # Calculate progress
                step_number = index + 1
                progress_pct = int((step_number / total_steps) * 100)
                elapsed_seconds = int(time.time() - workflow_start_time)

                bound_logger.info(
                    "step_started",
                    step=command_name,
                    step_number=step_number,
                    total_steps=total_steps,
                    progress=f"{step_number}/{total_steps}",
                    progress_pct=progress_pct,
                    elapsed_seconds=elapsed_seconds,
                )

                command_func = command_map[command_name]

                # Execute command
                step_start_time = time.time()
                result = await command_func(
                    executor=self.agent_executor,
                    command_loader=self.command_loader,
                    work_order_id=agent_work_order_id,
                    working_dir=sandbox.working_dir,
                    context=context,
                )
                step_duration = time.time() - step_start_time

                # Save step result
                step_history.steps.append(result)
                await self.state_repository.save_step_history(
                    agent_work_order_id, step_history
                )

                # Log completion
                bound_logger.info(
                    "step_completed",
                    step=command_name,
                    step_number=step_number,
                    total_steps=total_steps,
                    success=result.success,
                    duration_seconds=round(step_duration, 2),
                )

                # STOP on failure
                if not result.success:
                    await self.state_repository.update_status(
                        agent_work_order_id,
                        AgentWorkOrderStatus.FAILED,
                        error_message=result.error_message,
                    )
                    raise WorkflowExecutionError(
                        f"Command '{command_name}' failed: {result.error_message}"
                    )

                # Store output in context for next command
                context[command_name] = result.output

                # Special handling for specific commands
                if command_name == "create-branch":
                    await self.state_repository.update_git_branch(
                        agent_work_order_id, result.output or ""
                    )
                elif command_name == "create-pr":
                    # Store PR URL for final metadata update
                    context["github_pull_request_url"] = result.output

            # Calculate git stats and mark as completed
            branch_name = context.get("create-branch")
            completion_metadata = {}

            if branch_name:
                git_stats = await self._calculate_git_stats(
                    branch_name, sandbox.working_dir
                )
                completion_metadata["git_commit_count"] = git_stats["commit_count"]
                completion_metadata["git_files_changed"] = git_stats["files_changed"]

            # Include PR URL if create-pr step was executed
            pr_url = context.get("github_pull_request_url")
            if pr_url:
                completion_metadata["github_pull_request_url"] = pr_url

            await self.state_repository.update_status(
                agent_work_order_id,
                AgentWorkOrderStatus.COMPLETED,
                **completion_metadata
            )

            # Save final step history
            await self.state_repository.save_step_history(agent_work_order_id, step_history)

            total_duration = time.time() - workflow_start_time
            bound_logger.info(
                "workflow_completed",
                total_steps=len(step_history.steps),
                total_duration_seconds=round(total_duration, 2),
            )

        except Exception as e:
            error_msg = str(e)
            total_duration = time.time() - workflow_start_time
            bound_logger.exception(
                "workflow_failed",
                error=error_msg,
                total_duration_seconds=round(total_duration, 2),
                completed_steps=len(step_history.steps),
                total_steps=total_steps,
            )

            # Save partial step history even on failure
            await self.state_repository.save_step_history(agent_work_order_id, step_history)

            await self.state_repository.update_status(
                agent_work_order_id,
                AgentWorkOrderStatus.FAILED,
                error_message=error_msg,
            )

        finally:
            # Cleanup sandbox
            if sandbox:
                try:
                    bound_logger.info("sandbox_cleanup_started")
                    await sandbox.cleanup()
                    bound_logger.info("sandbox_cleanup_completed")
                except Exception as cleanup_error:
                    bound_logger.exception(
                        "sandbox_cleanup_failed",
                        error=str(cleanup_error),
                    )

            # Clear work order context to prevent leakage
            clear_work_order_context()

    async def _calculate_git_stats(
        self, branch_name: str | None, repo_path: str
    ) -> dict[str, int]:
        """Calculate git statistics for a branch

        Args:
            branch_name: Name of the git branch
            repo_path: Path to the repository

        Returns:
            Dictionary with commit_count and files_changed
        """
        if not branch_name:
            return {"commit_count": 0, "files_changed": 0}

        try:
            # Calculate stats compared to main branch
            commit_count = await get_commit_count(branch_name, repo_path)
            files_changed = await get_files_changed(branch_name, repo_path, base_branch="main")

            return {
                "commit_count": commit_count,
                "files_changed": files_changed,
            }
        except Exception as e:
            logger.warning(
                "git_stats_calculation_failed",
                branch_name=branch_name,
                error=str(e),
            )
            return {"commit_count": 0, "files_changed": 0}
