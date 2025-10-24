"""API Routes

FastAPI routes for agent work orders.
"""

import asyncio
from datetime import datetime

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
    CreateAgentWorkOrderRequest,
    GitHubRepositoryVerificationRequest,
    GitHubRepositoryVerificationResponse,
    GitProgressSnapshot,
    StepHistory,
)
from ..sandbox_manager.sandbox_factory import SandboxFactory
from ..state_manager.repository_factory import create_repository
from ..utils.id_generator import generate_work_order_id
from ..utils.log_buffer import WorkOrderLogBuffer
from ..utils.structured_logger import get_logger
from ..workflow_engine.workflow_orchestrator import WorkflowOrchestrator
from .sse_streams import stream_work_order_logs

logger = get_logger(__name__)
router = APIRouter()

# Initialize dependencies (singletons for MVP)
state_repository = create_repository()
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
        # Use provided ID or generate new one
        agent_work_order_id = request.agent_work_order_id or generate_work_order_id()

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

        # Start workflow in background
        asyncio.create_task(
            orchestrator.execute_workflow(
                agent_work_order_id=agent_work_order_id,
                repository_url=request.repository_url,
                sandbox_type=request.sandbox_type,
                user_request=request.user_request,
                selected_commands=request.selected_commands,
                github_issue_number=request.github_issue_number,
            )
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
