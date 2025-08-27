"""
API Routes for Clean Provider System

Simple endpoints for managing models, API keys, and usage tracking.
"""

from typing import Dict, List, Optional, Any
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, SecretStr
from supabase import Client

from ..services import (
    ModelConfigService,
    APIKeyManager,
    UsageTracker,
    ModelConfig,
    UsageSummary
)
from ..models.openrouter_models import OpenRouterService, ProviderModel
from ..embedding_models import EmbeddingModelService

# Create router
router = APIRouter(prefix="/api/providers", tags=["providers"])

# Optional security (can be removed if not needed)
security = HTTPBearer(auto_error=False)


# ==================== Request/Response Models ====================

class ModelSelectionRequest(BaseModel):
    """Request to update model selection"""
    service_name: str = Field(..., description="Service name (e.g., 'rag_agent')")
    model_string: str = Field(..., description="Model string (e.g., 'openai:gpt-4o')")
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(None, gt=0)


class APIKeyRequest(BaseModel):
    """Request to set an API key"""
    provider: str = Field(..., description="Provider name (e.g., 'openai')")
    api_key: SecretStr = Field(..., description="API key to store")
    base_url: Optional[str] = Field(None, description="Optional base URL")


class AvailableModel(BaseModel):
    """Available model information"""
    provider: str
    model: str
    model_string: str
    display_name: str
    has_api_key: bool
    cost_tier: Optional[str] = None
    estimated_cost_per_1k: Optional[Dict[str, float]] = None
    is_embedding: bool = False
    model_id: Optional[str] = None
    description: Optional[str] = None
    context_length: Optional[int] = None
    input_cost: Optional[float] = None
    output_cost: Optional[float] = None
    supports_vision: bool = False
    supports_tools: bool = False
    supports_reasoning: bool = False


class ServiceStatus(BaseModel):
    """Service configuration status"""
    service_name: str
    model_string: str
    provider: str
    model: str
    api_key_configured: bool
    temperature: float
    max_tokens: Optional[int]


# ==================== Dependencies ====================

def get_supabase() -> Client:
    """Get Supabase client (implement based on your setup)"""
    import os
    from supabase import create_client
    
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    
    if not url or not key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database configuration missing"
        )
    
    return create_client(url, key)


def get_model_service(supabase: Client = Depends(get_supabase)) -> ModelConfigService:
    """Get model configuration service"""
    return ModelConfigService(supabase)


def get_key_manager(supabase: Client = Depends(get_supabase)) -> APIKeyManager:
    """Get API key manager"""
    return APIKeyManager(supabase)


def get_usage_tracker(supabase: Client = Depends(get_supabase)) -> UsageTracker:
    """Get usage tracker"""
    return UsageTracker(supabase)


# ==================== Model Configuration Endpoints ====================

@router.get("/models/config/{service_name}", response_model=ModelConfig)
async def get_model_config(
    service_name: str,
    service: ModelConfigService = Depends(get_model_service)
):
    """Get current model configuration for a service"""
    try:
        config = await service.get_model_config(service_name)
        return config
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get model config: {str(e)}"
        )


@router.post("/models/config", response_model=ModelConfig)
async def update_model_config(
    request: ModelSelectionRequest,
    service: ModelConfigService = Depends(get_model_service)
):
    """Update model configuration for a service"""
    try:
        config = await service.set_model_config(
            service_name=request.service_name,
            model_string=request.model_string,
            temperature=request.temperature,
            max_tokens=request.max_tokens
        )
        return config
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update model config: {str(e)}"
        )


@router.get("/models/configs", response_model=Dict[str, str])
async def get_all_model_configs(
    service: ModelConfigService = Depends(get_model_service)
):
    """Get all service model configurations"""
    try:
        configs = await service.get_all_configs()
        return configs
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get configurations: {str(e)}"
        )


@router.get("/models/status", response_model=List[ServiceStatus])
async def get_services_status(
    model_service: ModelConfigService = Depends(get_model_service),
    key_manager: APIKeyManager = Depends(get_key_manager)
):
    """Get status of all configured services"""
    try:
        configs = await model_service.get_all_configs()
        active_providers = await key_manager.get_active_providers()
        
        status_list = []
        for service_name, model_string in configs.items():
            provider = model_string.split(':', 1)[0] if ':' in model_string else 'unknown'
            model = model_string.split(':', 1)[1] if ':' in model_string else model_string
            
            # Get full config for temperature and max_tokens
            full_config = await model_service.get_model_config(service_name)
            
            status_list.append(ServiceStatus(
                service_name=service_name,
                model_string=model_string,
                provider=provider,
                model=model,
                api_key_configured=provider in active_providers or provider == 'ollama',
                temperature=full_config.temperature,
                max_tokens=full_config.max_tokens
            ))
        
        return status_list
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get service status: {str(e)}"
        )


