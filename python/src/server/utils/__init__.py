"""
Utility functions for the Crawl4AI MCP server - Compatibility Layer

This file now serves as a compatibility layer, importing functions from
the new service modules to maintain backward compatibility.

The actual implementations have been moved to:
- services/embeddings/ - Embedding operations
- services/storage/ - Document and code storage
- services/search/ - Vector search operations
- services/source_management_service.py - Source metadata
- services/client_manager.py - Client connections
"""

# Import all functions from new services for backward compatibility
import asyncio

# Keep some imports that are still needed
import os
from typing import Optional

from ..services.client_manager import get_supabase_client
from ..services.embeddings import (
    create_embedding,
    create_embeddings_batch,
    generate_contextual_embedding,
    generate_contextual_embeddings_batch,
    process_chunk_with_context,
)

# Note: storage and search imports removed to avoid circular dependency
# Import these directly from their modules when needed:
# from ..services.storage import add_documents_to_supabase, extract_code_blocks, etc.
# from ..services.search import search_documents, search_code_examples
from ..services.source_management_service import (
    extract_source_summary,
    generate_source_title_and_metadata,
    update_source_info,
)

# Re-export threading service imports for compatibility
from ..services.threading_service import (
    ProcessingMode,
    RateLimitConfig,
    ThreadingConfig,
    get_threading_service,
)

# Global threading service instance for optimization
_threading_service = None


async def initialize_threading_service(
    threading_config: ThreadingConfig | None = None,
    rate_limit_config: RateLimitConfig | None = None,
):
    """Initialize the global threading service for utilities"""
    global _threading_service
    if _threading_service is None:
        from ..services.threading_service import ThreadingService

        _threading_service = ThreadingService(threading_config, rate_limit_config)
        await _threading_service.start()
    return _threading_service


def get_utils_threading_service():
    """Get the threading service instance (lazy initialization)"""
    global _threading_service
    if _threading_service is None:
        _threading_service = get_threading_service()
    return _threading_service


# Export all imported functions for backward compatibility
__all__ = [
    # Threading functions
    "initialize_threading_service",
    "get_utils_threading_service",
    "get_threading_service",
    "ProcessingMode",
    "ThreadingConfig",
    "RateLimitConfig",
    # Client functions
    "get_supabase_client",
    # Embedding functions
    "create_embedding",
    "create_embeddings_batch",
    # Contextual embedding functions
    "generate_contextual_embedding",
    "generate_contextual_embeddings_batch",
    "process_chunk_with_context",
    # Note: Document storage and search functions not exported from utils
    # to avoid circular dependencies. Import directly from services modules.
    # Source management functions
    "extract_source_summary",
    "generate_source_title_and_metadata",
    "update_source_info",
]
