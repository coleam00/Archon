"""
Multi-Dimensional Embedding Service

Manages embeddings with different dimensions (768, 1024, 1536, 3072) to support
various embedding models from OpenAI, Google, Ollama, and other providers.

This service works with the tested database schema that has been validated.
"""

from typing import Any

from ...config.logfire_config import get_logger

logger = get_logger(__name__)

# Supported embedding dimensions based on tested database schema
SUPPORTED_DIMENSIONS = {
    768: ["text-embedding-004", "gemini-text-embedding"],  # Google models
    1024: ["mxbai-embed-large", "ollama-embed-large"],     # Ollama models
    1536: ["text-embedding-3-small", "text-embedding-ada-002"], # OpenAI models
    3072: ["text-embedding-3-large"]  # OpenAI large model
}

class MultiDimensionalEmbeddingService:
    """Service for managing embeddings with multiple dimensions."""
    
    def __init__(self):
        pass
    
    def get_supported_dimensions(self) -> dict[int, list[str]]:
        """Get all supported embedding dimensions and their associated models."""
        return SUPPORTED_DIMENSIONS.copy()
    
    def get_dimension_for_model(self, model_name: str) -> int:
        """Get the embedding dimension for a specific model name."""
        # Check exact matches first
        for dimension, models in SUPPORTED_DIMENSIONS.items():
            if model_name in models:
                return dimension
        
        # Check for partial matches (e.g., for Ollama models with tags)
        model_base = model_name.split(':')[0].lower()
        for dimension, models in SUPPORTED_DIMENSIONS.items():
            for model in models:
                if model_base in model.lower() or model.lower() in model_base:
                    return dimension
        
        # Default fallback for unknown models (OpenAI default)
        logger.warning(f"Unknown model {model_name}, defaulting to 1536 dimensions")
        return 1536
    
    def get_embedding_column_name(self, dimension: int) -> str:
        """Get the appropriate database column name for the given dimension."""
        if dimension in SUPPORTED_DIMENSIONS:
            return f"embedding_{dimension}"
        else:
            logger.warning(f"Unsupported dimension {dimension}, using fallback column")
            return "embedding"  # Fallback to original column
    
    def is_dimension_supported(self, dimension: int) -> bool:
        """Check if a dimension is supported by the database schema."""
        return dimension in SUPPORTED_DIMENSIONS

# Global instance
multi_dimensional_embedding_service = MultiDimensionalEmbeddingService()