"""
Telemetry Service for Archon Phase 5.

Provides metrics for the live telemetry dashboard:
- get_agent_metrics()       — live status + last_seen delta from archon_agent_registry
- get_sprint_metrics()      — velocity, burn-down, queue depth from archon_tasks / archon_sprints
- get_snapshot()            — combined snapshot for GET /api/telemetry/snapshot
"""

from collections import defaultdict
from datetime import UTC, datetime

from ..config.logfire_config import get_logger
from ..utils import get_supabase_client

logger = get_logger(__name__)


class TelemetryService:
    """Service for telemetry metrics used by the live dashboard."""

    def __init__(self, supabase_client=None):
        self.supabase = supabase_client or get_supabase_client()

    async def get_agent_metrics(self) -> list[dict]:
        """
        Return live status and last_seen delta for every registered agent.

        Each record includes:
          - id, name, role, status, capabilities, metadata
          - last_seen: ISO timestamp
          - last_seen_seconds_ago: int  (–1 if last_seen is null)
        """
        response = (
            self.supabase.table("archon_agent_registry")
            .select("id, name, role, status, capabilities, metadata, last_seen")
            .order("last_seen", desc=True, nullsfirst=False)
            .execute()
        )
        agents = response.data or []

        now = datetime.now(UTC)
        for agent in agents:
            raw = agent.get("last_seen")
            if raw:
                try:
                    ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    agent["last_seen_seconds_ago"] = max(0, int((now - ts).total_seconds()))
                except ValueError:
                    agent["last_seen_seconds_ago"] = -1
            else:
                agent["last_seen_seconds_ago"] = -1

        return agents

    async def get_sprint_metrics(self, sprint_id: str) -> dict:
        """
        Return velocity, burn-down, and queue depth for a sprint.

        Fields returned:
          sprint:       id, name, goal, status, start_date, end_date
          total_tasks:  total task count in sprint
          by_status:    { todo, doing, review, done } counts
          queue_depth:  todo + doing count
          velocity:     list of { date: "YYYY-MM-DD", count: int } for done tasks,
                        sorted by date ascending (burn-down chart data)
        """
        sprint_resp = (
            self.supabase.table("archon_sprints")
            .select("id, name, goal, status, start_date, end_date")
            .eq("id", sprint_id)
            .execute()
        )
        if not sprint_resp.data:
            raise ValueError(f"Sprint '{sprint_id}' not found")
        sprint = sprint_resp.data[0]

        tasks_resp = (
            self.supabase.table("archon_tasks")
            .select("id, status, updated_at")
            .eq("sprint_id", sprint_id)
            .execute()
        )
        tasks = tasks_resp.data or []

        by_status: dict[str, int] = defaultdict(int)
        done_by_date: dict[str, int] = defaultdict(int)

        for task in tasks:
            status = task.get("status", "todo")
            by_status[status] += 1

            if status == "done" and task.get("updated_at"):
                try:
                    ts = datetime.fromisoformat(task["updated_at"].replace("Z", "+00:00"))
                    date_str = ts.date().isoformat()
                    done_by_date[date_str] += 1
                except ValueError:
                    pass

        velocity = sorted(
            [{"date": d, "count": c} for d, c in done_by_date.items()],
            key=lambda x: x["date"],
        )

        return {
            "sprint": sprint,
            "total_tasks": len(tasks),
            "by_status": {
                "todo": by_status.get("todo", 0),
                "doing": by_status.get("doing", 0),
                "review": by_status.get("review", 0),
                "done": by_status.get("done", 0),
            },
            "queue_depth": by_status.get("todo", 0) + by_status.get("doing", 0),
            "velocity": velocity,
        }

    async def get_snapshot(self, sprint_id: str | None = None) -> dict:
        """
        Full telemetry snapshot for GET /api/telemetry/snapshot.

        Includes agent metrics always. Sprint metrics are included when
        sprint_id is provided; if omitted, the most recent active sprint
        is resolved automatically.

        Returns:
          {
            "agents": [...],
            "sprint": { ... } | None,
            "generated_at": "<ISO timestamp>"
          }
        """
        agents = await self.get_agent_metrics()

        resolved_id = sprint_id
        if not resolved_id:
            active = (
                self.supabase.table("archon_sprints")
                .select("id")
                .eq("status", "active")
                .order("start_date", desc=True, nullsfirst=False)
                .limit(1)
                .execute()
            )
            if active.data:
                resolved_id = active.data[0]["id"]

        sprint_metrics = None
        if resolved_id:
            try:
                sprint_metrics = await self.get_sprint_metrics(resolved_id)
            except ValueError as e:
                logger.warning(f"Could not load sprint metrics: {e}")

        return {
            "agents": agents,
            "sprint": sprint_metrics,
            "generated_at": datetime.now(UTC).isoformat(),
        }


# Singleton
_telemetry_service: TelemetryService | None = None


def get_telemetry_service() -> TelemetryService:
    """Get or create the singleton TelemetryService instance."""
    global _telemetry_service
    if _telemetry_service is None:
        _telemetry_service = TelemetryService()
    return _telemetry_service
