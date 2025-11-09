"""Supabase client for Agent Work Orders.

Provides database connection management and health checks for work order state persistence.
Reuses same Supabase credentials as main Archon server (SUPABASE_URL, SUPABASE_SERVICE_KEY).
"""

import os
from typing import Any

from supabase import Client, create_client

from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


def get_agent_work_orders_client() -> Client:
    """Get Supabase client for agent work orders.

    Reuses same credentials as main Archon server (SUPABASE_URL, SUPABASE_SERVICE_KEY).
    The service key provides full access and bypasses Row Level Security policies.

    Returns:
        Supabase client instance configured for work order operations

    Raises:
        ValueError: If SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables are not set

    Example:
        >>> client = get_agent_work_orders_client()
        >>> response = client.table("archon_agent_work_orders").select("*").execute()
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise ValueError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment variables. "
            "These should match the credentials used by the main Archon server."
        )

    return create_client(url, key)


async def check_database_health() -> dict[str, Any]:
    """Check if agent work orders tables exist and are accessible.

    Verifies that both archon_agent_work_orders and archon_agent_work_order_steps
    tables exist and can be queried. This is a lightweight check using limit(0)
    to avoid fetching actual data.

    Returns:
        Dictionary with health check results:
        - status: "healthy" or "unhealthy"
        - tables_exist: True if both tables are accessible, False otherwise
        - error: Error message if check failed (only present when unhealthy)

    Example:
        >>> health = await check_database_health()
        >>> if health["status"] == "healthy":
        ...     print("Database is ready")
    """
    try:
        client = get_agent_work_orders_client()

        # Try to query both tables (limit 0 to avoid fetching data)
        client.table("archon_agent_work_orders").select("agent_work_order_id").limit(0).execute()
        client.table("archon_agent_work_order_steps").select("id").limit(0).execute()

        logger.info("database_health_check_passed", tables=["archon_agent_work_orders", "archon_agent_work_order_steps"])
        return {"status": "healthy", "tables_exist": True}
    except Exception as e:
        logger.error("database_health_check_failed", error=str(e), exc_info=True)
        return {"status": "unhealthy", "tables_exist": False, "error": str(e)}
