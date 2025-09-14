"""
MCP Client for Agents

This lightweight client allows PydanticAI agents to call MCP tools via HTTP.
Agents use this client to access all data operations through the API server
instead of the broken MCP protocol calls.
"""

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MCPClient:
    """Client for calling API server endpoints directly."""

    def __init__(self, api_url: str = None):
        """
        Initialize MCP client.

        Args:
            api_url: API server URL (defaults to service discovery)
        """
        if api_url:
            self.api_url = api_url
        else:
            # Use service discovery to find API server
            try:
                from ..server.config.service_discovery import get_api_url

                self.api_url = get_api_url()
            except ImportError:
                # Fallback for when running in agents container
                import os

                api_port = os.getenv("ARCHON_SERVER_PORT", "8181")
                if os.getenv("DOCKER_CONTAINER"):
                    self.api_url = f"http://archon-server:{api_port}"
                else:
                    self.api_url = f"http://localhost:{api_port}"

        self.client = httpx.AsyncClient(timeout=30.0)
        logger.info(f"MCP Client initialized with API URL: {self.api_url}")

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        await self.close()

    async def close(self):
        """Close the HTTP client."""
        await self.client.aclose()

    async def call_tool(self, tool_name: str, **kwargs) -> dict[str, Any]:
        """
        Call an MCP tool via direct API server endpoints.

        Args:
            tool_name: Name of the MCP tool to call
            **kwargs: Tool arguments

        Returns:
            Dict with the tool response
        """
        try:
            # Map MCP tool names to API endpoints
            if tool_name == "manage_document":
                return await self._call_manage_document(**kwargs)
            elif tool_name == "manage_project":
                return await self._call_manage_project(**kwargs)
            elif tool_name == "manage_task":
                return await self._call_manage_task(**kwargs)
            elif tool_name == "perform_rag_query":
                return await self._call_perform_rag_query(**kwargs)
            elif tool_name == "get_available_sources":
                return await self._call_get_available_sources(**kwargs)
            elif tool_name == "search_code_examples":
                return await self._call_search_code_examples(**kwargs)
            else:
                raise Exception(f"Unknown MCP tool: {tool_name}")

        except Exception as e:
            logger.error(f"Error calling MCP tool {tool_name}: {e}")
            raise

    async def _call_manage_document(self, action: str, project_id: str, **kwargs) -> dict[str, Any]:
        """Call document management via API server endpoints."""
        try:
            if action == "add":
                # Create new document
                response = await self.client.post(
                    f"{self.api_url}/api/projects/{project_id}/docs",
                    json={
                        "document_type": kwargs.get("document_type"),
                        "title": kwargs.get("title"),
                        "content": kwargs.get("content", {}),
                        "tags": kwargs.get("metadata", {}).get("tags", []) if kwargs.get("metadata") else [],
                        "author": kwargs.get("metadata", {}).get("author") if kwargs.get("metadata") else None,
                    },
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "document": result.get("document"), "message": result.get("message")}

            elif action == "list":
                # List documents
                response = await self.client.get(f"{self.api_url}/api/projects/{project_id}/docs")
                response.raise_for_status()
                result = response.json()
                return {"success": True, **result}

            elif action == "get":
                # Get specific document
                doc_id = kwargs.get("doc_id")
                if not doc_id:
                    return {"success": False, "error": "doc_id is required for get action"}
                
                response = await self.client.get(f"{self.api_url}/api/projects/{project_id}/docs/{doc_id}")
                if response.status_code == 404:
                    return {"success": False, "error": f"Document {doc_id} not found"}
                response.raise_for_status()
                result = response.json()
                return {"success": True, "document": result}

            elif action == "update":
                # Update document
                doc_id = kwargs.get("doc_id")
                if not doc_id:
                    return {"success": False, "error": "doc_id is required for update action"}
                
                update_fields = {}
                if "title" in kwargs:
                    update_fields["title"] = kwargs["title"]
                if "content" in kwargs:
                    update_fields["content"] = kwargs["content"]
                if "metadata" in kwargs:
                    metadata = kwargs["metadata"]
                    if "tags" in metadata:
                        update_fields["tags"] = metadata["tags"]
                    if "author" in metadata:
                        update_fields["author"] = metadata["author"]
                if "version" in kwargs:
                    update_fields["version"] = kwargs["version"]

                response = await self.client.put(
                    f"{self.api_url}/api/projects/{project_id}/docs/{doc_id}",
                    json=update_fields,
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "document": result.get("document"), "message": result.get("message")}

            elif action == "delete":
                # Delete document
                doc_id = kwargs.get("doc_id")
                if not doc_id:
                    return {"success": False, "error": "doc_id is required for delete action"}
                
                response = await self.client.delete(f"{self.api_url}/api/projects/{project_id}/docs/{doc_id}")
                response.raise_for_status()
                result = response.json()
                return {"success": True, "message": result.get("message")}

            else:
                return {"success": False, "error": f"Invalid action '{action}'"}

        except httpx.HTTPError as e:
            logger.error(f"HTTP error in manage_document: {e}")
            return {"success": False, "error": f"HTTP error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error in manage_document: {e}")
            return {"success": False, "error": str(e)}

    async def _call_manage_project(self, action: str, **kwargs) -> dict[str, Any]:
        """Call project management via API server endpoints."""
        try:
            if action == "create":
                # Create new project
                response = await self.client.post(
                    f"{self.api_url}/api/projects",
                    json={
                        "title": kwargs.get("title"),
                        "description": kwargs.get("description", ""),
                        "status": kwargs.get("status", "active"),
                        "tags": kwargs.get("tags", []),
                    },
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "project": result.get("project"), "message": result.get("message")}

            elif action == "list":
                # List projects
                params = {}
                if "status" in kwargs:
                    params["status"] = kwargs["status"]
                if "tags" in kwargs:
                    params["tags"] = kwargs["tags"]
                
                response = await self.client.get(f"{self.api_url}/api/projects", params=params)
                response.raise_for_status()
                result = response.json()
                return {"success": True, **result}

            elif action == "get":
                # Get specific project
                project_id = kwargs.get("project_id")
                if not project_id:
                    return {"success": False, "error": "project_id is required for get action"}
                
                response = await self.client.get(f"{self.api_url}/api/projects/{project_id}")
                if response.status_code == 404:
                    return {"success": False, "error": f"Project {project_id} not found"}
                response.raise_for_status()
                result = response.json()
                return {"success": True, "project": result}

            elif action == "update":
                # Update project
                project_id = kwargs.get("project_id")
                if not project_id:
                    return {"success": False, "error": "project_id is required for update action"}
                
                update_fields = {}
                if "title" in kwargs:
                    update_fields["title"] = kwargs["title"]
                if "description" in kwargs:
                    update_fields["description"] = kwargs["description"]
                if "status" in kwargs:
                    update_fields["status"] = kwargs["status"]
                if "tags" in kwargs:
                    update_fields["tags"] = kwargs["tags"]

                response = await self.client.put(
                    f"{self.api_url}/api/projects/{project_id}",
                    json=update_fields,
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "project": result.get("project"), "message": result.get("message")}

            elif action == "delete":
                # Delete project
                project_id = kwargs.get("project_id")
                if not project_id:
                    return {"success": False, "error": "project_id is required for delete action"}
                
                response = await self.client.delete(f"{self.api_url}/api/projects/{project_id}")
                response.raise_for_status()
                result = response.json()
                return {"success": True, "message": result.get("message")}

            else:
                return {"success": False, "error": f"Invalid action '{action}'"}

        except httpx.HTTPError as e:
            logger.error(f"HTTP error in manage_project: {e}")
            return {"success": False, "error": f"HTTP error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error in manage_project: {e}")
            return {"success": False, "error": str(e)}

    async def _call_manage_task(self, action: str, project_id: str, **kwargs) -> dict[str, Any]:
        """Call task management via API server endpoints."""
        try:
            if action == "add":
                # Create new task
                response = await self.client.post(
                    f"{self.api_url}/api/projects/{project_id}/tasks",
                    json={
                        "title": kwargs.get("title"),
                        "description": kwargs.get("description", ""),
                        "status": kwargs.get("status", "todo"),
                        "priority": kwargs.get("priority", "medium"),
                        "assignee": kwargs.get("assignee", "User"),
                        "feature": kwargs.get("feature"),
                        "order": kwargs.get("task_order", 0),
                    },
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "task": result.get("task"), "message": result.get("message")}

            elif action == "list":
                # List tasks
                params = {"project_id": project_id}
                if "status" in kwargs:
                    params["status"] = kwargs["status"]
                if "feature" in kwargs:
                    params["feature"] = kwargs["feature"]
                if "assignee" in kwargs:
                    params["assignee"] = kwargs["assignee"]
                
                response = await self.client.get(f"{self.api_url}/api/tasks", params=params)
                response.raise_for_status()
                result = response.json()
                return {"success": True, **result}

            elif action == "get":
                # Get specific task
                task_id = kwargs.get("task_id")
                if not task_id:
                    return {"success": False, "error": "task_id is required for get action"}
                
                response = await self.client.get(f"{self.api_url}/api/tasks/{task_id}")
                if response.status_code == 404:
                    return {"success": False, "error": f"Task {task_id} not found"}
                response.raise_for_status()
                result = response.json()
                return {"success": True, "task": result}

            elif action == "update":
                # Update task
                task_id = kwargs.get("task_id")
                if not task_id:
                    return {"success": False, "error": "task_id is required for update action"}
                
                update_fields = {}
                if "title" in kwargs:
                    update_fields["title"] = kwargs["title"]
                if "description" in kwargs:
                    update_fields["description"] = kwargs["description"]
                if "status" in kwargs:
                    update_fields["status"] = kwargs["status"]
                if "priority" in kwargs:
                    update_fields["priority"] = kwargs["priority"]
                if "assignee" in kwargs:
                    update_fields["assignee"] = kwargs["assignee"]
                if "feature" in kwargs:
                    update_fields["feature"] = kwargs["feature"]
                if "order" in kwargs:
                    update_fields["order"] = kwargs["order"]

                response = await self.client.put(
                    f"{self.api_url}/api/tasks/{task_id}",
                    json=update_fields,
                )
                response.raise_for_status()
                result = response.json()
                return {"success": True, "task": result.get("task"), "message": result.get("message")}

            elif action == "delete":
                # Delete task
                task_id = kwargs.get("task_id")
                if not task_id:
                    return {"success": False, "error": "task_id is required for delete action"}
                
                response = await self.client.delete(f"{self.api_url}/api/tasks/{task_id}")
                response.raise_for_status()
                result = response.json()
                return {"success": True, "message": result.get("message")}

            else:
                return {"success": False, "error": f"Invalid action '{action}'"}

        except httpx.HTTPError as e:
            logger.error(f"HTTP error in manage_task: {e}")
            return {"success": False, "error": f"HTTP error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error in manage_task: {e}")
            return {"success": False, "error": str(e)}

    async def _call_perform_rag_query(self, query: str, source: str = None, match_count: int = 5) -> dict[str, Any]:
        """Call RAG query via API server endpoints."""
        try:
            params = {"query": query, "match_count": match_count}
            if source:
                params["source"] = source
            
            response = await self.client.get(f"{self.api_url}/api/knowledge-items/search", params=params)
            response.raise_for_status()
            result = response.json()
            return {"success": True, **result}

        except httpx.HTTPError as e:
            logger.error(f"HTTP error in perform_rag_query: {e}")
            return {"success": False, "error": f"HTTP error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error in perform_rag_query: {e}")
            return {"success": False, "error": str(e)}

    async def _call_get_available_sources(self) -> dict[str, Any]:
        """Get available sources via API server endpoints."""
        try:
            response = await self.client.get(f"{self.api_url}/api/knowledge-items/sources")
            response.raise_for_status()
            result = response.json()
            return {"success": True, **result}

        except httpx.HTTPError as e:
            logger.error(f"HTTP error in get_available_sources: {e}")
            return {"success": False, "error": f"HTTP error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error in get_available_sources: {e}")
            return {"success": False, "error": str(e)}

    async def _call_search_code_examples(self, query: str, source_id: str = None, match_count: int = 5) -> dict[str, Any]:
        """Search code examples via API server endpoints."""
        try:
            params = {"query": query, "match_count": match_count}
            if source_id:
                params["source_id"] = source_id
            
            response = await self.client.get(f"{self.api_url}/api/knowledge-items/search", params=params)
            response.raise_for_status()
            result = response.json()
            return {"success": True, **result}

        except httpx.HTTPError as e:
            logger.error(f"HTTP error in search_code_examples: {e}")
            return {"success": False, "error": f"HTTP error: {str(e)}"}
        except Exception as e:
            logger.error(f"Error in search_code_examples: {e}")
            return {"success": False, "error": str(e)}

    # Convenience methods for common MCP tools (maintain backward compatibility)

    async def perform_rag_query(self, query: str, source: str = None, match_count: int = 5) -> str:
        """Perform a RAG query through API server."""
        result = await self._call_perform_rag_query(query=query, source=source, match_count=match_count)
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def get_available_sources(self) -> str:
        """Get available sources through API server."""
        result = await self._call_get_available_sources()
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def search_code_examples(
        self, query: str, source_id: str = None, match_count: int = 5
    ) -> str:
        """Search code examples through API server."""
        result = await self._call_search_code_examples(query=query, source_id=source_id, match_count=match_count)
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def manage_project(self, action: str, **kwargs) -> str:
        """Manage projects through API server."""
        result = await self._call_manage_project(action=action, **kwargs)
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def manage_document(self, action: str, project_id: str, **kwargs) -> str:
        """Manage documents through API server."""
        result = await self._call_manage_document(action=action, project_id=project_id, **kwargs)
        return json.dumps(result) if isinstance(result, dict) else str(result)

    async def manage_task(self, action: str, project_id: str, **kwargs) -> str:
        """Manage tasks through API server."""
        result = await self._call_manage_task(action=action, project_id=project_id, **kwargs)
        return json.dumps(result) if isinstance(result, dict) else str(result)


# Global MCP client instance (created on first use)
_mcp_client: MCPClient | None = None


async def get_mcp_client() -> MCPClient:
    """
    Get or create the global MCP client instance.

    Returns:
        MCPClient instance
    """
    global _mcp_client

    if _mcp_client is None:
        _mcp_client = MCPClient()

    return _mcp_client
