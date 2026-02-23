"""API Routes

FastAPI routes for agent work orders.
"""

import asyncio
from collections.abc import Callable
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sse_starlette.sse import EventSourceResponse

from ..agent_executor.agent_cli_executor import AgentCLIExecutor
from ..command_loader.claude_command_loader import ClaudeCommandLoader
from ..github_integration.github_client import GitHubClient
from ..models import (
    AgentPromptRequest,
    AgentWorkflowPhase,
    AgentWorkOrder,
    AgentWorkOrderResponse,
    AgentWorkOrderState,
    AgentWorkOrderStatus,
    ConfiguredRepository,
    CreateAgentWorkOrderRequest,
    CreateRepositoryRequest,
    GitHubRepositoryVerificationRequest,
    GitHubRepositoryVerificationResponse,
    GitProgressSnapshot,
    StepHistory,
    UpdateRepositoryRequest,
)
from ..sandbox_manager.sandbox_factory import SandboxFactory
from ..state_manager.repository_config_repository import RepositoryConfigRepository
from ..state_manager.repository_factory import create_repository
from ..utils.id_generator import generate_work_order_id
from ..utils.log_buffer import WorkOrderLogBuffer
from ..utils.structured_logger import get_logger
from ..workflow_engine.workflow_orchestrator import WorkflowOrchestrator
from .sse_streams import stream_work_order_logs

logger = get_logger(__name__)
router = APIRouter()

# Registry to track background workflow tasks by work order ID
# Enables monitoring, exception tracking, and cleanup
_workflow_tasks: dict[str, asyncio.Task] = {}


def _create_task_done_callback(agent_work_order_id: str) -> Callable[[asyncio.Task], None]:
    """Create a done callback for workflow tasks
    
    Logs exceptions, updates work order status, and removes task from registry.
    Note: This callback is synchronous but schedules async operations for status updates.
    
    Args:
        agent_work_order_id: Work order ID to track
    """
    def on_task_done(task: asyncio.Task) -> None:
        """Callback invoked when workflow task completes
        
        Inspects task.exception() to determine if workflow succeeded or failed,
        logs appropriately, and updates work order status.
        """
        try:
            # Check if task raised an exception
            exception = task.exception()

            if exception is None:
                # Task completed successfully
                logger.info(
                    "workflow_task_completed",
                    agent_work_order_id=agent_work_order_id,
                    status="completed",
                )
                # Note: Orchestrator handles updating status to COMPLETED
                # so we don't need to update it here
            else:
                # Task failed with an exception
                # Log full exception details with context
                logger.exception(
                    "workflow_task_failed",
                    agent_work_order_id=agent_work_order_id,
                    status="failed",
                    exception_type=type(exception).__name__,
                    exception_message=str(exception),
                    exc_info=True,
                )

                # Schedule async operation to update work order status if needed
                # (execute_workflow_with_error_handling may have already done this)
                async def update_status_if_needed() -> None:
                    try:
                        result = await state_repository.get(agent_work_order_id)
                        if result:
                            _, metadata = result
                            current_status = metadata.get("status")
                            if current_status != AgentWorkOrderStatus.FAILED:
                                error_msg = f"Workflow task failed: {str(exception)}"
                                await state_repository.update_status(
                                    agent_work_order_id,
                                    AgentWorkOrderStatus.FAILED,
                                    error_message=error_msg,
                                )
                                logger.info(
                                    "workflow_status_updated_to_failed",
                                    agent_work_order_id=agent_work_order_id,
                                )
                    except Exception as update_error:
                        # Log but don't raise - task is already failed
                        logger.error(
                            "workflow_status_update_failed_in_callback",
                            agent_work_order_id=agent_work_order_id,
                            update_error=str(update_error),
                            original_exception=str(exception),
                            exc_info=True,
                        )

                # Schedule the async status update
                asyncio.create_task(update_status_if_needed())
        finally:
            # Always remove task from registry when done (success or failure)
            _workflow_tasks.pop(agent_work_order_id, None)
            logger.debug(
                "workflow_task_removed_from_registry",
                agent_work_order_id=agent_work_order_id,
            )

    return on_task_done


# Initialize dependencies (singletons for MVP)
state_repository = create_repository()
repository_config_repo = RepositoryConfigRepository()
agent_executor = AgentCLIExecutor()
sandbox_factory = SandboxFactory()
github_client = GitHubClient()
command_loader = ClaudeCommandLoader()
log_buffer = WorkOrderLogBuffer()
orchestrator = WorkflowOrchestrator(
    agent_executor=agent_executor,
    sandbox_factory=sandbox_factory,
    github_client=github_client,
    command_loader=command_loader,
    state_repository=state_repository,
)


