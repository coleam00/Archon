"""
OpenRouter Models Integration

Fetches and parses model information from OpenRouter API
to dynamically provide available models and providers.
"""

from typing import List, Dict, Optional, Any
from datetime import datetime
from decimal import Decimal
from pydantic import BaseModel, Field
import httpx
import json
from pathlib import Path
from functools import lru_cache


class OpenRouterArchitecture(BaseModel):
    """Model architecture information"""
    modality: str
    input_modalities: List[str]
    output_modalities: List[str]
    tokenizer: str
    instruct_type: Optional[str] = None


class OpenRouterPricing(BaseModel):
    """Pricing information for a model"""
    prompt: str
    completion: str
    request: str = "0"
    image: str = "0"
    audio: str = "0"
    web_search: str = "0"
    internal_reasoning: str = "0"
    input_cache_read: Optional[str] = None
    input_cache_write: Optional[str] = None


class OpenRouterTopProvider(BaseModel):
    """Top provider information"""
    context_length: Optional[int] = None
    max_completion_tokens: Optional[int] = None
    is_moderated: bool


class OpenRouterModel(BaseModel):
    """Individual model from OpenRouter"""
    id: str
    canonical_slug: str
    hugging_face_id: Optional[str] = ""
    name: str
    created: int
    description: str
    context_length: int
    architecture: OpenRouterArchitecture
    pricing: OpenRouterPricing
    top_provider: OpenRouterTopProvider
    per_request_limits: Optional[Any] = None
    supported_parameters: List[str]


class OpenRouterResponse(BaseModel):
    """Response from OpenRouter API"""
    data: List[OpenRouterModel]


class ProviderModel(BaseModel):
    """Simplified model for our system"""
    provider: str
    model_id: str
    display_name: str
    description: str
    context_length: int
    input_cost: float  # Per 1M tokens
    output_cost: float  # Per 1M tokens
    supports_vision: bool = False
    supports_tools: bool = False
    supports_reasoning: bool = False
    is_free: bool = False


