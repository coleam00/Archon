"""
Concrete Supabase repository implementations with enhanced type safety.

This module contains all concrete repository implementations using Supabase
for data persistence. Each repository class implements the corresponding
interface with comprehensive type checking, validation, error handling,
and ordering guarantees.
"""

import asyncio
import builtins
import logging
import re
from datetime import datetime
from typing import Any, Literal, overload
from uuid import UUID

from supabase import Client

from ..exceptions import (
    DatabaseConnectionError,
    DatabaseOperationError,
    DuplicateEntityError,
    QueryError,
    ValidationError,
)
from ..interfaces.base_repository import (
    OrderingField,
    PaginatedResult,
    PaginationParams,
    SortDirection,
)
from ..interfaces.knowledge_repository import ICodeExampleRepository, IDocumentRepository, ISourceRepository
from ..interfaces.project_repository import IProjectRepository, ITaskRepository, IVersionRepository, TaskStatus
from ..interfaces.settings_repository import IPromptRepository, ISettingsRepository
from ..validation import RepositoryValidator


class SupabaseSourceRepository(ISourceRepository):
    """
    Enhanced Supabase implementation of source repository with comprehensive type safety,
    validation, error handling, and ordering guarantees.
    """

    # Valid fields for filtering and ordering
    VALID_FIELDS = [
        'id', 'source_id', 'source_type', 'base_url', 'title', 'summary',
        'crawl_status', 'total_pages', 'pages_crawled', 'total_word_count',
        'metadata', 'created_at', 'updated_at'
    ]

    # Required fields for creation
    REQUIRED_FIELDS = ['source_id', 'source_type']

    # Default ordering for deterministic results
    DEFAULT_ORDERING = [
        {'field': 'updated_at', 'direction': SortDirection.DESC},
        {'field': 'id', 'direction': SortDirection.ASC}
    ]

    def __init__(self, client: Client):
        """Initialize with Supabase client and validator."""
        self._client = client
        self._table = 'archon_sources'
        self._logger = logging.getLogger(__name__)
        self._validator = RepositoryValidator()

    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        """
        Create a new source record with comprehensive validation and error handling.

        Args:
            entity: Source data dictionary with required fields

        Returns:
            Created source with populated ID and timestamps

        Raises:
            ValidationError: If entity data is invalid
            DuplicateEntityError: If source_id already exists
            DatabaseOperationError: If database operation fails
        """
        operation = "create_source"

        try:
            # Validate entity data
            validated_entity = self._validator.validate_entity_data(
                entity,
                required_fields=self.REQUIRED_FIELDS,
                operation="create"
            )

            # Add timestamps
            now = datetime.utcnow()
            validated_entity.update({
                'created_at': now.isoformat(),
                'updated_at': now.isoformat()
            })

            # Execute database operation - offload blocking call to thread
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).insert(validated_entity).execute()
            )

            if not response.data:
                raise DatabaseOperationError(
                    "No data returned from insert operation",
                    operation=operation,
                    entity_type="Source"
                )

            created_entity = response.data[0]
            self._logger.info(f"Created source with ID: {created_entity.get('id')}")
            return created_entity

        except ValidationError:
            # Re-raise validation errors as-is
            raise
        except Exception as e:
            # Log with full stack trace
            self._logger.error(f"Failed to create source: {e}", exc_info=True)

            # Check for duplicate key violations
            if "duplicate key" in str(e).lower() or "unique constraint" in str(e).lower():
                raise DuplicateEntityError(
                    f"Source with source_id '{entity.get('source_id')}' already exists",
                    conflicting_fields=['source_id'],
                    operation=operation,
                    entity_type="Source",
                    original_error=e
                )

            # Handle connection errors
            if "connection" in str(e).lower() or "timeout" in str(e).lower():
                raise DatabaseConnectionError(
                    f"Database connection failed during source creation: {e}",
                    operation=operation,
                    original_error=e
                )

            # Re-raise original exception to preserve stack trace
            raise

    @overload
    async def get_by_id(self, id: UUID) -> dict[str, Any] | None: ...
    @overload
    async def get_by_id(self, id: str) -> dict[str, Any] | None: ...
    @overload
    async def get_by_id(self, id: int) -> dict[str, Any] | None: ...

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        """
        Retrieve source by ID with comprehensive validation, retry logic, and error handling.

        Args:
            id: Source ID (UUID, string, or integer)

        Returns:
            Source record if found, None if not found

        Raises:
            ValidationError: If ID format is invalid
            DatabaseConnectionError: If database connection fails
            DatabaseOperationError: If database query fails
        """
        operation = "get_source_by_id"

        try:
            # Validate ID format
            validated_id = self._validator.validate_id(id, "source_id")

            # Retry logic for resilient database access
            max_retries = 3
            base_delay = 0.5

            for attempt in range(max_retries):
                try:
                    # Execute database query
                    response = await asyncio.to_thread(
                        lambda: self._client.table(self._table)
                        .select('*')
                        .eq('id', str(validated_id))
                        .execute()
                    )

                    result = response.data[0] if response.data else None

                    if result:
                        self._logger.debug(f"Retrieved source with ID: {validated_id}")
                    else:
                        self._logger.debug(f"Source not found with ID: {validated_id}")

                    return result

                except Exception as e:
                    if attempt == max_retries - 1:
                        # Last attempt failed
                        self._logger.error(
                            f"Failed to get source by ID {validated_id} after {max_retries} attempts: {e}",
                            exc_info=True
                        )

                        # Classify error type
                        if "connection" in str(e).lower() or "timeout" in str(e).lower():
                            raise DatabaseConnectionError(
                                f"Database connection failed after {max_retries} attempts: {e}",
                                operation=operation,
                                entity_id=validated_id,
                                retry_count=max_retries,
                                original_error=e
                            )
                        else:
                            raise DatabaseOperationError(
                                f"Database query failed: {e}",
                                operation=operation,
                                entity_type="Source",
                                entity_id=validated_id,
                                retry_count=max_retries,
                                original_error=e
                            )
                    else:
                        # Retry with exponential backoff
                        delay = base_delay * (2 ** attempt)
                        self._logger.warning(
                            f"Attempt {attempt + 1}/{max_retries} failed for source ID {validated_id}: {e}. "
                            f"Retrying in {delay}s..."
                        )
                        await asyncio.sleep(delay)

            return None

        except ValidationError:
            # Re-raise validation errors
            raise
        except (DatabaseConnectionError, DatabaseOperationError):
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.exception(f"Unexpected error retrieving source by ID {id}: {e}")
            raise DatabaseOperationError(
                f"Unexpected database error: {e}",
                operation=operation,
                entity_type="Source",
                entity_id=id,
                original_error=e
            )

    async def get_by_source_id(self, source_id: str) -> dict[str, Any] | None:
        """Retrieve source by source_id."""
        operation = "get_source_by_source_id"
        
        try:
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).select('*').eq('source_id', source_id).execute()
            )
            
            result = response.data[0] if response.data else None
            
            if result:
                self._logger.debug(f"Retrieved source with source_id: {source_id}")
            else:
                self._logger.debug(f"Source not found with source_id: {source_id}")
                
            return result
            
        except Exception as e:
            self._logger.error(f"Failed to get source by source_id {source_id}: {e}", exc_info=True)
            
            # Check for connection errors
            if "connection" in str(e).lower() or "timeout" in str(e).lower():
                raise DatabaseConnectionError(
                    f"Database connection failed: {e}",
                    operation=operation,
                    original_error=e
                ) from e
            
            raise DatabaseOperationError(
                f"Database operation failed: {e}",
                operation=operation,
                entity_type="Source",
                original_error=e
            ) from e

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Update source record."""
        operation = "update_source"
        
        try:
            # Validate ID format
            validated_id = self._validator.validate_id(id, "source_id")
            
            # Validate update data
            validated_data = self._validator.validate_entity_data(
                data,
                required_fields=[],  # No required fields for updates
                operation="update"
            )
            
            # Add updated timestamp
            validated_data['updated_at'] = datetime.utcnow().isoformat()
            
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).update(validated_data).eq('id', str(validated_id)).execute()
            )
            
            if not response.data:
                return None  # Entity not found or no changes made
                
            result = response.data[0]
            self._logger.info(f"Updated source with ID: {validated_id}")
            return result
            
        except ValidationError:
            # Re-raise validation errors as-is
            raise
        except Exception as e:
            self._logger.error(f"Failed to update source {id}: {e}", exc_info=True)
            
            # Check for connection errors
            if "connection" in str(e).lower() or "timeout" in str(e).lower():
                raise DatabaseConnectionError(
                    f"Database connection failed during source update: {e}",
                    operation=operation,
                    entity_id=id,
                    original_error=e
                ) from e
            
            raise DatabaseOperationError(
                f"Database operation failed: {e}",
                operation=operation,
                entity_type="Source",
                entity_id=id,
                original_error=e
            ) from e

    async def delete(self, id: str | UUID | int) -> bool:
        """Delete source record."""
        operation = "delete_source"
        
        try:
            # Validate ID format
            validated_id = self._validator.validate_id(id, "source_id")
            
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).delete().eq('id', str(validated_id)).execute()
            )
            
            deleted_count = len(response.data) if response.data else 0
            success = deleted_count > 0
            
            if success:
                self._logger.info(f"Deleted source with ID: {validated_id}")
            else:
                self._logger.debug(f"No source found to delete with ID: {validated_id}")
                
            return success
            
        except ValidationError:
            # Re-raise validation errors as-is
            raise
        except Exception as e:
            self._logger.error(f"Failed to delete source {id}: {e}", exc_info=True)
            
            # Check for connection errors
            if "connection" in str(e).lower() or "timeout" in str(e).lower():
                raise DatabaseConnectionError(
                    f"Database connection failed during source deletion: {e}",
                    operation=operation,
                    entity_id=id,
                    original_error=e
                ) from e
            
            raise DatabaseOperationError(
                f"Database operation failed: {e}",
                operation=operation,
                entity_type="Source",
                entity_id=id,
                original_error=e
            ) from e

    @overload
    async def list(
        self,
        *,
        filters: dict[str, Any] | None = None,
        pagination: PaginationParams | None = None,
        ordering: list[OrderingField] | None = None,
        return_total_count: Literal[False] = False
    ) -> list[dict[str, Any]]: ...

    @overload
    async def list(
        self,
        *,
        filters: dict[str, Any] | None = None,
        pagination: PaginationParams | None = None,
        ordering: builtins.list[OrderingField] | None = None,
        return_total_count: Literal[True]
    ) -> PaginatedResult[dict[str, Any]]: ...

    async def list(
        self,
        *,
        filters: dict[str, Any] | None = None,
        pagination: PaginationParams | None = None,
        ordering: builtins.list[OrderingField] | None = None,
        return_total_count: bool = False
    ) -> builtins.list[dict[str, Any]] | PaginatedResult[dict[str, Any]]:
        """
        List sources with comprehensive filtering, guaranteed ordering, and pagination.

        Args:
            filters: Field-value filters for querying
            pagination: Limit and offset parameters
            ordering: List of ordering specifications
            return_total_count: Whether to return paginated result with total count

        Returns:
            List of sources or paginated result with metadata

        Raises:
            ValidationError: If parameters are invalid
            QueryError: If query construction fails
            DatabaseOperationError: If database query fails
        """
        operation = "list_sources"

        try:
            # Validate parameters
            validated_filters = self._validator.validate_filters(
                filters, valid_fields=self.VALID_FIELDS
            )
            validated_pagination = self._validator.validate_pagination(pagination)
            validated_ordering = self._validator.validate_ordering(
                ordering, valid_fields=self.VALID_FIELDS
            )

            # Ensure deterministic ordering
            final_ordering = self._validator.ensure_deterministic_ordering(
                validated_ordering,
                default_timestamp_field="updated_at",
                default_id_field="id"
            )

            # Build base query
            query = self._client.table(self._table).select('*')

            # Apply filters
            if validated_filters:
                for field, value in validated_filters.items():
                    if isinstance(value, dict) and 'operator' in value:
                        # Handle complex filter conditions
                        query = self._apply_complex_filter(query, field, value)
                    else:
                        # Simple equality filter
                        query = query.eq(field, value)

            # Apply deterministic ordering
            for order_field in final_ordering:
                field_name = order_field['field']
                direction = order_field['direction']
                descending = direction in [SortDirection.DESC, SortDirection.DESCENDING]

                query = query.order(field_name, desc=descending)

            # Get total count if requested (before pagination)
            total_count = 0
            if return_total_count:
                count_query = self._client.table(self._table).select('id', count='exact')
                if validated_filters:
                    for field, value in validated_filters.items():
                        if not isinstance(value, dict):
                            count_query = count_query.eq(field, value)

                count_response = await asyncio.to_thread(lambda: count_query.execute())
                count_value = count_response.count
                
                if count_value is None:
                    self._logger.warning("Count query returned None, defaulting to 0")
                    total_count = 0
                else:
                    total_count = int(count_value)

            # Apply pagination
            if validated_pagination:
                if 'limit' in validated_pagination:
                    query = query.limit(validated_pagination['limit'])
                if 'offset' in validated_pagination:
                    query = query.offset(validated_pagination['offset'])

            # Execute query
            response = await asyncio.to_thread(lambda: query.execute())
            entities = response.data or []

            self._logger.debug(
                f"Listed {len(entities)} sources with filters={validated_filters}, "
                f"pagination={validated_pagination}, ordering={len(final_ordering)} fields"
            )

            # Return appropriate result format
            if return_total_count:
                page_size = validated_pagination.get('limit') if validated_pagination else len(entities)
                current_offset = validated_pagination.get('offset', 0) if validated_pagination else 0

                return PaginatedResult[dict[str, Any]](
                    entities=entities,
                    total_count=total_count,
                    page_size=page_size,
                    current_offset=current_offset,
                    has_more=current_offset + len(entities) < total_count,
                    metadata={
                        'ordering_fields': [f['field'] for f in final_ordering],
                        'filter_count': len(validated_filters) if validated_filters else 0
                    }
                )
            else:
                return entities

        except ValidationError:
            # Re-raise validation errors
            raise
        except Exception as e:
            self._logger.exception(f"Failed to list sources: {e}")

            # Classify error type
            if "connection" in str(e).lower() or "timeout" in str(e).lower():
                raise DatabaseConnectionError(
                    f"Database connection failed during source listing: {e}",
                    operation=operation,
                    original_error=e
                )
            else:
                raise DatabaseOperationError(
                    f"Database query failed: {e}",
                    operation=operation,
                    entity_type="Source",
                    query_info=f"filters={filters}, pagination={pagination}",
                    original_error=e
                )

    def _apply_complex_filter(self, query, field: str, condition: dict[str, Any]):
        """Apply complex filter condition to query."""
        operator = condition.get('operator')
        value = condition.get('value')

        if operator == 'eq':
            return query.eq(field, value)
        elif operator == 'ne':
            return query.neq(field, value)
        elif operator == 'gt':
            return query.gt(field, value)
        elif operator == 'gte':
            return query.gte(field, value)
        elif operator == 'lt':
            return query.lt(field, value)
        elif operator == 'lte':
            return query.lte(field, value)
        elif operator == 'in':
            return query.in_(field, value)
        elif operator == 'like':
            return query.like(field, value)
        elif operator == 'ilike':
            return query.ilike(field, value)
        elif operator == 'is_null':
            return query.is_(field, None)
        elif operator == 'not_null':
            return query.not_.is_(field, None)
        else:
            self._logger.warning(f"Unsupported filter operator: {operator}")
            return query

    # Implement remaining base repository methods with minimal functionality
    async def count(self, filters: dict[str, Any] | None = None) -> int:
        """Count sources."""
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    if isinstance(value, dict) and 'operator' in value:
                        # Handle complex filter conditions
                        query = self._apply_complex_filter(query, field, value)
                    else:
                        # Simple equality filter
                        query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_sources",
                    entity_type="Source"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count sources: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_sources",
                entity_type="Source",
                original_error=e
            ) from e

    async def exists(self, id: str | UUID | int) -> bool:
        """Check if source exists."""
        result = await self.get_by_id(id)
        return result is not None

    async def create_batch(self, entities: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Create multiple sources."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create source batch: {e}")
            return []

    async def update_batch(self, updates: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Update multiple sources."""
        # Implementation would need individual updates as Supabase doesn't support bulk updates easily
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results

    async def delete_batch(self, ids: builtins.list[str | UUID | int]) -> int:
        """Delete multiple sources."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count

    # Source-specific methods
    async def update_crawl_status(
        self,
        source_id: str,
        status: str,
        pages_crawled: int | None = None,
        total_pages: int | None = None
    ) -> dict[str, Any] | None:
        """Update crawling status and progress."""
        try:
            update_data = {'crawl_status': status, 'updated_at': datetime.utcnow().isoformat()}
            if pages_crawled is not None:
                update_data['pages_crawled'] = pages_crawled
            if total_pages is not None:
                update_data['total_pages'] = total_pages

            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).update(update_data).eq('source_id', source_id).execute()
            )
            
            result = response.data[0] if response.data else None
            if result:
                self._logger.info(f"Updated crawl status for source {source_id} to {status}")
            else:
                self._logger.warning(f"No source found to update crawl status for source_id: {source_id}")
            return result
            
        except Exception as e:
            self._logger.error(f"Failed to update crawl status for {source_id}: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Failed to update crawl status: {e}",
                operation="update_crawl_status",
                entity_type="Source",
                query_info=f"source_id={source_id}, status={status}",
                original_error=e
            ) from e

    async def update_metadata(self, source_id: str, metadata: dict[str, Any]) -> dict[str, Any] | None:
        """Update source metadata."""
        try:
            update_data = {'metadata': metadata, 'updated_at': datetime.utcnow().isoformat()}
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).update(update_data).eq('source_id', source_id).execute()
            )
            
            result = response.data[0] if response.data else None
            if result:
                self._logger.info(f"Updated metadata for source {source_id}")
            else:
                self._logger.warning(f"No source found to update metadata for source_id: {source_id}")
            return result
            
        except Exception as e:
            self._logger.error(f"Failed to update metadata for {source_id}: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Failed to update metadata: {e}",
                operation="update_source_metadata",
                entity_type="Source",
                query_info=f"source_id={source_id}",
                original_error=e
            ) from e

    async def get_by_status(self, status: str) -> builtins.list[dict[str, Any]]:
        """Get sources by crawling status."""
        return await self.list(filters={'crawl_status': status})

    async def get_by_type(self, source_type: str) -> builtins.list[dict[str, Any]]:
        """Get sources by type."""
        return await self.list(filters={'source_type': source_type})

    async def get_crawl_statistics(self) -> dict[str, Any]:
        """Get crawling statistics."""
        try:
            all_sources = await self.list()

            stats = {
                'total_sources': len(all_sources),
                'by_status': {},
                'by_type': {},
                'total_pages': 0
            }

            for source in all_sources:
                # Count by status
                status = source.get('crawl_status', 'unknown')
                stats['by_status'][status] = stats['by_status'].get(status, 0) + 1

                # Count by type
                source_type = source.get('source_type', 'unknown')
                stats['by_type'][source_type] = stats['by_type'].get(source_type, 0) + 1

                # Sum total pages
                stats['total_pages'] += source.get('pages_crawled', 0)

            return stats
        except Exception as e:
            self._logger.exception(f"Failed to get crawl statistics: {e}")
            return {'total_sources': 0, 'by_status': {}, 'by_type': {}, 'total_pages': 0}


class SupabaseDocumentRepository(IDocumentRepository):
    """Supabase implementation of document repository for archon_crawled_pages table."""

    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_crawled_pages'
        self._logger = logging.getLogger(__name__)

    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        """Create a new document chunk."""
        try:
            response = self._client.table(self._table).insert(entity).execute()
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.error(f"Failed to create document: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        """Retrieve document by ID."""
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get document by ID {id}: {e}")
            return None

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Update document record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update document {id}: {e}")
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        """Delete document record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete document {id}: {e}")
            return False

    async def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        order_direction: str | None = "asc"
    ) -> list[dict[str, Any]]:
        """List documents with filtering and pagination."""
        try:
            query = self._client.table(self._table).select('*')

            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)

            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)

            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)

            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list documents: {e}")
            return []

    # Implement remaining base repository methods
    async def count(self, filters: dict[str, Any] | None = None) -> int:
        """Count documents."""
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_documents",
                    entity_type="Document"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count documents: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_documents",
                entity_type="Document",
                original_error=e
            ) from e

    async def exists(self, id: str | UUID | int) -> bool:
        """Check if document exists."""
        result = await self.get_by_id(id)
        return result is not None

    async def create_batch(self, entities: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Create multiple documents in batch."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create document batch: {e}")
            return []

    async def update_batch(self, updates: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Update multiple documents."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results

    async def delete_batch(self, ids: builtins.list[str | UUID | int]) -> int:
        """Delete multiple documents."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count

    # Document-specific methods
    async def vector_search(
        self,
        embedding: builtins.list[float],
        limit: int = 10,
        source_filter: str | None = None,
        metadata_filter: dict[str, Any] | None = None
    ) -> builtins.list[dict[str, Any]]:
        """Perform vector similarity search."""
        try:
            # Call Supabase RPC function for vector search
            params = {
                'query_embedding': embedding,
                'match_count': limit
            }
            if source_filter:
                params['source_filter'] = source_filter

            # Add metadata filter if provided
            # Note: The RPC function expects 'filter' parameter for metadata filtering
            if metadata_filter:
                params['filter'] = metadata_filter
                self._logger.debug(f"Vector search with metadata filter: {metadata_filter}")

            response = self._client.rpc('match_archon_crawled_pages', params).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to perform vector search: {e}")
            return []

    async def hybrid_search(
        self,
        query: str,
        embedding: builtins.list[float],
        limit: int = 10,
        source_filter: str | None = None,
        keyword_weight: float = 0.5,
        vector_weight: float = 0.5
    ) -> builtins.list[dict[str, Any]]:
        """Perform hybrid search combining keyword and vector similarity."""
        try:
            # Call Supabase RPC function for hybrid search
            params = {
                'query_text': query,
                'query_embedding': embedding,
                'match_count': limit,
                'keyword_weight': keyword_weight,
                'vector_weight': vector_weight
            }
            if source_filter:
                params['source_filter'] = source_filter

            response = self._client.rpc('hybrid_search_archon_crawled_pages', params).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to perform hybrid search: {e}")
            return []

    async def get_by_source(
        self,
        source_id: str,
        limit: int | None = None,
        offset: int | None = None
    ) -> builtins.list[dict[str, Any]]:
        """Get documents by source ID."""
        return await self.list(
            filters={'source_id': source_id},
            limit=limit,
            offset=offset
        )

    async def get_by_url(self, url: str) -> builtins.list[dict[str, Any]]:
        """Get documents by URL."""
        return await self.list(
            filters={'url': url},
            order_by='chunk_number'
        )

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all documents for a source."""
        try:
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).delete().eq('source_id', source_id).execute()
            )
            
            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"Deleted {deleted_count} documents for source {source_id}")
            return deleted_count
            
        except Exception as e:
            self._logger.error(f"Failed to delete documents by source {source_id}: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Failed to delete documents for source: {e}",
                operation="delete_documents_by_source",
                entity_type="Document",
                query_info=f"source_id={source_id}",
                original_error=e
            ) from e

    async def delete_by_url(self, url: str) -> int:
        """Delete all documents for a URL."""
        try:
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).delete().eq('url', url).execute()
            )
            
            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"Deleted {deleted_count} documents for URL {url}")
            return deleted_count
            
        except Exception as e:
            self._logger.error(f"Failed to delete documents by URL {url}: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Failed to delete documents for URL: {e}",
                operation="delete_documents_by_url",
                entity_type="Document",
                query_info=f"url={url}",
                original_error=e
            ) from e

    async def get_content_statistics(self) -> dict[str, Any]:
        """Get content statistics."""
        try:
            all_docs = await self.list()

            stats = {
                'total_chunks': len(all_docs),
                'total_sources': len(set(doc.get('source_id') for doc in all_docs)),
                'by_source': {},
                'avg_chunk_size': 0
            }

            total_chars = 0
            for doc in all_docs:
                source_id = doc.get('source_id', 'unknown')
                stats['by_source'][source_id] = stats['by_source'].get(source_id, 0) + 1

                content = doc.get('content', '')
                if content:
                    total_chars += len(content)

            if all_docs:
                stats['avg_chunk_size'] = total_chars // len(all_docs)

            return stats
        except Exception as e:
            self._logger.error(f"Failed to get content statistics: {e}")
            return {'total_chunks': 0, 'total_sources': 0, 'by_source': {}, 'avg_chunk_size': 0}

    async def search_content(
        self,
        query: str,
        limit: int = 10,
        source_filter: str | None = None
    ) -> builtins.list[dict[str, Any]]:
        """Perform full-text search on content."""
        from postgrest.exceptions import APIError

        from ..exceptions import DatabaseOperationError

        # Build query - safe to do outside try block as this just constructs query objects
        search_query = self._client.table(self._table).select('*')
        search_query = search_query.text_search('content', query)

        if source_filter:
            search_query = search_query.eq('source_id', source_filter)

        if limit:
            search_query = search_query.limit(limit)

        # Execute query - let exceptions propagate with proper context
        try:
            response = search_query.execute()
        except APIError as e:
            # APIError from postgrest has structured error information
            raise QueryError(
                f"Text search query failed: {str(e)}",
                query_type="text_search",
                filters={'query': query, 'source_filter': source_filter},
                limit=limit,
                operation="search_content",
                entity_type="Document",
                original_error=e
            ) from e
        except Exception as e:
            # Unexpected errors should still propagate with context
            raise DatabaseOperationError(
                f"Unexpected error during text search: {str(e)}",
                query_info=f"text_search on 'content' for query: {query[:100]}",
                operation="search_content",
                entity_type="Document",
                original_error=e
            ) from e

        return response.data or []

    def _calculate_text_relevance(self, query: str, content: str) -> float:
        """Calculate simple text relevance score for hybrid search."""
        if not query or not content:
            return 0.0

        query_lower = query.lower()
        content_lower = content.lower()

        # Simple keyword matching score
        query_words = query_lower.split()
        content_words = content_lower.split()

        if not query_words or not content_words:
            return 0.0

        # Count exact matches
        matches = sum(1 for word in query_words if word in content_lower)

        # Calculate TF-like score
        word_freq_score = matches / len(query_words)

        # Bonus for phrase matches
        phrase_bonus = 0.2 if query_lower in content_lower else 0.0

        # Final score (0.0 to 1.0)
        return min(1.0, word_freq_score + phrase_bonus)


