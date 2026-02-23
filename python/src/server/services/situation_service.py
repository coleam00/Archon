"""
Situation Agent Service for Archon.

Collects current system state (tasks, projects, sessions, shared context, plans)
and uses Claude to generate a prioritized daily brief with recommended actions.
"""

import json
import os
from typing import Any

from ..config.logfire_config import get_logger

logger = get_logger(__name__)


class SituationService:
    DOCUMENTS_BASE_PATH = os.getenv("DOCUMENTS_BASE_PATH", "/documents")
    PLANS_INDEX_PATH = "Documentation/System/PLANS_INDEX.md"

    async def _get_api_key(self) -> str:
        """Return Anthropic API key. Env var takes priority over Supabase credential service."""
        anthropic_key = os.getenv("ANTHROPIC_API_KEY")
        if anthropic_key:
            return anthropic_key

        from ..services.credential_service import credential_service

        provider_config = await credential_service.get_active_provider("llm")
        api_key = provider_config.get("api_key", "")
        if not api_key:
            raise RuntimeError(
                "No ANTHROPIC_API_KEY found. Set it in the .env file or configure credentials in Archon Settings."
            )
        return api_key

    def _read_plans_index(self) -> str:
        """Read PLANS_INDEX.md content. Returns empty string if not accessible."""
        index_path = os.path.join(self.DOCUMENTS_BASE_PATH, self.PLANS_INDEX_PATH)
        try:
            with open(index_path) as f:
                return f.read()[:3000]  # Trim to keep prompt reasonable
        except FileNotFoundError:
            logger.warning(f"PLANS_INDEX.md not found at {index_path}")
            return ""

    async def collect_state(self) -> dict[str, Any]:
        """Collect current system state from Archon REST APIs and files."""
        from ..utils import get_supabase_client

        supabase = get_supabase_client()
        state: dict[str, Any] = {}

        # Active tasks (todo + doing)
        try:
            tasks_response = (
                supabase.table("archon_tasks")
                .select("id,title,status,priority,assignee,created_at,updated_at")
                .in_("status", ["todo", "doing"])
                .limit(50)
                .execute()
            )
            tasks = tasks_response.data or []
            state["active_tasks"] = tasks
            state["active_tasks_count"] = len(tasks)
        except Exception as e:
            logger.warning(f"Failed to collect tasks: {e}")
            state["active_tasks"] = []
            state["active_tasks_count"] = 0

        # Active projects
        try:
            projects_response = (
                supabase.table("archon_projects")
                .select("id,title,status,created_at,updated_at")
                .limit(20)
                .execute()
            )
            state["projects"] = projects_response.data or []
        except Exception as e:
            logger.warning(f"Failed to collect projects: {e}")
            state["projects"] = []

        # Recent Claude sessions
        try:
            sessions_response = (
                supabase.table("archon_sessions")
                .select("id,agent_name,title,summary,created_at,ended_at")
                .eq("agent_name", "claude")
                .order("created_at", desc=True)
                .limit(5)
                .execute()
            )
            state["recent_sessions"] = sessions_response.data or []
        except Exception as e:
            logger.warning(f"Failed to collect sessions: {e}")
            state["recent_sessions"] = []

        # Shared context (trimmed — keys + metadata only, not full values)
        try:
            context_response = (
                supabase.table("archon_shared_context")
                .select("context_key,set_by,updated_at")
                .limit(50)
                .execute()
            )
            state["context_keys"] = context_response.data or []
        except Exception as e:
            logger.warning(f"Failed to collect shared context: {e}")
            state["context_keys"] = []

        # Recent audit log
        try:
            audit_response = (
                supabase.table("unified_audit_log")
                .select("source,action,agent,outcome,timestamp")
                .order("timestamp", desc=True)
                .limit(20)
                .execute()
            )
            state["recent_audit"] = audit_response.data or []
        except Exception as e:
            logger.warning(f"Failed to collect audit log: {e}")
            state["recent_audit"] = []

        # Plans index
        plans_content = self._read_plans_index()
        if plans_content:
            state["plans_index"] = plans_content

        return state

    async def generate_brief(self, state: dict[str, Any]) -> dict[str, Any]:
        """Send collected state to Claude and return a parsed brief dict."""
        import anthropic

        api_key = await self._get_api_key()
        client = anthropic.AsyncAnthropic(api_key=api_key)

        system_prompt = (
            "You are the Situation Agent for Archon — an AI orchestration platform. "
            "Analyze the provided system state and produce a concise JSON brief. "
            "Respond with ONLY valid JSON (no markdown, no explanation) matching this schema:\n"
            "{\n"
            '  "summary": "2-3 sentence overview of current system state",\n'
            '  "active_tasks": [\n'
            '    {"title": "...", "status": "todo|doing", "priority": "low|medium|high|critical"}\n'
            "  ],\n"
            '  "recent_activity": "1-2 sentence summary of recent audit/session activity",\n'
            '  "system_health": "healthy|degraded|warning",\n'
            '  "system_health_notes": "brief explanation of health assessment",\n'
            '  "recommended_actions": [\n'
            "    {\n"
            '      "title": "Action title",\n'
            '      "description": "What to do and why",\n'
            '      "priority": "low|medium|high|critical",\n'
            '      "type": "task|review|investigation|maintenance|feature",\n'
            '      "estimated_effort": "quick|moderate|significant",\n'
            '      "why": "Reason this is recommended now"\n'
            "    }\n"
            "  ]\n"
            "}\n"
            "Include up to 5 active_tasks (highest priority first) and up to 3 recommended_actions."
        )

        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            system=system_prompt,
            messages=[{"role": "user", "content": json.dumps(state, default=str)}],
        )

        raw = message.content[0].text.strip()

        # Strip optional markdown fences
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
            if raw.endswith("```"):
                raw = raw[: raw.rfind("```")]

        brief = json.loads(raw)

        # Validate required keys exist
        required = ["summary", "active_tasks", "recent_activity", "system_health", "recommended_actions"]
        for key in required:
            if key not in brief:
                brief[key] = "" if key in ("summary", "recent_activity", "system_health") else []

        return brief

    async def save_and_audit(self, brief: dict[str, Any]) -> None:
        """Persist brief to shared context and write an audit log entry."""
        from ..utils import get_supabase_client

        supabase = get_supabase_client()

        # Save to shared context as situation:latest
        try:
            supabase.table("archon_shared_context").upsert(
                {
                    "context_key": "situation:latest",
                    "value": json.dumps(brief),
                    "set_by": "situation_agent",
                },
                on_conflict="context_key",
            ).execute()
        except Exception as e:
            logger.error(f"Failed to save brief to shared context: {e}", exc_info=True)

        # Write audit log entry
        try:
            supabase.table("unified_audit_log").insert(
                {
                    "source": "situation_agent",
                    "action": "brief_generated",
                    "agent": "claude",
                    "risk_level": "LOW",
                    "outcome": "success",
                    "metadata": {"model": "claude-sonnet-4-6", "task_count": len(brief.get("active_tasks", []))},
                }
            ).execute()
        except Exception as e:
            logger.error(f"Failed to write audit log: {e}", exc_info=True)
