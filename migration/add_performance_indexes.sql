-- Database Performance Indexes for Archon
-- This migration adds indexes for frequently queried fields to improve performance
-- Uses CONCURRENTLY and IF NOT EXISTS for safe deployment without downtime
-- Note: Many indexes already exist in the schema, this adds only missing ones

-- Composite index for tasks by project and status (most common query pattern)
-- Only add if the tasks table has an 'archived' column
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_tasks_project_status_new
    ON archon_tasks(project_id, status);

-- Index for crawled pages by source (for source-specific page queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_crawled_pages_source_new
    ON archon_crawled_pages(source_id);

-- Compound index for crawled pages by source and chunk number (for ordered retrieval)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_crawled_pages_source_chunk_new
    ON archon_crawled_pages(source_id, chunk_number);

-- Index for project sources relationship queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_archon_project_sources_project_new
    ON archon_project_sources(project_id);

-- Note: The following indexes already exist in the schema:
-- - idx_archon_sources_knowledge_type (btree on metadata->>'knowledge_type')
-- - idx_archon_sources_created_at (btree created_at DESC)
-- - idx_archon_sources_metadata (GIN index on metadata)
-- - Various primary keys and unique constraints