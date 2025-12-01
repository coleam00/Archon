"""
OpenRouter API routes.

Endpoints for OpenRouter model discovery and configuration.
"""

from fastapi import APIRouter

from ..services.openrouter_discovery_service import OpenRouterModelListResponse, openrouter_discovery_service

router = APIRouter(prefix="/api/openrouter", tags=["openrouter"])


@router.get("/models", response_model=OpenRouterModelListResponse)
async def get_openrouter_models() -> OpenRouterModelListResponse:
    """
    Get available OpenRouter embedding models.

    Returns a list of embedding models available through OpenRouter,
    including models from OpenAI, Google, Qwen, and Mistral providers.

    Returns:
        OpenRouterModelListResponse: List of embedding models with metadata
    """
    models = await openrouter_discovery_service.discover_embedding_models()

    return OpenRouterModelListResponse(embedding_models=models, total_count=len(models))