# ==================== API Key Management Endpoints ====================

@router.post("/api-keys", status_code=status.HTTP_201_CREATED)
async def set_api_key(
    request: APIKeyRequest,
    manager: APIKeyManager = Depends(get_key_manager)
):
    """Store an API key for a provider"""
    try:
        await manager.set_api_key(
            provider=request.provider,
            api_key=request.api_key.get_secret_value(),
            base_url=request.base_url
        )
        return {"status": "success", "provider": request.provider}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to store API key: {str(e)}"
        )


@router.get("/api-keys/providers", response_model=List[str])
async def get_active_providers(
    manager: APIKeyManager = Depends(get_key_manager)
):
    """Get list of providers with active API keys"""
    try:
        providers = await manager.get_active_providers()
        return providers
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get active providers: {str(e)}"
        )


@router.delete("/api-keys/{provider}")
async def deactivate_api_key(
    provider: str,
    manager: APIKeyManager = Depends(get_key_manager)
):
    """Deactivate an API key for a provider"""
    try:
        success = await manager.deactivate_api_key(provider)
        if success:
            return {"status": "success", "provider": provider}
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No active API key found for {provider}"
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to deactivate API key: {str(e)}"
        )


@router.post("/api-keys/test/{provider}")
async def test_api_key(
    provider: str,
    manager: APIKeyManager = Depends(get_key_manager)
):
    """Test if a provider's API key is configured"""
    try:
        is_valid = await manager.test_provider_key(provider)
        return {
            "provider": provider,
            "configured": is_valid,
            "status": "active" if is_valid else "not_configured"
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to test API key: {str(e)}"
        )


# ==================== Available Models Endpoints ====================

@router.get("/providers/list", response_model=List[str])
async def get_provider_list():
    """Get list of all available providers from OpenRouter"""
    try:
        providers = OpenRouterService.get_unique_providers()
        # Add OpenRouter itself as a provider since it won't come from their API
        if 'openrouter' not in providers:
            providers.append('openrouter')
        return sorted(providers)
    except Exception as e:
        # Fallback to common providers if OpenRouter fails
        return [
            'openai', 'anthropic', 'google', 'mistral', 
            'meta', 'deepseek', 'groq', 'cohere', 
            'ai21', 'xai', 'ollama', 'openrouter'
        ]

@router.get("/providers/metadata")
async def get_providers_metadata():
    """Get metadata for all providers including costs and context lengths"""
    try:
        metadata = OpenRouterService.get_all_provider_metadata()
        
        # Add special handling for OpenRouter itself
        if 'openrouter' not in metadata:
            metadata['openrouter'] = {
                'provider': 'openrouter',
                'model_count': 100,  # Approximate
                'max_context_length': 200000,  # Highest available through OpenRouter
                'min_input_cost': 0,
                'max_input_cost': 15,
                'has_free_models': True,
                'supports_vision': True,
                'supports_tools': True,
                'description': 'Unified API for all providers'
            }
        
        return metadata
    except Exception as e:
        # Return empty metadata on error
        return {}

@router.get("/providers/{provider}/metadata")
async def get_provider_metadata(provider: str):
    """Get metadata for a specific provider"""
    try:
        if provider == 'openrouter':
            return {
                'provider': 'openrouter',
                'model_count': 100,  # Approximate
                'max_context_length': 200000,  # Highest available through OpenRouter
                'min_input_cost': 0,
                'max_input_cost': 15,
                'has_free_models': True,
                'supports_vision': True,
                'supports_tools': True,
                'description': 'Unified API for all providers'
            }
        
        metadata = OpenRouterService.get_provider_metadata(provider)
        return metadata
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get provider metadata: {str(e)}"
        )

