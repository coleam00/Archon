"""State Reconciliation Utilities

Utilities to detect and fix inconsistencies between database state and filesystem.
These tools help identify orphaned worktrees (exist on filesystem but not in database)
and dangling state (exist in database but worktree deleted).
"""

import os
import shutil
from pathlib import Path
from typing import Any

from ..config import config
from ..models import AgentWorkOrderStatus
from ..state_manager.supabase_repository import SupabaseWorkOrderRepository
from ..utils.structured_logger import get_logger

logger = get_logger(__name__)


async def find_orphaned_worktrees(repository: SupabaseWorkOrderRepository) -> list[str]:
    """Find worktrees that exist on filesystem but not in database.

    Orphaned worktrees can occur when:
    - Database entries are deleted but worktree cleanup fails
    - Service crashes during work order creation (worktree created but not saved to DB)
    - Manual filesystem operations outside the service

    Args:
        repository: Supabase repository instance to query current state

    Returns:
        List of absolute paths to orphaned worktree directories

    Example:
        >>> repository = SupabaseWorkOrderRepository()
        >>> orphans = await find_orphaned_worktrees(repository)
        >>> print(f"Found {len(orphans)} orphaned worktrees")
    """
    worktree_base = Path(config.WORKTREE_BASE_DIR)
    if not worktree_base.exists():
        logger.info("worktree_base_directory_not_found", path=str(worktree_base))
        return []

    # Get all worktree directories from filesystem
    filesystem_worktrees = {d.name for d in worktree_base.iterdir() if d.is_dir()}

    # Get all work orders from database
    work_orders = await repository.list()
    database_identifiers = {state.sandbox_identifier for state, _ in work_orders}

    # Find orphans (in filesystem but not in database)
    orphans = filesystem_worktrees - database_identifiers

    logger.info(
        "orphaned_worktrees_found",
        count=len(orphans),
        orphans=list(orphans)[:10],  # Log first 10 to avoid spam
        total_filesystem=len(filesystem_worktrees),
        total_database=len(database_identifiers),
    )

    return [str(worktree_base / name) for name in orphans]


async def find_dangling_state(repository: SupabaseWorkOrderRepository) -> list[str]:
    """Find database entries with missing worktrees.

    Dangling state can occur when:
    - Worktree cleanup succeeds but database update fails
    - Manual deletion of worktree directories
    - Filesystem corruption or disk full errors

    Args:
        repository: Supabase repository instance to query current state

    Returns:
        List of work order IDs that have missing worktrees

    Example:
        >>> repository = SupabaseWorkOrderRepository()
        >>> dangling = await find_dangling_state(repository)
        >>> print(f"Found {len(dangling)} dangling state entries")
    """
    worktree_base = Path(config.WORKTREE_BASE_DIR)

    # Get all work orders from database
    work_orders = await repository.list()

    dangling = []
    for state, _ in work_orders:
        worktree_path = worktree_base / state.sandbox_identifier
        if not worktree_path.exists():
            dangling.append(state.agent_work_order_id)

    logger.info(
        "dangling_state_found",
        count=len(dangling),
        dangling=dangling[:10],  # Log first 10 to avoid spam
        total_work_orders=len(work_orders),
    )

    return dangling


async def reconcile_state(
    repository: SupabaseWorkOrderRepository,
    fix: bool = False
) -> dict[str, Any]:
    """Reconcile database state with filesystem.

    Detects both orphaned worktrees and dangling state. If fix=True,
    will clean up orphaned worktrees and mark dangling state as failed.

    Args:
        repository: Supabase repository instance
        fix: If True, cleanup orphans and update dangling state. If False, dry-run only.

    Returns:
        Report dictionary with:
        - orphaned_worktrees: List of orphaned worktree paths
        - dangling_state: List of work order IDs with missing worktrees
        - fix_applied: Whether fixes were applied
        - actions_taken: List of action descriptions

    Example:
        >>> # Dry run to see what would be fixed
        >>> report = await reconcile_state(repository, fix=False)
        >>> print(f"Found {len(report['orphaned_worktrees'])} orphans")
        >>>
        >>> # Actually fix issues
        >>> report = await reconcile_state(repository, fix=True)
        >>> for action in report['actions_taken']:
        ...     print(action)
    """
    orphans = await find_orphaned_worktrees(repository)
    dangling = await find_dangling_state(repository)

    actions: list[str] = []

    if fix:
        # Clean up orphaned worktrees
        worktree_base = Path(config.WORKTREE_BASE_DIR)
        base_dir_resolved = os.path.abspath(os.path.normpath(str(worktree_base)))
        
        for orphan_path in orphans:
            try:
                # Safety check: verify orphan_path is inside worktree base directory
                orphan_path_resolved = os.path.abspath(os.path.normpath(orphan_path))
                
                # Verify path is within base directory and not the base directory itself
                try:
                    common_path = os.path.commonpath([base_dir_resolved, orphan_path_resolved])
                    is_inside_base = common_path == base_dir_resolved
                    is_not_base = orphan_path_resolved != base_dir_resolved
                    # Check if path is a root directory (Unix / or Windows drive root like C:\)
                    path_obj = Path(orphan_path_resolved)
                    is_not_root = not (
                        orphan_path_resolved in ("/", "\\") or
                        (os.name == "nt" and len(path_obj.parts) == 2 and path_obj.parts[1] == "")
                    )
                except ValueError:
                    # commonpath raises ValueError if paths are on different drives (Windows)
                    is_inside_base = False
                    is_not_base = True
                    is_not_root = True
                
                if is_inside_base and is_not_base and is_not_root:
                shutil.rmtree(orphan_path)
                actions.append(f"Deleted orphaned worktree: {orphan_path}")
                logger.info("orphaned_worktree_deleted", path=orphan_path)
                else:
                    # Safety check failed - do not delete
                    actions.append(f"Skipped deletion of {orphan_path} (safety check failed: outside worktree base or invalid path)")
                    logger.error(
                        "orphaned_worktree_deletion_skipped_safety_check_failed",
                        path=orphan_path,
                        path_resolved=orphan_path_resolved,
                        base_dir=base_dir_resolved,
                        is_inside_base=is_inside_base,
                        is_not_base=is_not_base,
                        is_not_root=is_not_root,
                    )
            except Exception as e:
                actions.append(f"Failed to delete {orphan_path}: {e}")
                logger.error("orphaned_worktree_delete_failed", path=orphan_path, error=str(e), exc_info=True)

        # Update dangling state to mark as failed
        for work_order_id in dangling:
            try:
                await repository.update_status(
                    work_order_id,
                    AgentWorkOrderStatus.FAILED,
                    error_message="Worktree missing - state/filesystem divergence detected during reconciliation"
                )
                actions.append(f"Marked work order {work_order_id} as failed (worktree missing)")
                logger.info("dangling_state_updated", work_order_id=work_order_id)
            except Exception as e:
                actions.append(f"Failed to update {work_order_id}: {e}")
                logger.error("dangling_state_update_failed", work_order_id=work_order_id, error=str(e), exc_info=True)

    return {
        "orphaned_worktrees": orphans,
        "dangling_state": dangling,
        "fix_applied": fix,
        "actions_taken": actions,
    }