@router.post("/", status_code=201)
async def create_agent_work_order(
    request: CreateAgentWorkOrderRequest,
) -> AgentWorkOrderResponse:
    """Create a new agent work order

    Creates a work order and starts workflow execution in the background.
    """
    logger.info(
        "agent_work_order_creation_started",
        repository_url=request.repository_url,
        sandbox_type=request.sandbox_type.value,
        selected_commands=request.selected_commands,
    )

    try:
        # Generate ID
        agent_work_order_id = generate_work_order_id()

        # Create state
        state = AgentWorkOrderState(
            agent_work_order_id=agent_work_order_id,
            repository_url=request.repository_url,
            sandbox_identifier=f"sandbox-{agent_work_order_id}",
            git_branch_name=None,
            agent_session_id=None,
        )

        # Create metadata
        metadata = {
            "sandbox_type": request.sandbox_type,
            "github_issue_number": request.github_issue_number,
            "status": AgentWorkOrderStatus.PENDING,
            "current_phase": None,
            "created_at": datetime.now(),
            "updated_at": datetime.now(),
            "github_pull_request_url": None,
            "git_commit_count": 0,
            "git_files_changed": 0,
            "error_message": None,
        }

        # Save to repository
        await state_repository.create(state, metadata)

        # Wrapper function to handle exceptions from workflow execution
        async def execute_workflow_with_error_handling() -> None:
            """Execute workflow and handle any unhandled exceptions
            
            Broad exception handler ensures all exceptions are caught and logged,
            with full context for debugging. Status is updated to FAILED on errors.
            """
            try:
                await orchestrator.execute_workflow(
                agent_work_order_id=agent_work_order_id,
                repository_url=request.repository_url,
                sandbox_type=request.sandbox_type,
                user_request=request.user_request,
                selected_commands=request.selected_commands,
                github_issue_number=request.github_issue_number,
            )
            except Exception as e:
                # Catch any exceptions that weren't handled by the orchestrator
                # (e.g., exceptions during initialization, argument validation, etc.)
                error_msg = str(e)
                logger.exception(
                    "workflow_execution_unhandled_exception",
                    agent_work_order_id=agent_work_order_id,
                    error=error_msg,
                    exception_type=type(e).__name__,
                    exc_info=True,
                )
                try:
                    # Update work order status to FAILED
                    await state_repository.update_status(
                        agent_work_order_id,
                        AgentWorkOrderStatus.FAILED,
                        error_message=f"Workflow execution failed before orchestrator could handle it: {error_msg}",
                    )
                except Exception as update_error:
                    # Log but don't raise - we've already caught the original error
                    logger.error(
                        "workflow_status_update_failed_after_exception",
                        agent_work_order_id=agent_work_order_id,
                        update_error=str(update_error),
                        original_error=error_msg,
                        exc_info=True,
                    )
                # Re-raise to ensure task.exception() returns the exception
                raise

        # Create and track background workflow task
        task = asyncio.create_task(execute_workflow_with_error_handling())
        _workflow_tasks[agent_work_order_id] = task

        # Attach done callback to log exceptions and update status
        task.add_done_callback(_create_task_done_callback(agent_work_order_id))

        logger.debug(
            "workflow_task_created_and_tracked",
            agent_work_order_id=agent_work_order_id,
            task_count=len(_workflow_tasks),
        )

        logger.info(
            "agent_work_order_created",
            agent_work_order_id=agent_work_order_id,
        )

        return AgentWorkOrderResponse(
            agent_work_order_id=agent_work_order_id,
            status=AgentWorkOrderStatus.PENDING,
            message="Agent work order created and workflow execution started",
        )

    except Exception as e:
        logger.error("agent_work_order_creation_failed", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create work order: {e}") from e


# =====================================================
# Repository Configuration Endpoints
# NOTE: These MUST come before the catch-all /{agent_work_order_id} route
# =====================================================


@router.get("/repositories")
async def list_configured_repositories() -> list[ConfiguredRepository]:
    """List all configured repositories

    Returns list of all configured repositories ordered by created_at DESC.
    Each repository includes metadata, verification status, and preferences.
    """
    logger.info("repository_list_started")

    try:
        repositories = await repository_config_repo.list_repositories()

        logger.info(
            "repository_list_completed",
            count=len(repositories)
        )

        return repositories

    except Exception as e:
        logger.exception(
            "repository_list_failed",
            error=str(e)
        )
        raise HTTPException(status_code=500, detail=f"Failed to list repositories: {e}") from e


@router.post("/repositories", status_code=201)
async def create_configured_repository(
    request: CreateRepositoryRequest,
) -> ConfiguredRepository:
    """Create a new configured repository

    If verify=True (default), validates repository access via GitHub API
    and extracts metadata (display_name, owner, default_branch).
    """
    logger.info(
        "repository_creation_started",
        repository_url=request.repository_url,
        verify=request.verify
    )

    try:
        # Initialize metadata variables
        display_name: str | None = None
        owner: str | None = None
        default_branch: str | None = None
        is_verified = False

        # Verify repository and extract metadata if requested
        if request.verify:
            try:
                is_accessible = await github_client.verify_repository_access(request.repository_url)

                if is_accessible:
                    repo_info = await github_client.get_repository_info(request.repository_url)
                    display_name = repo_info.name
                    owner = repo_info.owner
                    default_branch = repo_info.default_branch
                    is_verified = True
                    logger.info(
                        "repository_verified",
                        repository_url=request.repository_url,
                        display_name=display_name
                    )
                else:
                    logger.warning(
                        "repository_verification_failed",
                        repository_url=request.repository_url
                    )
                    raise HTTPException(
                        status_code=400,
                        detail="Repository not accessible or not found"
                    )
            except HTTPException:
                raise
            except Exception as github_error:
                logger.error(
                    "github_api_error_during_verification",
                    repository_url=request.repository_url,
                    error=str(github_error),
                    exc_info=True
                )
                raise HTTPException(
                    status_code=502,
                    detail=f"GitHub API error during repository verification: {str(github_error)}"
                ) from github_error

        # Create repository in database
        repository = await repository_config_repo.create_repository(
            repository_url=request.repository_url,
            display_name=display_name,
            owner=owner,
            default_branch=default_branch,
            is_verified=is_verified,
        )

        logger.info(
            "repository_created",
            repository_id=repository.id,
            repository_url=request.repository_url
        )

        return repository

    except HTTPException:
        raise
    except ValueError as e:
        # Validation errors (e.g., invalid enum values from database)
        logger.error(
            "repository_validation_error",
            repository_url=request.repository_url,
            error=str(e),
            exc_info=True
        )
        raise HTTPException(status_code=422, detail=f"Validation error: {str(e)}") from e
    except Exception as e:
        # Check for unique constraint violation (duplicate repository_url)
        error_message = str(e).lower()
        if "unique" in error_message or "duplicate" in error_message:
            logger.error(
                "repository_url_already_exists",
                repository_url=request.repository_url,
                error=str(e)
            )
            raise HTTPException(
                status_code=409,
                detail=f"Repository URL already configured: {request.repository_url}"
            ) from e

        # All other database/unexpected errors
        logger.exception(
            "repository_creation_unexpected_error",
            repository_url=request.repository_url,
            error=str(e)
        )
        # For beta: expose detailed error for debugging (as per CLAUDE.md principles)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create repository: {str(e)}"
        ) from e


