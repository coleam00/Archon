"""Workflow Operations

Command execution functions for user-selectable workflow.
Each function loads and executes a command file.
"""

import time

from ..agent_executor.agent_cli_executor import AgentCLIExecutor
from ..command_loader.claude_command_loader import ClaudeCommandLoader
from ..models import StepExecutionResult, WorkflowStep
from ..utils.structured_logger import get_logger
from .agent_names import (
    BRANCH_CREATOR,
    COMMITTER,
    IMPLEMENTOR,
    PLANNER,
    PR_CREATOR,
    REVIEWER,
)

logger = get_logger(__name__)


async def run_create_branch_step(
    executor: AgentCLIExecutor,
    command_loader: ClaudeCommandLoader,
    work_order_id: str,
    working_dir: str,
    context: dict,
) -> StepExecutionResult:
    """Execute create-branch.md command

    Creates git branch based on user request.

    Args:
        executor: CLI executor for running claude commands
        command_loader: Loads command files
        work_order_id: Work order ID for logging
        working_dir: Directory to run command in
        context: Shared context with user_request

    Returns:
        StepExecutionResult with branch_name in output
    """
    start_time = time.time()

    try:
        command_file = command_loader.load_command("create-branch")

        # Get user request from context
        user_request = context.get("user_request", "")

        cli_command, prompt_text = executor.build_command(
            command_file, args=[user_request]
        )

        result = await executor.execute_async(
            cli_command, working_dir,
            prompt_text=prompt_text,
            work_order_id=work_order_id
        )

        duration = time.time() - start_time

        if result.success and result.result_text:
            branch_name = result.result_text.strip()
            return StepExecutionResult(
                step=WorkflowStep.CREATE_BRANCH,
                agent_name=BRANCH_CREATOR,
                success=True,
                output=branch_name,
                duration_seconds=duration,
                session_id=result.session_id,
            )
        else:
            return StepExecutionResult(
                step=WorkflowStep.CREATE_BRANCH,
                agent_name=BRANCH_CREATOR,
                success=False,
                error_message=result.error_message or "Branch creation failed",
                duration_seconds=duration,
            )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("create_branch_step_error", error=str(e), exc_info=True)
        return StepExecutionResult(
            step=WorkflowStep.CREATE_BRANCH,
            agent_name=BRANCH_CREATOR,
            success=False,
            error_message=str(e),
            duration_seconds=duration,
        )


async def run_planning_step(
    executor: AgentCLIExecutor,
    command_loader: ClaudeCommandLoader,
    work_order_id: str,
    working_dir: str,
    context: dict,
) -> StepExecutionResult:
    """Execute planning.md command

    Creates PRP file based on user request.

    Args:
        executor: CLI executor for running claude commands
        command_loader: Loads command files
        work_order_id: Work order ID for logging
        working_dir: Directory to run command in
        context: Shared context with user_request and optional github_issue_number

    Returns:
        StepExecutionResult with plan_file path in output
    """
    start_time = time.time()

    try:
        command_file = command_loader.load_command("planning")

        # Get args from context
        user_request = context.get("user_request", "")
        github_issue_number = context.get("github_issue_number") or ""

        cli_command, prompt_text = executor.build_command(
            command_file, args=[user_request, github_issue_number]
        )

        result = await executor.execute_async(
            cli_command, working_dir,
            prompt_text=prompt_text,
            work_order_id=work_order_id
        )

        duration = time.time() - start_time

        if result.success and result.result_text:
            plan_file = result.result_text.strip()
            return StepExecutionResult(
                step=WorkflowStep.PLANNING,
                agent_name=PLANNER,
                success=True,
                output=plan_file,
                duration_seconds=duration,
                session_id=result.session_id,
            )
        else:
            return StepExecutionResult(
                step=WorkflowStep.PLANNING,
                agent_name=PLANNER,
                success=False,
                error_message=result.error_message or "Planning failed",
                duration_seconds=duration,
            )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("planning_step_error", error=str(e), exc_info=True)
        return StepExecutionResult(
            step=WorkflowStep.PLANNING,
            agent_name=PLANNER,
            success=False,
            error_message=str(e),
            duration_seconds=duration,
        )


async def run_execute_step(
    executor: AgentCLIExecutor,
    command_loader: ClaudeCommandLoader,
    work_order_id: str,
    working_dir: str,
    context: dict,
) -> StepExecutionResult:
    """Execute execute.md command

    Implements the PRP plan.

    Args:
        executor: CLI executor for running claude commands
        command_loader: Loads command files
        work_order_id: Work order ID for logging
        working_dir: Directory to run command in
        context: Shared context with plan_file from planning step

    Returns:
        StepExecutionResult with implementation summary in output
    """
    start_time = time.time()

    try:
        command_file = command_loader.load_command("execute")

        # Get plan file from context (output of planning step)
        plan_file = context.get("planning", "")
        if not plan_file:
            raise ValueError("No plan file found in context. Planning step must run before execute.")

        cli_command, prompt_text = executor.build_command(
            command_file, args=[plan_file]
        )

        result = await executor.execute_async(
            cli_command, working_dir,
            prompt_text=prompt_text,
            work_order_id=work_order_id
        )

        duration = time.time() - start_time

        if result.success:
            implementation_summary = result.result_text or result.stdout or "Implementation completed"
            return StepExecutionResult(
                step=WorkflowStep.EXECUTE,
                agent_name=IMPLEMENTOR,
                success=True,
                output=implementation_summary,
                duration_seconds=duration,
                session_id=result.session_id,
            )
        else:
            return StepExecutionResult(
                step=WorkflowStep.EXECUTE,
                agent_name=IMPLEMENTOR,
                success=False,
                error_message=result.error_message or "Implementation failed",
                duration_seconds=duration,
            )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("execute_step_error", error=str(e), exc_info=True)
        return StepExecutionResult(
            step=WorkflowStep.EXECUTE,
            agent_name=IMPLEMENTOR,
            success=False,
            error_message=str(e),
            duration_seconds=duration,
        )