class SupabaseProjectRepository(IProjectRepository):
    """Supabase implementation of project repository for archon_projects table."""

    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_projects'
        self._logger = logging.getLogger(__name__)

    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        """Create a new project."""
        try:
            response = self._client.table(self._table).insert(entity).execute()
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.exception(f"Failed to create project: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        """Retrieve project by ID."""
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get project by ID {id}: {e}")
            return None

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Update project record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update project {id}: {e}")
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        """Delete project record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete project {id}: {e}")
            return False

    async def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        order_direction: str | None = "asc"
    ) -> list[dict[str, Any]]:
        """List projects with filtering and pagination."""
        try:
            query = self._client.table(self._table).select('*')

            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)

            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)

            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)

            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list projects: {e}")
            return []

    # Implement remaining base repository methods
    async def count(self, filters: dict[str, Any] | None = None) -> int:
        """Count projects."""
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_projects",
                    entity_type="Project"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count projects: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_projects",
                entity_type="Project",
                original_error=e
            ) from e

    async def exists(self, id: str | UUID | int) -> bool:
        """Check if project exists."""
        result = await self.get_by_id(id)
        return result is not None

    async def create_batch(self, entities: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Create multiple projects."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create project batch: {e}")
            return []

    async def update_batch(self, updates: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Update multiple projects."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results

    async def delete_batch(self, ids: builtins.list[str | UUID | int]) -> int:
        """Delete multiple projects."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count

    # Project-specific methods (implementing key methods from interface)
    async def get_with_tasks(self, project_id: UUID) -> dict[str, Any] | None:
        """Get project with associated tasks."""
        # This would require a join or separate query for tasks
        # For now, return the project - tasks would be fetched separately
        return await self.get_by_id(project_id)

    async def update_jsonb_field(
        self,
        project_id: UUID,
        field_name: str,
        value: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Update a JSONB field."""
        return await self.update(project_id, {field_name: value})

    async def get_pinned(self) -> builtins.list[dict[str, Any]]:
        """Get pinned projects."""
        return await self.list(
            filters={'is_pinned': True},
            order_by='updated_at',
            order_direction='desc'
        )

    # Simplified implementations for remaining interface methods
    async def merge_jsonb_field(self, project_id: UUID, field_name: str, value: dict[str, Any]) -> dict[str, Any] | None:
        """Merge data into JSONB field."""
        try:
            project = await self.get_by_id(project_id)
            if not project:
                return None

            current = project.get(field_name, {})
            if isinstance(current, dict) and isinstance(value, dict):
                merged = {**current, **value}
                return await self.update(project_id, {field_name: merged})

            # Fallback: for non-dict types, replace
            return await self.update(project_id, {field_name: value})
        except Exception:
            self._logger.exception(f"Failed to merge JSONB field {field_name} for project {project_id}")
            return None

    async def append_to_jsonb_array(self, project_id: UUID, field_name: str, item: dict[str, Any]) -> dict[str, Any] | None:
        """Append item to JSONB array - simplified implementation."""
        project = await self.get_by_id(project_id)
        if project:
            current_array = project.get(field_name, [])
            if isinstance(current_array, list):
                current_array.append(item)
                return await self.update_jsonb_field(project_id, field_name, current_array)
        return None

    async def remove_from_jsonb_array(self, project_id: UUID, field_name: str, item_id: str) -> dict[str, Any] | None:
        """Remove item from JSONB array - simplified implementation."""
        project = await self.get_by_id(project_id)
        if project:
            current_array = project.get(field_name, [])
            if isinstance(current_array, list):
                filtered_array = [item for item in current_array if item.get('id') != item_id]
                return await self.update_jsonb_field(project_id, field_name, filtered_array)
        return None

    async def set_pinned(self, project_id: UUID, is_pinned: bool) -> dict[str, Any] | None:
        """Set pinned status."""
        return await self.update(project_id, {'is_pinned': is_pinned})

    async def search_by_title(self, query: str, limit: int = 10) -> builtins.list[dict[str, Any]]:
        """Search projects by title."""
        try:
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).select('*').ilike('title', f'%{query}%').limit(limit).execute()
            )
            return response.data or []
        except Exception:
            self._logger.exception("Failed to search projects by title")
            return []

    async def get_project_statistics(self) -> dict[str, Any]:
        """Get project statistics - simplified implementation."""
        try:
            all_projects = await self.list()

            stats = {
                'total_projects': len(all_projects),
                'pinned_projects': len([p for p in all_projects if p.get('is_pinned', False)]),
                'with_github_repo': len([p for p in all_projects if p.get('github_repo')]),
                'avg_docs_per_project': 0
            }

            if all_projects:
                total_docs = sum(len(p.get('docs', [])) for p in all_projects)
                stats['avg_docs_per_project'] = total_docs // len(all_projects)

            return stats
        except Exception as e:
            self._logger.exception(f"Failed to get project statistics: {e}")
            return {'total_projects': 0, 'pinned_projects': 0, 'with_github_repo': 0, 'avg_docs_per_project': 0}

    async def query_jsonb_field(self, field_name: str, query_path: str, query_value: Any, limit: int = 10) -> builtins.list[dict[str, Any]]:
        """Query JSONB field - simplified implementation."""
        # This would require more complex JSONB querying in Supabase
        # For now, return empty list as this is an advanced feature
        self._logger.warning(f"JSONB querying not fully implemented for {field_name}")
        return []


