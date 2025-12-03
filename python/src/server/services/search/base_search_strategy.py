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

# Supported embedding dimensions that map to database columns
SUPPORTED_DIMENSIONS = {384, 768, 1024, 1536, 3072}


class BaseSearchStrategy:
    """Base strategy implementing fundamental vector similarity search"""

    def __init__(self, supabase_client: Client):
        """Initialize with database client"""
        self.supabase_client = supabase_client

    def _get_embedding_dimension(self, query_embedding: list[float]) -> int:
        """
        Detect the embedding dimension and validate it's supported.

        Args:
            query_embedding: The embedding vector

        Returns:
            The dimension of the embedding

        Raises:
            ValueError: If the dimension is not supported
        """
        dimension = len(query_embedding)
        if dimension not in SUPPORTED_DIMENSIONS:
            raise ValueError(
                f"Unsupported embedding dimension: {dimension}. "
                f"Supported dimensions are: {sorted(SUPPORTED_DIMENSIONS)}"
            )
        return dimension

    def _get_multi_rpc_name(self, table_rpc: str) -> str:
        """
        Get the multi-dimensional RPC function name from a legacy RPC name.

        Args:
            table_rpc: The RPC function name (legacy or multi)

        Returns:
            The multi-dimensional RPC function name
        """
        # Map legacy functions to their multi-dimensional versions
        rpc_mapping = {
            "match_archon_crawled_pages": "match_archon_crawled_pages_multi",
            "match_archon_code_examples": "match_archon_code_examples_multi",
        }
        return rpc_mapping.get(table_rpc, f"{table_rpc}_multi")

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
        Automatically detects the embedding dimension and uses the appropriate
        multi-dimensional search function.

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
                # Detect embedding dimension from the query vector
                embedding_dimension = self._get_embedding_dimension(query_embedding)
                span.set_attribute("embedding_dimension", embedding_dimension)

                # Use multi-dimensional RPC function
                multi_rpc = self._get_multi_rpc_name(table_rpc)
                logger.debug(
                    f"Using {multi_rpc} with dimension={embedding_dimension} "
                    f"(query embedding has {len(query_embedding)} elements)"
                )

                # Build RPC parameters for multi-dimensional function
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

                # Execute search
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
