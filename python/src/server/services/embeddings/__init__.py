"""
Embedding Services

Handles all embedding-related operations.
"""

from .contextual_embedding_service import (
    generate_contextual_embedding,
    generate_contextual_embeddings_batch,
    process_chunk_with_context,
)
from .embedding_service import create_embedding, create_embeddings_batch

__all__ = [
    # Embedding functions
    "create_embedding",
    "create_embeddings_batch",
    # Contextual embedding functions
    "generate_contextual_embedding",
    "generate_contextual_embeddings_batch",
    "process_chunk_with_context",
]
