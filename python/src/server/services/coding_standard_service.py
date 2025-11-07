"""Coding Standard Service

Provides business logic for managing coding standards (linter configs, style guides, etc.).
"""

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from ..models.template_models import CodingStandard, CreateCodingStandardRequest, UpdateCodingStandardRequest
from ..utils import get_supabase_client

logger = logging.getLogger(__name__)


class CodingStandardNotFoundError(Exception):
    """Raised when coding standard is not found"""

    pass


class DuplicateCodingStandardError(Exception):
    """Raised when coding standard slug already exists"""

    pass


class CodingStandardService:
    """Service for managing coding standards

    Handles CRUD operations for coding standards (linter configs, style guides, etc.).
    Standards are language-specific and can be assigned to agents/repositories.
    """

    def __init__(self) -> None:
        """Initialize coding standard service with Supabase client"""
        self.client = get_supabase_client()
        self.table_name = "archon_coding_standards"
        logger.info("Coding standard service initialized for table: %s", self.table_name)

    def _row_to_model(self, row: dict[str, Any]) -> CodingStandard:
        """Convert database row to CodingStandard model

        Args:
            row: Database row dictionary

        Returns:
            CodingStandard model instance
        """
        return CodingStandard(
            id=row["id"],
            slug=row["slug"],
            name=row["name"],
            language=row["language"],
            description=row.get("description"),
            standards=row.get("standards", {}),
            metadata=row.get("metadata", {}),
            is_active=row.get("is_active", True),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def list_coding_standards(
        self, language: str | None = None, is_active: bool | None = None
    ) -> list[CodingStandard]:
        """List coding standards with optional filtering

        Args:
            language: Filter by programming language (e.g., 'python', 'typescript')
            is_active: Filter by active status

        Returns:
            List of coding standards

        Raises:
            Exception: If database query fails
        """
        logger.info("List coding standards called: language=%s, is_active=%s", language, is_active)

        try:
            query = self.client.table(self.table_name).select("*")

            if language is not None:
                query = query.eq("language", language)

            if is_active is not None:
                query = query.eq("is_active", is_active)

            result = query.order("language").order("name").execute()
            standards = [self._row_to_model(row) for row in result.data]

            logger.info("Retrieved %d coding standards", len(standards))
            return standards

        except Exception as e:
            logger.error("Failed to list coding standards: %s", e, exc_info=True)
            raise

    async def get_coding_standard(self, slug: str) -> CodingStandard | None:
        """Get coding standard by slug

        Args:
            slug: Coding standard slug

        Returns:
            CodingStandard if found, None otherwise

        Raises:
            Exception: If database query fails
        """
        logger.info("Get coding standard called: slug=%s", slug)

        try:
            result = self.client.table(self.table_name).select("*").eq("slug", slug).eq("is_active", True).execute()

            if not result.data:
                logger.warning("Coding standard not found: %s", slug)
                return None

            standard = self._row_to_model(result.data[0])
            logger.info("Retrieved coding standard: %s", slug)
            return standard

        except Exception as e:
            logger.error("Failed to get coding standard %s: %s", slug, e, exc_info=True)
            raise

    async def create_coding_standard(self, request: CreateCodingStandardRequest) -> CodingStandard:
        """Create new coding standard

        Args:
            request: Coding standard creation request

        Returns:
            Created CodingStandard

        Raises:
            DuplicateCodingStandardError: If slug already exists
            Exception: If database operation fails
        """
        logger.info("Create coding standard called: slug=%s, language=%s", request.slug, request.language)

        try:
            # Check for duplicate slug
            existing = (
                self.client.table(self.table_name).select("id").eq("slug", request.slug).eq("is_active", True).execute()
            )

            if existing.data:
                error_msg = f"Coding standard with slug '{request.slug}' already exists"
                logger.error(error_msg)
                raise DuplicateCodingStandardError(error_msg)

            # Create standard
            now = datetime.now(UTC).isoformat()
            standard_data = {
                "id": str(uuid4()),
                "slug": request.slug,
                "name": request.name,
                "language": request.language,
                "description": request.description,
                "standards": request.standards,
                "metadata": request.metadata,
                "is_active": True,
                "created_at": now,
                "updated_at": now,
            }

            result = self.client.table(self.table_name).insert(standard_data).execute()

            standard = self._row_to_model(result.data[0])
            logger.info("Created coding standard: %s", standard.slug)
            return standard

        except DuplicateCodingStandardError:
            raise
        except Exception as e:
            logger.error("Failed to create coding standard: %s", e, exc_info=True)
            raise

    async def update_coding_standard(self, slug: str, request: UpdateCodingStandardRequest) -> CodingStandard:
        """Update existing coding standard

        Args:
            slug: Coding standard slug to update
            request: Update request with fields to change

        Returns:
            Updated CodingStandard

        Raises:
            CodingStandardNotFoundError: If standard not found
            Exception: If database operation fails
        """
        logger.info("Update coding standard called: slug=%s", slug)

        try:
            # Check if standard exists
            existing = (
                self.client.table(self.table_name).select("*").eq("slug", slug).eq("is_active", True).execute()
            )

            if not existing.data:
                error_msg = f"Coding standard not found: {slug}"
                logger.error(error_msg)
                raise CodingStandardNotFoundError(error_msg)

            # Build update dict with only provided fields
            update_data: dict[str, Any] = {"updated_at": datetime.now(UTC).isoformat()}

            if request.name is not None:
                update_data["name"] = request.name
            if request.description is not None:
                update_data["description"] = request.description
            if request.language is not None:
                update_data["language"] = request.language
            if request.standards is not None:
                update_data["standards"] = request.standards
            if request.metadata is not None:
                update_data["metadata"] = request.metadata

            # Update standard
            result = self.client.table(self.table_name).update(update_data).eq("slug", slug).execute()

            standard = self._row_to_model(result.data[0])
            logger.info("Updated coding standard: %s", slug)
            return standard

        except CodingStandardNotFoundError:
            raise
        except Exception as e:
            logger.error("Failed to update coding standard %s: %s", slug, e, exc_info=True)
            raise

    async def delete_coding_standard(self, slug: str) -> None:
        """Soft delete coding standard by setting is_active=False

        Args:
            slug: Coding standard slug to delete

        Raises:
            CodingStandardNotFoundError: If standard not found
            Exception: If database operation fails
        """
        logger.info("Delete coding standard called: slug=%s", slug)

        try:
            # Check if standard exists
            existing = (
                self.client.table(self.table_name).select("id").eq("slug", slug).eq("is_active", True).execute()
            )

            if not existing.data:
                error_msg = f"Coding standard not found: {slug}"
                logger.error(error_msg)
                raise CodingStandardNotFoundError(error_msg)

            # Soft delete
            self.client.table(self.table_name).update(
                {"is_active": False, "updated_at": datetime.now(UTC).isoformat()}
            ).eq("slug", slug).execute()

            logger.info("Deleted coding standard: %s", slug)

        except CodingStandardNotFoundError:
            raise
        except Exception as e:
            logger.error("Failed to delete coding standard %s: %s", slug, e, exc_info=True)
            raise
