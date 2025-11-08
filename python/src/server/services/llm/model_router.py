"""Intelligent model routing for cost optimization."""

from typing import Optional, Tuple

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class ModelRouter:
    """Route requests to optimal model based on complexity and caching benefits."""

    def select_model_for_rag(
        self, query: str, context_length: int, enable_caching: bool = True
    ) -> Tuple[str, str]:
        """
        Select best model for RAG queries with caching optimization.

        Args:
            query: User query text
            context_length: Length of context that will be cached
            enable_caching: Whether to prefer Claude for caching benefits

        Returns:
            (provider, model) tuple
        """
        if enable_caching and context_length > 1000:
            logger.debug(
                f"Selecting Claude for RAG with large context ({context_length} chars) for caching benefit"
            )
            return ("claude", "claude-3-5-sonnet-20241022")

        if len(query.split()) < 10 and context_length < 1000:
            logger.debug("Simple query with small context, using Claude Haiku for speed")
            return ("claude", "claude-3-haiku-20240307")

        logger.debug("Using Claude Sonnet as default for RAG queries")
        return ("claude", "claude-3-5-sonnet-20241022")

    def select_model_for_task(
        self, task_type: str, complexity: str = "medium"
    ) -> Tuple[str, str]:
        """
        Select best model for a specific task type.

        Args:
            task_type: Type of task (e.g., 'rag_query', 'code_analysis', 'summarization')
            complexity: Task complexity ('simple', 'medium', 'complex')

        Returns:
            (provider, model) tuple
        """
        if task_type == "rag_query":
            return ("claude", "claude-3-5-sonnet-20241022")
        elif task_type == "code_analysis":
            return ("claude", "claude-3-5-sonnet-20241022")
        elif task_type == "summarization":
            if complexity == "simple":
                return ("claude", "claude-3-haiku-20240307")
            return ("claude", "claude-3-5-sonnet-20241022")
        elif task_type == "document_processing":
            return ("claude", "claude-3-5-sonnet-20241022")
        else:
            return ("openai", "gpt-4o-mini")


_model_router: Optional[ModelRouter] = None


def get_model_router() -> ModelRouter:
    """Get or create model router instance."""
    global _model_router
    if _model_router is None:
        _model_router = ModelRouter()
    return _model_router
