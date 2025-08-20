"""
Reranking Strategy

Implements result reranking using CrossEncoder models to improve search result ordering.
The reranking process re-scores search results based on query-document relevance using
a trained neural model, typically improving precision over initial retrieval scores.

Uses the cross-encoder/ms-marco-MiniLM-L-6-v2 model for reranking by default.
"""

import os
from typing import Any

try:
    from sentence_transformers import CrossEncoder

    CROSSENCODER_AVAILABLE = True
except ImportError:
    CrossEncoder = None
    CROSSENCODER_AVAILABLE = False

from ...config.logfire_config import get_logger, safe_span

logger = get_logger(__name__)

# Default reranking model
DEFAULT_RERANKING_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


class RerankingStrategy:
    """Strategy class implementing result reranking using CrossEncoder models"""

    def __init__(
        self, model_name: str = DEFAULT_RERANKING_MODEL, model_instance: Any | None = None
    ):
        """
        Initialize reranking strategy.

        Args:
            model_name: Name/path of the CrossEncoder model to use
            model_instance: Pre-loaded CrossEncoder instance or any object with a predict method (optional)
        """
        self.model_name = model_name
        self.model = model_instance or self._load_model()

    @classmethod
    def from_model(cls, model: Any, model_name: str = "custom_model") -> "RerankingStrategy":
        """
        Create a RerankingStrategy from any model with a predict method.

        This factory method is useful for tests or when using non-CrossEncoder models.

        Args:
            model: Any object with a predict(pairs) method
            model_name: Optional name for the model

        Returns:
            RerankingStrategy instance using the provided model
        """
        return cls(model_name=model_name, model_instance=model)

    def _load_model(self) -> CrossEncoder:
        """Load the CrossEncoder model for reranking."""
        if not CROSSENCODER_AVAILABLE:
            logger.warning("sentence-transformers not available - reranking disabled")
            return None

        try:
            logger.info(f"Loading reranking model: {self.model_name}")
            return CrossEncoder(self.model_name)
        except Exception as e:
            logger.error(f"Failed to load reranking model {self.model_name}: {e}")
            return None

    def is_available(self) -> bool:
        """Check if reranking is available (model loaded successfully)."""
        return self.model is not None

    def build_query_document_pairs(
        self, query: str, results: list[dict[str, Any]], content_key: str = "content"
    ) -> tuple[list[list[str]], list[int]]:
        """
        Build query-document pairs for the reranking model.

        Args:
            query: The search query
            results: List of search results
            content_key: The key in each result dict containing text content

        Returns:
            Tuple of (query-document pairs, valid indices)
        """
        texts = []
        valid_indices = []

        for i, result in enumerate(results):
            content = result.get(content_key, "")
            if content and isinstance(content, str):
                texts.append(content)
                valid_indices.append(i)
            else:
                logger.warning(f"Result {i} has no valid content for reranking")

        query_doc_pairs = [[query, text] for text in texts]
        return query_doc_pairs, valid_indices

    def apply_rerank_scores(
        self,
        results: list[dict[str, Any]],
        scores: list[float],
        valid_indices: list[int],
        top_k: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Apply reranking scores to results and sort them.

        Args:
            results: Original search results
            scores: Reranking scores from the model
            valid_indices: Indices of results that were scored
            top_k: Optional limit on number of results to return

        Returns:
            Reranked and sorted list of results
        """
        # Add rerank scores to valid results
        for i, valid_idx in enumerate(valid_indices):
            results[valid_idx]["rerank_score"] = float(scores[i])

        # Sort results by rerank score (descending - highest relevance first)
        reranked_results = sorted(results, key=lambda x: x.get("rerank_score", -1.0), reverse=True)

        # Apply top_k limit if specified
        if top_k is not None and top_k > 0:
            reranked_results = reranked_results[:top_k]

        return reranked_results

    async def rerank_results(
        self,
        query: str,
        results: list[dict[str, Any]],
        content_key: str = "content",
        top_k: int | None = None,
    ) -> list[dict[str, Any]]:
        """
        Rerank search results using the CrossEncoder model.

        Args:
            query: The search query used to retrieve results
            results: List of search results to rerank
            content_key: The key in each result dict containing text content for reranking
            top_k: Optional limit on number of results to return after reranking

        Returns:
            Reranked list of results ordered by rerank_score (highest first)
        """
        if not self.model or not results:
            logger.debug("Reranking skipped - no model or no results")
            return results

        with safe_span(
            "rerank_results", result_count=len(results), model_name=self.model_name
        ) as span:
            try:
                # Build query-document pairs
                query_doc_pairs, valid_indices = self.build_query_document_pairs(
                    query, results, content_key
                )

                if not query_doc_pairs:
                    logger.warning("No valid texts found for reranking")
                    return results

                # Get reranking scores from the model
                with safe_span("crossencoder_predict"):
                    scores = self.model.predict(query_doc_pairs)

                # Apply scores and sort results
                reranked_results = self.apply_rerank_scores(results, scores, valid_indices, top_k)

                span.set_attribute("reranked_count", len(reranked_results))
                if len(scores) > 0:
                    span.set_attribute("score_range", f"{min(scores):.3f}-{max(scores):.3f}")
                    logger.debug(
                        f"Reranked {len(query_doc_pairs)} results, score range: {min(scores):.3f}-{max(scores):.3f}"
                    )

                return reranked_results

            except Exception as e:
                logger.error(f"Error during reranking: {e}")
                span.set_attribute("error", str(e))
                return results

    def get_model_info(self) -> dict[str, Any]:
        """Get information about the loaded reranking model."""
        return {
            "model_name": self.model_name,
            "available": self.is_available(),
            "crossencoder_available": CROSSENCODER_AVAILABLE,
            "model_loaded": self.model is not None,
        }


class RerankingConfig:
    """Configuration helper for reranking settings"""

    @staticmethod
    def from_credential_service(credential_service) -> dict[str, Any]:
        """Load reranking configuration from credential service."""
        try:
            use_reranking = credential_service.get_bool_setting("USE_RERANKING", False)
            model_name = credential_service.get_setting("RERANKING_MODEL", DEFAULT_RERANKING_MODEL)
            top_k = int(credential_service.get_setting("RERANKING_TOP_K", "0"))

            return {
                "enabled": use_reranking,
                "model_name": model_name,
                "top_k": top_k if top_k > 0 else None,
            }
        except Exception as e:
            logger.error(f"Error loading reranking config: {e}")
            return {"enabled": False, "model_name": DEFAULT_RERANKING_MODEL, "top_k": None}

    @staticmethod
    def from_env() -> dict[str, Any]:
        """Load reranking configuration from environment variables."""
        return {
            "enabled": os.getenv("USE_RERANKING", "false").lower() in ("true", "1", "yes", "on"),
            "model_name": os.getenv("RERANKING_MODEL", DEFAULT_RERANKING_MODEL),
            "top_k": int(os.getenv("RERANKING_TOP_K", "0")) or None,
        }
