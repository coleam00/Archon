"""Repository Configuration Repository

Provides database operations for managing configured GitHub repositories.
Stores repository metadata, verification status, and per-repository preferences.
"""

import os
from datetime import UTC, datetime
from typing import Any

from supabase import Client, create_client

from ..models import ConfiguredRepository, SandboxType, WorkflowStep
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


def get_supabase_client() -> Client:
    """Get a Supabase client instance for agent work orders.

    Returns:
        Supabase client instance

    Raises:
        ValueError: If environment variables are not set
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise ValueError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment variables"
        )

    return create_client(url, key)


class RepositoryConfigRepository:
    """Repository for managing configured repositories in Supabase

    Provides CRUD operations for the archon_configured_repositories table.
    Uses the same Supabase client as the main Archon server for consistency.

    Architecture Note - async/await Pattern:
        All repository methods are declared as `async def` for interface consistency
        with other repository implementations (FileStateRepository, WorkOrderRepository),
        even though the Supabase Python client's operations are synchronous.

        This design choice maintains a consistent async API contract across all
        repository implementations, allowing them to be used interchangeably without
        caller code changes. The async signature enables future migration to truly
        async database clients (e.g., asyncpg) without breaking the interface.

        Current behavior: Methods don't await Supabase operations (which are sync),
        but callers should still await repository method calls for forward compatibility.
    """

    def __init__(self) -> None:
        """Initialize repository with Supabase client"""
        self.client: Client = get_supabase_client()
        self.table_name: str = "archon_configured_repositories"
        self._logger = logger.bind(table=self.table_name)
        self._logger.info("repository_config_repository_initialized")

    def _row_to_model(self, row: dict[str, Any]) -> ConfiguredRepository:
        """Convert database row to ConfiguredRepository model

        Args:
            row: Database row dictionary

        Returns:
            ConfiguredRepository model instance

        Raises:
            ValueError: If row contains invalid enum values that cannot be converted
        """
        repository_id = row.get("id", "unknown")

        # Convert default_commands from list of strings to list of WorkflowStep enums
        default_commands_raw = row.get("default_commands", [])
        try:
            default_commands = [WorkflowStep(cmd) for cmd in default_commands_raw]
        except ValueError as e:
            self._logger.error(
                "invalid_workflow_step_in_database",
                repository_id=repository_id,
                invalid_commands=default_commands_raw,
                error=str(e),
                exc_info=True
            )
            raise ValueError(
                f"Database contains invalid workflow steps for repository {repository_id}: {default_commands_raw}"
            ) from e

        # Convert default_sandbox_type from string to SandboxType enum
        sandbox_type_raw = row.get("default_sandbox_type", "git_worktree")
        try:
            sandbox_type = SandboxType(sandbox_type_raw)
        except ValueError as e:
            self._logger.error(
                "invalid_sandbox_type_in_database",
                repository_id=repository_id,
                invalid_type=sandbox_type_raw,
                error=str(e),
                exc_info=True
            )
            raise ValueError(
                f"Database contains invalid sandbox type for repository {repository_id}: {sandbox_type_raw}"
            ) from e

        return ConfiguredRepository(
            id=row["id"],
            repository_url=row["repository_url"],
            display_name=row.get("display_name"),
            owner=row.get("owner"),
            default_branch=row.get("default_branch"),
            is_verified=row.get("is_verified", False),
            last_verified_at=row.get("last_verified_at"),
            default_sandbox_type=sandbox_type,
            default_commands=default_commands,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def list_repositories(self) -> list[ConfiguredRepository]:
        """List all configured repositories

        Returns:
            List of ConfiguredRepository models ordered by created_at DESC.
            Invalid rows (with bad enum values) are skipped and logged.

        Raises:
            Exception: If database query fails
        """
        try:
            response = self.client.table(self.table_name).select("*").order("created_at", desc=True).execute()

            repositories = [self._row_to_model(row) for row in response.data]

            self._logger.info(
                "repositories_listed",
                count=len(repositories)
            )

            return repositories

        except Exception as e:
            self._logger.exception(
                "list_repositories_failed",
                error=str(e)
            )
            raise

    async def get_repository(self, repository_id: str) -> ConfiguredRepository | None:
        """Get a single repository by ID

        Args:
            repository_id: UUID of the repository

        Returns:
            ConfiguredRepository model or None if not found

        Raises:
            Exception: If database query fails
            ValueError: If repository data contains invalid enum values
        """
        try:
            response = self.client.table(self.table_name).select("*").eq("id", repository_id).execute()

            if not response.data:
                self._logger.info(
                    "repository_not_found",
                    repository_id=repository_id
                )
                return None

            repository = self._row_to_model(response.data[0])

            self._logger.info(
                "repository_retrieved",
                repository_id=repository_id,
                repository_url=repository.repository_url
            )

            return repository

        except Exception as e:
            self._logger.exception(
                "get_repository_failed",
                repository_id=repository_id,
                error=str(e)
            )
            raise

    async def create_repository(
        self,
        repository_url: str,
        display_name: str | None = None,
        owner: str | None = None,
        default_branch: str | None = None,
        is_verified: bool = False,
    ) -> ConfiguredRepository:
        """Create a new configured repository

        Args:
            repository_url: GitHub repository URL
            display_name: Human-readable repository name (e.g., "owner/repo")
            owner: Repository owner/organization
            default_branch: Default branch name (e.g., "main")
            is_verified: Whether repository access has been verified

        Returns:
            Created ConfiguredRepository model

        Raises:
            Exception: If database insert fails (e.g., unique constraint violation)
        """
        try:
            # Prepare data for insertion
            data: dict[str, Any] = {
                "repository_url": repository_url,
                "display_name": display_name,
                "owner": owner,
                "default_branch": default_branch,
                "is_verified": is_verified,
            }

            # Set last_verified_at if verified
            if is_verified:
                data["last_verified_at"] = datetime.now(UTC).isoformat()

            response = self.client.table(self.table_name).insert(data).execute()

            repository = self._row_to_model(response.data[0])

            self._logger.info(
                "repository_created",
                repository_id=repository.id,
                repository_url=repository_url,
                is_verified=is_verified
            )

            return repository

        except Exception as e:
            self._logger.exception(
                "create_repository_failed",
                repository_url=repository_url,
                error=str(e)
            )
            raise

    async def update_repository(
        self,
        repository_id: str,
        **updates: Any
    ) -> ConfiguredRepository | None:
        """Update an existing repository

        Args:
            repository_id: UUID of the repository
            **updates: Fields to update (any valid column name)

        Returns:
            Updated ConfiguredRepository model or None if not found

        Raises:
            Exception: If database update fails
        """
        try:
            # Convert enum values to strings for database storage
            prepared_updates: dict[str, Any] = {}
            for key, value in updates.items():
                if isinstance(value, SandboxType):
                    prepared_updates[key] = value.value
                elif isinstance(value, list) and value and all(isinstance(item, WorkflowStep) for item in value):
                    prepared_updates[key] = [step.value for step in value]
                else:
                    prepared_updates[key] = value

            # Always update updated_at timestamp
            prepared_updates["updated_at"] = datetime.now(UTC).isoformat()

            response = (
                self.client.table(self.table_name)
                .update(prepared_updates)
                .eq("id", repository_id)
                .execute()
            )

            if not response.data:
                self._logger.info(
                    "repository_not_found_for_update",
                    repository_id=repository_id
                )
                return None

            repository = self._row_to_model(response.data[0])

            self._logger.info(
                "repository_updated",
                repository_id=repository_id,
                updated_fields=list(updates.keys())
            )

            return repository

        except Exception as e:
            self._logger.exception(
                "update_repository_failed",
                repository_id=repository_id,
                error=str(e)
            )
            raise

    async def delete_repository(self, repository_id: str) -> bool:
        """Delete a repository by ID

        Args:
            repository_id: UUID of the repository

        Returns:
            True if deleted, False if not found

        Raises:
            Exception: If database delete fails
        """
        try:
            response = self.client.table(self.table_name).delete().eq("id", repository_id).execute()

            deleted = len(response.data) > 0

            if deleted:
                self._logger.info(
                    "repository_deleted",
                    repository_id=repository_id
                )
            else:
                self._logger.info(
                    "repository_not_found_for_delete",
                    repository_id=repository_id
                )

            return deleted

        except Exception as e:
            self._logger.exception(
                "delete_repository_failed",
                repository_id=repository_id,
                error=str(e)
            )
            raise
