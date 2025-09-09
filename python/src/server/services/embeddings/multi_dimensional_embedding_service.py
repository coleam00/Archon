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
# Note: Model lists are dynamically determined by providers, not hardcoded
SUPPORTED_DIMENSIONS = {
    768: [],   # Common dimensions for various providers (Google, etc.)
    1024: [],  # Ollama and other providers
    1536: [],  # OpenAI models (text-embedding-3-small, ada-002)
    3072: []   # OpenAI large models (text-embedding-3-large)
}

class MultiDimensionalEmbeddingService:
    """Service for managing embeddings with multiple dimensions."""
    
    def __init__(self):
        pass
    
    def get_supported_dimensions(self) -> dict[int, list[str]]:
        """Get all supported embedding dimensions and their associated models."""
        return SUPPORTED_DIMENSIONS.copy()
    
    def get_dimension_for_model(self, model_name: str) -> int:
        """Get the embedding dimension for a specific model name using heuristics."""
        model_lower = model_name.lower()
        
        # Use heuristics to determine dimension based on model name patterns
        # OpenAI models
        if "text-embedding-3-large" in model_lower:
            return 3072
        elif "text-embedding-3-small" in model_lower or "text-embedding-ada" in model_lower:
            return 1536
        
        # Google models
        elif "text-embedding-004" in model_lower or "gemini-text-embedding" in model_lower:
            return 768
            
        # Ollama models (common patterns)
        elif "mxbai-embed" in model_lower:
            return 1024
        elif "nomic-embed" in model_lower:
            return 768
        elif "embed" in model_lower:
            # Generic embedding model, assume common dimension
            return 768
        
        # Default fallback for unknown models (most common OpenAI dimension)
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