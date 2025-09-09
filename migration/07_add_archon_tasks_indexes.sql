-- =====================================================
-- Step 07 — Database migration: targeted indexes
-- Purpose: Improve common task list/query performance
-- Notes:
--   - Uses CONCURRENTLY to avoid blocking writes
--   - Must be run outside of a transaction block
--   - Safe to re-run due to IF NOT EXISTS
-- =====================================================

-- Composite index for typical list patterns used in the app:
--   WHERE project_id = $1 AND status = $2
--   ORDER BY task_order
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_project_status_order
  ON archon_tasks(project_id, status, task_order);

-- Optional: full-text search on description (enable only if used in Phase 1)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_description_gin
--   ON archon_tasks USING gin(to_tsvector('english', description));

-- =====================================================
-- Validation (manual):
--   1) List indexes:         \di+ idx_archon_tasks_*
--   2) Typical query plan:   EXPLAIN ANALYZE SELECT id FROM archon_tasks
--                             WHERE project_id = '00000000-0000-0000-0000-000000000000'
--                               AND status = 'todo'
--                             ORDER BY task_order
--                             LIMIT 50;
--   3) Usage stats:          SELECT * FROM pg_stat_user_indexes WHERE indexrelname LIKE 'idx_archon_tasks_%';
-- Rollback:
--   DROP INDEX IF EXISTS idx_archon_tasks_project_status_order;
--   -- DROP INDEX IF EXISTS idx_archon_tasks_description_gin;

