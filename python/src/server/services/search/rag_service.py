"""
RAG Service - Thin Coordinator

This service acts as a coordinator that delegates to specific strategy implementations.
It combines multiple RAG strategies in a pipeline fashion:

1. Base vector search
2. + Hybrid search (if enabled) - combines vector + keyword
3. + Reranking (if enabled) - reorders results using CrossEncoder
4. + Agentic RAG (if enabled) - enhanced code example search

Multiple strategies can be enabled simultaneously and work together.
"""

import os
from typing import Any

from ...config.logfire_config import get_logger, safe_span
from ...utils import get_supabase_client
from ..embeddings.embedding_service import create_embedding
from .agentic_rag_strategy import AgenticRAGStrategy

# Import all strategies
from .base_search_strategy import BaseSearchStrategy
from .hybrid_search_strategy import HybridSearchStrategy
from .reranking_strategy import RerankingStrategy

logger = get_logger(__name__)


class RAGService:
    """
    Coordinator service that orchestrates multiple RAG strategies.

    This service delegates to strategy implementations and combines them
    based on configuration settings.
    """

    def __init__(self, supabase_client=None):
        """Initialize RAG service as a coordinator for search strategies"""
        self.supabase_client = supabase_client or get_supabase_client()

        # Initialize base strategy (always needed)
        self.base_strategy = BaseSearchStrategy(self.supabase_client)

        # Initialize optional strategies
        self.hybrid_strategy = HybridSearchStrategy(self.supabase_client, self.base_strategy)
        self.agentic_strategy = AgenticRAGStrategy(self.supabase_client, self.base_strategy)

        # Initialize reranking strategy based on settings
        self.reranking_strategy = None
        use_reranking = self.get_bool_setting("USE_RERANKING", False)
        if use_reranking:
            try:
                self.reranking_strategy = RerankingStrategy()
                logger.info("Reranking strategy loaded successfully")
            except Exception as e:
                logger.warning(f"Failed to load reranking strategy: {e}")
                self.reranking_strategy = None

    def get_setting(self, key: str, default: str = "false") -> str:
        """Get a setting from the credential service or fall back to environment variable."""
        try:
            from ..credential_service import credential_service

            if hasattr(credential_service, "_cache") and credential_service._cache_initialized:
                cached_value = credential_service._cache.get(key)
                if isinstance(cached_value, dict) and cached_value.get("is_encrypted"):
                    encrypted_value = cached_value.get("encrypted_value")
                    if encrypted_value:
                        try:
                            return credential_service._decrypt_value(encrypted_value)
                        except Exception:
                            pass
                elif cached_value:
                    return str(cached_value)
            # Fallback to environment variable
            return os.getenv(key, default)
        except Exception:
            return os.getenv(key, default)

    def get_bool_setting(self, key: str, default: bool = False) -> bool:
        """Get a boolean setting from credential service."""
        value = self.get_setting(key, "false" if not default else "true")
        return value.lower() in ("true", "1", "yes", "on")

    async def search_documents(
        self,
        query: str,
        match_count: int = 5,
        filter_metadata: dict | None = None,
        use_hybrid_search: bool = False,
        cached_api_key: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Document search with hybrid search capability.

        Args:
            query: Search query string
            match_count: Number of results to return
            filter_metadata: Optional metadata filter dict
            use_hybrid_search: Whether to use hybrid search
            cached_api_key: Deprecated parameter for compatibility

        Returns:
            List of matching documents
        """
        with safe_span(
            "rag_search_documents",
            query_length=len(query),
            match_count=match_count,
            hybrid_enabled=use_hybrid_search,
        ) as span:
            try:
                # Create embedding for the query
                query_embedding = await create_embedding(query)

                if not query_embedding:
                    logger.error("Failed to create embedding for query")
                    return []

                if use_hybrid_search:
                    # Use hybrid strategy
                    results = await self.hybrid_strategy.search_documents_hybrid(
                        query=query,
                        query_embedding=query_embedding,
                        match_count=match_count,
                        filter_metadata=filter_metadata,
                    )
                    span.set_attribute("search_mode", "hybrid")
                else:
                    # Use basic vector search from base strategy
                    results = await self.base_strategy.vector_search(
                        query_embedding=query_embedding,
                        match_count=match_count,
                        filter_metadata=filter_metadata,
                    )
                    span.set_attribute("search_mode", "vector")

                span.set_attribute("results_found", len(results))
                return results

            except Exception as e:
                logger.error(f"Document search failed: {e}")
                span.set_attribute("error", str(e))
                return []

    async def search_code_examples(
        self,
        query: str,
        match_count: int = 10,
        filter_metadata: dict[str, Any] | None = None,
        source_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Search for code examples - delegates to agentic strategy.

        Args:
            query: Query text
            match_count: Maximum number of results to return
            filter_metadata: Optional metadata filter
            source_id: Optional source ID to filter results

        Returns:
            List of matching code examples
        """
        return await self.agentic_strategy.search_code_examples(
            query=query,
            match_count=match_count,
            filter_metadata=filter_metadata,
            source_id=source_id,
            use_enhancement=True,
        )

    async def _group_chunks_by_pages(
        self, chunk_results: list[dict[str, Any]], match_count: int
    ) -> list[dict[str, Any]]:
        """Group chunk results by page_id (if available) or URL and fetch page metadata."""
        page_groups: dict[str, dict[str, Any]] = {}

        for result in chunk_results:
            metadata = result.get("metadata", {})
            page_id = metadata.get("page_id")
            url = metadata.get("url")

            # Use page_id as key if available, otherwise URL
            group_key = page_id if page_id else url
            if not group_key:
                continue

            if group_key not in page_groups:
                page_groups[group_key] = {
                    "page_id": page_id,
                    "url": url,
                    "chunk_matches": 0,
                    "total_similarity": 0.0,
                    "best_chunk_content": result.get("content", ""),
                    "source_id": metadata.get("source_id"),
                }

            page_groups[group_key]["chunk_matches"] += 1
            page_groups[group_key]["total_similarity"] += result.get("similarity_score", 0.0)

        page_results = []
        for group_key, data in page_groups.items():
            avg_similarity = data["total_similarity"] / data["chunk_matches"]
            match_boost = min(0.2, data["chunk_matches"] * 0.02)
            aggregate_score = avg_similarity * (1 + match_boost)

            # Query page by page_id if available, otherwise by URL
            if data["page_id"]:
                page_info = (
                    self.supabase_client.table("archon_page_metadata")
                    .select("id, url, section_title, word_count")
                    .eq("id", data["page_id"])
                    .maybe_single()
                    .execute()
                )
            else:
                # Regular pages - exact URL match
                page_info = (
                    self.supabase_client.table("archon_page_metadata")
                    .select("id, url, section_title, word_count")
                    .eq("url", data["url"])
                    .maybe_single()
                    .execute()
                )

            if page_info and page_info.data is not None:
                page_results.append({
                    "page_id": page_info.data["id"],
                    "url": page_info.data["url"],
                    "section_title": page_info.data.get("section_title"),
                    "word_count": page_info.data.get("word_count", 0),
                    "chunk_matches": data["chunk_matches"],
                    "aggregate_similarity": aggregate_score,
                    "average_similarity": avg_similarity,
                    "source_id": data["source_id"],
                })

        page_results.sort(key=lambda x: x["aggregate_similarity"], reverse=True)
        return page_results[:match_count]

    async def perform_rag_query(
        self, query: str, source: str = None, match_count: int = 5, return_mode: str = "chunks"
    ) -> tuple[bool, dict[str, Any]]:
        """
        Unified RAG query with all strategies.

        Pipeline:
        1. Vector/Hybrid Search (based on settings)
        2. Reranking (if enabled)
        3. Page Grouping (if return_mode="pages")

        Args:
            query: The search query
            source: Optional source domain to filter results
            match_count: Maximum number of results to return
            return_mode: "chunks" (default) or "pages"

        Returns:
            Tuple of (success, result_dict)
        """
        with safe_span(
            "rag_query_pipeline", query_length=len(query), source=source, match_count=match_count
        ) as span:
            try:
                logger.info(f"RAG query started: {query[:100]}{'...' if len(query) > 100 else ''}")

                # Build filter metadata
                filter_metadata = {"source": source} if source else None

                # Check which strategies are enabled
                use_hybrid_search = self.get_bool_setting("USE_HYBRID_SEARCH", False)
                use_reranking = self.get_bool_setting("USE_RERANKING", False)

                # If reranking is enabled, fetch more candidates for the reranker to evaluate
                # This allows the reranker to see a broader set of results
                search_match_count = match_count
                if use_reranking and self.reranking_strategy:
                    # Fetch 5x the requested amount when reranking is enabled
                    # The reranker will select the best from this larger pool
                    search_match_count = match_count * 5
                    logger.debug(f"Reranking enabled - fetching {search_match_count} candidates for {match_count} final results")

                # Step 1 & 2: Get results (with hybrid search if enabled)
                results = await self.search_documents(
                    query=query,
                    match_count=search_match_count,
                    filter_metadata=filter_metadata,
                    use_hybrid_search=use_hybrid_search,
                )

                span.set_attribute("raw_results_count", len(results))
                span.set_attribute("hybrid_search_enabled", use_hybrid_search)

                # Format results for processing
                formatted_results = []
                for i, result in enumerate(results):
                    try:
                        formatted_result = {
                            "id": result.get("id", f"result_{i}"),
                            "content": result.get("content", "")[:1000],  # Limit content
                            "metadata": result.get("metadata", {}),
                            "similarity_score": result.get("similarity", 0.0),
                        }
                        formatted_results.append(formatted_result)
                    except Exception as format_error:
                        logger.warning(f"Failed to format result {i}: {format_error}")
                        continue

                # Step 3: Apply reranking if we have a strategy or if enabled
                reranking_applied = False
                if self.reranking_strategy and formatted_results:
                    try:
                        # Pass top_k to limit results to the originally requested count
                        formatted_results = await self.reranking_strategy.rerank_results(
                            query, formatted_results, content_key="content", top_k=match_count
                        )
                        reranking_applied = True
                        logger.debug(f"Reranking applied: {search_match_count} candidates -> {len(formatted_results)} final results")
                    except Exception as e:
                        logger.warning(f"Reranking failed: {e}")
                        reranking_applied = False
                        # If reranking fails but we fetched extra results, trim to requested count
                        if len(formatted_results) > match_count:
                            formatted_results = formatted_results[:match_count]

                # Step 4: Group by pages if return_mode="pages" AND pages exist
                actual_return_mode = return_mode
                if return_mode == "pages":
                    # Check if any chunks have page_id set
                    has_page_ids = any(
                        result.get("metadata", {}).get("page_id") is not None
                        for result in formatted_results
                    )

                    if has_page_ids:
                        # Group by pages when page_ids exist
                        formatted_results = await self._group_chunks_by_pages(formatted_results, match_count)
                    else:
                        # Fall back to chunks when no page_ids (pre-migration data)
                        actual_return_mode = "chunks"
                        logger.info("No page_ids found in results, returning chunks instead of pages")

                # Build response
                response_data = {
                    "results": formatted_results,
                    "query": query,
                    "source": source,
                    "match_count": match_count,
                    "total_found": len(formatted_results),
                    "execution_path": "rag_service_pipeline",
                    "search_mode": "hybrid" if use_hybrid_search else "vector",
                    "reranking_applied": reranking_applied,
                    "return_mode": actual_return_mode,
                }

                span.set_attribute("final_results_count", len(formatted_results))
                span.set_attribute("reranking_applied", reranking_applied)
                span.set_attribute("return_mode", return_mode)
                span.set_attribute("success", True)

                logger.info(f"RAG query completed - {len(formatted_results)} {return_mode} found")
                return True, response_data

            except Exception as e:
                logger.error(f"RAG query failed: {e}")
                span.set_attribute("error", str(e))
                span.set_attribute("success", False)

                return False, {
                    "error": str(e),
                    "error_type": type(e).__name__,
                    "query": query,
                    "source": source,
                    "execution_path": "rag_service_pipeline",
                }

    async def search_code_examples_service(
        self, query: str, source_id: str | None = None, match_count: int = 5
    ) -> tuple[bool, dict[str, Any]]:
        """
        Search for code examples using agentic strategy with hybrid search and reranking.

        Pipeline for code examples:
        1. Check if agentic RAG is enabled
        2. Use agentic strategy for enhanced code search
        3. Apply hybrid search if enabled
        4. Apply reranking if enabled

        Args:
            query: The search query
            source_id: Optional source ID to filter results
            match_count: Maximum number of results to return

        Returns:
            Tuple of (success, result_dict)
        """
        with safe_span(
            "code_examples_pipeline",
            query_length=len(query),
            source_id=source_id,
            match_count=match_count,
        ) as span:
            try:
                # Check if agentic RAG is enabled
                if not self.agentic_strategy.is_enabled():
                    return False, {
                        "error": "Code example extraction is disabled. Enable USE_AGENTIC_RAG setting to use this feature.",
                        "query": query,
                    }

                # Check which strategies are enabled
                use_hybrid_search = self.get_bool_setting("USE_HYBRID_SEARCH", False)
                use_reranking = self.get_bool_setting("USE_RERANKING", False)

                # If reranking is enabled, fetch more candidates
                search_match_count = match_count
                if use_reranking and self.reranking_strategy:
                    search_match_count = match_count * 5
                    logger.debug(f"Reranking enabled for code search - fetching {search_match_count} candidates")

                # Prepare filter
                filter_metadata = {"source": source_id} if source_id and source_id.strip() else None

                if use_hybrid_search:
                    # Use hybrid search for code examples
                    results = await self.hybrid_strategy.search_code_examples_hybrid(
                        query=query,
                        match_count=search_match_count,
                        filter_metadata=filter_metadata,
                        source_id=source_id,
                    )
                else:
                    # Use standard agentic search
                    results = await self.agentic_strategy.search_code_examples(
                        query=query,
                        match_count=search_match_count,
                        filter_metadata=filter_metadata,
                        source_id=source_id,
                    )

                # Apply reranking if we have a strategy
                if self.reranking_strategy and results:
                    try:
                        results = await self.reranking_strategy.rerank_results(
                            query, results, content_key="content", top_k=match_count
                        )
                        logger.debug(f"Code reranking applied: {search_match_count} candidates -> {len(results)} final results")
                    except Exception as e:
                        logger.warning(f"Code reranking failed: {e}")
                        # If reranking fails but we fetched extra results, trim to requested count
                        if len(results) > match_count:
                            results = results[:match_count]

                # Format results
                formatted_results = []
                for result in results:
                    formatted_result = {
                        "url": result.get("url"),
                        "code": result.get("content"),
                        "summary": result.get("summary"),
                        "metadata": result.get("metadata"),
                        "source_id": result.get("source_id"),
                        "similarity": result.get("similarity"),
                    }
                    # Include rerank score if available
                    if "rerank_score" in result:
                        formatted_result["rerank_score"] = result["rerank_score"]
                    formatted_results.append(formatted_result)

                response_data = {
                    "query": query,
                    "source_filter": source_id,
                    "search_mode": "hybrid" if use_hybrid_search else "vector",
                    "reranking_applied": self.reranking_strategy is not None,
                    "results": formatted_results,
                    "count": len(formatted_results),
                }

                span.set_attribute("results_found", len(formatted_results))
                span.set_attribute("hybrid_used", use_hybrid_search)
                span.set_attribute("reranking_used", use_reranking)

                return True, response_data

            except Exception as e:
                logger.error(f"Code example search failed: {e}")
                span.set_attribute("error", str(e))
                return False, {"query": query, "error": str(e)}
