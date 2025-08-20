"""
Task management tools for Archon MCP Server.

This module provides separate tools for each task operation:
- create_task: Create a new task
- list_tasks: List tasks with filtering
- get_task: Get task details
- update_task: Update task properties
- delete_task: Delete a task
"""

from .task_tools import register_task_tools

__all__ = ["register_task_tools"]
