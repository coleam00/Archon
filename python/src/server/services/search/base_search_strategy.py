"""
Base Search Strategy

Implements the foundational vector similarity search that all other strategies build upon.
This is the core semantic search functionality.
"""

from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger, safe_span

logger = get_logger(__name__)

# Fixed similarity threshold for vector results
SIMILARITY_THRESHOLD = 0.05


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
        embedding_model_filter: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Perform basic vector similarity search.

        This is the foundational semantic search that all strategies use.

        Args:
            query_embedding: The embedding vector for the query
            match_count: Number of results to return
            filter_metadata: Optional metadata filters
            table_rpc: The RPC function to call (match_archon_crawled_pages or match_archon_code_examples)
            embedding_model_filter: Optional filter to only return results from specific embedding model

        Returns:
            List of matching documents with similarity scores
        """
        with safe_span("base_vector_search", table=table_rpc, match_count=match_count) as span:
            try:
                # Detect embedding dimension from the query vector
                embedding_dimension = len(query_embedding)

                # Use multi-dimensional RPC function to support all embedding models
                multi_rpc = f"{table_rpc}_multi"

                # Build RPC parameters with embedding dimension
                rpc_params = {
                    "query_embedding": query_embedding,
                    "embedding_dimension": embedding_dimension,
                    "match_count": match_count,
                }

                # Add filter parameters
                if filter_metadata:
                    if "source" in filter_metadata:
                        rpc_params["source_filter"] = filter_metadata["source"]
                        rpc_params["filter"] = {}
                    else:
                        rpc_params["filter"] = filter_metadata
                else:
                    rpc_params["filter"] = {}

                # Add embedding model filter if provided
                if embedding_model_filter:
                    rpc_params["embedding_model_filter"] = embedding_model_filter

                # Execute search using multi-dimensional RPC
                logger.debug(f"Searching with {embedding_dimension}D embedding via {multi_rpc}")
                response = self.supabase_client.rpc(multi_rpc, rpc_params).execute()

                # Filter by similarity threshold
                filtered_results = []
                if response.data:
                    for result in response.data:
                        similarity = float(result.get("similarity", 0.0))
                        if similarity >= SIMILARITY_THRESHOLD:
                            filtered_results.append(result)

                span.set_attribute("results_found", len(filtered_results))
                span.set_attribute(
                    "results_filtered",
                    len(response.data) - len(filtered_results) if response.data else 0,
                )

                return filtered_results

            except Exception as e:
                logger.error(f"Vector search failed: {e}")
                span.set_attribute("error", str(e))
                return []
