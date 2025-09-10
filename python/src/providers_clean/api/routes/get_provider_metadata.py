import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException

from ...services import ModelSyncService
from ...infrastructure.dependencies import get_model_sync_service
from ..schemas import ProviderDetailMetadata, TopModelInfo


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.get("/{provider}/metadata", response_model=ProviderDetailMetadata)
async def get_provider_metadata(
    provider: str,
    sync_service: ModelSyncService = Depends(get_model_sync_service)
) -> ProviderDetailMetadata:
    """Get metadata for a specific provider"""
    try:
        async with sync_service.uow as uow:
            repo = uow.available_models
            if repo is None:
                raise HTTPException(
                    status_code=500, detail="Available models repository not initialized")
            models = await repo.get_models_by_provider(provider)

            if not models:
                raise HTTPException(
                    status_code=404,
                    detail=f"Provider not found: {provider}"
                )

            max_context = max(int(m.get('context_length', 0) or 0)
                              for m in models)
            nonzero_costs = [float(m.get('input_cost') or 0)
                             for m in models if float(m.get('input_cost') or 0) > 0]
            min_input_cost = min(nonzero_costs) if nonzero_costs else None
            max_input_cost = max(float(m.get('input_cost') or 0)
                                 for m in models) if models else None
            has_free = any(bool(m.get('is_free', False)) for m in models)
            supports_vision = any(
                bool(m.get('supports_vision', False)) for m in models)
            supports_tools = any(bool(m.get('supports_tools', False))
                                 for m in models)

            top_models: List[TopModelInfo] = [
                TopModelInfo(
                    model_id=str(m['model_id']),
                    display_name=str(m['display_name']),
                    context_length=int(m.get('context_length', 0) or 0),
                    input_cost=float(m.get('input_cost') or 0),
                    is_free=bool(m.get('is_free', False))
                )
                for m in models[:3]
            ]

            provider_meta = ProviderDetailMetadata(
                provider=provider,
                model_count=len(models),
                max_context_length=max_context,
                min_input_cost=min_input_cost,
                max_input_cost=max_input_cost,
                has_free_models=has_free,
                supports_vision=supports_vision,
                supports_tools=supports_tools,
                top_models=top_models
            )

            return provider_meta

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get metadata for provider {provider}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get provider metadata: {str(e)}"
        )
