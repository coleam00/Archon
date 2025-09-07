"""
Base Search Strategy

Implements the foundational vector similarity search that all other strategies build upon.
This is the core semantic search functionality.
"""

from typing import Any
import os

from supabase import Client

from ...config.logfire_config import get_logger, safe_span

logger = get_logger(__name__)

# Default similarity threshold for vector results (overridable via settings/env)
DEFAULT_SIMILARITY_THRESHOLD = 0.15


class BaseSearchStrategy:
    """Base strategy implementing fundamental vector similarity search"""

    def __init__(self, supabase_client: Client):
        """Initialize with database client"""
        self.supabase_client = supabase_client

    async def vector_search(
        self,
        query_embedding: list[float],
        match_count: int,
        filter_metadata: dict | None = None,
        table_rpc: str = "match_archon_crawled_pages",
    ) -> list[dict[str, Any]]:
        """
        Perform basic vector similarity search.

        This is the foundational semantic search that all strategies use.

        Args:
            query_embedding: The embedding vector for the query
            match_count: Number of results to return
            filter_metadata: Optional metadata filters
            table_rpc: The RPC function to call (match_archon_crawled_pages or match_archon_code_examples)

        Returns:
            List of matching documents with similarity scores
        """
        with safe_span("base_vector_search", table=table_rpc, match_count=match_count) as span:
            try:
                # Resolve similarity threshold from credentials or environment
                similarity_threshold = DEFAULT_SIMILARITY_THRESHOLD
                try:
                    from ..credential_service import credential_service  # lazy import

                    rag_settings = await credential_service.get_credentials_by_category("rag_strategy")
                    th_val = rag_settings.get("SIMILARITY_THRESHOLD") or os.getenv(
                        "SIMILARITY_THRESHOLD",
                        str(DEFAULT_SIMILARITY_THRESHOLD),
                    )
                    similarity_threshold = float(th_val)
                except Exception:
                    try:
                        similarity_threshold = float(
                            os.getenv("SIMILARITY_THRESHOLD", str(DEFAULT_SIMILARITY_THRESHOLD))
                        )
                    except Exception:
                        similarity_threshold = DEFAULT_SIMILARITY_THRESHOLD
                # Build RPC parameters
                rpc_params = {"query_embedding": query_embedding, "match_count": match_count}

                # Add filter parameters
                if filter_metadata:
                    if "source" in filter_metadata:
                        rpc_params["source_filter"] = filter_metadata["source"]
                        rpc_params["filter"] = {}
                    else:
                        rpc_params["filter"] = filter_metadata
                else:
                    rpc_params["filter"] = {}

                # Execute search
                response = self.supabase_client.rpc(table_rpc, rpc_params).execute()

                # Filter by similarity threshold
                filtered_results = []
                if response.data:
                    for result in response.data:
                        similarity = float(result.get("similarity", 0.0))
                        if similarity >= similarity_threshold:
                            filtered_results.append(result)

                span.set_attribute("results_found", len(filtered_results))
                span.set_attribute(
                    "results_filtered",
                    len(response.data) - len(filtered_results) if response.data else 0,
                )
                span.set_attribute("similarity_threshold", similarity_threshold)

                return filtered_results

            except Exception as e:
                logger.error(f"Vector search failed: {e}")
                span.set_attribute("error", str(e))
                return []
