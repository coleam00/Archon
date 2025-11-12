"""
OpenRouter model discovery service.

Provides discovery and metadata for OpenRouter embedding models.
"""

from pydantic import BaseModel, Field, field_validator


class OpenRouterEmbeddingModel(BaseModel):
    """OpenRouter embedding model metadata."""

    id: str = Field(..., description="Full model ID with provider prefix (e.g., openai/text-embedding-3-large)")
    provider: str = Field(..., description="Provider name (openai, google, qwen, mistralai)")
    name: str = Field(..., description="Display name without prefix")
    dimensions: int = Field(..., description="Embedding dimensions")
    context_length: int = Field(..., description="Maximum context window in tokens")
    pricing_per_1m_tokens: float = Field(..., description="Cost per 1M tokens in USD")
    supports_dimension_reduction: bool = Field(default=False, description="Whether model supports dimension parameter")

    @field_validator("id")
    @classmethod
    def validate_model_id_has_prefix(cls, v: str) -> str:
        """Ensure model ID includes provider prefix."""
        if "/" not in v:
            raise ValueError("OpenRouter model IDs must include provider prefix (e.g., openai/model-name)")
        return v


class OpenRouterModelListResponse(BaseModel):
    """Response from OpenRouter model discovery."""

    embedding_models: list[OpenRouterEmbeddingModel] = Field(default_factory=list)
    total_count: int = Field(..., description="Total number of embedding models")


class OpenRouterDiscoveryService:
    """Discover and manage OpenRouter embedding models."""

    async def discover_embedding_models(self) -> list[OpenRouterEmbeddingModel]:
        """
        Get available OpenRouter embedding models.

        Returns hardcoded list of supported embedding models with metadata.
        Future enhancement: Could fetch from OpenRouter API if they provide a models endpoint.
        """
        return [
            # OpenAI models via OpenRouter
            OpenRouterEmbeddingModel(
                id="openai/text-embedding-3-small",
                provider="openai",
                name="text-embedding-3-small",
                dimensions=1536,
                context_length=8191,
                pricing_per_1m_tokens=0.02,
                supports_dimension_reduction=True,
            ),
            OpenRouterEmbeddingModel(
                id="openai/text-embedding-3-large",
                provider="openai",
                name="text-embedding-3-large",
                dimensions=3072,
                context_length=8191,
                pricing_per_1m_tokens=0.13,
                supports_dimension_reduction=True,
            ),
            OpenRouterEmbeddingModel(
                id="openai/text-embedding-ada-002",
                provider="openai",
                name="text-embedding-ada-002",
                dimensions=1536,
                context_length=8191,
                pricing_per_1m_tokens=0.10,
                supports_dimension_reduction=False,
            ),
            # Google models via OpenRouter
            OpenRouterEmbeddingModel(
                id="google/gemini-embedding-001",
                provider="google",
                name="gemini-embedding-001",
                dimensions=768,
                context_length=20000,
                pricing_per_1m_tokens=0.00,  # Free tier available
                supports_dimension_reduction=True,
            ),
            OpenRouterEmbeddingModel(
                id="google/text-embedding-004",
                provider="google",
                name="text-embedding-004",
                dimensions=768,
                context_length=20000,
                pricing_per_1m_tokens=0.00,  # Free tier available
                supports_dimension_reduction=True,
            ),
            # Qwen models via OpenRouter
            OpenRouterEmbeddingModel(
                id="qwen/qwen3-embedding-0.6b",
                provider="qwen",
                name="qwen3-embedding-0.6b",
                dimensions=1024,
                context_length=32768,
                pricing_per_1m_tokens=0.01,
                supports_dimension_reduction=False,
            ),
            OpenRouterEmbeddingModel(
                id="qwen/qwen3-embedding-4b",
                provider="qwen",
                name="qwen3-embedding-4b",
                dimensions=1024,
                context_length=32768,
                pricing_per_1m_tokens=0.01,
                supports_dimension_reduction=False,
            ),
            OpenRouterEmbeddingModel(
                id="qwen/qwen3-embedding-8b",
                provider="qwen",
                name="qwen3-embedding-8b",
                dimensions=1024,
                context_length=32768,
                pricing_per_1m_tokens=0.01,
                supports_dimension_reduction=False,
            ),
            # Mistral models via OpenRouter
            OpenRouterEmbeddingModel(
                id="mistralai/mistral-embed",
                provider="mistralai",
                name="mistral-embed",
                dimensions=1024,
                context_length=8192,
                pricing_per_1m_tokens=0.10,
                supports_dimension_reduction=False,
            ),
        ]


# Create singleton instance
openrouter_discovery_service = OpenRouterDiscoveryService()