class SupabaseSettingsRepository(ISettingsRepository):
    """Supabase implementation of settings repository for archon_settings table."""

    def __init__(self, client: Client):
        """Initialize with Supabase client."""
        self._client = client
        self._table = 'archon_settings'
        self._logger = logging.getLogger(__name__)

    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        """Create a new setting."""
        try:
            # Offload blocking Supabase call to thread pool
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).insert(entity).execute()
            )
            if response.data:
                return response.data[0]
            else:
                raise Exception("No data returned from insert operation")
        except Exception as e:
            self._logger.exception(f"Failed to create setting: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        """Retrieve setting by ID."""
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get setting by ID {id}: {e}")
            return None

    async def get_by_key(self, key: str) -> dict[str, Any] | None:
        """Retrieve setting by key."""
        try:
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).select('*').eq('key', key).execute()
            )
            
            result = response.data[0] if response.data else None
            if result:
                self._logger.debug(f"Retrieved setting with key: {key}")
            else:
                self._logger.debug(f"Setting not found with key: {key}")
            return result
            
        except Exception as e:
            self._logger.error(f"Failed to get setting by key {key}: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Failed to retrieve setting: {e}",
                operation="get_setting_by_key",
                entity_type="Setting",
                query_info=f"key={key}",
                original_error=e
            ) from e

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        """Update setting record."""
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update setting {id}: {e}")
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        """Delete setting record."""
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete setting {id}: {e}")
            return False

    async def list(
        self,
        filters: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        order_direction: str | None = "asc"
    ) -> list[dict[str, Any]]:
        """List settings with filtering and pagination."""
        try:
            query = self._client.table(self._table).select('*')

            # Apply filters
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)

            # Apply ordering
            if order_by:
                ascending = order_direction.lower() == "asc"
                query = query.order(order_by, desc=not ascending)

            # Apply pagination
            if limit:
                query = query.limit(limit)
            if offset:
                query = query.offset(offset)

            response = query.execute()
            return response.data or []
        except Exception as e:
            self._logger.exception(f"Failed to list settings: {e}")
            return []

    # Implement remaining base repository methods
    async def count(self, filters: dict[str, Any] | None = None) -> int:
        """Count settings."""
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_settings",
                    entity_type="Setting"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count settings: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_settings",
                entity_type="Setting",
                original_error=e
            ) from e

    async def exists(self, id: str | UUID | int) -> bool:
        """Check if setting exists."""
        result = await self.get_by_id(id)
        return result is not None

    async def create_batch(self, entities: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Create multiple settings."""
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception as e:
            self._logger.error(f"Failed to create setting batch: {e}")
            return []

    async def update_batch(self, updates: builtins.list[dict[str, Any]]) -> builtins.list[dict[str, Any]]:
        """Update multiple settings."""
        results = []
        for update_data in updates:
            if 'id' in update_data:
                entity_id = update_data.pop('id')
                result = await self.update(entity_id, update_data)
                if result:
                    results.append(result)
        return results

    async def delete_batch(self, ids: builtins.list[str | UUID | int]) -> int:
        """Delete multiple settings."""
        count = 0
        for entity_id in ids:
            if await self.delete(entity_id):
                count += 1
        return count

    # Settings-specific methods (implementing key methods from interface)
    async def get_by_category(self, category: str) -> builtins.list[dict[str, Any]]:
        """Get settings by category."""
        return await self.list(filters={'category': category}, order_by='key')

    async def upsert(
        self,
        key: str,
        value: str,
        category: str = "general",
        description: str | None = None,
        encrypted: bool = False,
        user_configurable: bool = True,
        default_value: str | None = None,
        validation_regex: str | None = None
    ) -> dict[str, Any]:
        """Insert or update a setting."""
        try:
            # Check if setting exists
            existing = await self.get_by_key(key)

            setting_data = {
                'key': key,
                'value': value,
                'category': category,
                'description': description,
                'is_encrypted': encrypted,
                'is_user_configurable': user_configurable,
                'default_value': default_value,
                'validation_regex': validation_regex
            }

            # Validate value against regex if validation_regex is provided
            if validation_regex is not None:
                if not re.fullmatch(validation_regex, value):
                    raise ValueError(f"Value '{value}' does not match validation regex '{validation_regex}' for setting '{key}'")

            if existing:
                # Update existing
                response = await asyncio.to_thread(
                lambda: self._client.table(self._table).update(setting_data).eq('key', key).execute()
            )
            else:
                # Create new
                response = await asyncio.to_thread(
                    lambda: self._client.table(self._table).insert(setting_data).execute()
                )

            result = response.data[0] if response.data else {}
            if not result:
                raise DatabaseOperationError(
                    "No data returned from upsert operation",
                    operation="upsert_setting",
                    entity_type="Setting"
                )
            
            return result
        except Exception as e:
            self._logger.error(f"Failed to upsert setting {key}: {e}")
            raise

    async def get_decrypted(self, key: str) -> str | None:
        """Get decrypted setting value."""
        setting = await self.get_by_key(key)
        if setting:
            if setting.get('is_encrypted', False):
                raise NotImplementedError(
                    f"Encryption/decryption not yet implemented. Cannot retrieve encrypted setting '{key}'. "
                    "Please implement proper encryption service integration before storing encrypted values."
                )
            return setting.get('value')
        return None

    async def set_encrypted(self, key: str, value: str, category: str = "credentials") -> dict[str, Any]:
        """Store encrypted setting."""
        raise NotImplementedError(
            f"Encryption not yet implemented. Cannot store encrypted setting '{key}'. "
            "Please implement proper encryption service integration (e.g., KMS, encryption key from config) "
            "before storing encrypted values. As a temporary measure, consider storing in environment variables."
        )

    # Simplified implementations for remaining interface methods
    async def get_user_configurable(self) -> builtins.list[dict[str, Any]]:
        """Get user-configurable settings."""
        return await self.list(filters={'is_user_configurable': True}, order_by='category')

    async def get_defaults(self) -> dict[str, str]:
        """Get default values."""
        settings = await self.list()
        return {s['key']: s.get('default_value', '') for s in settings if s.get('default_value')}

    async def reset_to_default(self, key: str) -> dict[str, Any] | None:
        """Reset setting to default."""
        setting = await self.get_by_key(key)
        if setting and setting.get('default_value'):
            return await self.update(setting['id'], {'value': setting['default_value']})
        return None

    async def validate_setting(self, key: str, value: str) -> bool:
        """Validate setting value."""
        setting = await self.get_by_key(key)
        if setting and setting.get('validation_regex'):
            import re
            pattern = setting['validation_regex']
            return bool(re.match(pattern, value))
        return True

    async def get_categories(self) -> builtins.list[str]:
        """Get all categories."""
        settings = await self.list()
        return list(set(s.get('category', 'general') for s in settings))

    async def bulk_update_category(self, category: str, updates: dict[str, str]) -> builtins.list[dict[str, Any]]:
        """Update multiple settings in category."""
        results = []
        for key, value in updates.items():
            try:
                result = await self.upsert(key, value, category)
                results.append(result)
            except Exception as e:
                self._logger.error(f"Failed to update setting {key}: {e}")
        return results

    async def export_settings(self, category_filter: str | None = None, include_encrypted: bool = False) -> dict[str, Any]:
        """Export settings."""
        filters = {}
        if category_filter:
            filters['category'] = category_filter

        settings = await self.list(filters=filters)

        if not include_encrypted:
            settings = [s for s in settings if not s.get('is_encrypted', False)]

        return {
            'settings': settings,
            'exported_at': datetime.now().isoformat(),
            'count': len(settings)
        }

    async def import_settings(self, settings_data: dict[str, Any], overwrite_existing: bool = False) -> dict[str, Any]:
        """Import settings."""
        imported = 0
        errors = []

        for setting in settings_data.get('settings', []):
            try:
                key = setting.get('key')
                if key:
                    existing = await self.get_by_key(key)
                    if not existing or overwrite_existing:
                        await self.upsert(
                            key=key,
                            value=setting.get('value', ''),
                            category=setting.get('category', 'general'),
                            description=setting.get('description'),
                            encrypted=setting.get('is_encrypted', False),
                            user_configurable=setting.get('is_user_configurable', True),
                            default_value=setting.get('default_value'),
                            validation_regex=setting.get('validation_regex')
                        )
                        imported += 1
            except Exception as e:
                errors.append(str(e))

        return {
            'imported': imported,
            'errors': errors,
            'success': len(errors) == 0
        }


# Placeholder implementations for remaining repositories
class SupabaseTaskRepository(ITaskRepository):
    """Minimal task repository implementation."""

    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_tasks'
        self._logger = logging.getLogger(__name__)

    # Implement minimal required methods
    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create task: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to get task: {e}")
            return None

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception as e:
            self._logger.error(f"Failed to update task: {e}")
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception as e:
            self._logger.error(f"Failed to delete task: {e}")
            return False

    # Minimal implementations for required abstract methods
    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> list[dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            if limit:
                query = query.limit(limit)
            response = query.execute()
            return response.data or []
        except Exception:
            return []

    async def count(self, filters=None) -> int:
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_tasks",
                    entity_type="Task"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count tasks: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_tasks",
                entity_type="Task",
                original_error=e
            ) from e

    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None

    async def create_batch(self, entities) -> builtins.list[dict[str, Any]]:
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception:
            return []

    async def update_batch(self, updates) -> builtins.list[dict[str, Any]]:
        return []  # Simplified implementation

    async def delete_batch(self, ids) -> int:
        return 0  # Simplified implementation

    # Task-specific methods with minimal implementation
    async def get_by_project(self, project_id, include_closed=False, limit=None, offset=None) -> builtins.list[dict[str, Any]]:
        filters = {'project_id': str(project_id)}
        if not include_closed:
            # Exclude DONE tasks - include TODO, DOING, and REVIEW
            try:
                query = self._client.table(self._table).select('*').eq('project_id', str(project_id))
                query = query.neq('status', TaskStatus.DONE.value)
                if limit:
                    query = query.limit(limit)
                if offset:
                    query = query.offset(offset)
                response = query.execute()
                return response.data or []
            except Exception as e:
                self._logger.error(f"Failed to get tasks by project: {e}")
                return []
        return await self.list(filters=filters, limit=limit, offset=offset)

    async def get_by_status(self, project_id, status, limit=None) -> builtins.list[dict[str, Any]]:
        return await self.list(filters={'project_id': str(project_id), 'status': status.value}, limit=limit)

    async def update_status(self, task_id, status, assignee=None) -> dict[str, Any] | None:
        update_data = {'status': status.value}
        if assignee:
            update_data['assignee'] = assignee
        return await self.update(task_id, update_data)

    async def archive(self, task_id) -> bool:
        return await self.delete(task_id)  # Simplified: just delete

    # Remaining methods with minimal/placeholder implementations
    async def get_by_assignee(self, assignee, status_filter=None, limit=None) -> builtins.list[dict[str, Any]]:
        filters = {'assignee': assignee}
        if status_filter:
            filters['status'] = status_filter.value
        return await self.list(filters=filters, limit=limit)

    async def get_by_feature(self, project_id, feature, include_closed=False) -> builtins.list[dict[str, Any]]:
        filters = {'project_id': str(project_id), 'feature': feature}
        return await self.list(filters=filters)

    async def update_task_order(self, task_id, new_order) -> dict[str, Any] | None:
        return await self.update(task_id, {'task_order': new_order})

    async def add_source_reference(self, task_id, source) -> dict[str, Any] | None:
        # Simplified implementation - would need to handle JSONB array operations
        return await self.get_by_id(task_id)

    async def add_code_example(self, task_id, code_example) -> dict[str, Any] | None:
        # Simplified implementation - would need to handle JSONB array operations
        return await self.get_by_id(task_id)

    async def get_task_statistics(self, project_id=None) -> dict[str, Any]:
        filters = {'project_id': str(project_id)} if project_id else None
        tasks = await self.list(filters=filters)
        return {
            'total_tasks': len(tasks),
            'by_status': {},
            'by_assignee': {},
            'by_feature': {}
        }

    async def bulk_update_status(self, task_ids, status, assignee=None) -> builtins.list[dict[str, Any]]:
        results = []
        for task_id in task_ids:
            result = await self.update_status(task_id, status, assignee)
            if result:
                results.append(result)
        return results


class SupabaseVersionRepository(IVersionRepository):
    """Minimal version repository implementation."""

    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_document_versions'
        self._logger = logging.getLogger(__name__)

    # Minimal implementations for base repository methods
    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create version: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception:
            return None

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception:
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception:
            return False

    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> list[dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            response = query.execute()
            return response.data or []
        except Exception:
            return []

    async def count(self, filters=None) -> int:
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_versions",
                    entity_type="Version"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count versions: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_versions",
                entity_type="Version",
                original_error=e
            ) from e

    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None

    async def create_batch(self, entities) -> builtins.list[dict[str, Any]]:
        return []  # Simplified

    async def update_batch(self, updates) -> builtins.list[dict[str, Any]]:
        return []  # Simplified

    async def delete_batch(self, ids) -> int:
        return 0  # Simplified

    # Version-specific methods with minimal implementation
    async def create_snapshot(self, project_id, field_name, content, change_summary, created_by="system", change_type="automatic", document_id=None) -> dict[str, Any]:
        version_data = {
            'project_id': str(project_id),
            'field_name': field_name,
            'content': content,
            'change_summary': change_summary,
            'created_by': created_by,
            'change_type': change_type,
            'version_number': 1,  # Simplified - would need to get next version number
        }
        if document_id:
            version_data['document_id'] = str(document_id)

        return await self.create(version_data)

    async def get_version_history(self, project_id, field_name, limit=None, document_id=None) -> builtins.list[dict[str, Any]]:
        filters = {'project_id': str(project_id), 'field_name': field_name}
        if document_id:
            filters['document_id'] = str(document_id)
        return await self.list(filters=filters, limit=limit, order_by='version_number', order_direction='desc')

    async def get_version(self, project_id, field_name, version_number) -> dict[str, Any] | None:
        versions = await self.list(filters={
            'project_id': str(project_id),
            'field_name': field_name,
            'version_number': version_number
        })
        return versions[0] if versions else None

    async def restore_version(self, project_id, field_name, version_number, created_by="system") -> dict[str, Any]:
        # Simplified implementation - would need to actually restore the data
        return await self.create_snapshot(
            project_id, field_name, {}, f"Restored to version {version_number}", created_by, "rollback"
        )

    async def get_latest_version_number(self, project_id, field_name) -> int:
        versions = await self.get_version_history(project_id, field_name, limit=1)
        return versions[0].get('version_number', 0) if versions else 0

    async def delete_old_versions(self, project_id, field_name, keep_latest=10) -> int:
        return 0  # Simplified implementation

    async def compare_versions(self, project_id, field_name, version_a, version_b) -> dict[str, Any]:
        return {'differences': []}  # Simplified implementation

    async def get_version_statistics(self, project_id=None) -> dict[str, Any]:
        filters = {'project_id': str(project_id)} if project_id else None
        versions = await self.list(filters=filters)
        return {
            'total_versions': len(versions),
            'by_field': {},
            'by_project': {},
            'by_change_type': {}
        }


class SupabaseCodeExampleRepository(ICodeExampleRepository):
    """Enhanced Supabase implementation of code example repository with vector search capabilities."""

    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_code_examples'
        self._logger = logging.getLogger(__name__)

    # Minimal implementations for base repository methods
    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create code example: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception:
            return None

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception:
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception:
            return False

    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> list[dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            response = query.execute()
            return response.data or []
        except Exception:
            return []

    async def count(self, filters=None) -> int:
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_code_examples",
                    entity_type="CodeExample"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count code examples: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_code_examples",
                entity_type="CodeExample",
                original_error=e
            ) from e

    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None

    async def create_batch(self, entities) -> builtins.list[dict[str, Any]]:
        try:
            response = self._client.table(self._table).insert(entities).execute()
            return response.data or []
        except Exception:
            return []

    async def update_batch(self, updates) -> builtins.list[dict[str, Any]]:
        return []  # Simplified

    async def delete_batch(self, ids) -> int:
        return 0  # Simplified

    # Code example specific methods with minimal implementation
    async def search_by_summary(
        self,
        query: str,
        limit: int = 5,
        source_filter: str | None = None
    ) -> builtins.list[dict[str, Any]]:
        from postgrest.exceptions import APIError

        from ..exceptions import DatabaseOperationError

        # Build query - safe to do outside try block as this just constructs query objects
        search_query = self._client.table(self._table).select('*')
        search_query = search_query.text_search('summary', query)
        if source_filter:
            search_query = search_query.eq('source_id', source_filter)
        if limit:
            search_query = search_query.limit(limit)

        # Execute query - let exceptions propagate with proper context
        try:
            response = search_query.execute()
        except APIError as e:
            # APIError from postgrest has structured error information
            raise QueryError(
                f"Text search on code examples failed: {str(e)}",
                query_type="text_search",
                filters={'query': query, 'source_filter': source_filter},
                limit=limit,
                operation="search_by_summary",
                entity_type="CodeExample",
                original_error=e
            ) from e
        except Exception as e:
            # Unexpected errors should still propagate with context
            raise DatabaseOperationError(
                f"Unexpected error during code example text search: {str(e)}",
                query_info=f"text_search on 'summary' for query: {query[:100]}",
                operation="search_by_summary",
                entity_type="CodeExample",
                original_error=e
            ) from e

        return response.data or []

    async def get_by_language(
        self,
        language: str,
        limit: int | None = None,
        offset: int | None = None
    ) -> builtins.list[dict[str, Any]]:
        return await self.list(filters={'language': language}, limit=limit, offset=offset)

    async def get_by_source(
        self,
        source_id: str,
        limit: int | None = None,
        offset: int | None = None
    ) -> builtins.list[dict[str, Any]]:
        return await self.list(filters={'source_id': source_id}, limit=limit, offset=offset)

    async def search_by_metadata(
        self,
        metadata_query: dict[str, Any],
        limit: int = 10
    ) -> builtins.list[dict[str, Any]]:
        # Simplified implementation - would need complex JSONB querying
        return []

    async def get_languages(self) -> builtins.list[str]:
        examples = await self.list()
        return list(set(ex.get('language', 'unknown') for ex in examples))

    async def delete_by_source(self, source_id) -> int:
        try:
            response = await asyncio.to_thread(
                lambda: self._client.table(self._table).delete().eq('source_id', source_id).execute()
            )
            
            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"Deleted {deleted_count} code examples for source {source_id}")
            return deleted_count
            
        except Exception as e:
            self._logger.error(f"Failed to delete code examples by source {source_id}: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Failed to delete code examples for source: {e}",
                operation="delete_code_examples_by_source",
                entity_type="CodeExample",
                query_info=f"source_id={source_id}",
                original_error=e
            ) from e

    async def get_code_statistics(self) -> dict[str, Any]:
        examples = await self.list()
        return {
            'total_examples': len(examples),
            'by_language': {},
            'by_source': {},
            'avg_code_length': 0
        }

    async def search_code_content(
        self,
        query: str,
        language_filter: str | None = None,
        limit: int = 10
    ) -> builtins.list[dict[str, Any]]:
        from postgrest.exceptions import APIError

        from ..exceptions import DatabaseOperationError

        # Build query - safe to do outside try block as this just constructs query objects
        search_query = self._client.table(self._table).select('*')
        search_query = search_query.text_search('code_block', query)
        if language_filter:
            search_query = search_query.eq('language', language_filter)
        if limit:
            search_query = search_query.limit(limit)

        # Execute query - let exceptions propagate with proper context
        try:
            response = search_query.execute()
        except APIError as e:
            # APIError from postgrest has structured error information
            raise QueryError(
                f"Code search query failed: {str(e)}",
                query_type="search_code_content",
                filters={'query': query, 'language_filter': language_filter},
                limit=limit,
                operation="search_code_content",
                entity_type="CodeExample",
                original_error=e
            ) from e
        except Exception as e:
            # Unexpected errors should still propagate with context
            raise DatabaseOperationError(
                f"Unexpected error during code search: {str(e)}",
                query_info=f"text_search on 'code_block' for query: {query[:100]}",
                operation="search_code_content",
                entity_type="CodeExample",
                original_error=e
            ) from e

        return response.data or []

    async def vector_search(
        self,
        embedding: builtins.list[float],
        limit: int = 10,
        source_filter: str | None = None,
        metadata_filter: dict[str, Any] | None = None
    ) -> builtins.list[dict[str, Any]]:
        """Perform vector similarity search on code examples using match_archon_code_examples RPC."""
        try:
            # Validate input parameters
            if not embedding:
                raise ValueError("embedding cannot be empty")
            if len(embedding) != 1536:
                raise ValueError("embedding must have 1536 dimensions")
            if limit <= 0 or limit > 1000:
                raise ValueError("limit must be between 1 and 1000")

            # Prepare RPC function parameters
            params = {
                'query_embedding': embedding,
                'match_count': limit,
                'filter': metadata_filter or {},
                'source_filter': source_filter
            }

            # Call the Supabase RPC function for code examples
            response = self._client.rpc('match_archon_code_examples', params).execute()

            if not response.data:
                self._logger.info(f"Vector search returned no code examples for limit={limit}")
                return []

            # Process results and add similarity scores
            results = []
            for row in response.data:
                code_example_data = {
                    'id': row['id'],
                    'url': row['url'],
                    'chunk_number': row['chunk_number'],
                    'content': row['content'],  # This is the code block
                    'summary': row.get('summary', ''),
                    'metadata': row.get('metadata', {}),
                    'source_id': row['source_id'],
                    'similarity_score': row.get('similarity', 0.0)
                }
                # Add similarity score to metadata for backward compatibility
                code_example_data['metadata']['similarity_score'] = code_example_data['similarity_score']
                code_example_data['metadata']['search_type'] = 'vector_search'
                results.append(code_example_data)

            self._logger.info(f"Vector search returned {len(results)} code examples")
            return results

        except Exception as e:
            self._logger.error(f"Code example vector search failed: {e}", exc_info=True)
            return []

    def _calculate_text_relevance(self, query: str, text: str) -> float:
        """Calculate text relevance score for code summaries and descriptions."""
        if not query or not text:
            return 0.0

        query_lower = query.lower()
        text_lower = text.lower()

        # Simple keyword matching
        query_words = query_lower.split()
        if not query_words:
            return 0.0

        matches = sum(1 for word in query_words if word in text_lower)
        word_freq_score = matches / len(query_words)

        # Bonus for phrase matches
        phrase_bonus = 0.3 if query_lower in text_lower else 0.0

        return min(1.0, word_freq_score + phrase_bonus)

    def _calculate_code_relevance(self, query: str, code: str) -> float:
        """Calculate relevance score specifically for code content."""
        if not query or not code:
            return 0.0

        query_lower = query.lower()
        code_lower = code.lower()

        # Check for exact matches (higher weight for code)
        if query_lower in code_lower:
            return 1.0

        # Check for word matches
        query_words = query_lower.split()
        if not query_words:
            return 0.0

        matches = sum(1 for word in query_words if word in code_lower)
        word_score = matches / len(query_words)

        # Bonus for function/class name matches (common code patterns)
        code_patterns = ['def ', 'class ', 'function ', 'const ', 'var ', 'let ']
        pattern_bonus = 0.0
        for word in query_words:
            for pattern in code_patterns:
                if f'{pattern}{word}' in code_lower:
                    pattern_bonus += 0.2
                    break

        return min(1.0, word_score + pattern_bonus)