@router.get("/models/available", response_model=List[AvailableModel])
async def get_available_models(
    key_manager: APIKeyManager = Depends(get_key_manager),
    usage_tracker: UsageTracker = Depends(get_usage_tracker)
):
    """Get list of available models based on configured API keys"""
    try:
        active_providers = await key_manager.get_active_providers()
        available_models = []
        
        # Get models from OpenRouter data
        all_provider_models = OpenRouterService.get_all_providers()
        
        # Always include Ollama models (no API key needed)
        if 'ollama' not in active_providers:
            active_providers.append('ollama')
        
        # Add OpenRouter models if OpenRouter API key is configured
        if 'openrouter' in active_providers and 'openrouter' not in all_provider_models:
            # When using OpenRouter, ALL models from all providers are available
            all_provider_models['openrouter'] = []
            for provider_models in all_provider_models.values():
                for model in provider_models[:5]:  # Take top 5 from each provider
                    openrouter_model = ProviderModel(
                        provider='openrouter',
                        model_id=f"{model.provider}/{model.model_id}",
                        display_name=f"OpenRouter: {model.display_name}",
                        description=model.description,
                        context_length=model.context_length,
                        input_cost=model.input_cost,
                        output_cost=model.output_cost,
                        supports_vision=model.supports_vision,
                        supports_tools=model.supports_tools,
                        supports_reasoning=model.supports_reasoning,
                        is_free=False
                    )
                    all_provider_models['openrouter'].append(openrouter_model)
        
        # Add some common Ollama models if not in OpenRouter data
        if 'ollama' not in all_provider_models:
            all_provider_models['ollama'] = [
                ProviderModel(
                    provider='ollama',
                    model_id='llama3',
                    display_name='Llama 3 (Local)',
                    description='Local Llama 3 model',
                    context_length=8192,
                    input_cost=0,
                    output_cost=0,
                    is_free=True
                ),
                ProviderModel(
                    provider='ollama',
                    model_id='mistral',
                    display_name='Mistral (Local)',
                    description='Local Mistral model',
                    context_length=8192,
                    input_cost=0,
                    output_cost=0,
                    is_free=True
                ),
                ProviderModel(
                    provider='ollama',
                    model_id='codellama',
                    display_name='Code Llama (Local)',
                    description='Local Code Llama model',
                    context_length=8192,
                    input_cost=0,
                    output_cost=0,
                    is_free=True
                )
            ]
        
        # Track seen model strings to avoid duplicates
        seen_model_strings = set()
        
        for provider in set(active_providers):
            if provider in all_provider_models:
                # Get all models for the provider
                all_models = all_provider_models[provider]
                
                # Show all models - both free and paid
                # Separate free and paid models
                free_models = [m for m in all_models if m.is_free]
                paid_models = [m for m in all_models if not m.is_free]
                
                # Combine all models without limits (free first for visibility, then paid)
                provider_model_list = free_models + paid_models
                
                for model in provider_model_list:
                    model_string = f"{provider}:{model.model_id}"
                    
                    # Skip if we've already added this model
                    if model_string in seen_model_strings:
                        continue
                    
                    seen_model_strings.add(model_string)
                    
                    # Determine cost tier
                    if model.is_free:
                        cost_tier = 'free'
                    elif model.input_cost < 0.5:
                        cost_tier = 'low'
                    elif model.input_cost < 5:
                        cost_tier = 'medium'
                    else:
                        cost_tier = 'high'
                    
                    available_models.append(AvailableModel(
                        provider=provider,
                        model=model.model_id,
                        model_string=model_string,
                        display_name=model.display_name,
                        has_api_key=provider != 'ollama',
                        cost_tier=cost_tier,
                        estimated_cost_per_1k={
                            'input': model.input_cost / 1000,  # Convert to per 1k tokens
                            'output': model.output_cost / 1000
                        } if not model.is_free else None
                    ))
        
        # Add embedding models based on configured API keys
        api_key_status = {}
        for provider in active_providers:
            api_key_status[provider] = True
        
        embedding_models = EmbeddingModelService.get_available_models(api_key_status)
        for emb_model in embedding_models:
            # Determine cost tier for embedding models
            if emb_model.cost_per_million_tokens == 0:
                cost_tier = 'free'
            elif emb_model.cost_per_million_tokens < 0.05:
                cost_tier = 'low'
            elif emb_model.cost_per_million_tokens < 0.15:
                cost_tier = 'medium'
            else:
                cost_tier = 'high'
            
            available_models.append(AvailableModel(
                provider=emb_model.provider,
                model=emb_model.model_id,
                model_string=emb_model.model_string,
                display_name=emb_model.name,
                has_api_key=True,  # We only show models with API keys
                cost_tier=cost_tier,
                estimated_cost_per_1k={
                    'input': emb_model.cost_per_million_tokens / 1000000,  # Convert to per-token cost
                    'output': 0  # Embeddings don't have output cost
                } if emb_model.cost_per_million_tokens > 0 else None,
                is_embedding=True,
                model_id=emb_model.model_id,
                description=f"Embedding model with {emb_model.dimensions} dimensions",
                context_length=emb_model.max_tokens,
                input_cost=emb_model.cost_per_million_tokens / 1000000,
                output_cost=0,
                supports_vision=False,
                supports_tools=False,
                supports_reasoning=False
            ))
        
        return available_models
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get available models: {str(e)}"
        )


# ==================== Usage Tracking Endpoints ====================

