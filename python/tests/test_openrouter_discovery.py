"""
Unit tests for OpenRouter model discovery service.
"""

import pytest

from src.server.services.openrouter_discovery_service import (
    OpenRouterDiscoveryService,
    OpenRouterEmbeddingModel,
    OpenRouterModelListResponse,
)


@pytest.fixture
def discovery_service():
    """Create OpenRouter discovery service instance."""
    return OpenRouterDiscoveryService()


@pytest.mark.asyncio
async def test_discover_embedding_models_returns_valid_list(discovery_service):
    """Test that discover_embedding_models returns a non-empty list of models."""
    models = await discovery_service.discover_embedding_models()

    assert isinstance(models, list)
    assert len(models) > 0
    assert all(isinstance(model, OpenRouterEmbeddingModel) for model in models)


@pytest.mark.asyncio
async def test_all_models_have_provider_prefix(discovery_service):
    """Test that all model IDs include provider prefix."""
    models = await discovery_service.discover_embedding_models()

    for model in models:
        assert "/" in model.id, f"Model ID '{model.id}' missing provider prefix"
        assert model.id.startswith(
            f"{model.provider}/"
        ), f"Model ID '{model.id}' doesn't match provider '{model.provider}'"


@pytest.mark.asyncio
async def test_dimensions_are_positive_integers(discovery_service):
    """Test that all models have positive integer dimensions."""
    models = await discovery_service.discover_embedding_models()

    for model in models:
        assert isinstance(model.dimensions, int), f"Model '{model.id}' dimensions is not an integer"
        assert model.dimensions > 0, f"Model '{model.id}' has non-positive dimensions: {model.dimensions}"


@pytest.mark.asyncio
async def test_pricing_is_non_negative(discovery_service):
    """Test that all models have non-negative pricing."""
    models = await discovery_service.discover_embedding_models()

    for model in models:
        assert isinstance(
            model.pricing_per_1m_tokens, (int, float)
        ), f"Model '{model.id}' pricing is not numeric"
        assert (
            model.pricing_per_1m_tokens >= 0
        ), f"Model '{model.id}' has negative pricing: {model.pricing_per_1m_tokens}"


@pytest.mark.asyncio
async def test_context_length_is_positive(discovery_service):
    """Test that all models have positive context length."""
    models = await discovery_service.discover_embedding_models()

    for model in models:
        assert isinstance(
            model.context_length, int
        ), f"Model '{model.id}' context_length is not an integer"
        assert (
            model.context_length > 0
        ), f"Model '{model.id}' has non-positive context_length: {model.context_length}"


@pytest.mark.asyncio
async def test_model_providers_are_valid(discovery_service):
    """Test that all models have valid provider names."""
    models = await discovery_service.discover_embedding_models()
    valid_providers = {"openai", "google", "qwen", "mistralai"}

    for model in models:
        assert (
            model.provider in valid_providers
        ), f"Model '{model.id}' has invalid provider: {model.provider}"


@pytest.mark.asyncio
async def test_openai_models_present(discovery_service):
    """Test that OpenAI models are included in the list."""
    models = await discovery_service.discover_embedding_models()
    openai_models = [m for m in models if m.provider == "openai"]

    assert len(openai_models) > 0, "No OpenAI models found"
    assert any(
        "text-embedding-3-small" in m.id for m in openai_models
    ), "text-embedding-3-small not found"
    assert any(
        "text-embedding-3-large" in m.id for m in openai_models
    ), "text-embedding-3-large not found"


@pytest.mark.asyncio
async def test_qwen_models_present(discovery_service):
    """Test that Qwen models are included in the list."""
    models = await discovery_service.discover_embedding_models()
    qwen_models = [m for m in models if m.provider == "qwen"]

    assert len(qwen_models) > 0, "No Qwen models found"
    # Verify at least one Qwen3 embedding model is present
    assert any("qwen3-embedding" in m.id for m in qwen_models), "No Qwen3 embedding models found"


@pytest.mark.asyncio
async def test_model_list_response_structure():
    """Test OpenRouterModelListResponse structure."""
    service = OpenRouterDiscoveryService()
    models = await service.discover_embedding_models()

    response = OpenRouterModelListResponse(embedding_models=models, total_count=len(models))

    assert response.total_count == len(models)
    assert response.total_count == len(response.embedding_models)
    assert response.total_count > 0


def test_model_id_validation_requires_prefix():
    """Test that model ID validation enforces provider prefix."""
    with pytest.raises(ValueError, match="must include provider prefix"):
        OpenRouterEmbeddingModel(
            id="text-embedding-3-small",  # Missing provider prefix
            provider="openai",
            name="text-embedding-3-small",
            dimensions=1536,
            context_length=8191,
            pricing_per_1m_tokens=0.02,
            supports_dimension_reduction=True,
        )


def test_model_with_valid_prefix_accepted():
    """Test that model with valid provider prefix is accepted."""
    model = OpenRouterEmbeddingModel(
        id="openai/text-embedding-3-small",
        provider="openai",
        name="text-embedding-3-small",
        dimensions=1536,
        context_length=8191,
        pricing_per_1m_tokens=0.02,
        supports_dimension_reduction=True,
    )

    assert model.id == "openai/text-embedding-3-small"
    assert "/" in model.id