@router.patch("/repositories/{repository_id}")
async def update_configured_repository(
    repository_id: str,
    request: UpdateRepositoryRequest,
) -> ConfiguredRepository:
    """Update an existing configured repository

    Supports partial updates - only provided fields will be updated.
    Returns 404 if repository not found.
    """
    logger.info(
        "repository_update_started",
        repository_id=repository_id
    )

    try:
        # Build updates dict from non-None fields
        updates: dict[str, Any] = {}
        if request.default_sandbox_type is not None:
            updates["default_sandbox_type"] = request.default_sandbox_type
        if request.default_commands is not None:
            updates["default_commands"] = request.default_commands

        # Update repository
        repository = await repository_config_repo.update_repository(repository_id, **updates)

        if repository is None:
            logger.warning(
                "repository_not_found_for_update",
                repository_id=repository_id
            )
            raise HTTPException(status_code=404, detail="Repository not found")

        logger.info(
            "repository_updated",
            repository_id=repository_id,
            updated_fields=list(updates.keys())
        )

        return repository

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "repository_update_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(status_code=500, detail=f"Failed to update repository: {e}") from e


@router.delete("/repositories/{repository_id}", status_code=204)
async def delete_configured_repository(repository_id: str) -> None:
    """Delete a configured repository

    Returns 204 No Content on success, 404 if repository not found.
    """
    logger.info(
        "repository_deletion_started",
        repository_id=repository_id
    )

    try:
        deleted = await repository_config_repo.delete_repository(repository_id)

        if not deleted:
            logger.warning(
                "repository_not_found_for_delete",
                repository_id=repository_id
            )
            raise HTTPException(status_code=404, detail="Repository not found")

        logger.info(
            "repository_deleted",
            repository_id=repository_id
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "repository_deletion_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(status_code=500, detail=f"Failed to delete repository: {e}") from e


@router.post("/repositories/{repository_id}/verify")
async def verify_repository_access(repository_id: str) -> dict[str, bool | str]:
    """Re-verify repository access and update metadata

    Calls GitHub API to verify current access and updates repository
    metadata if accessible (display_name, owner, default_branch, is_verified, last_verified_at).
    Returns verification result with is_accessible boolean.
    """
    logger.info(
        "repository_verification_started",
        repository_id=repository_id
    )

    try:
        # Fetch repository from database
        repository = await repository_config_repo.get_repository(repository_id)

        if repository is None:
            logger.warning(
                "repository_not_found_for_verification",
                repository_id=repository_id
            )
            raise HTTPException(status_code=404, detail="Repository not found")

        # Verify repository access
        is_accessible = await github_client.verify_repository_access(repository.repository_url)

        if is_accessible:
            # Fetch updated metadata
            repo_info = await github_client.get_repository_info(repository.repository_url)

            # Update repository with new metadata
            await repository_config_repo.update_repository(
                repository_id,
                display_name=repo_info.name,
                owner=repo_info.owner,
                default_branch=repo_info.default_branch,
                is_verified=True,
                last_verified_at=datetime.now(),
            )

            logger.info(
                "repository_verification_success",
                repository_id=repository_id,
                repository_url=repository.repository_url
            )
        else:
            # Update verification status to false
            await repository_config_repo.update_repository(
                repository_id,
                is_verified=False,
            )

            logger.warning(
                "repository_verification_not_accessible",
                repository_id=repository_id,
                repository_url=repository.repository_url
            )

        return {
            "is_accessible": is_accessible,
            "repository_id": repository_id,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "repository_verification_failed",
            repository_id=repository_id,
            error=str(e)
        )
        raise HTTPException(status_code=500, detail=f"Failed to verify repository: {e}") from e


@router.get("/{agent_work_order_id}")
async def get_agent_work_order(agent_work_order_id: str) -> AgentWorkOrder:
    """Get agent work order by ID"""
    logger.info("agent_work_order_get_started", agent_work_order_id=agent_work_order_id)

    try:
        result = await state_repository.get(agent_work_order_id)
        if not result:
            raise HTTPException(status_code=404, detail="Work order not found")

        state, metadata = result

        # Build full model
        work_order = AgentWorkOrder(
            agent_work_order_id=state.agent_work_order_id,
            repository_url=state.repository_url,
            sandbox_identifier=state.sandbox_identifier,
            git_branch_name=state.git_branch_name,
            agent_session_id=state.agent_session_id,
            sandbox_type=metadata["sandbox_type"],
            github_issue_number=metadata["github_issue_number"],
            status=metadata["status"],
            current_phase=metadata["current_phase"],
            created_at=metadata["created_at"],
            updated_at=metadata["updated_at"],
            github_pull_request_url=metadata.get("github_pull_request_url"),
            git_commit_count=metadata.get("git_commit_count", 0),
            git_files_changed=metadata.get("git_files_changed", 0),
            error_message=metadata.get("error_message"),
        )

        logger.info("agent_work_order_get_completed", agent_work_order_id=agent_work_order_id)
        return work_order

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "agent_work_order_get_failed",
            agent_work_order_id=agent_work_order_id,
            error=str(e),
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=f"Failed to get work order: {e}") from e


