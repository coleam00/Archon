"""
Hybrid Search Strategy

Implements hybrid search combining vector similarity search with full-text search
using PostgreSQL's ts_vector for improved recall and precision in document and 
code example retrieval.

Strategy combines:
1. Vector/semantic search for conceptual matches
2. Full-text search using ts_vector for efficient keyword matching
3. Returns union of both result sets for maximum coverage
"""

from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger, safe_span
from ..embeddings.embedding_service import create_embedding

logger = get_logger(__name__)


class HybridSearchStrategy:
    """Strategy class implementing hybrid search combining vector and full-text search"""

    def __init__(self, supabase_client: Client, base_strategy):
        self.supabase_client = supabase_client
        self.base_strategy = base_strategy

    async def search_documents_hybrid(
        self,
        query: str,
        query_embedding: list[float],
        match_count: int,
        filter_metadata: dict | None = None,
    ) -> list[dict[str, Any]]:
        """
        Perform hybrid search on archon_crawled_pages table using the PostgreSQL 
        hybrid search function that combines vector and full-text search.

        Args:
            query: Original search query text
            query_embedding: Pre-computed query embedding
            match_count: Number of results to return
            filter_metadata: Optional metadata filter dict

        Returns:
            List of matching documents from both vector and text search
        """
        with safe_span("hybrid_search_documents") as span:
            try:
                # Prepare filter and source parameters
                filter_json = filter_metadata or {}
                source_filter = filter_json.pop("source", None) if "source" in filter_json else None

                # Call the hybrid search PostgreSQL function
                response = self.supabase_client.rpc(
                    "hybrid_search_archon_crawled_pages",
                    {
                        "query_embedding": query_embedding,
                        "query_text": query,
                        "match_count": match_count,
                        "filter": filter_json,
                        "source_filter": source_filter,
                    },
                ).execute()

                if not response.data:
                    logger.debug("No results from hybrid search")
                    return []

                # Format results to match expected structure
                results = []
                for row in response.data:
                    result = {
                        "id": row["id"],
                        "url": row["url"],
                        "chunk_number": row["chunk_number"],
                        "content": row["content"],
                        "metadata": row["metadata"],
                        "source_id": row["source_id"],
                        "similarity": row["similarity"],
                        "match_type": row["match_type"],
                    }
                    results.append(result)

                span.set_attribute("results_count", len(results))

                # Log match type distribution for debugging
                match_types = {}
                for r in results:
                    mt = r.get("match_type", "unknown")
                    match_types[mt] = match_types.get(mt, 0) + 1

                logger.debug(
                    f"Hybrid search returned {len(results)} results. "
                    f"Match types: {match_types}"
                )

                return results

            except Exception as e:
                logger.error(f"Hybrid document search failed: {e}")
                span.set_attribute("error", str(e))
                return []

    async def search_code_examples_hybrid(
        self,
        query: str,
        match_count: int,
        filter_metadata: dict | None = None,
        source_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Perform hybrid search on archon_code_examples table using the PostgreSQL 
        hybrid search function that combines vector and full-text search.

        Args:
            query: Search query text
            match_count: Number of results to return
            filter_metadata: Optional metadata filter dict
            source_id: Optional source ID to filter results

        Returns:
            List of matching code examples from both vector and text search
        """
        with safe_span("hybrid_search_code_examples") as span:
            try:
                # Create query embedding
                query_embedding = await create_embedding(query)

                if not query_embedding:
                    logger.error("Failed to create embedding for code example query")
                    return []

                # Prepare filter and source parameters
                filter_json = filter_metadata or {}
                # Use source_id parameter if provided, otherwise check filter_metadata
                final_source_filter = source_id
                if not final_source_filter and "source" in filter_json:
                    final_source_filter = filter_json.pop("source")

                # Call the hybrid search PostgreSQL function
                response = self.supabase_client.rpc(
                    "hybrid_search_archon_code_examples",
                    {
                        "query_embedding": query_embedding,
                        "query_text": query,
                        "match_count": match_count,
                        "filter": filter_json,
                        "source_filter": final_source_filter,
                    },
                ).execute()

                if not response.data:
                    logger.debug("No results from hybrid code search")
                    return []

                # Format results to match expected structure
                results = []
                for row in response.data:
                    result = {
                        "id": row["id"],
                        "url": row["url"],
                        "chunk_number": row["chunk_number"],
                        "content": row["content"],
                        "summary": row["summary"],
                        "metadata": row["metadata"],
                        "source_id": row["source_id"],
                        "similarity": row["similarity"],
                        "match_type": row["match_type"],
                    }
                    results.append(result)

                span.set_attribute("results_count", len(results))

                # Log match type distribution for debugging
                match_types = {}
                for r in results:
                    mt = r.get("match_type", "unknown")
                    match_types[mt] = match_types.get(mt, 0) + 1

                logger.debug(
                    f"Hybrid code search returned {len(results)} results. "
                    f"Match types: {match_types}"
                )

                return results

            except Exception as e:
                logger.error(f"Hybrid code example search failed: {e}")
                span.set_attribute("error", str(e))
                return []