async def run_commit_step(
    executor: AgentCLIExecutor,
    command_loader: ClaudeCommandLoader,
    work_order_id: str,
    working_dir: str,
    context: dict,
) -> StepExecutionResult:
    """Execute commit.md command

    Commits changes and pushes to remote.

    Args:
        executor: CLI executor for running claude commands
        command_loader: Loads command files
        work_order_id: Work order ID for logging
        working_dir: Directory to run command in
        context: Shared context (no specific args needed)

    Returns:
        StepExecutionResult with commit_hash and branch_name in output
    """
    start_time = time.time()

    try:
        command_file = command_loader.load_command("commit")

        # Commit command doesn't need args (commits all changes)
        cli_command, prompt_text = executor.build_command(
            command_file, args=[]
        )

        result = await executor.execute_async(
            cli_command, working_dir,
            prompt_text=prompt_text,
            work_order_id=work_order_id
        )

        duration = time.time() - start_time

        if result.success and result.result_text:
            commit_info = result.result_text.strip()
            return StepExecutionResult(
                step=WorkflowStep.COMMIT,
                agent_name=COMMITTER,
                success=True,
                output=commit_info,
                duration_seconds=duration,
                session_id=result.session_id,
            )
        else:
            return StepExecutionResult(
                step=WorkflowStep.COMMIT,
                agent_name=COMMITTER,
                success=False,
                error_message=result.error_message or "Commit failed",
                duration_seconds=duration,
            )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("commit_step_error", error=str(e), exc_info=True)
        return StepExecutionResult(
            step=WorkflowStep.COMMIT,
            agent_name=COMMITTER,
            success=False,
            error_message=str(e),
            duration_seconds=duration,
        )


async def run_create_pr_step(
    executor: AgentCLIExecutor,
    command_loader: ClaudeCommandLoader,
    work_order_id: str,
    working_dir: str,
    context: dict,
) -> StepExecutionResult:
    """Execute create-pr.md command

    Creates GitHub pull request.

    Args:
        executor: CLI executor for running claude commands
        command_loader: Loads command files
        work_order_id: Work order ID for logging
        working_dir: Directory to run command in
        context: Shared context with branch_name and optional plan_file

    Returns:
        StepExecutionResult with pr_url in output
    """
    start_time = time.time()

    try:
        command_file = command_loader.load_command("create-pr")

        # Get args from context
        branch_name = context.get("create-branch", "")
        plan_file = context.get("planning", "")

        if not branch_name:
            raise ValueError("No branch name found in context. create-branch step must run before create-pr.")

        cli_command, prompt_text = executor.build_command(
            command_file, args=[branch_name, plan_file]
        )

        result = await executor.execute_async(
            cli_command, working_dir,
            prompt_text=prompt_text,
            work_order_id=work_order_id
        )

        duration = time.time() - start_time

        if result.success and result.result_text:
            pr_url = result.result_text.strip()
            return StepExecutionResult(
                step=WorkflowStep.CREATE_PR,
                agent_name=PR_CREATOR,
                success=True,
                output=pr_url,
                duration_seconds=duration,
                session_id=result.session_id,
            )
        else:
            return StepExecutionResult(
                step=WorkflowStep.CREATE_PR,
                agent_name=PR_CREATOR,
                success=False,
                error_message=result.error_message or "PR creation failed",
                duration_seconds=duration,
            )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("create_pr_step_error", error=str(e), exc_info=True)
        return StepExecutionResult(
            step=WorkflowStep.CREATE_PR,
            agent_name=PR_CREATOR,
            success=False,
            error_message=str(e),
            duration_seconds=duration,
        )


async def run_review_step(
    executor: AgentCLIExecutor,
    command_loader: ClaudeCommandLoader,
    work_order_id: str,
    working_dir: str,
    context: dict,
) -> StepExecutionResult:
    """Execute prp-review.md command

    Reviews implementation against PRP specification.

    Args:
        executor: CLI executor for running claude commands
        command_loader: Loads command files
        work_order_id: Work order ID for logging
        working_dir: Directory to run command in
        context: Shared context with plan_file from planning step

    Returns:
        StepExecutionResult with review JSON in output
    """
    start_time = time.time()

    try:
        command_file = command_loader.load_command("prp-review")

        # Get plan file from context
        plan_file = context.get("planning", "")
        if not plan_file:
            raise ValueError("No plan file found in context. Planning step must run before review.")

        cli_command, prompt_text = executor.build_command(
            command_file, args=[plan_file]
        )

        result = await executor.execute_async(
            cli_command, working_dir,
            prompt_text=prompt_text,
            work_order_id=work_order_id
        )

        duration = time.time() - start_time

        if result.success:
            review_output = result.result_text or "Review completed"
            return StepExecutionResult(
                step=WorkflowStep.REVIEW,
                agent_name=REVIEWER,
                success=True,
                output=review_output,
                duration_seconds=duration,
                session_id=result.session_id,
            )
        else:
            return StepExecutionResult(
                step=WorkflowStep.REVIEW,
                agent_name=REVIEWER,
                success=False,
                error_message=result.error_message or "Review failed",
                duration_seconds=duration,
            )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("review_step_error", error=str(e), exc_info=True)
        return StepExecutionResult(
            step=WorkflowStep.REVIEW,
            agent_name=REVIEWER,
            success=False,
            error_message=str(e),
            duration_seconds=duration,
        )
