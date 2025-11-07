"""Repository Agent Override Repository

Manages agent tool/standard overrides for specific repositories.
"""

import os
from datetime import UTC, datetime
from typing import Any

from supabase import Client, create_client

from ..models import RepositoryAgentOverride
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


def get_supabase_client() -> Client:
    """Get Supabase client (reuse from repository_config_repository)"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise ValueError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set"
        )

    return create_client(url, key)


class RepositoryAgentOverrideRepository:
    """Repository for managing agent overrides per repository"""

    def __init__(self) -> None:
        self.client: Client = get_supabase_client()
        self.table_name: str = "archon_repository_agent_overrides"
        self._logger = logger.bind(table=self.table_name)
        self._logger.info("repository_agent_override_repository_initialized")

    def _row_to_model(self, row: dict[str, Any]) -> RepositoryAgentOverride:
        """Convert database row to model"""
        return RepositoryAgentOverride(
            id=row["id"],
            repository_id=row["repository_id"],
            agent_template_id=row["agent_template_id"],
            override_tools=row.get("override_tools"),
            override_standards=row.get("override_standards"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def list_by_repository(
        self,
        repository_id: str
    ) -> list[RepositoryAgentOverride]:
        """List all agent overrides for a repository"""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("repository_id", repository_id)
                .execute()
            )

            overrides = [self._row_to_model(row) for row in response.data]

            self._logger.info(
                "agent_overrides_listed",
                repository_id=repository_id,
                count=len(overrides)
            )

            return overrides

        except Exception as e:
            self._logger.exception(
                "list_agent_overrides_failed",
                repository_id=repository_id,
                error=str(e)
            )
            raise

    async def get_override(
        self,
        repository_id: str,
        agent_template_id: str
    ) -> RepositoryAgentOverride | None:
        """Get specific agent override for repository"""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("repository_id", repository_id)
                .eq("agent_template_id", agent_template_id)
                .execute()
            )

            if not response.data:
                return None

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.exception(
                "get_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

    async def create_override(
        self,
        repository_id: str,
        agent_template_id: str,
        override_tools: list[str] | None = None,
        override_standards: dict[str, Any] | None = None,
    ) -> RepositoryAgentOverride:
        """Create agent override for repository"""
        try:
            data: dict[str, Any] = {
                "repository_id": repository_id,
                "agent_template_id": agent_template_id,
                "override_tools": override_tools,
                "override_standards": override_standards,
            }

            response = self.client.table(self.table_name).insert(data).execute()

            override = self._row_to_model(response.data[0])

            self._logger.info(
                "agent_override_created",
                override_id=override.id,
                repository_id=repository_id,
                agent_template_id=agent_template_id
            )

            return override

        except Exception as e:
            self._logger.exception(
                "create_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

    async def update_override(
        self,
        repository_id: str,
        agent_template_id: str,
        **updates: Any
    ) -> RepositoryAgentOverride | None:
        """Update agent override"""
        try:
            updates["updated_at"] = datetime.now(UTC).isoformat()

            response = (
                self.client.table(self.table_name)
                .update(updates)
                .eq("repository_id", repository_id)
                .eq("agent_template_id", agent_template_id)
                .execute()
            )

            if not response.data:
                return None

            override = self._row_to_model(response.data[0])

            self._logger.info(
                "agent_override_updated",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                updated_fields=list(updates.keys())
            )

            return override

        except Exception as e:
            self._logger.exception(
                "update_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

    async def delete_override(
        self,
        repository_id: str,
        agent_template_id: str
    ) -> bool:
        """Delete agent override"""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("repository_id", repository_id)
                .eq("agent_template_id", agent_template_id)
                .execute()
            )

            deleted = len(response.data) > 0

            if deleted:
                self._logger.info(
                    "agent_override_deleted",
                    repository_id=repository_id,
                    agent_template_id=agent_template_id
                )

            return deleted

        except Exception as e:
            self._logger.exception(
                "delete_agent_override_failed",
                repository_id=repository_id,
                agent_template_id=agent_template_id,
                error=str(e)
            )
            raise

