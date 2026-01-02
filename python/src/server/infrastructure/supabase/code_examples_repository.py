"""
Supabase implementation of ICodeExamplesRepository.

Uses Supabase PostgREST client for CRUD operations and RPC for vector search.
"""

import json
from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger
from ...domain.interfaces.code_examples_repository import ICodeExamplesRepository
from ...domain.models.code_example import CodeExample, CodeExampleCreate
from ...domain.models.search_result import SearchResult

logger = get_logger(__name__)

# Similarity threshold for vector search results
SIMILARITY_THRESHOLD = 0.05


class SupabaseCodeExamplesRepository(ICodeExamplesRepository):
    """
    Supabase-backed repository for code examples.

    Uses the archon_code_examples table for storage and
    match_archon_code_examples RPC for vector similarity search.

    Args:
        client: Supabase client instance
        table_name: Name of the code examples table (default: archon_code_examples)
    """

    def __init__(self, client: Client, table_name: str = "archon_code_examples"):
        self.client = client
        self.table_name = table_name
        self._logger = logger.bind(repository="SupabaseCodeExamplesRepository")

    def _row_to_model(self, row: dict[str, Any]) -> CodeExample:
        """Convert a database row to a CodeExample model."""
        metadata = row.get("metadata", {})
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except json.JSONDecodeError as e:
                self._logger.error(
                    f"Failed to parse metadata JSON: {e}",
                    id=row.get("id"),
                    exc_info=True
                )
                metadata = {}  # Fall back to empty metadata

        return CodeExample(
            id=str(row["id"]) if row.get("id") else None,
            source_id=row.get("source_id", ""),
            page_url=row.get("page_url", ""),
            code=row.get("code", ""),
            language=row.get("language"),
            summary=row.get("summary"),
            context=row.get("context"),
            metadata=metadata,
            embedding_768=row.get("embedding_768"),
            embedding_1024=row.get("embedding_1024"),
            embedding_1536=row.get("embedding_1536"),
            embedding_3072=row.get("embedding_3072"),
            embedding_model=row.get("embedding_model"),
            embedding_dimension=row.get("embedding_dimension"),
            created_at=row.get("created_at"),
        )

    async def get_by_id(self, id: str) -> CodeExample | None:
        """Get a code example by its ID."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("id", id)
                .execute()
            )

            if not response.data:
                return None

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"get_by_id failed: {e}", id=id, exc_info=True)
            raise

    async def find_by_source(self, source_id: str) -> list[CodeExample]:
        """Find all code examples for a given source."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("source_id", source_id)
                .order("created_at", desc=True)
                .execute()
            )

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"find_by_source failed: {e}", source_id=source_id, exc_info=True)
            raise

    async def find_by_page_url(self, page_url: str) -> list[CodeExample]:
        """Find all code examples from a specific page."""
        try:
            response = (
                self.client.table(self.table_name)
                .select("*")
                .eq("page_url", page_url)
                .order("created_at")
                .execute()
            )

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"find_by_page_url failed: {e}", page_url=page_url, exc_info=True)
            raise

    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        source_id: str | None = None,
        language: str | None = None,
    ) -> list[SearchResult[CodeExample]]:
        """
        Search for code examples similar to the given embedding.

        Uses the match_archon_code_examples RPC function for vector search.

        Note:
            Language filtering is applied post-query, which means fewer than
            `match_count` results may be returned if many top matches don't
            match the specified language. For guaranteed result counts with
            language filtering, consider fetching more results and truncating.
        """
        try:
            # Build RPC parameters
            rpc_params: dict[str, Any] = {
                "query_embedding": embedding,
                "match_count": match_count,
                "filter": {},
            }

            # Add source filter
            if source_id:
                rpc_params["source_filter"] = source_id

            # Execute RPC
            response = self.client.rpc("match_archon_code_examples", rpc_params).execute()

            # Process results
            results: list[SearchResult[CodeExample]] = []
            if response.data:
                for row in response.data:
                    similarity = float(row.get("similarity", 0.0))
                    if similarity >= SIMILARITY_THRESHOLD:
                        # Apply language filter post-query if needed
                        if language and row.get("language") != language:
                            continue
                        example = self._row_to_model(row)
                        results.append(SearchResult(item=example, similarity=similarity))

            self._logger.info(
                f"search_similar returned {len(results)} results",
                match_count=match_count,
                source_id=source_id,
                language=language,
            )

            return results

        except Exception as e:
            self._logger.error(f"search_similar failed: {e}", exc_info=True)
            raise

    async def insert(self, example: CodeExampleCreate) -> CodeExample:
        """Insert a new code example."""
        try:
            # Determine embedding column
            embedding_column = None
            if example.embedding and example.embedding_dimension:
                dim = example.embedding_dimension
                if dim == 768:
                    embedding_column = "embedding_768"
                elif dim == 1024:
                    embedding_column = "embedding_1024"
                elif dim == 1536:
                    embedding_column = "embedding_1536"
                elif dim == 3072:
                    embedding_column = "embedding_3072"

            # Build insert data
            data: dict[str, Any] = {
                "source_id": example.source_id,
                "page_url": example.page_url,
                "code": example.code,
                "language": example.language,
                "summary": example.summary,
                "context": example.context,
                "metadata": example.metadata,
                "embedding_model": example.embedding_model,
                "embedding_dimension": example.embedding_dimension,
            }

            if embedding_column and example.embedding:
                data[embedding_column] = example.embedding

            response = self.client.table(self.table_name).insert(data).execute()

            if not response.data:
                raise RuntimeError("Insert returned no data")

            return self._row_to_model(response.data[0])

        except Exception as e:
            self._logger.error(f"insert failed: {e}", page_url=example.page_url, exc_info=True)
            raise

    async def insert_batch(self, examples: list[CodeExampleCreate]) -> list[CodeExample]:
        """Insert multiple code examples in a batch."""
        if not examples:
            return []

        try:
            batch_data: list[dict[str, Any]] = []

            for example in examples:
                # Determine embedding column
                embedding_column = None
                if example.embedding and example.embedding_dimension:
                    dim = example.embedding_dimension
                    if dim == 768:
                        embedding_column = "embedding_768"
                    elif dim == 1024:
                        embedding_column = "embedding_1024"
                    elif dim == 1536:
                        embedding_column = "embedding_1536"
                    elif dim == 3072:
                        embedding_column = "embedding_3072"

                data: dict[str, Any] = {
                    "source_id": example.source_id,
                    "page_url": example.page_url,
                    "code": example.code,
                    "language": example.language,
                    "summary": example.summary,
                    "context": example.context,
                    "metadata": example.metadata,
                    "embedding_model": example.embedding_model,
                    "embedding_dimension": example.embedding_dimension,
                }

                if embedding_column and example.embedding:
                    data[embedding_column] = example.embedding

                batch_data.append(data)

            response = self.client.table(self.table_name).insert(batch_data).execute()

            self._logger.info(f"insert_batch inserted {len(response.data)} examples")

            return [self._row_to_model(row) for row in response.data]

        except Exception as e:
            self._logger.error(f"insert_batch failed: {e}", count=len(examples), exc_info=True)
            raise

    async def delete_by_source(self, source_id: str) -> int:
        """Delete all code examples from a specific source."""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("source_id", source_id)
                .execute()
            )

            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"delete_by_source deleted {deleted_count} examples", source_id=source_id)

            return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_source failed: {e}", source_id=source_id, exc_info=True)
            raise

    async def delete_by_page_url(self, page_url: str) -> int:
        """Delete all code examples from a specific page."""
        try:
            response = (
                self.client.table(self.table_name)
                .delete()
                .eq("page_url", page_url)
                .execute()
            )

            deleted_count = len(response.data) if response.data else 0
            self._logger.info(f"delete_by_page_url deleted {deleted_count} examples", page_url=page_url)

            return deleted_count

        except Exception as e:
            self._logger.error(f"delete_by_page_url failed: {e}", page_url=page_url, exc_info=True)
            raise

    async def count(self, source_id: str | None = None) -> int:
        """Count code examples in the repository."""
        try:
            query = self.client.table(self.table_name).select("id", count="exact")

            if source_id:
                query = query.eq("source_id", source_id)

            response = query.execute()

            return response.count if response.count else 0

        except Exception as e:
            self._logger.error(f"count failed: {e}", source_id=source_id, exc_info=True)
            raise

    async def list_languages(self, source_id: str | None = None) -> list[str]:
        """List all unique programming languages."""
        try:
            query = self.client.table(self.table_name).select("language")

            if source_id:
                query = query.eq("source_id", source_id)

            response = query.execute()

            # Extract unique non-null languages and sort
            languages = sorted(set(
                row["language"]
                for row in response.data
                if row.get("language")
            ))

            return languages

        except Exception as e:
            self._logger.error(f"list_languages failed: {e}", source_id=source_id, exc_info=True)
            raise
