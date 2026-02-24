"""
Agent Registry Service for Archon Shared Memory.

Enables agents to register themselves, broadcast capabilities, send heartbeats,
and discover other agents in the multi-agent ecosystem.
"""
from datetime import UTC, datetime

from ..config.logfire_config import get_logger
from ..utils import get_supabase_client

logger = get_logger(__name__)


class AgentRegistryService:
    """Service for managing the agent registry."""

    def __init__(self):
        """Initialize the agent registry service."""
        self.supabase = get_supabase_client()

    async def register_agent(
        self,
        name: str,
        capabilities: list[str] | None = None,
        metadata: dict | None = None,
        role: str | None = None,
    ) -> dict:
        """
        Register or update an agent in the registry.

        Uses upsert by name so repeated calls update the existing record and
        refresh last_seen rather than creating duplicates.

        Args:
            name: Unique agent name (e.g. "claude", "gemini")
            capabilities: List of capability strings
            metadata: Arbitrary metadata dict

        Returns:
            Upserted agent record
        """
        try:
            logger.info(f"Registering agent: {name}")
            agent_data = {
                "name": name,
                "capabilities": capabilities or [],
                "status": "active",
                "last_seen": datetime.now(UTC).isoformat(),
                "metadata": metadata or {},
            }
            if role is not None:
                agent_data["role"] = role
            response = (
                self.supabase.table("archon_agent_registry")
                .upsert(agent_data, on_conflict="name")
                .execute()
            )
            if not response.data:
                raise Exception("Agent registration returned no data")
            agent = response.data[0]
            logger.info(f"Agent registered: {agent['id']} ({name})")
            return agent
        except Exception as e:
            logger.error(f"Failed to register agent {name}: {e}", exc_info=True)
            raise

    async def heartbeat(self, name: str) -> dict:
        """
        Update an agent's last_seen timestamp and ensure status is active.

        Args:
            name: Agent name

        Returns:
            Updated agent record
        """
        try:
            response = (
                self.supabase.table("archon_agent_registry")
                .update({"last_seen": datetime.now(UTC).isoformat(), "status": "active"})
                .eq("name", name)
                .execute()
            )
            if not response.data:
                raise Exception(f"Agent '{name}' not found for heartbeat")
            return response.data[0]
        except Exception as e:
            logger.error(f"Failed heartbeat for agent {name}: {e}", exc_info=True)
            raise

    async def get_agent(self, name: str) -> dict | None:
        """
        Get an agent by name.

        Args:
            name: Agent name

        Returns:
            Agent record or None if not found
        """
        try:
            response = (
                self.supabase.table("archon_agent_registry")
                .select("*")
                .eq("name", name)
                .execute()
            )
            if not response.data:
                return None
            return response.data[0]
        except Exception as e:
            logger.error(f"Failed to get agent {name}: {e}", exc_info=True)
            raise

    async def list_agents(self, status: str | None = None) -> list[dict]:
        """
        List all registered agents with optional status filter.

        Args:
            status: Optional filter — "active", "inactive", or "busy"

        Returns:
            List of agent records ordered by last_seen descending
        """
        try:
            query = self.supabase.table("archon_agent_registry").select("*")
            if status:
                query = query.eq("status", status)
            response = query.order("last_seen", desc=True).execute()
            return response.data or []
        except Exception as e:
            logger.error(f"Failed to list agents: {e}", exc_info=True)
            raise

    async def update_agent(
        self,
        name: str,
        capabilities: list[str] | None = None,
        metadata: dict | None = None,
        status: str | None = None,
        role: str | None = None,
    ) -> dict:
        """
        Update an existing agent's fields. Only provided (non-None) values are written;
        omitted fields are left unchanged in the database.

        Args:
            name: Agent name (used to locate the record)
            capabilities: Updated capability list
            metadata: Updated metadata dict
            status: Updated status string
            role: Updated role string

        Returns:
            Updated agent record
        """
        try:
            update_data: dict = {}
            if capabilities is not None:
                update_data["capabilities"] = capabilities
            if metadata is not None:
                update_data["metadata"] = metadata
            if status is not None:
                update_data["status"] = status
            if role is not None:
                update_data["role"] = role
            if not update_data:
                raise ValueError("No fields provided to update")
            response = (
                self.supabase.table("archon_agent_registry")
                .update(update_data)
                .eq("name", name)
                .execute()
            )
            if not response.data:
                raise Exception(f"Agent '{name}' not found for update")
            agent = response.data[0]
            logger.info(f"Agent updated: {name} | fields={list(update_data)}")
            return agent
        except Exception as e:
            logger.error(f"Failed to update agent {name}: {e}", exc_info=True)
            raise

    async def deactivate_agent(self, name: str) -> dict:
        """
        Set an agent's status to inactive.

        Args:
            name: Agent name

        Returns:
            Updated agent record
        """
        try:
            response = (
                self.supabase.table("archon_agent_registry")
                .update({"status": "inactive"})
                .eq("name", name)
                .execute()
            )
            if not response.data:
                raise Exception(f"Agent '{name}' not found for deactivation")
            return response.data[0]
        except Exception as e:
            logger.error(f"Failed to deactivate agent {name}: {e}", exc_info=True)
            raise


# Singleton instance
_agent_registry_service: AgentRegistryService | None = None


def get_agent_registry_service() -> AgentRegistryService:
    """Get or create the singleton AgentRegistryService instance."""
    global _agent_registry_service
    if _agent_registry_service is None:
        _agent_registry_service = AgentRegistryService()
    return _agent_registry_service
