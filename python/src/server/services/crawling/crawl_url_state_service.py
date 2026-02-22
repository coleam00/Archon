"""
Crawl URL State Service

Tracks per-URL crawl progress to enable checkpoint/resume functionality.
"""

from datetime import UTC

from ...config.logfire_config import get_logger, safe_logfire_error, safe_logfire_info
from ...utils import get_supabase_client

logger = get_logger(__name__)


class CrawlUrlStateService:
    """
    Service for tracking crawl URL state to enable resumable crawls.
    """

    def __init__(self, supabase_client=None):
        """
        Initialize the crawl URL state service.

        Args:
            supabase_client: Optional Supabase client for database operations
        """
        self.supabase_client = supabase_client or get_supabase_client()
        self.table_name = "archon_crawl_url_state"

    def initialize_urls(self, source_id: str, urls: list[str], max_retries: int = 3) -> dict[str, int]:
        """
        Initialize URLs in pending state for a crawl.

        Args:
            source_id: The source ID for this crawl
            urls: List of URLs to track
            max_retries: Maximum retry attempts per URL

        Returns:
            Dict with counts of inserted/skipped URLs
        """
        if not urls:
            return {"inserted": 0, "skipped": 0}

        now = UTC
        records = [
            {
                "source_id": source_id,
                "url": url,
                "status": "pending",
                "max_retries": max_retries,
                "created_at": now,
                "updated_at": now,
            }
            for url in urls
        ]

        try:
            # Upsert: insert new, skip existing
            result = (
                self.supabase_client.table(self.table_name)
                .upsert(records, on_conflict="source_id,url", ignore_duplicates=True)
                .execute()
            )

            inserted = len(result.data) if result.data else 0
            skipped = len(urls) - inserted

            safe_logfire_info(
                f"Initialized crawl URL state | source_id={source_id} | inserted={inserted} | skipped={skipped}"
            )

            return {"inserted": inserted, "skipped": skipped}
        except Exception as e:
            safe_logfire_error(f"Failed to initialize URL state: {e}")
            raise

    def mark_fetched(self, source_id: str, url: str) -> bool:
        """
        Mark a URL as fetched.

        Args:
            source_id: The source ID
            url: The URL that was fetched

        Returns:
            True if successful
        """
        return self._update_status(source_id, url, "fetched")

    def mark_embedded(self, source_id: str, url: str) -> bool:
        """
        Mark a URL as embedded (complete).

        Args:
            source_id: The source ID
            url: The URL that was embedded

        Returns:
            True if successful
        """
        return self._update_status(source_id, url, "embedded")

    def mark_failed(self, source_id: str, url: str, error_message: str) -> bool:
        """
        Mark a URL as failed and increment retry count.

        Args:
            source_id: The source ID
            url: The URL that failed
            error_message: The error message

        Returns:
            True if successful (or if max retries exceeded and marked as failed permanently)
        """
        try:
            # Get current state
            result = (
                self.supabase_client.table(self.table_name)
                .select("retry_count, max_retries")
                .match({"source_id": source_id, "url": url})
                .execute()
            )

            if not result.data:
                return False

            current = result.data[0]
            retry_count = current.get("retry_count", 0) + 1
            max_retries = current.get("max_retries", 3)

            # Check if we should keep trying or give up
            if retry_count >= max_retries:
                # Max retries exceeded - mark as permanently failed
                return self._update_status(source_id, url, "failed", error_message)
            else:
                # Increment retry count, keep as pending for retry
                self.supabase_client.table(self.table_name).update(
                    {
                        "retry_count": retry_count,
                        "error_message": error_message,
                        "status": "pending",  # Reset to pending for retry
                        "updated_at": UTC,
                    }
                ).match({"source_id": source_id, "url": url}).execute()

                safe_logfire_info(f"URL will retry | url={url} | retry={retry_count}/{max_retries}")
                return True

        except Exception as e:
            safe_logfire_error(f"Failed to mark URL as failed: {e}")
            return False

    def _update_status(self, source_id: str, url: str, status: str, error_message: str | None = None) -> bool:
        """
        Update the status of a URL.

        Args:
            source_id: The source ID
            url: The URL
            status: New status
            error_message: Optional error message

        Returns:
            True if successful
        """
        try:
            update_data = {"status": status, "updated_at": UTC}
            if error_message:
                update_data["error_message"] = error_message

            self.supabase_client.table(self.table_name).update(update_data).match(
                {"source_id": source_id, "url": url}
            ).execute()

            return True
        except Exception as e:
            safe_logfire_error(f"Failed to update URL status: {e}")
            return False

    def get_pending_urls(self, source_id: str) -> list[str]:
        """
        Get URLs that are still pending for a source.

        Args:
            source_id: The source ID

        Returns:
            List of pending URLs
        """
        return self._get_urls_by_status(source_id, "pending")

    def get_fetched_urls(self, source_id: str) -> list[str]:
        """
        Get URLs that have been fetched but not embedded.

        Args:
            source_id: The source ID

        Returns:
            List of fetched URLs
        """
        return self._get_urls_by_status(source_id, "fetched")

    def get_embedded_urls(self, source_id: str) -> list[str]:
        """
        Get URLs that have been embedded (completed).

        Args:
            source_id: The source ID

        Returns:
            List of embedded URLs
        """
        return self._get_urls_by_status(source_id, "embedded")

    def get_failed_urls(self, source_id: str) -> list[str]:
        """
        Get URLs that have permanently failed.

        Args:
            source_id: The source ID

        Returns:
            List of failed URLs
        """
        return self._get_urls_by_status(source_id, "failed")

    def _get_urls_by_status(self, source_id: str, status: str) -> list[str]:
        """
        Get URLs by status.

        Args:
            source_id: The source ID
            status: The status to filter by

        Returns:
            List of URLs
        """
        try:
            result = (
                self.supabase_client.table(self.table_name)
                .select("url")
                .match({"source_id": source_id, "status": status})
                .execute()
            )

            return [row["url"] for row in (result.data or [])]
        except Exception as e:
            safe_logfire_error(f"Failed to get URLs by status: {e}")
            return []

    def get_crawl_state(self, source_id: str) -> dict[str, int]:
        """
        Get the current state of a crawl.

        Args:
            source_id: The source ID

        Returns:
            Dict with counts by status: {pending, fetched, embedded, failed, total}
        """
        try:
            result = (
                self.supabase_client.table(self.table_name).select("status").match({"source_id": source_id}).execute()
            )

            counts = {"pending": 0, "fetched": 0, "embedded": 0, "failed": 0, "total": 0}
            for row in result.data or []:
                status = row.get("status", "pending")
                if status in counts:
                    counts[status] += 1
                counts["total"] += 1

            return counts
        except Exception as e:
            safe_logfire_error(f"Failed to get crawl state: {e}")
            return counts

    def has_existing_state(self, source_id: str) -> bool:
        """
        Check if there is existing crawl state for a source.

        Args:
            source_id: The source ID

        Returns:
            True if there is existing state
        """
        try:
            result = (
                self.supabase_client.table(self.table_name)
                .select("id", count="exact")
                .match({"source_id": source_id})
                .execute()
            )

            return (result.count or 0) > 0
        except Exception as e:
            safe_logfire_error(f"Failed to check existing state: {e}")
            return False

    def clear_state(self, source_id: str) -> bool:
        """
        Clear all state for a source (for fresh start).

        Args:
            source_id: The source ID

        Returns:
            True if successful
        """
        try:
            self.supabase_client.table(self.table_name).delete().match({"source_id": source_id}).execute()

            safe_logfire_info(f"Cleared crawl URL state | source_id={source_id}")
            return True
        except Exception as e:
            safe_logfire_error(f"Failed to clear crawl state: {e}")
            return False


# Singleton instance
crawl_url_state_service: CrawlUrlStateService | None = None


def get_crawl_url_state_service(supabase_client=None) -> CrawlUrlStateService:
    """
    Get the singleton crawl URL state service instance.

    Args:
        supabase_client: Optional Supabase client

    Returns:
        CrawlUrlStateService instance
    """
    global crawl_url_state_service
    if crawl_url_state_service is None:
        crawl_url_state_service = CrawlUrlStateService(supabase_client)
    return crawl_url_state_service
