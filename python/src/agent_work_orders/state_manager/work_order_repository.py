"""Work Order Repository

In-memory storage for agent work orders (MVP).
TODO Phase 2+: Migrate to Supabase persistence.
"""

import asyncio
from datetime import datetime

from ..models import AgentWorkOrderState, AgentWorkOrderStatus, StepHistory
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


class WorkOrderRepository:
    """In-memory repository for work order state

    Stores minimal state (5 fields) and metadata separately.
    TODO Phase 2+: Replace with SupabaseWorkOrderRepository
    """

    def __init__(self):
        self._work_orders: dict[str, AgentWorkOrderState] = {}
        self._metadata: dict[str, dict] = {}
        self._step_histories: dict[str, StepHistory] = {}
        self._lock = asyncio.Lock()
        self._logger = logger

    async def create(self, work_order: AgentWorkOrderState, metadata: dict) -> None:
        """Create a new work order

        Args:
            work_order: Core work order state
            metadata: Additional metadata (status, workflow_type, etc.)
        """
        async with self._lock:
            self._work_orders[work_order.agent_work_order_id] = work_order
            self._metadata[work_order.agent_work_order_id] = metadata
            self._logger.info(
                "work_order_created",
                agent_work_order_id=work_order.agent_work_order_id,
            )

    async def get(self, agent_work_order_id: str) -> tuple[AgentWorkOrderState, dict] | None:
        """Get a work order by ID

        Args:
            agent_work_order_id: Work order ID

        Returns:
            Tuple of (state, metadata) or None if not found
        """
        async with self._lock:
            if agent_work_order_id not in self._work_orders:
                return None
            return (
                self._work_orders[agent_work_order_id],
                self._metadata[agent_work_order_id],
            )

    async def list(self, status_filter: AgentWorkOrderStatus | None = None) -> list[tuple[AgentWorkOrderState, dict]]:
        """List all work orders

        Args:
            status_filter: Optional status to filter by

        Returns:
            List of (state, metadata) tuples
        """
        async with self._lock:
            results = []
            for wo_id in self._work_orders:
                state = self._work_orders[wo_id]
                metadata = self._metadata[wo_id]

                if status_filter is None or metadata.get("status") == status_filter:
                    results.append((state, metadata))

            return results

    async def update_status(
        self,
        agent_work_order_id: str,
        status: AgentWorkOrderStatus,
        **kwargs,
    ) -> None:
        """Update work order status and other fields

        Args:
            agent_work_order_id: Work order ID
            status: New status
            **kwargs: Additional fields to update
        """
        async with self._lock:
            if agent_work_order_id in self._metadata:
                self._metadata[agent_work_order_id]["status"] = status
                self._metadata[agent_work_order_id]["updated_at"] = datetime.now()

                for key, value in kwargs.items():
                    self._metadata[agent_work_order_id][key] = value

                self._logger.info(
                    "work_order_status_updated",
                    agent_work_order_id=agent_work_order_id,
                    status=status.value,
                )

    async def update_git_branch(
        self, agent_work_order_id: str, git_branch_name: str
    ) -> None:
        """Update git branch name in state

        Args:
            agent_work_order_id: Work order ID
            git_branch_name: Git branch name
        """
        async with self._lock:
            if agent_work_order_id in self._work_orders:
                self._work_orders[agent_work_order_id].git_branch_name = git_branch_name
                self._metadata[agent_work_order_id]["updated_at"] = datetime.now()
                self._logger.info(
                    "work_order_git_branch_updated",
                    agent_work_order_id=agent_work_order_id,
                    git_branch_name=git_branch_name,
                )

    async def update_session_id(
        self, agent_work_order_id: str, agent_session_id: str
    ) -> None:
        """Update agent session ID in state

        Args:
            agent_work_order_id: Work order ID
            agent_session_id: Claude CLI session ID
        """
        async with self._lock:
            if agent_work_order_id in self._work_orders:
                self._work_orders[agent_work_order_id].agent_session_id = agent_session_id
                self._metadata[agent_work_order_id]["updated_at"] = datetime.now()
                self._logger.info(
                    "work_order_session_id_updated",
                    agent_work_order_id=agent_work_order_id,
                    agent_session_id=agent_session_id,
                )

    async def save_step_history(
        self, agent_work_order_id: str, step_history: StepHistory
    ) -> None:
        """Save step execution history

        Args:
            agent_work_order_id: Work order ID
            step_history: Step execution history
        """
        async with self._lock:
            self._step_histories[agent_work_order_id] = step_history
            self._logger.info(
                "step_history_saved",
                agent_work_order_id=agent_work_order_id,
                step_count=len(step_history.steps),
            )

    async def get_step_history(self, agent_work_order_id: str) -> StepHistory | None:
        """Get step execution history

        Args:
            agent_work_order_id: Work order ID

        Returns:
            Step history or None if not found
        """
        async with self._lock:
            return self._step_histories.get(agent_work_order_id)
