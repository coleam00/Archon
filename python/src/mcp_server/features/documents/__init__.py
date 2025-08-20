"""
Document and version management tools for Archon MCP Server.

This module provides separate tools for document operations:
- create_document, list_documents, get_document, update_document, delete_document
- create_version, list_versions, get_version, restore_version
"""

from .document_tools import register_document_tools
from .version_tools import register_version_tools

__all__ = ["register_document_tools", "register_version_tools"]
