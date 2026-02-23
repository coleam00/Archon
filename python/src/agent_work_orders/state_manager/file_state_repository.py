"""File-based Work Order Repository

Provides persistent JSON-based storage for agent work orders.
Enables state persistence across service restarts and debugging.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from ..models import AgentWorkOrderState, AgentWorkOrderStatus, StepHistory
from ..utils.structured_logger import get_logger

if TYPE_CHECKING:
    import structlog

logger = get_logger(__name__)


class FileStateRepository:
    """File-based repository for work order state

    Stores state as JSON files in <state_directory>/<work_order_id>.json
    Each file contains: state, metadata, and step_history
    """

    def __init__(self, state_directory: str):
        self.state_directory = Path(state_directory)
        self.state_directory.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._logger: structlog.stdlib.BoundLogger = logger.bind(
            state_directory=str(self.state_directory)
        )
        self._logger.info("file_state_repository_initialized")

    def _get_state_file_path(self, agent_work_order_id: str) -> Path:
        """Get path to state file for work order

        Args:
            agent_work_order_id: Work order ID

        Returns:
            Path to state file
        """
        return self.state_directory / f"{agent_work_order_id}.json"

    def _serialize_datetime(self, obj):
        """JSON serializer for datetime objects

        Args:
            obj: Object to serialize

        Returns:
            ISO format string for datetime objects
        """
        if isinstance(obj, datetime):
            return obj.isoformat()
        raise TypeError(f"Type {type(obj)} not serializable")

    async def _read_state_file(self, agent_work_order_id: str) -> dict[str, Any] | None:
        """Read state file

        Args:
            agent_work_order_id: Work order ID

        Returns:
            State dictionary or None if file doesn't exist
        """
        state_file = self._get_state_file_path(agent_work_order_id)
        if not state_file.exists():
            return None

        try:
            with state_file.open("r") as f:
                data = json.load(f)
                return cast(dict[str, Any], data)
        except Exception as e:
            self._logger.error(
                "state_file_read_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
                exc_info=True
            )
            return None

    async def _write_state_file(self, agent_work_order_id: str, data: dict[str, Any]) -> None:
        """Write state file

        Args:
            agent_work_order_id: Work order ID
            data: State dictionary to write
        """
        state_file = self._get_state_file_path(agent_work_order_id)

        try:
            with state_file.open("w") as f:
                json.dump(data, f, indent=2, default=self._serialize_datetime)
        except Exception as e:
            self._logger.error(
                "state_file_write_failed",
                agent_work_order_id=agent_work_order_id,
                error=str(e),
                exc_info=True
            )
            raise

    async def create(self, work_order: AgentWorkOrderState, metadata: dict[str, Any]) -> None:
        """Create a new work order

        Args:
            work_order: Core work order state
            metadata: Additional metadata (status, workflow_type, etc.)
        """
        async with self._lock:
            data = {
                "state": work_order.model_dump(mode="json"),
                "metadata": metadata,
                "step_history": None
            }

            await self._write_state_file(work_order.agent_work_order_id, data)

            self._logger.info(
                "work_order_created",
                agent_work_order_id=work_order.agent_work_order_id,
            )

    async def get(self, agent_work_order_id: str) -> tuple[AgentWorkOrderState, dict[str, Any]] | None:
        """Get a work order by ID

        Args:
            agent_work_order_id: Work order ID

        Returns:
            Tuple of (state, metadata) or None if not found
        """
        async with self._lock:
            data = await self._read_state_file(agent_work_order_id)
            if not data:
                return None

            state = AgentWorkOrderState(**data["state"])
            metadata = data["metadata"]

            return (state, metadata)

    async def list(self, status_filter: AgentWorkOrderStatus | None = None) -> list[tuple[AgentWorkOrderState, dict[str, Any]]]:
        """List all work orders

        Args:
            status_filter: Optional status to filter by

        Returns:
            List of (state, metadata) tuples
        """
        async with self._lock:
            results = []

            # Iterate over all JSON files in state directory
            for state_file in self.state_directory.glob("*.json"):
                try:
                    with state_file.open("r") as f:
                        data = json.load(f)

                    state = AgentWorkOrderState(**data["state"])
                    metadata = data["metadata"]

                    if status_filter is None or metadata.get("status") == status_filter:
                        results.append((state, metadata))

                except Exception as e:
                    self._logger.error(
                        "state_file_load_failed",
                        file=str(state_file),
                        error=str(e)
                    )
                    continue

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
            data = await self._read_state_file(agent_work_order_id)
            if not data:
                self._logger.warning(
                    "work_order_not_found_for_update",
                    agent_work_order_id=agent_work_order_id
                )
                return

            data["metadata"]["status"] = status
            data["metadata"]["updated_at"] = datetime.now(UTC).isoformat()

            for key, value in kwargs.items():
                data["metadata"][key] = value

            await self._write_state_file(agent_work_order_id, data)

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
            data = await self._read_state_file(agent_work_order_id)
            if not data:
                self._logger.warning(
                    "work_order_not_found_for_update",
                    agent_work_order_id=agent_work_order_id
                )
                return

            data["state"]["git_branch_name"] = git_branch_name
            data["metadata"]["updated_at"] = datetime.now(UTC).isoformat()

            await self._write_state_file(agent_work_order_id, data)

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
            data = await self._read_state_file(agent_work_order_id)
            if not data:
                self._logger.warning(
                    "work_order_not_found_for_update",
                    agent_work_order_id=agent_work_order_id
                )
                return

            data["state"]["agent_session_id"] = agent_session_id
            data["metadata"]["updated_at"] = datetime.now(UTC).isoformat()

            await self._write_state_file(agent_work_order_id, data)

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
            data = await self._read_state_file(agent_work_order_id)
            if not data:
                # Create minimal state if doesn't exist
                data = {
                    "state": {"agent_work_order_id": agent_work_order_id},
                    "metadata": {},
                    "step_history": None
                }

            data["step_history"] = step_history.model_dump(mode="json")

            await self._write_state_file(agent_work_order_id, data)

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
            data = await self._read_state_file(agent_work_order_id)
            if not data or not data.get("step_history"):
                return None

            return StepHistory(**data["step_history"])

    async def delete(self, agent_work_order_id: str) -> None:
        """Delete a work order state file

        Args:
            agent_work_order_id: Work order ID
        """
        async with self._lock:
            state_file = self._get_state_file_path(agent_work_order_id)
            if state_file.exists():
                state_file.unlink()
                self._logger.info(
                    "work_order_deleted",
                    agent_work_order_id=agent_work_order_id
                )

    def list_state_ids(self) -> "list[str]":  # type: ignore[valid-type]
        """List all work order IDs with state files

        Returns:
            List of work order IDs
        """
        return [f.stem for f in self.state_directory.glob("*.json")]
