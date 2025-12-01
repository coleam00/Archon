"""
Agentic RAG Strategy

Implements agentic RAG functionality for intelligent code example extraction and search.
This strategy focuses on code-specific search and retrieval, providing enhanced
search capabilities for code examples, documentation, and programming-related content.

Key features:
- Enhanced query processing for code-related searches
- Specialized embedding strategies for code content
- Code example extraction and retrieval
- Programming language and framework-aware search
"""

from typing import Any

from supabase import Client

from ...config.logfire_config import get_logger, safe_span
from ..embeddings.embedding_service import create_embedding

logger = get_logger(__name__)


class AgenticRAGStrategy:
    """Strategy class implementing agentic RAG for code example search and extraction"""

    def __init__(self, supabase_client: Client, base_strategy):
        """
        Initialize agentic RAG strategy.

        Args:
            supabase_client: Supabase client for database operations
            base_strategy: Base strategy for vector search
        """
        self.supabase_client = supabase_client
        self.base_strategy = base_strategy

    def is_enabled(self) -> bool:
        """Check if agentic RAG is enabled via configuration."""
        try:
            from ..credential_service import credential_service

            if hasattr(credential_service, "_cache") and credential_service._cache_initialized:
                cached_value = credential_service._cache.get("USE_AGENTIC_RAG")
                if cached_value:
                    # Handle both direct values and encrypted values
                    if isinstance(cached_value, dict) and cached_value.get("is_encrypted"):
                        encrypted_value = cached_value.get("encrypted_value")
                        if encrypted_value:
                            try:
                                value = credential_service._decrypt_value(encrypted_value)
                            except Exception:
                                return False
                        else:
                            return False
                    else:
                        value = str(cached_value)

                    return value.lower() in ("true", "1", "yes", "on")

            # Default to false if not found in settings
            return False
        except Exception:
            # Default to false on any error
            return False

    async def search_code_examples(
        self,
        query: str,
        match_count: int = 10,
        filter_metadata: dict[str, Any] | None = None,
        source_id: str | None = None,
        embedding_model_filter: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Search for code examples using vector similarity.

        Args:
            query: Search query text
            match_count: Maximum number of results to return
            filter_metadata: Optional metadata filter
            source_id: Optional source ID to filter results
            embedding_model_filter: Optional filter to only return results from specific embedding model

        Returns:
            List of matching code examples
        """
        with safe_span(
            "agentic_code_search", query_length=len(query), match_count=match_count
        ) as span:
            try:
                # Create embedding for the query (no enhancement)
                query_embedding = await create_embedding(query)

                if not query_embedding:
                    logger.error("Failed to create embedding for code example query")
                    return []

                # Prepare filters
                combined_filter = filter_metadata or {}
                if source_id:
                    combined_filter["source"] = source_id

                # Use base strategy for vector search
                results = await self.base_strategy.vector_search(
                    query_embedding=query_embedding,
                    match_count=match_count,
                    filter_metadata=combined_filter,
                    table_rpc="match_archon_code_examples",
                    embedding_model_filter=embedding_model_filter,
                )

                span.set_attribute("results_found", len(results))

                logger.debug(
                    f"Agentic code search found {len(results)} results for query: {query[:50]}..."
                )

                return results

            except Exception as e:
                logger.error(f"Error in agentic code example search: {e}")
                span.set_attribute("error", str(e))
                return []

    async def perform_agentic_search(
        self,
        query: str,
        source_id: str | None = None,
        match_count: int = 5,
        include_context: bool = True,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Perform a comprehensive agentic RAG search for code examples with enhanced formatting.

        Args:
            query: The search query
            source_id: Optional source ID to filter results
            match_count: Maximum number of results to return
            include_context: Whether to include contextual information in results

        Returns:
            Tuple of (success, result_dict)
        """
        with safe_span(
            "agentic_rag_search",
            query_length=len(query),
            source_id=source_id,
            match_count=match_count,
        ) as span:
            try:
                # Check if agentic RAG is enabled
                if not self.is_enabled():
                    return False, {
                        "error": "Agentic RAG (code example extraction) is disabled. Enable USE_AGENTIC_RAG setting to use this feature.",
                        "query": query,
                    }

                # Prepare filter if source is provided
                filter_metadata = None
                if source_id and source_id.strip():
                    filter_metadata = {"source": source_id}

                # Perform code example search
                results = await self.search_code_examples(
                    query=query,
                    match_count=match_count,
                    filter_metadata=filter_metadata,
                    source_id=source_id,
                )

                # Format results for API response
                formatted_results = []
                for result in results:
                    formatted_result = {
                        "url": result.get("url"),
                        "code": result.get("content"),
                        "summary": result.get("summary"),
                        "metadata": result.get("metadata", {}),
                        "source_id": result.get("source_id"),
                        "similarity": result.get("similarity", 0.0),
                    }

                    # Add additional context if requested
                    if include_context:
                        formatted_result["chunk_number"] = result.get("chunk_number")
                        formatted_result["context"] = self._extract_code_context(result)

                    formatted_results.append(formatted_result)

                response_data = {
                    "query": query,
                    "source_filter": source_id,
                    "search_mode": "agentic_rag",
                    "strategy": "enhanced_code_search",
                    "results": formatted_results,
                    "count": len(formatted_results),
                    "enhanced_query_used": True,
                }

                span.set_attribute("results_returned", len(formatted_results))
                span.set_attribute("success", True)

                logger.info(
                    f"Agentic RAG search completed - {len(formatted_results)} code examples found"
                )

                return True, response_data

            except Exception as e:
                logger.error(f"Agentic RAG search failed: {e}")
                span.set_attribute("error", str(e))
                span.set_attribute("success", False)

                return False, {
                    "error": str(e),
                    "error_type": type(e).__name__,
                    "query": query,
                    "source_filter": source_id,
                    "search_mode": "agentic_rag",
                }

    def _extract_code_context(self, result: dict[str, Any]) -> dict[str, Any]:
        """
        Extract additional context information from a code example result.

        Args:
            result: Raw search result from database

        Returns:
            Dictionary with contextual information
        """
        context = {}

        metadata = result.get("metadata", {})
        if isinstance(metadata, dict):
            # Extract programming language if available
            if "language" in metadata:
                context["language"] = metadata["language"]

            # Extract framework/library information
            if "framework" in metadata:
                context["framework"] = metadata["framework"]

            # Extract file information
            if "file_path" in metadata:
                context["file_path"] = metadata["file_path"]

            # Extract line numbers if available
            if "line_start" in metadata and "line_end" in metadata:
                context["line_range"] = f"{metadata['line_start']}-{metadata['line_end']}"

        # Add content statistics
        content = result.get("content", "")
        if content:
            context["content_length"] = len(content)
            context["line_count"] = content.count("\\n") + 1

        return context

    def analyze_code_query(self, query: str) -> dict[str, Any]:
        """
        Analyze a query to determine if it's code-related and extract relevant information.

        Args:
            query: Search query to analyze

        Returns:
            Analysis results with query classification and extracted info
        """
        query_lower = query.lower()

        # Programming language detection
        languages = [
            "python",
            "javascript",
            "java",
            "c++",
            "cpp",
            "c#",
            "csharp",
            "ruby",
            "go",
            "golang",
            "rust",
            "swift",
            "kotlin",
            "scala",
            "php",
            "typescript",
            "html",
            "css",
            "sql",
            "bash",
            "shell",
            "r",
            "matlab",
            "julia",
            "perl",
            "lua",
            "dart",
            "elixir",
        ]

        detected_languages = [lang for lang in languages if lang in query_lower]

        # Framework/library detection
        frameworks = [
            "react",
            "angular",
            "vue",
            "django",
            "flask",
            "fastapi",
            "express",
            "spring",
            "rails",
            "laravel",
            "tensorflow",
            "pytorch",
            "pandas",
            "numpy",
            "matplotlib",
            "opencv",
        ]

        detected_frameworks = [fw for fw in frameworks if fw in query_lower]

        # Code-related keywords
        code_keywords = [
            "function",
            "class",
            "method",
            "algorithm",
            "implementation",
            "example",
            "tutorial",
            "pattern",
            "template",
            "snippet",
            "code",
            "programming",
            "development",
            "api",
            "library",
        ]

        code_indicators = [kw for kw in code_keywords if kw in query_lower]

        # Determine if query is code-related
        is_code_query = (
            len(detected_languages) > 0 or len(detected_frameworks) > 0 or len(code_indicators) > 0
        )

        return {
            "is_code_query": is_code_query,
            "confidence": min(
                1.0,
                (len(detected_languages) + len(detected_frameworks) + len(code_indicators)) * 0.3,
            ),
            "languages": detected_languages,
            "frameworks": detected_frameworks,
            "code_indicators": code_indicators,
            "enhanced_query_recommended": is_code_query,
        }


# Utility functions for standalone usage
def create_agentic_rag_strategy(supabase_client: Client) -> AgenticRAGStrategy:
    """Create an agentic RAG strategy instance."""
    return AgenticRAGStrategy(supabase_client)


async def search_code_examples_agentic(
    client: Client,
    query: str,
    match_count: int = 10,
    filter_metadata: dict[str, Any] | None = None,
    source_id: str | None = None,
) -> list[dict[str, Any]]:
    """
    Standalone function for agentic code example search.

    Args:
        client: Supabase client
        query: Search query
        match_count: Number of results to return
        filter_metadata: Optional metadata filter
        source_id: Optional source filter

    Returns:
        List of code example results
    """
    strategy = AgenticRAGStrategy(client)
    return await strategy.search_code_examples_async(query, match_count, filter_metadata, source_id)


def analyze_query_for_code_search(query: str) -> dict[str, Any]:
    """
    Standalone function to analyze if a query is code-related.

    Args:
        query: Query to analyze

    Returns:
        Analysis results
    """
    strategy = AgenticRAGStrategy(None)  # Don't need client for analysis
    return strategy.analyze_code_query(query)
