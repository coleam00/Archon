"""
Auto-Archive Service for Archon

Periodically checks for projects where all tasks are "done" and have been 
unchanged for more than 24 hours, then automatically archives the project.
"""

import asyncio
from datetime import datetime, timedelta, timezone
import logfire
from .project_service import ProjectService
from .task_service import TaskService
from src.server.utils import get_supabase_client

class AutoArchiveService:
    def __init__(self, check_interval_seconds: int = 3600): # Default: 1 hour
        self.check_interval = check_interval_seconds
        self.project_service = ProjectService()
        self.task_service = TaskService()
        self._running = False
        self._task = None

    async def start(self):
        """Start the background archiving task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())
        logfire.info("Auto-Archive Service started", extra={"interval_seconds": self.check_interval})

    async def stop(self):
        """Stop the background archiving task."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logfire.info("Auto-Archive Service stopped")

    async def _run_loop(self):
        while self._running:
            await asyncio.sleep(self.check_interval)
            if not self._running:
                break
            try:
                await self.check_and_archive_projects()
                await self.archive_stale_tasks()
            except Exception as e:
                logfire.error(f"Error in Auto-Archive loop: {e}", exc_info=True)

    async def check_and_archive_projects(self):
        """Perform the check and archive logic."""
        logfire.debug("Auto-Archive: Checking for completed projects...")
        
        # 1. Get all active (non-archived) projects
        success, result = self.project_service.list_projects(include_content=False)
        if not success:
            return

        active_projects = [p for p in result["projects"] if not p.get("archived")]
        cutoff_time = datetime.now(timezone.utc) - timedelta(days=1)

        for project in active_projects:
            project_id = project["id"]
            
            # 2. Get all tasks for this project
            t_success, t_result = self.task_service.list_tasks(project_id=project_id, include_closed=True)
            if not t_success:
                continue
            
            tasks = t_result["tasks"]
            if not tasks:
                continue # Skip projects with no tasks
            
            # 3. Verify all tasks are "done"
            all_done = all(t["status"] == "done" for t in tasks)
            if not all_done:
                continue
            
            # 4. Check if the newest task update is older than 24 hours
            # We use updated_at to ensure they've been 'done' for at least a day
            newest_update = None
            for t in tasks:
                updated_str = t.get("updated_at")
                if not updated_str:
                    continue
                
                # Parse timestamp (handling possible formats)
                try:
                    updated_at = datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
                    if updated_at.tzinfo is None:
                        updated_at = updated_at.replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                
                if newest_update is None or updated_at > newest_update:
                    newest_update = updated_at
            
            if newest_update and newest_update < cutoff_time:
                # 5. Archive the project!
                logfire.info(f"Auto-Archiving project '{project['title']}' - All tasks done for >24h")
                self.project_service.update_project(project_id, {"archived": True})

    async def archive_stale_tasks(
        self,
        status_filter: list[str] | None = None,
        days_threshold: int = 30,
    ) -> int:
        """
        Archive tasks that have been in the given statuses for longer than days_threshold days.

        Args:
            status_filter: List of statuses to target. Defaults to ["todo"].
            days_threshold: Days of inactivity before archiving. Defaults to 30.

        Returns:
            Number of tasks archived.
        """
        if status_filter is None:
            status_filter = ["todo"]

        logfire.debug(
            f"Auto-Archive: Checking for stale tasks (status={status_filter}, >{days_threshold} days)..."
        )

        success, result = self.task_service.bulk_archive_tasks(
            status_filter=status_filter,
            older_than_days=days_threshold,
            archived_by="auto-archive",
            archived_reason=f"Auto-archived: stale task in '{', '.join(status_filter)}' status for >{days_threshold} days",
        )

        if success:
            count = result.get("archived_count", 0)
            if count > 0:
                logfire.info(f"Auto-Archive: Archived {count} stale task(s)")
            return count
        else:
            logfire.error(f"Auto-Archive: Failed to archive stale tasks: {result}")
            return 0

# Singleton instance
auto_archive_service = AutoArchiveService()
