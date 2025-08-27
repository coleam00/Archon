"""
Hardcoded Embedding Models Configuration

Since embedding models are not available from all providers and OpenRouter doesn't provide them,
we maintain a hardcoded list of known embedding models and their providers.
"""

from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class EmbeddingModel(BaseModel):
    """Embedding model configuration"""
    model_string: str = Field(..., description="Full model string (provider:model)")
    name: str = Field(..., description="Display name")
    dimensions: int = Field(..., description="Number of dimensions in the embedding vector")
    max_tokens: int = Field(..., description="Maximum input tokens")
    cost_per_million_tokens: float = Field(0.0, description="Cost per million tokens")
    provider: str = Field(..., description="Provider name")
    model_id: str = Field(..., description="Model ID without provider prefix")


# Known embedding models from major providers
EMBEDDING_MODELS: List[EmbeddingModel] = [
    # OpenAI Embedding Models
    EmbeddingModel(
        model_string="openai:text-embedding-3-large",
        name="OpenAI Text Embedding 3 Large",
        dimensions=3072,
        max_tokens=8191,
        cost_per_million_tokens=0.13,
        provider="openai",
        model_id="text-embedding-3-large"
    ),
    EmbeddingModel(
        model_string="openai:text-embedding-3-small",
        name="OpenAI Text Embedding 3 Small",
        dimensions=1536,
        max_tokens=8191,
        cost_per_million_tokens=0.02,
        provider="openai",
        model_id="text-embedding-3-small"
    ),
    EmbeddingModel(
        model_string="openai:text-embedding-ada-002",
        name="OpenAI Ada v2 (Legacy)",
        dimensions=1536,
        max_tokens=8191,
        cost_per_million_tokens=0.10,
        provider="openai",
        model_id="text-embedding-ada-002"
    ),
    
    # Google/Gemini Embedding Models
    EmbeddingModel(
        model_string="google:text-embedding-004",
        name="Google Text Embedding 004",
        dimensions=768,
        max_tokens=2048,
        cost_per_million_tokens=0.025,
        provider="google",
        model_id="text-embedding-004"
    ),
    EmbeddingModel(
        model_string="google:text-multilingual-embedding-002",
        name="Google Multilingual Embedding",
        dimensions=768,
        max_tokens=2048,
        cost_per_million_tokens=0.025,
        provider="google",
        model_id="text-multilingual-embedding-002"
    ),
    
    # Cohere Embedding Models
    EmbeddingModel(
        model_string="cohere:embed-english-v3.0",
        name="Cohere Embed English v3",
        dimensions=1024,
        max_tokens=512,
        cost_per_million_tokens=0.10,
        provider="cohere",
        model_id="embed-english-v3.0"
    ),
    EmbeddingModel(
        model_string="cohere:embed-multilingual-v3.0",
        name="Cohere Embed Multilingual v3",
        dimensions=1024,
        max_tokens=512,
        cost_per_million_tokens=0.10,
        provider="cohere",
        model_id="embed-multilingual-v3.0"
    ),
    EmbeddingModel(
        model_string="cohere:embed-english-light-v3.0",
        name="Cohere Embed English Light v3",
        dimensions=384,
        max_tokens=512,
        cost_per_million_tokens=0.02,
        provider="cohere",
        model_id="embed-english-light-v3.0"
    ),
    
    # Mistral Embedding Models
    EmbeddingModel(
        model_string="mistral:mistral-embed",
        name="Mistral Embed",
        dimensions=1024,
        max_tokens=8000,
        cost_per_million_tokens=0.10,
        provider="mistral",
        model_id="mistral-embed"
    ),
    
    # Local/Ollama Embedding Models (free but requires local setup)
    EmbeddingModel(
        model_string="ollama:nomic-embed-text",
        name="Nomic Embed Text (Local)",
        dimensions=768,
        max_tokens=8192,
        cost_per_million_tokens=0.0,
        provider="ollama",
        model_id="nomic-embed-text"
    ),
    EmbeddingModel(
        model_string="ollama:mxbai-embed-large",
        name="MixedBread AI Embed Large (Local)",
        dimensions=1024,
        max_tokens=512,
        cost_per_million_tokens=0.0,
        provider="ollama",
        model_id="mxbai-embed-large"
    ),
    EmbeddingModel(
        model_string="ollama:all-minilm",
        name="All-MiniLM (Local)",
        dimensions=384,
        max_tokens=256,
        cost_per_million_tokens=0.0,
        provider="ollama",
        model_id="all-minilm"
    ),
]


class EmbeddingModelService:
    """Service for managing embedding models"""
    
    @staticmethod
    def get_all_models() -> List[EmbeddingModel]:
        """Get all available embedding models"""
        return EMBEDDING_MODELS
    
    @staticmethod
    def get_models_by_provider(provider: str) -> List[EmbeddingModel]:
        """Get embedding models for a specific provider"""
        return [m for m in EMBEDDING_MODELS if m.provider.lower() == provider.lower()]
    
    @staticmethod
    def get_model(model_string: str) -> Optional[EmbeddingModel]:
        """Get a specific embedding model by its model string"""
        for model in EMBEDDING_MODELS:
            if model.model_string == model_string:
                return model
        return None
    
    @staticmethod
    def get_available_models(api_keys: Dict[str, bool]) -> List[EmbeddingModel]:
        """
        Get embedding models that are available based on configured API keys.
        
        Args:
            api_keys: Dictionary mapping provider names to whether they have valid API keys
            
        Returns:
            List of embedding models that can be used
        """
        available_models = []
        
        for model in EMBEDDING_MODELS:
            # Ollama models don't need API keys
            if model.provider == "ollama":
                available_models.append(model)
            # Check if provider has an API key configured
            elif api_keys.get(model.provider, False):
                available_models.append(model)
        
        return available_models
    
    @staticmethod
    def get_default_model(api_keys: Dict[str, bool]) -> Optional[str]:
        """
        Get the best default embedding model based on available API keys.
        
        Priority order:
        1. OpenAI text-embedding-3-small (best balance of cost/performance)
        2. Google text-embedding-004 (good alternative)
        3. Cohere embed-english-light-v3.0 (lightweight option)
        4. Ollama nomic-embed-text (free local option)
        
        Args:
            api_keys: Dictionary mapping provider names to whether they have valid API keys
            
        Returns:
            Model string for the best available embedding model, or None if no models available
        """
        # Priority order of preferred models
        preferences = [
            ("openai", "openai:text-embedding-3-small"),
            ("google", "google:text-embedding-004"),
            ("cohere", "cohere:embed-english-light-v3.0"),
            ("mistral", "mistral:mistral-embed"),
            ("ollama", "ollama:nomic-embed-text"),  # Always available as fallback
        ]
        
        for provider, model_string in preferences:
            if provider == "ollama" or api_keys.get(provider, False):
                return model_string
        
        return None