# Step 07 — Database migration: targeted indexes

Goal
- Improve common task list/query performance with targeted indexes.

Why
- Composite index speeds typical filters/sorts; FTS optional based on usage.

Scope (isolated)
- Migration doc (this file) with SQL; apply when implementing

Acceptance criteria
- Composite index exists and is used by planner for list queries.
- Optional FTS index only if needed by Phase 1.

Proposed SQL (apply with care; `CONCURRENTLY` outside transactions):
```sql
-- Composite index for list patterns
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_project_status_order
  ON archon_tasks(project_id, status, task_order);

-- Optional: full-text search on description (only if used in Phase 1)
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_description_gin
--   ON archon_tasks USING gin(to_tsvector('english', description));
```

Validation steps
1) `\di+ idx_archon_tasks_*`
2) `EXPLAIN ANALYZE` on typical list query
3) Inspect `pg_stat_user_indexes` for usage

Rollback
- DROP INDEX CONCURRENTLY IF EXISTS public.idx_archon_tasks_project_status_order;
- DROP INDEX CONCURRENTLY IF EXISTS public.idx_archon_tasks_description_tsv_gin;
- DROP INDEX CONCURRENTLY IF EXISTS public.idx_archon_tasks_description_trgm;
Time estimate
- 30–45 minutes