@router.get("/")
async def list_agent_work_orders(
    status: AgentWorkOrderStatus | None = None,
) -> list[AgentWorkOrder]:
    """List all agent work orders

    Args:
        status: Optional status filter
    """
    logger.info("agent_work_orders_list_started", status=status.value if status else None)

    try:
        results = await state_repository.list(status_filter=status)

        work_orders = []
        for state, metadata in results:
            work_order = AgentWorkOrder(
                agent_work_order_id=state.agent_work_order_id,
                repository_url=state.repository_url,
                sandbox_identifier=state.sandbox_identifier,
                git_branch_name=state.git_branch_name,
                agent_session_id=state.agent_session_id,
                sandbox_type=metadata["sandbox_type"],
                github_issue_number=metadata["github_issue_number"],
                status=metadata["status"],
                current_phase=metadata["current_phase"],
                created_at=metadata["created_at"],
                updated_at=metadata["updated_at"],
                github_pull_request_url=metadata.get("github_pull_request_url"),
                git_commit_count=metadata.get("git_commit_count", 0),
                git_files_changed=metadata.get("git_files_changed", 0),
                error_message=metadata.get("error_message"),
            )
            work_orders.append(work_order)

        logger.info("agent_work_orders_list_completed", count=len(work_orders))
        return work_orders

    except Exception as e:
        logger.error("agent_work_orders_list_failed", error=str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to list work orders: {e}") from e


@router.post("/{agent_work_order_id}/prompt")
async def send_prompt_to_agent(
    agent_work_order_id: str,
    request: AgentPromptRequest,
) -> dict:
    """Send prompt to running agent

    TODO Phase 2+: Implement agent session resumption
    For MVP, this is a placeholder.
    """
    logger.info(
        "agent_prompt_send_started",
        agent_work_order_id=agent_work_order_id,
        prompt=request.prompt_text,
    )

    # TODO Phase 2+: Implement session resumption
    # For now, return success but don't actually send
    return {
        "success": True,
        "message": "Prompt sending not yet implemented (Phase 2+)",
        "agent_work_order_id": agent_work_order_id,
    }


@router.get("/{agent_work_order_id}/git-progress")
async def get_git_progress(agent_work_order_id: str) -> GitProgressSnapshot:
    """Get git progress for a work order"""
    logger.info("git_progress_get_started", agent_work_order_id=agent_work_order_id)

    try:
        result = await state_repository.get(agent_work_order_id)
        if not result:
            raise HTTPException(status_code=404, detail="Work order not found")

        state, metadata = result

        if not state.git_branch_name:
            # No branch yet, return minimal snapshot
            current_phase = metadata.get("current_phase")
            return GitProgressSnapshot(
                agent_work_order_id=agent_work_order_id,
                current_phase=current_phase if current_phase else AgentWorkflowPhase.PLANNING,
                git_commit_count=0,
                git_files_changed=0,
                latest_commit_message=None,
                git_branch_name=None,
            )

        # TODO Phase 2+: Get actual progress from sandbox
        # For MVP, return metadata values
        current_phase = metadata.get("current_phase")
        return GitProgressSnapshot(
            agent_work_order_id=agent_work_order_id,
            current_phase=current_phase if current_phase else AgentWorkflowPhase.PLANNING,
            git_commit_count=metadata.get("git_commit_count", 0),
            git_files_changed=metadata.get("git_files_changed", 0),
            latest_commit_message=None,
            git_branch_name=state.git_branch_name,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "git_progress_get_failed",
            agent_work_order_id=agent_work_order_id,
            error=str(e),
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=f"Failed to get git progress: {e}") from e


@router.get("/{agent_work_order_id}/logs")
async def get_agent_work_order_logs(
    agent_work_order_id: str,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    level: str | None = Query(None, description="Filter by log level (info, warning, error, debug)"),
    step: str | None = Query(None, description="Filter by step name"),
) -> dict:
    """Get buffered logs for a work order.

    Returns logs from the in-memory buffer. For real-time streaming, use the
    /logs/stream endpoint.

    Args:
        agent_work_order_id: Work order ID
        limit: Maximum number of logs to return (1-1000)
        offset: Number of logs to skip for pagination
        level: Optional log level filter
        step: Optional step name filter

    Returns:
        Dictionary with log entries and pagination metadata
    """
    logger.info(
        "agent_logs_get_started",
        agent_work_order_id=agent_work_order_id,
        limit=limit,
        offset=offset,
        level=level,
        step=step,
    )

    # Verify work order exists
    work_order = await state_repository.get(agent_work_order_id)
    if not work_order:
        raise HTTPException(status_code=404, detail="Agent work order not found")

    # Get logs from buffer
    log_entries = log_buffer.get_logs(
        work_order_id=agent_work_order_id,
        level=level,
        step=step,
        limit=limit,
        offset=offset,
    )

    return {
        "agent_work_order_id": agent_work_order_id,
        "log_entries": log_entries,
        "total": log_buffer.get_log_count(agent_work_order_id),
        "limit": limit,
        "offset": offset,
    }


@router.get("/{agent_work_order_id}/logs/stream")
async def stream_agent_work_order_logs(
    agent_work_order_id: str,
    level: str | None = Query(None, description="Filter by log level (info, warning, error, debug)"),
    step: str | None = Query(None, description="Filter by step name"),
    since: str | None = Query(None, description="ISO timestamp - only return logs after this time"),
) -> EventSourceResponse:
    """Stream work order logs in real-time via Server-Sent Events.

    Connects to a live stream that delivers logs as they are generated.
    Connection stays open until work order completes or client disconnects.

    Args:
        agent_work_order_id: Work order ID
        level: Optional log level filter (info, warning, error, debug)
        step: Optional step name filter (exact match)
        since: Optional ISO timestamp - only return logs after this time

    Returns:
        EventSourceResponse streaming log events

    Examples:
        curl -N http://localhost:8053/api/agent-work-orders/wo-123/logs/stream
        curl -N "http://localhost:8053/api/agent-work-orders/wo-123/logs/stream?level=error"

    Notes:
        - Uses Server-Sent Events (SSE) protocol
        - Sends heartbeat every 15 seconds to keep connection alive
        - Automatically handles client disconnect
        - Each event is JSON with timestamp, level, event, work_order_id, and extra fields
    """
    logger.info(
        "agent_logs_stream_started",
        agent_work_order_id=agent_work_order_id,
        level=level,
        step=step,
        since=since,
    )

    # Verify work order exists
    work_order = await state_repository.get(agent_work_order_id)
    if not work_order:
        raise HTTPException(status_code=404, detail="Agent work order not found")

    # Create SSE stream
    return EventSourceResponse(
        stream_work_order_logs(
            work_order_id=agent_work_order_id,
            log_buffer=log_buffer,
            level_filter=level,
            step_filter=step,
            since_timestamp=since,
        ),
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{agent_work_order_id}/steps")
async def get_agent_work_order_steps(agent_work_order_id: str) -> StepHistory:
    """Get step execution history for a work order

    Returns detailed history of each step executed,
    including success/failure, duration, and errors.
    Returns empty history if work order exists but has no steps yet.
    """
    logger.info("agent_step_history_get_started", agent_work_order_id=agent_work_order_id)

    try:
        # First check if work order exists
        result = await state_repository.get(agent_work_order_id)
        if not result:
            raise HTTPException(status_code=404, detail="Work order not found")

        step_history = await state_repository.get_step_history(agent_work_order_id)

        if not step_history:
            # Work order exists but no steps yet - return empty history
            logger.info(
                "agent_step_history_empty",
                agent_work_order_id=agent_work_order_id,
            )
            return StepHistory(agent_work_order_id=agent_work_order_id, steps=[])

        logger.info(
            "agent_step_history_get_completed",
            agent_work_order_id=agent_work_order_id,
            step_count=len(step_history.steps),
        )
        return step_history

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "agent_step_history_get_failed",
            agent_work_order_id=agent_work_order_id,
            error=str(e),
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=f"Failed to get step history: {e}") from e


@router.post("/github/verify-repository")
async def verify_github_repository(
    request: GitHubRepositoryVerificationRequest,
) -> GitHubRepositoryVerificationResponse:
    """Verify GitHub repository access"""
    logger.info("github_repository_verification_started", repository_url=request.repository_url)

    try:
        is_accessible = await github_client.verify_repository_access(request.repository_url)

        if is_accessible:
            repo_info = await github_client.get_repository_info(request.repository_url)
            logger.info("github_repository_verified", repository_url=request.repository_url)
            return GitHubRepositoryVerificationResponse(
                is_accessible=True,
                repository_name=repo_info.name,
                repository_owner=repo_info.owner,
                default_branch=repo_info.default_branch,
                error_message=None,
            )
        else:
            logger.warning("github_repository_not_accessible", repository_url=request.repository_url)
            return GitHubRepositoryVerificationResponse(
                is_accessible=False,
                repository_name=None,
                repository_owner=None,
                default_branch=None,
                error_message="Repository not accessible or not found",
            )

    except Exception as e:
        logger.error(
            "github_repository_verification_failed",
            repository_url=request.repository_url,
            error=str(e),
            exc_info=True,
        )
        return GitHubRepositoryVerificationResponse(
            is_accessible=False,
            repository_name=None,
            repository_owner=None,
            default_branch=None,
            error_message=str(e),
        )


