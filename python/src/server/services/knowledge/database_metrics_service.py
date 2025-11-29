"""
Database Metrics Service

Handles retrieval of database statistics and metrics.
"""

from datetime import datetime
from typing import Any

from ...config.logfire_config import safe_logfire_error, safe_logfire_info


class DatabaseMetricsService:
    """
    Service for retrieving database metrics and statistics.
    """

    def __init__(self, supabase_client):
        """
        Initialize the database metrics service.

        Args:
            supabase_client: The Supabase client for database operations
        """
        self.supabase = supabase_client

    async def get_metrics(self) -> dict[str, Any]:
        """
        Get database metrics and statistics.

        Returns:
            Dictionary containing database metrics
        """
        try:
            safe_logfire_info("Getting database metrics")

            # Get counts from various tables
            metrics = {}

            # Sources count
            sources_result = (
                self.supabase.table("archon_sources").select("*", count="exact").execute()
            )
            metrics["sources_count"] = sources_result.count if sources_result.count else 0

            # Crawled pages count
            pages_result = (
                self.supabase.table("archon_crawled_pages").select("*", count="exact").execute()
            )
            metrics["pages_count"] = pages_result.count if pages_result.count else 0

            # Code examples count
            try:
                code_examples_result = (
                    self.supabase.table("archon_code_examples").select("*", count="exact").execute()
                )
                metrics["code_examples_count"] = (
                    code_examples_result.count if code_examples_result.count else 0
                )
            except Exception:
                metrics["code_examples_count"] = 0

            # Add timestamp
            metrics["timestamp"] = datetime.now().isoformat()

            # Calculate additional metrics
            metrics["average_pages_per_source"] = (
                round(metrics["pages_count"] / metrics["sources_count"], 2)
                if metrics["sources_count"] > 0
                else 0
            )

            safe_logfire_info(
                f"Database metrics retrieved | sources={metrics['sources_count']} | pages={metrics['pages_count']} | code_examples={metrics['code_examples_count']}"
            )

            return metrics

        except Exception as e:
            safe_logfire_error(f"Failed to get database metrics | error={str(e)}")
            raise

    async def get_storage_statistics(self) -> dict[str, Any]:
        """
        Get storage statistics including sizes and counts by type.

        Returns:
            Dictionary containing storage statistics
        """
        try:
            stats = {}

            # Get knowledge type distribution
            knowledge_types_result = (
                self.supabase.table("archon_sources").select("metadata->knowledge_type").execute()
            )

            if knowledge_types_result.data:
                type_counts = {}
                for row in knowledge_types_result.data:
                    ktype = row.get("knowledge_type", "unknown")
                    type_counts[ktype] = type_counts.get(ktype, 0) + 1
                stats["knowledge_type_distribution"] = type_counts

            # Get recent activity
            recent_sources = (
                self.supabase.table("archon_sources")
                .select("source_id, created_at")
                .order("created_at", desc=True)
                .limit(5)
                .execute()
            )

            stats["recent_sources"] = [
                {"source_id": s["source_id"], "created_at": s["created_at"]}
                for s in (recent_sources.data or [])
            ]

            return stats

        except Exception as e:
            safe_logfire_error(f"Failed to get storage statistics | error={str(e)}")
            return {}