class OpenRouterService:
    """Service to fetch and parse OpenRouter models"""
    
    CACHE_FILE = Path(__file__).parent.parent / "openrouter_models.json"
    CACHE_DURATION = 3600  # 1 hour in seconds
    
    # Map OpenRouter provider IDs to our standard names
    PROVIDER_MAPPING = {
        'openai': 'openai',
        'anthropic': 'anthropic',
        'google': 'google',
        'meta-llama': 'meta',
        'mistralai': 'mistral',
        'deepseek': 'deepseek',
        'qwen': 'qwen',
        'cohere': 'cohere',
        'ai21': 'ai21',
        'x-ai': 'xai',
        'nvidia': 'nvidia',
        'microsoft': 'microsoft',
        'alibaba': 'alibaba',
        'baidu': 'baidu',
        'groq': 'groq',
        'perplexity': 'perplexity',
        'together': 'together',
        'fireworks': 'fireworks',
        'replicate': 'replicate',
        'databricks': 'databricks',
        'z-ai': 'zai',
        'inflection': 'inflection',
        '01-ai': '01ai',
        'nousresearch': 'nous',
        'openchat': 'openchat',
        'pygmalionai': 'pygmalion',
        'undi95': 'undi95',
        'gryphe': 'gryphe',
        'sophosympatheia': 'sophosympatheia',
        'neversleep': 'neversleep',
        'sao10k': 'sao10k'
    }
    
    @classmethod
    def _load_cache(cls) -> Optional[OpenRouterResponse]:
        """Load cached models if available and fresh"""
        if not cls.CACHE_FILE.exists():
            return None
            
        try:
            cache_stat = cls.CACHE_FILE.stat()
            cache_age = datetime.now().timestamp() - cache_stat.st_mtime
            
            if cache_age > cls.CACHE_DURATION:
                return None
                
            with open(cls.CACHE_FILE, 'r') as f:
                data = json.load(f)
                return OpenRouterResponse(**data)
        except Exception:
            return None
    
    @classmethod
    def _save_cache(cls, response: OpenRouterResponse) -> None:
        """Save response to cache file"""
        try:
            cls.CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(cls.CACHE_FILE, 'w') as f:
                json.dump(response.model_dump(), f, indent=2)
        except Exception:
            pass  # Caching is optional
    
    @classmethod
    async def fetch_models(cls) -> OpenRouterResponse:
        """Fetch models from OpenRouter API or cache"""
        # Try cache first
        cached = cls._load_cache()
        if cached:
            return cached
            
        # Fetch from API
        async with httpx.AsyncClient() as client:
            response = await client.get("https://openrouter.ai/api/v1/models")
            response.raise_for_status()
            
            data = OpenRouterResponse(**response.json())
            cls._save_cache(data)
            return data
    
    @classmethod
    def fetch_models_sync(cls) -> OpenRouterResponse:
        """Synchronous version of fetch_models"""
        # Try cache first
        cached = cls._load_cache()
        if cached:
            return cached
            
        # Fetch from API
        with httpx.Client() as client:
            response = client.get("https://openrouter.ai/api/v1/models")
            response.raise_for_status()
            
            data = OpenRouterResponse(**response.json())
            cls._save_cache(data)
            return data
    
    @classmethod
    def parse_provider_from_id(cls, model_id: str) -> str:
        """Extract provider from model ID (e.g., 'openai/gpt-4' -> 'openai')"""
        if '/' in model_id:
            provider_part = model_id.split('/')[0]
            return cls.PROVIDER_MAPPING.get(provider_part, provider_part)
        return 'unknown'
    
    @classmethod
    def parse_model_name(cls, model_id: str) -> str:
        """Extract model name from ID (e.g., 'openai/gpt-4' -> 'gpt-4')"""
        if '/' in model_id:
            model_name = model_id.split('/', 1)[1]
        else:
            model_name = model_id
        
        # Remove :free, :beta, :extended or other suffixes that cause issues
        if ':' in model_name:
            model_name = model_name.split(':')[0]
        
        return model_name
    
    @classmethod
    def convert_to_provider_models(cls, openrouter_models: List[OpenRouterModel]) -> List[ProviderModel]:
        """Convert OpenRouter models to our simplified format"""
        provider_models = []
        
        for model in openrouter_models:
            provider = cls.parse_provider_from_id(model.id)
            model_name = cls.parse_model_name(model.id)
            
            # Parse costs (OpenRouter prices are per token, we want per 1M)
            try:
                input_cost = float(model.pricing.prompt) * 1_000_000
                output_cost = float(model.pricing.completion) * 1_000_000
            except (ValueError, TypeError):
                input_cost = 0.0
                output_cost = 0.0
            
            # Check capabilities
            supports_vision = 'image' in model.architecture.input_modalities
            supports_tools = 'tools' in model.supported_parameters or 'tool_choice' in model.supported_parameters
            supports_reasoning = 'reasoning' in model.supported_parameters
            is_free = input_cost == 0 and output_cost == 0
            
            provider_models.append(ProviderModel(
                provider=provider,
                model_id=model_name,
                display_name=model.name,
                description=model.description[:500] if model.description else "",  # Truncate long descriptions
                context_length=model.context_length,
                input_cost=input_cost,
                output_cost=output_cost,
                supports_vision=supports_vision,
                supports_tools=supports_tools,
                supports_reasoning=supports_reasoning,
                is_free=is_free
            ))
        
        return provider_models
    
    @classmethod
    @lru_cache(maxsize=1)
    def get_all_providers(cls) -> Dict[str, List[ProviderModel]]:
        """Get all available providers and their models"""
        response = cls.fetch_models_sync()
        models = cls.convert_to_provider_models(response.data)
        
        # Group by provider
        providers: Dict[str, List[ProviderModel]] = {}
        for model in models:
            if model.provider not in providers:
                providers[model.provider] = []
            providers[model.provider].append(model)
        
        # Sort models within each provider for better variety
        # Put free models first, then sort paid models by cost
        for provider in providers:
            free_models = [m for m in providers[provider] if m.is_free]
            paid_models = [m for m in providers[provider] if not m.is_free]
            
            # Sort paid models by cost
            paid_models.sort(key=lambda m: m.input_cost)
            
            # Combine: free models first, then paid models sorted by cost
            providers[provider] = free_models + paid_models
        
        return providers
    
    @classmethod
    def get_provider_models(cls, provider: str) -> List[ProviderModel]:
        """Get models for a specific provider"""
        all_providers = cls.get_all_providers()
        return all_providers.get(provider, [])
    
    @classmethod
    def get_unique_providers(cls) -> List[str]:
        """Get list of unique provider names"""
        all_providers = cls.get_all_providers()
        return sorted(all_providers.keys())
    
    @classmethod
    def get_model_by_string(cls, model_string: str) -> Optional[ProviderModel]:
        """Get a specific model by its string format (e.g., 'openai:gpt-4')"""
        if ':' not in model_string:
            return None
            
        provider, model_id = model_string.split(':', 1)
        models = cls.get_provider_models(provider)
        
        for model in models:
            if model.model_id == model_id:
                return model
        
        return None
    
    @classmethod
    def get_provider_metadata(cls, provider: str) -> Dict[str, Any]:
        """Get aggregated metadata for a provider"""
        models = cls.get_provider_models(provider)
        
        if not models:
            return {
                'provider': provider,
                'model_count': 0,
                'max_context_length': 0,
                'min_input_cost': 0,
                'max_input_cost': 0,
                'has_free_models': False,
                'supports_vision': False,
                'supports_tools': False
            }
        
        return {
            'provider': provider,
            'model_count': len(models),
            'max_context_length': max(m.context_length for m in models),
            'min_input_cost': min(m.input_cost for m in models if m.input_cost > 0) if any(m.input_cost > 0 for m in models) else 0,
            'max_input_cost': max(m.input_cost for m in models),
            'has_free_models': any(m.is_free for m in models),
            'supports_vision': any(m.supports_vision for m in models),
            'supports_tools': any(m.supports_tools for m in models),
            'top_models': [
                {
                    'model_id': m.model_id,
                    'display_name': m.display_name,
                    'context_length': m.context_length,
                    'input_cost': m.input_cost,
                    'is_free': m.is_free
                }
                for m in models[:3]  # Top 3 models
            ]
        }
    
    @classmethod
    def get_all_provider_metadata(cls) -> Dict[str, Dict[str, Any]]:
        """Get metadata for all providers"""
        providers = cls.get_unique_providers()
        return {p: cls.get_provider_metadata(p) for p in providers}


# Export main class and models
__all__ = [
    'OpenRouterService',
    'ProviderModel',
    'OpenRouterModel',
    'OpenRouterResponse'
]