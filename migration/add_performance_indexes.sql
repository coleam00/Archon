-- Database Performance Indexes for Archon
-- This migration adds indexes for frequently queried fields to improve performance
-- Uses CONCURRENTLY and IF NOT EXISTS for safe deployment without downtime
-- Note: Many indexes already exist in the schema, this adds only missing ones

-- Composite index for tasks by project and status (most common query pattern)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_project_status
    ON archon_tasks(project_id, status);

-- Compound index for crawled pages by source and chunk number (for ordered retrieval)
-- Note: This also serves single-column queries on source_id due to leftmost prefix rule
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_crawled_pages_source_chunk
    ON archon_crawled_pages(source_id, chunk_number);

-- Note: The following indexes already exist in the schema:
-- - idx_archon_sources_knowledge_type (btree on metadata->>'knowledge_type')
-- - idx_archon_sources_created_at (btree created_at DESC)
-- - idx_archon_sources_metadata (GIN index on metadata)
-- - idx_archon_project_sources_project_id (btree project_id)
-- - idx_archon_crawled_pages_source_id (btree source_id) - covered by composite index
-- - Various primary keys and unique constraints