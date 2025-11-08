"""Answer generation service using Claude with prompt caching for RAG queries."""

from typing import Dict, List, Optional

from ...config.logfire_config import get_logger
from .claude_service import get_claude_service
from .model_router import get_model_router

logger = get_logger(__name__)


class AnswerGenerationService:
    """Service for generating answers from search results using LLMs."""

    def __init__(self):
        self.claude_service = get_claude_service()
        self.model_router = get_model_router()

    async def generate_answer(
        self,
        query: str,
        search_results: List[Dict],
        use_claude: bool = True,
        enable_caching: bool = True,
    ) -> Dict[str, any]:
        """
        Generate an answer to a query based on search results.

        Args:
            query: User's question
            search_results: List of search results with content
            use_claude: Whether to use Claude (default True for caching benefits)
            enable_caching: Whether to enable prompt caching

        Returns:
            Dictionary with answer, usage stats, and metadata
        """
        try:
            context = self._build_context(search_results)

            if use_claude:
                return await self._generate_with_claude(query, context, enable_caching)
            else:
                return await self._generate_with_openai(query, context)

        except Exception as e:
            logger.error(f"Answer generation failed: {e}")
            return {
                "answer": "I encountered an error generating an answer. Please try again.",
                "error": str(e),
                "success": False,
            }

    def _build_context(self, search_results: List[Dict]) -> str:
        """Build context string from search results."""
        if not search_results:
            return "No relevant context found."

        context_parts = []
        for i, result in enumerate(search_results[:5], 1):
            content = result.get("content", "")
            url = result.get("url", result.get("metadata", {}).get("url", "Unknown"))
            context_parts.append(f"[Source {i}] {url}\n{content}\n")

        return "\n\n".join(context_parts)

    async def _generate_with_claude(
        self, query: str, context: str, enable_caching: bool
    ) -> Dict[str, any]:
        """Generate answer using Claude with prompt caching."""
        await self.claude_service.initialize()

        system_prompt = """You are a helpful AI assistant that answers questions based on provided context.

Guidelines:
- Always cite sources using [Source N] notation
- If the context doesn't contain enough information, say so clearly
- Be concise but comprehensive
- Focus on accuracy over completeness"""

        messages = [
            {
                "role": "user",
                "content": f"""Context:\n{context}\n\nQuestion: {query}\n\nPlease provide a detailed answer based on the context above.""",
            }
        ]

        response = await self.claude_service.create_message(
            messages=messages,
            system=system_prompt,
            model="claude-3-5-sonnet-20241022",
            use_caching=enable_caching,
            max_tokens=2048,
        )

        usage = response.get("usage", {})
        cache_read = usage.get("cache_read_tokens", 0)
        cache_creation = usage.get("cache_creation_tokens", 0)

        logger.info(
            f"Claude answer generated - Input: {usage.get('input_tokens', 0)}, "
            f"Output: {usage.get('output_tokens', 0)}, "
            f"Cache read: {cache_read}, Cache creation: {cache_creation}"
        )

        return {
            "answer": response["content"],
            "model": response["model"],
            "usage": usage,
            "success": True,
            "provider": "claude",
            "caching_enabled": enable_caching,
            "cache_hit": cache_read > 0,
            "cost_savings": self._calculate_savings(usage),
        }

    async def _generate_with_openai(self, query: str, context: str) -> Dict[str, any]:
        """Generate answer using OpenAI (fallback)."""
        from ..llm_provider_service import get_llm_client

        async with get_llm_client(provider="openai") as client:
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant that answers questions based on context.",
                    },
                    {
                        "role": "user",
                        "content": f"Context:\n{context}\n\nQuestion: {query}\n\nAnswer:",
                    },
                ],
                max_tokens=2048,
            )

            return {
                "answer": response.choices[0].message.content,
                "model": response.model,
                "usage": {
                    "input_tokens": response.usage.prompt_tokens,
                    "output_tokens": response.usage.completion_tokens,
                },
                "success": True,
                "provider": "openai",
            }

    def _calculate_savings(self, usage: Dict) -> float:
        """Calculate approximate cost savings from caching."""
        cache_read = usage.get("cache_read_tokens", 0)
        cache_creation = usage.get("cache_creation_tokens", 0)

        if cache_read == 0:
            return 0.0

        savings_pct = (cache_read / (cache_read + cache_creation)) * 0.9 if cache_creation > 0 else 0.9

        return round(savings_pct * 100, 1)


_answer_service: Optional[AnswerGenerationService] = None


def get_answer_generation_service() -> AnswerGenerationService:
    """Get or create answer generation service instance."""
    global _answer_service
    if _answer_service is None:
        _answer_service = AnswerGenerationService()
    return _answer_service
