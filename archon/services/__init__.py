"""
Services layer for Archon.

This package provides business logic services that sit between agents and repositories.
Services encapsulate complex operations, orchestrate multiple repository calls,
and provide a clean API for application logic.

Architecture:
    Agents (pydantic_ai_coder, etc.)
        ↓
    Services (DocumentationService)
        ↓
    Repositories (ISitePagesRepository)
"""

from .documentation_service import DocumentationService

__all__ = [
    "DocumentationService",
]
