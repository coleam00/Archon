"""Database client module for Agent Work Orders.

Provides Supabase client initialization and health checks for work order persistence.
"""

from .client import check_database_health, get_agent_work_orders_client

__all__ = ["get_agent_work_orders_client", "check_database_health"]