@router.get("/usage/summary")
async def get_usage_summary(
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    tracker: UsageTracker = Depends(get_usage_tracker)
):
    """Get usage summary across all services"""
    try:
        summary = await tracker.get_usage_summary(start_date, end_date)
        
        # Convert to expected frontend format
        return {
            "total_cost": float(summary.total_cost),
            "total_requests": summary.total_requests,
            "total_input_tokens": summary.total_tokens // 2,  # Rough estimate
            "total_output_tokens": summary.total_tokens // 2,  # Rough estimate
            "providers": [],  # TODO: Aggregate by provider
            "models": [],  # TODO: Aggregate by model
            "by_model": {
                k: {**v, "cost": float(v["cost"])}
                for k, v in summary.by_model.items()
            }
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get usage summary: {str(e)}"
        )


@router.get("/usage/daily")
async def get_daily_costs(
    days: int = 7,
    tracker: UsageTracker = Depends(get_usage_tracker)
):
    """Get daily costs for the last N days"""
    try:
        daily_costs = await tracker.get_daily_costs(days)
        
        # Convert Decimal to float
        return {
            date: float(cost)
            for date, cost in daily_costs.items()
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get daily costs: {str(e)}"
        )


@router.get("/usage/estimate-monthly")
async def estimate_monthly_cost(
    tracker: UsageTracker = Depends(get_usage_tracker)
):
    """Estimate monthly cost based on current usage"""
    try:
        estimate = await tracker.estimate_monthly_cost()
        return {
            "estimated_monthly_cost": float(estimate),
            "based_on_days": 7
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to estimate monthly cost: {str(e)}"
        )


# ==================== Initialization Endpoint ====================

@router.post("/initialize")
async def initialize_provider_system(
    key_manager: APIKeyManager = Depends(get_key_manager)
):
    """Initialize the provider system (set up environment variables)"""
    try:
        status = await key_manager.setup_environment()
        return {
            "status": "initialized",
            "providers_configured": list(status.keys()),
            "success_count": sum(1 for v in status.values() if v)
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to initialize provider system: {str(e)}"
        )


# ==================== Active Models Status Endpoint ====================

@router.get("/active-models")
async def get_active_models_status(
    model_service: ModelConfigService = Depends(get_model_service),
    key_manager: APIKeyManager = Depends(get_key_manager),
    usage_tracker: UsageTracker = Depends(get_usage_tracker)
):
    """
    Get the currently active models for all services.
    This endpoint shows exactly what models are being used by each service.
    Also includes usage statistics (tokens and costs).
    """
    try:
        # Get all model configurations
        all_configs = await model_service.get_all_configs()
        
        # Get API key status for each provider
        api_key_status = {}
        for provider in ['openai', 'anthropic', 'google', 'mistral', 'groq', 'deepseek', 'ollama', 'openrouter']:
            api_key_status[provider] = await key_manager.test_provider_key(provider)
        
        # Build response with service -> model mapping
        active_models = {}
        for service_name, model_string in all_configs.items():
            provider = model_string.split(':')[0] if ':' in model_string else 'unknown'
            model_name = model_string.split(':', 1)[1] if ':' in model_string else model_string
            
            active_models[service_name] = {
                "model_string": model_string,
                "provider": provider,
                "model": model_name,
                "api_key_configured": api_key_status.get(provider, False)
            }
        
        # Add default services if not configured (only for services defined in frontend)
        default_services = {
            'rag_agent': 'openai:gpt-4o-mini',
            'document_agent': 'openai:gpt-4o',
            'task_agent': 'openai:gpt-4o',
            'embeddings': 'openai:text-embedding-3-small',
            'contextual_embedding': 'openai:gpt-4o-mini',
            'source_summary': 'openai:gpt-4o-mini',
            'code_summary': 'openai:gpt-4o-mini',
            'code_analysis': 'openai:gpt-4o-mini',
            'validation': 'openai:gpt-3.5-turbo'
        }
        
        for service, default_model in default_services.items():
            if service not in active_models:
                provider = default_model.split(':')[0]
                model_name = default_model.split(':', 1)[1]
                active_models[service] = {
                    "model_string": default_model,
                    "provider": provider,
                    "model": model_name,
                    "api_key_configured": api_key_status.get(provider, False),
                    "is_default": True
                }
        
        # Get usage statistics for today
        from datetime import datetime, timedelta
        today = datetime.utcnow().date()
        start_of_day = datetime.combine(today, datetime.min.time())
        
        # Get usage summary
        usage_summary = await usage_tracker.get_usage_summary(start_of_day, None)
        
        # Calculate total tokens (approximate from summary)
        total_tokens = usage_summary.total_tokens if usage_summary else 0
        total_cost = float(usage_summary.total_cost) if usage_summary else 0.0
        
        # Get monthly estimate
        monthly_estimate = await usage_tracker.estimate_monthly_cost()
        
        return {
            "active_models": active_models,
            "api_key_status": api_key_status,
            "usage": {
                "total_tokens_today": total_tokens,
                "total_cost_today": total_cost,
                "estimated_monthly_cost": float(monthly_estimate)
            },
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get active models: {str(e)}"
        )