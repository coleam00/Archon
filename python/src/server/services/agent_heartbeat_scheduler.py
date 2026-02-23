"""
Agent Heartbeat Scheduler for Archon

Background service that periodically marks agents as inactive when they stop
sending heartbeats. Runs every 30 seconds and sets status to "inactive" for
any agent whose last_seen is older than STALE_THRESHOLD_SECONDS.

Heartbeat endpoint: POST /api/agents/{name}/heartbeat
Typical client interval: 20s (launchd plist with StartInterval: 20)
Stale threshold: 60s (3× the client interval)
"""

import asyncio
from datetime import UTC, datetime, timedelta

from ..config.logfire_config import get_logger
from ..utils import get_supabase_client

logger = get_logger(__name__)

STALE_THRESHOLD_SECONDS = 60
CHECK_INTERVAL_SECONDS = 30


class AgentHeartbeatScheduler:
    """Background service that expires stale agent registrations."""

    def __init__(
        self,
        stale_threshold_seconds: int = STALE_THRESHOLD_SECONDS,
        check_interval_seconds: int = CHECK_INTERVAL_SECONDS,
    ):
        self.stale_threshold = stale_threshold_seconds
        self.check_interval = check_interval_seconds
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the background scheduler."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        logger.info(
            f"Agent Heartbeat Scheduler started "
            f"(stale>{self.stale_threshold}s, check every {self.check_interval}s)"
        )

    async def stop(self) -> None:
        """Stop the background scheduler."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Agent Heartbeat Scheduler stopped")

    async def _run_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.check_interval)
            if not self._running:
                break
            try:
                await self.expire_stale_agents()
            except Exception as e:
                logger.error(f"Error in heartbeat scheduler loop: {e}", exc_info=True)

    async def expire_stale_agents(self) -> int:
        """
        Mark agents as inactive when last_seen is older than the stale threshold.

        Only transitions agents that are currently active or busy — agents
        already inactive are left untouched.

        Returns:
            Number of agents marked inactive.
        """
        cutoff = datetime.now(UTC) - timedelta(seconds=self.stale_threshold)
        cutoff_iso = cutoff.isoformat()

        try:
            supabase = get_supabase_client()
            response = (
                supabase.table("archon_agent_registry")
                .update({"status": "inactive"})
                .in_("status", ["active", "busy"])
                .lt("last_seen", cutoff_iso)
                .execute()
            )
            count = len(response.data) if response.data else 0
            if count > 0:
                names = [a.get("name", "?") for a in response.data]
                logger.info(f"Heartbeat scheduler: marked {count} agent(s) inactive: {names}")
            return count
        except Exception as e:
            logger.error(f"Failed to expire stale agents: {e}", exc_info=True)
            return 0


# Singleton
agent_heartbeat_scheduler = AgentHeartbeatScheduler()
