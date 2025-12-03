"""Supabase-backed repository for agent work order state management.

Provides ACID-compliant persistent storage for work order state using PostgreSQL
via Supabase. Implements the same interface as in-memory and file-based repositories
for seamless switching between storage backends.

Architecture Note - async/await Pattern:
    All repository methods are declared as `async def` for interface consistency
    with other repository implementations, even though Supabase operations are sync.
    This maintains a consistent async API contract across all repositories.
"""

from datetime import UTC, datetime
from typing import Any

from supabase import Client

from ..database.client import get_agent_work_orders_client
from ..models import (
    AgentWorkOrderState,
    AgentWorkOrderStatus,
    StepExecutionResult,
    StepHistory,
    WorkflowStep,
)
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class SupabaseWorkOrderRepository:
    """Supabase-backed repository for agent work orders.

    Provides persistent storage with ACID guarantees, row-level locking,
    and foreign key constraints for referential integrity.

    Architecture:
        - Work orders stored in archon_agent_work_orders table
        - Step history stored in archon_agent_work_order_steps table with CASCADE delete
        - Hybrid schema: Frequently queried fields as columns, flexible metadata as JSONB
        - Auto-managed timestamps via database triggers

    Thread Safety:
        Uses Supabase client which is thread-safe for concurrent operations.
        Database-level row locking prevents race conditions.
    """

    def __init__(self) -> None:
        """Initialize Supabase repository with database client.

        Raises:
            ValueError: If Supabase credentials are not configured
        """
        self.client: Client = get_agent_work_orders_client()
        self.table_name: str = "archon_agent_work_orders"
        self.steps_table_name: str = "archon_agent_work_order_steps"
        self._logger = logger.bind(table=self.table_name)
        self._logger.info("supabase_repository_initialized")

    def _row_to_state_and_metadata(self, row: dict[str, Any]) -> tuple[AgentWorkOrderState, dict]:
        """Convert database row to (AgentWorkOrderState, metadata) tuple.

        Args:
            row: Raw database row with columns and JSONB metadata

        Returns:
            Tuple of (state, metadata) where state contains core fields
            and metadata contains status, timestamps, and JSONB fields

        Note:
            Handles enum conversion from database string to AgentWorkOrderStatus
        """
        # Extract core state fields
        state = AgentWorkOrderState(
            agent_work_order_id=row["agent_work_order_id"],
            repository_url=row["repository_url"],
            sandbox_identifier=row["sandbox_identifier"],
            git_branch_name=row.get("git_branch_name"),
            agent_session_id=row.get("agent_session_id"),
        )

        # Extract metadata
        metadata = row.get("metadata", {}).copy()
        metadata["status"] = AgentWorkOrderStatus(row["status"])
        metadata["created_at"] = row["created_at"]
        metadata["updated_at"] = row["updated_at"]

        return (state, metadata)

    async def create(self, work_order: AgentWorkOrderState, metadata: dict) -> None:
        """Create new work order in database.

        Args:
            work_order: Core work order state (5 fields)
            metadata: Additional metadata including status, sandbox_type, etc.

        Raises:
            Exception: If database insert fails (e.g., duplicate ID, constraint violation)

        Example:
            >>> state = AgentWorkOrderState(
            ...     agent_work_order_id="wo-123",
            ...     repository_url="https://github.com/test/repo",
            ...     sandbox_identifier="sandbox-123"
            ... )
            >>> metadata = {"status": AgentWorkOrderStatus.PENDING, "sandbox_type": "git_worktree"}
            >>> await repository.create(state, metadata)
        """
        try:
            # Prepare data for insertion
            # Separate core state columns from JSONB metadata
            data = {
                "agent_work_order_id": work_order.agent_work_order_id,
                "repository_url": work_order.repository_url,
                "sandbox_identifier": work_order.sandbox_identifier,
                "git_branch_name": work_order.git_branch_name,
                "agent_session_id": work_order.agent_session_id,
                "status": (
                    metadata["status"].value
                    if isinstance(metadata["status"], AgentWorkOrderStatus)
                    else metadata["status"]
                ),
                # Store non-status/timestamp metadata in JSONB column
                "metadata": {k: v for k, v in metadata.items() if k not in ["status", "created_at", "updated_at"]},
            }

            self.client.table(self.table_name).insert(data).execute()

            self._logger.info(
                "work_order_created",
                agent_work_order_id=work_order.agent_work_order_id,
                repository_url=work_order.repository_url,
            )
        except Exception as e:
            self._logger.exception(
                "create_work_order_failed",
                agent_work_order_id=work_order.agent_work_order_id,
                error=str(e),
            )
            raise

    async def get(self, agent_work_order_id: str) -> tuple[AgentWorkOrderState, dict] | None:
        """Get work order by ID.

        Args:
            agent_work_order_id: Work order unique identifier

        Returns:
            Tuple of (state, metadata) or None if not found

        Raises:
            Exception: If database query fails

        Example:
            >>> result = await repository.get("wo-123")
            >>> if result:
            ...     state, metadata = result
            ...     print(f"Status: {metadata['status']}")
        """
        try:
            response = self.client.table(self.table_name).select("*").eq("agent_work_order_id", agent_work_order_id).execute()

            if not response.data:
                self._logger.info("work_order_not_found", agent_work_order_id=agent_work_order_id)
                return None

            return self._row_to_state_and_metadata(response.data[0])
        except Exception as e:
            self._logger.exception(
                "get_work_order_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
            )
            raise

    async def list(self, status_filter: AgentWorkOrderStatus | None = None) -> list[tuple[AgentWorkOrderState, dict]]:
        """List all work orders with optional status filter.

        Args:
            status_filter: Optional status to filter by (e.g., PENDING, RUNNING)

        Returns:
            List of (state, metadata) tuples ordered by created_at DESC

        Raises:
            Exception: If database query fails

        Example:
            >>> # Get all running work orders
            >>> running = await repository.list(status_filter=AgentWorkOrderStatus.RUNNING)
            >>> for state, metadata in running:
            ...     print(f"{state.agent_work_order_id}: {metadata['status']}")
        """
        try:
            query = self.client.table(self.table_name).select("*")

            if status_filter:
                query = query.eq("status", status_filter.value)

            response = query.order("created_at", desc=True).execute()

            results = [self._row_to_state_and_metadata(row) for row in response.data]

            self._logger.info(
                "work_orders_listed",
                count=len(results),
                status_filter=status_filter.value if status_filter else None,
            )

            return results
        except Exception as e:
            self._logger.exception(
                "list_work_orders_failed",
                status_filter=status_filter.value if status_filter else None,
                error=str(e),
            )
            raise

    async def update_status(
        self,
        agent_work_order_id: str,
        status: AgentWorkOrderStatus,
        **kwargs,
    ) -> None:
        """Update work order status and other metadata fields.

        Args:
            agent_work_order_id: Work order ID to update
            status: New status value
            **kwargs: Additional metadata fields to update (e.g., error_message, current_phase)

        Raises:
            Exception: If database update fails

        Note:
            If work order not found, logs warning but does not raise exception.
            Updates are merged with existing metadata in JSONB column.

        Example:
            >>> await repository.update_status(
            ...     "wo-123",
            ...     AgentWorkOrderStatus.FAILED,
            ...     error_message="Branch creation failed"
            ... )
        """
        try:
            # Prepare updates
            updates: dict[str, Any] = {
                "status": status.value,
                "updated_at": datetime.now(UTC).isoformat(),
            }

            # Add any metadata updates to the JSONB column
            if kwargs:
                # Get current metadata, update it, then save
                current = await self.get(agent_work_order_id)
                if current:
                    _, metadata = current
                    metadata.update(kwargs)
                    # Extract non-status/timestamp metadata for JSONB column
                    jsonb_metadata = {k: v for k, v in metadata.items() if k not in ["status", "created_at", "updated_at"]}
                    updates["metadata"] = jsonb_metadata

            response = (
                self.client.table(self.table_name)
                .update(updates)
                .eq("agent_work_order_id", agent_work_order_id)
                .execute()
            )

            if not response.data:
                self._logger.warning(
                    "work_order_not_found_for_update",
                    agent_work_order_id=agent_work_order_id,
                )
                return

            self._logger.info(
                "work_order_status_updated",
                agent_work_order_id=agent_work_order_id,
                status=status.value,
            )
        except Exception as e:
            self._logger.exception(
                "update_work_order_status_failed",
                agent_work_order_id=agent_work_order_id,
                status=status.value,
                error=str(e),
            )
            raise

    async def update_git_branch(
        self, agent_work_order_id: str, git_branch_name: str
    ) -> None:
        """Update git branch name in work order state.

        Args:
            agent_work_order_id: Work order ID to update
            git_branch_name: New git branch name

        Raises:
            Exception: If database update fails

        Example:
            >>> await repository.update_git_branch("wo-123", "feature/new-feature")
        """
        try:
            self.client.table(self.table_name).update({
                "git_branch_name": git_branch_name,
                "updated_at": datetime.now(UTC).isoformat(),
            }).eq("agent_work_order_id", agent_work_order_id).execute()

            self._logger.info(
                "work_order_git_branch_updated",
                agent_work_order_id=agent_work_order_id,
                git_branch_name=git_branch_name,
            )
        except Exception as e:
            self._logger.exception(
                "update_git_branch_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
            )
            raise

    async def update_session_id(
        self, agent_work_order_id: str, agent_session_id: str
    ) -> None:
        """Update agent session ID in work order state.

        Args:
            agent_work_order_id: Work order ID to update
            agent_session_id: New agent session ID

        Raises:
            Exception: If database update fails

        Example:
            >>> await repository.update_session_id("wo-123", "session-abc-456")
        """
        try:
            self.client.table(self.table_name).update({
                "agent_session_id": agent_session_id,
                "updated_at": datetime.now(UTC).isoformat(),
            }).eq("agent_work_order_id", agent_work_order_id).execute()

            self._logger.info(
                "work_order_session_id_updated",
                agent_work_order_id=agent_work_order_id,
                agent_session_id=agent_session_id,
            )
        except Exception as e:
            self._logger.exception(
                "update_session_id_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
            )
            raise

    async def save_step_history(
        self, agent_work_order_id: str, step_history: StepHistory
    ) -> None:
        """Save step execution history to database.

        Uses delete + insert pattern for fresh save, replacing all existing steps.

        Args:
            agent_work_order_id: Work order ID
            step_history: Complete step execution history

        Raises:
            Exception: If database operation fails

        Note:
            Foreign key constraint ensures cascade delete when work order is deleted.
            Steps are inserted with step_order to maintain execution sequence.

        Example:
            >>> history = StepHistory(
            ...     agent_work_order_id="wo-123",
            ...     steps=[
            ...         StepExecutionResult(
            ...             step=WorkflowStep.CREATE_BRANCH,
            ...             agent_name="test-agent",
            ...             success=True,
            ...             duration_seconds=1.5,
            ...             timestamp=datetime.now(timezone.utc)
            ...         )
            ...     ]
            ... )
            >>> await repository.save_step_history("wo-123", history)
        """
        try:
            # Delete existing steps (fresh save pattern)
            self.client.table(self.steps_table_name).delete().eq("agent_work_order_id", agent_work_order_id).execute()

            # Insert all steps
            if step_history.steps:
                steps_data = []
                for i, step in enumerate(step_history.steps):
                    steps_data.append({
                        "agent_work_order_id": agent_work_order_id,
                        "step": step.step.value,
                        "agent_name": step.agent_name,
                        "success": step.success,
                        "output": step.output,
                        "error_message": step.error_message,
                        "duration_seconds": step.duration_seconds,
                        "session_id": step.session_id,
                        "executed_at": step.timestamp.isoformat(),
                        "step_order": i,
                    })

                self.client.table(self.steps_table_name).insert(steps_data).execute()

            self._logger.info(
                "step_history_saved",
                agent_work_order_id=agent_work_order_id,
                step_count=len(step_history.steps),
            )
        except Exception as e:
            self._logger.exception(
                "save_step_history_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
            )
            raise

    async def get_step_history(self, agent_work_order_id: str) -> StepHistory | None:
        """Get step execution history from database.

        Args:
            agent_work_order_id: Work order ID

        Returns:
            StepHistory with ordered steps, or None if no steps found

        Raises:
            Exception: If database query fails

        Example:
            >>> history = await repository.get_step_history("wo-123")
            >>> if history:
            ...     for step in history.steps:
            ...         print(f"{step.step}: {'✓' if step.success else '✗'}")
        """
        try:
            response = (
                self.client.table(self.steps_table_name)
                .select("*")
                .eq("agent_work_order_id", agent_work_order_id)
                .order("step_order")
                .execute()
            )

            if not response.data:
                self._logger.info(
                    "step_history_not_found",
                    agent_work_order_id=agent_work_order_id,
                )
                return None

            # Convert rows to StepExecutionResult objects
            steps = []
            for row in response.data:
                steps.append(StepExecutionResult(
                    step=WorkflowStep(row["step"]),
                    agent_name=row["agent_name"],
                    success=row["success"],
                    output=row.get("output"),
                    error_message=row.get("error_message"),
                    duration_seconds=row["duration_seconds"],
                    session_id=row.get("session_id"),
                    timestamp=row["executed_at"],
                ))

            return StepHistory(agent_work_order_id=agent_work_order_id, steps=steps)
        except Exception as e:
            self._logger.exception(
                "get_step_history_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
            )
            raise
