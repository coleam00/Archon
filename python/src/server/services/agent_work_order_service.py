"""Agent Work Order Service

Simple service for managing agent work order repositories and work orders in Supabase.
Coordinates with the agent work orders microservice for execution.
"""

import re
from typing import Any

import httpx

from src.server.config.logfire_config import get_logger
from src.server.config.service_discovery import get_agent_work_orders_url
from src.server.utils import get_supabase_client

logger = get_logger(__name__)


class AgentWorkOrderService:
    """Service for agent work order and repository operations"""

    def __init__(self, supabase_client=None):
        self.supabase = supabase_client or get_supabase_client()
        self.agent_service_url = get_agent_work_orders_url()

    # Repository operations
    def create_repository(self, repository_url: str, repository_display_name: str | None = None) -> tuple[bool, dict[str, Any]]:
        """Create repository in Supabase"""
        try:
            # Validate and parse GitHub URL
            if not repository_url.startswith("https://github.com/"):
                return False, {"error": "Must be a GitHub URL"}

            match = re.match(r"https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$", repository_url)
            if not match:
                return False, {"error": "Invalid GitHub URL format"}

            owner, repo = match.groups()
            repository_name = f"{owner}/{repo}"

            repo_data = {
                "repository_url": repository_url,
                "repository_name": repository_name,
                "repository_owner": owner,
                "repository_display_name": repository_display_name or repository_name,
                "pinned": False,
                "metadata": {},
            }

            response = self.supabase.table("agent_work_order_repositories").insert(repo_data).execute()

            if not response.data:
                return False, {"error": "Failed to create repository"}

            return True, {"repository": response.data[0]}

        except Exception as e:
            logger.error(f"Error creating repository: {e}", exc_info=True)
            return False, {"error": str(e)}

    def list_repositories(self) -> tuple[bool, dict[str, Any]]:
        """List all repositories"""
        try:
            response = (
                self.supabase.table("agent_work_order_repositories")
                .select("*")
                .order("pinned", desc=True)
                .order("created_at", desc=True)
                .execute()
            )

            return True, {"repositories": response.data or [], "total_count": len(response.data or [])}

        except Exception as e:
            logger.error(f"Error listing repositories: {e}", exc_info=True)
            return False, {"error": str(e)}

    def get_repository(self, repository_id: str) -> tuple[bool, dict[str, Any]]:
        """Get single repository"""
        try:
            response = self.supabase.table("agent_work_order_repositories").select("*").eq("id", repository_id).execute()

            if not response.data:
                return False, {"error": "Repository not found"}

            return True, {"repository": response.data[0]}

        except Exception as e:
            logger.error(f"Error getting repository: {e}", exc_info=True)
            return False, {"error": str(e)}

    def update_repository(self, repository_id: str, updates: dict) -> tuple[bool, dict[str, Any]]:
        """Update repository"""
        try:
            response = self.supabase.table("agent_work_order_repositories").update(updates).eq("id", repository_id).execute()

            if not response.data:
                return False, {"error": "Repository not found"}

            return True, {"repository": response.data[0]}

        except Exception as e:
            logger.error(f"Error updating repository: {e}", exc_info=True)
            return False, {"error": str(e)}

    def delete_repository(self, repository_id: str) -> tuple[bool, dict[str, Any]]:
        """Delete repository"""
        try:
            response = self.supabase.table("agent_work_order_repositories").delete().eq("id", repository_id).execute()

            if not response.data:
                return False, {"error": "Repository not found"}

            return True, {"message": "Repository deleted"}

        except Exception as e:
            logger.error(f"Error deleting repository: {e}", exc_info=True)
            return False, {"error": str(e)}

    # Work order operations
    async def create_work_order(
        self, repository_id: str, user_request: str, selected_commands: list[str],
        sandbox_type: str, github_issue_number: str | None
    ) -> tuple[bool, dict[str, Any]]:
        """Create work order in Supabase and call agent service to execute"""
        try:
            # Get repository
            repo_success, repo_result = self.get_repository(repository_id)
            if not repo_success:
                return False, {"error": "Repository not found"}

            repository = repo_result["repository"]

            # Generate work order ID
            from src.agent_work_orders.utils.id_generator import generate_work_order_id
            work_order_id = generate_work_order_id()

            # Insert into Supabase with status='todo' (not sent to agent yet)
            work_order_data = {
                "agent_work_order_id": work_order_id,
                "repository_id": repository_id,
                "user_request": user_request,
                "selected_commands": selected_commands,
                "sandbox_type": sandbox_type,
                "github_issue_number": github_issue_number,
                "status": "todo",  # Kanban status - not sent to agent yet
            }

            wo_response = self.supabase.table("agent_work_orders").insert(work_order_data).execute()

            if not wo_response.data:
                return False, {"error": "Failed to create work order"}

            work_order = wo_response.data[0]

            # Don't call agent service yet - work order stays in "todo" status
            # Agent will be called when user drags to "in_progress"

            return True, {"work_order": work_order}

        except Exception as e:
            logger.error(f"Error creating work order: {e}", exc_info=True)
            return False, {"error": str(e)}

    def list_work_orders(self, repository_id: str | None = None, status: str | None = None) -> tuple[bool, dict[str, Any]]:
        """List work orders from Supabase"""
        try:
            query = self.supabase.table("agent_work_orders").select("*")

            if repository_id:
                query = query.eq("repository_id", repository_id)
            if status:
                query = query.eq("status", status)

            response = query.order("created_at", desc=True).execute()

            return True, {"work_orders": response.data or [], "total_count": len(response.data or [])}

        except Exception as e:
            logger.error(f"Error listing work orders: {e}", exc_info=True)
            return False, {"error": str(e)}

    def list_work_orders_by_repository(self, repository_id: str) -> tuple[bool, dict[str, Any]]:
        """List work orders for a specific repository"""
        return self.list_work_orders(repository_id=repository_id)

    async def update_work_order_status(self, work_order_id: str, new_status: str) -> tuple[bool, dict[str, Any]]:
        """Update work order Kanban status

        When moving to 'in_progress', triggers agent execution.

        Args:
            work_order_id: Work order ID
            new_status: New Kanban status (todo, in_progress, review, done)

        Returns:
            Tuple of (success, result_dict)
        """
        try:
            # If moving to in_progress, trigger agent execution
            if new_status == "in_progress":
                # Get work order details
                wo_response = (
                    self.supabase.table("agent_work_orders")
                    .select("*, agent_work_order_repositories(*)")
                    .eq("agent_work_order_id", work_order_id)
                    .execute()
                )

                if not wo_response.data:
                    return False, {"error": "Work order not found"}

                work_order = wo_response.data[0]
                repository = work_order["agent_work_order_repositories"]

                # Call agent service to execute
                try:
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        await client.post(
                            f"{self.agent_service_url}/api/agent-work-orders/",
                            json={
                                "agent_work_order_id": work_order_id,
                                "repository_url": repository["repository_url"],
                                "user_request": work_order["user_request"],
                                "selected_commands": work_order["selected_commands"],
                                "sandbox_type": work_order["sandbox_type"],
                                "github_issue_number": work_order["github_issue_number"],
                            },
                        )
                    logger.info(f"Triggered agent execution for {work_order_id}")
                except Exception as e:
                    logger.error(f"Failed to call agent service: {e}")
                    return False, {"error": f"Failed to start agent execution: {str(e)}"}

            # Update status in Supabase
            update_data = {"status": new_status}

            # Add completed_at if moving to done
            if new_status == "done":
                from datetime import datetime
                update_data["completed_at"] = datetime.now().isoformat()

            response = (
                self.supabase.table("agent_work_orders")
                .update(update_data)
                .eq("agent_work_order_id", work_order_id)
                .execute()
            )

            if not response.data:
                return False, {"error": "Work order not found"}

            return True, {"work_order": response.data[0]}

        except Exception as e:
            logger.error(f"Error updating work order status: {e}", exc_info=True)
            return False, {"error": str(e)}
