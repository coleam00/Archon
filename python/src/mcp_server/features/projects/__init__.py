"""
Project management tools for Archon MCP Server.

This module provides separate tools for each project operation:
- create_project: Create a new project
- list_projects: List all projects
- get_project: Get project details
- delete_project: Delete a project
"""

from .project_tools import register_project_tools

__all__ = ["register_project_tools"]