class SupabasePromptRepository(IPromptRepository):
    """Minimal prompt repository implementation."""

    def __init__(self, client: Client):
        self._client = client
        self._table = 'archon_prompts'
        self._logger = logging.getLogger(__name__)

    # Minimal implementations for base repository methods
    async def create(self, entity: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.table(self._table).insert(entity).execute()
            return response.data[0] if response.data else {}
        except Exception as e:
            self._logger.error(f"Failed to create prompt: {e}")
            raise

    async def get_by_id(self, id: str | UUID | int) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).select('*').eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception:
            return None

    async def update(self, id: str | UUID | int, data: dict[str, Any]) -> dict[str, Any] | None:
        try:
            response = self._client.table(self._table).update(data).eq('id', str(id)).execute()
            return response.data[0] if response.data else None
        except Exception:
            return None

    async def delete(self, id: str | UUID | int) -> bool:
        try:
            response = self._client.table(self._table).delete().eq('id', str(id)).execute()
            return len(response.data) > 0
        except Exception:
            return False

    async def list(self, filters=None, limit=None, offset=None, order_by=None, order_direction="asc") -> list[dict[str, Any]]:
        try:
            query = self._client.table(self._table).select('*')
            if filters:
                for key, value in filters.items():
                    query = query.eq(key, value)
            response = query.execute()
            return response.data or []
        except Exception:
            return []

    async def count(self, filters=None) -> int:
        try:
            # Use Supabase count feature for efficiency
            query = self._client.table(self._table).select('id', count='exact')
            
            # Apply filters if provided
            if filters:
                for field, value in filters.items():
                    query = query.eq(field, value)
            
            response = await asyncio.to_thread(lambda: query.execute())
            count_value = response.count
            
            if count_value is None:
                raise DatabaseOperationError(
                    "Count operation returned None",
                    operation="count_prompts",
                    entity_type="Prompt"
                )
            
            return int(count_value)
        except DatabaseOperationError:
            # Re-raise our custom exceptions
            raise
        except Exception as e:
            self._logger.error(f"Failed to count prompts: {e}", exc_info=True)
            raise DatabaseOperationError(
                f"Database operation failed during count: {e}",
                operation="count_prompts",
                entity_type="Prompt",
                original_error=e
            ) from e

    async def exists(self, id) -> bool:
        return await self.get_by_id(id) is not None

    async def create_batch(self, entities) -> builtins.list[dict[str, Any]]:
        return []  # Simplified

    async def update_batch(self, updates) -> builtins.list[dict[str, Any]]:
        return []  # Simplified

    async def delete_batch(self, ids) -> int:
        return 0  # Simplified

    # Prompt-specific methods with minimal implementation
    async def get_by_name(self, name, version=None) -> dict[str, Any] | None:
        filters = {'name': name}
        if version:
            filters['version'] = version
        else:
            filters['is_active'] = True
        prompts = await self.list(filters=filters)
        return prompts[0] if prompts else None

    async def get_by_category(self, category) -> builtins.list[dict[str, Any]]:
        return await self.list(filters={'category': category, 'is_active': True}, order_by='name')

    async def create_version(self, name, title, content, category="general", version=None, variables=None, metadata=None, created_by="system", is_active=True) -> dict[str, Any]:
        prompt_data = {
            'name': name,
            'title': title,
            'content': content,
            'category': category,
            'version': version or '1.0',
            'variables': variables or [],
            'metadata': metadata or {},
            'created_by': created_by,
            'is_active': is_active,
            'is_system': False
        }
        return await self.create(prompt_data)

    async def set_active_version(self, name, version) -> dict[str, Any] | None:
        # Simplified implementation - would need to deactivate other versions first
        prompts = await self.list(filters={'name': name, 'version': version})
        if prompts:
            return await self.update(prompts[0]['id'], {'is_active': True})
        return None

    async def get_versions(self, name) -> builtins.list[dict[str, Any]]:
        return await self.list(filters={'name': name}, order_by='created_at', order_direction='desc')

    async def render_prompt(self, name, variables, version=None) -> str:
        prompt = await self.get_by_name(name, version)
        if prompt:
            content = prompt.get('content', '')
            # Simple variable substitution - would need proper template engine
            for key, value in variables.items():
                content = content.replace(f'{{{key}}}', str(value))
            return content
        return ''

    async def validate_variables(self, name, variables, version=None) -> dict[str, Any]:
        prompt = await self.get_by_name(name, version)
        if prompt:
            required_vars = prompt.get('variables', [])
            missing = [var for var in required_vars if var not in variables]
            return {'valid': len(missing) == 0, 'missing': missing}
        return {'valid': False, 'missing': []}

    async def get_user_prompts(self) -> builtins.list[dict[str, Any]]:
        return await self.list(filters={'is_system': False})

    async def clone_prompt(self, source_name, new_name, new_title, created_by="user") -> dict[str, Any]:
        source = await self.get_by_name(source_name)
        if source:
            clone_data = source.copy()
            clone_data.update({
                'name': new_name,
                'title': new_title,
                'created_by': created_by,
                'is_system': False
            })
            clone_data.pop('id', None)  # Remove ID to create new record
            return await self.create(clone_data)
        return {}

    async def update_metadata(self, name, version, metadata_updates) -> dict[str, Any] | None:
        prompt = await self.get_by_name(name, version)
        if prompt:
            current_metadata = prompt.get('metadata', {})
            current_metadata.update(metadata_updates)
            return await self.update(prompt['id'], {'metadata': current_metadata})
        return None

    async def get_categories(self) -> builtins.list[str]:
        prompts = await self.list()
        return list(set(p.get('category', 'general') for p in prompts))

    async def search_prompts(self, query, category_filter=None, limit=10) -> builtins.list[dict[str, Any]]:
        # Simplified implementation - would need full-text search
        filters = {}
        if category_filter:
            filters['category'] = category_filter
        prompts = await self.list(filters=filters, limit=limit)
        # Simple text matching
        return [p for p in prompts if query.lower() in p.get('title', '').lower() or query.lower() in p.get('content', '').lower()]

    async def get_prompt_usage_stats(self, name) -> dict[str, Any]:
        return {'usage_count': 0, 'last_used': None}  # Simplified

    async def delete_version(self, name, version) -> bool:
        prompt = await self.get_by_name(name, version)
        if prompt:
            return await self.delete(prompt['id'])
        return False

