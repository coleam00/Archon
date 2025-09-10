import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_key_service
from ..schemas import AvailableModel
from ...services import APIKeyService, ModelSyncService
from ...infrastructure.dependencies import get_model_sync_service


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/providers", tags=["providers"])


@router.get("/models/available", response_model=List[AvailableModel])
async def get_available_models(
    key_service: APIKeyService = Depends(get_key_service),
    sync_service: ModelSyncService = Depends(get_model_sync_service)
):
    """Get list of available models from database, filtered by configured API keys"""
    try:
        active_providers = await key_service.get_active_providers()
        if not active_providers:
            raise HTTPException(
                status_code=404, detail="No providers with active API keys")

        async with sync_service.uow as uow:
            repo = uow.available_models
            if repo is None:
                raise HTTPException(
                    status_code=500, detail="Available models repository not initialized")
            db_models = await repo.get_providers_with_api_keys(active_providers)

        available_models: List[AvailableModel] = []
        for db_model in db_models:
            has_api_key = db_model['provider'] in active_providers or db_model['provider'] == 'ollama'

            estimated_cost_per_1m = None
            if db_model['input_cost'] and db_model['input_cost'] > 0:
                estimated_cost_per_1m = {
                    # Convert to per 1M tokens
                    'input': float(db_model['input_cost']) * 1000000,
                    'output': float(db_model['output_cost'] or 0) * 1000000
                }

            available_models.append(AvailableModel(
                provider=db_model['provider'],
                model=db_model['model_id'],
                model_string=db_model['model_string'],
                display_name=db_model['display_name'],
                has_api_key=has_api_key,
                cost_tier=db_model['cost_tier'],
                estimated_cost_per_1m=estimated_cost_per_1m,
                is_embedding=db_model['is_embedding'],
                model_id=db_model['model_id'],
                description=db_model['description'],
                context_length=db_model['context_length'],
                input_cost=float(db_model['input_cost']) *
                1_000_000 if db_model['input_cost'] else 0,
                output_cost=float(
                    db_model['output_cost']) * 1_000_000 if db_model['output_cost'] else 0,
                supports_vision=db_model['supports_vision'],
                supports_tools=db_model['supports_tools'],
                supports_reasoning=db_model['supports_reasoning']
            ))

        if not available_models:
            raise HTTPException(
                status_code=404, detail="No available models found in database for configured providers")

        logger.info(
            f"Returned {len(available_models)} models from database for {len(active_providers)} providers")
        return available_models

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get available models: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get available models: {str(e)}"
        )
