-- Migration: Add operation progress tracking table
-- Purpose: Persist operation progress to database for restart/resume capability
-- Supports: crawls, uploads, revectorize, resummarize operations
--
-- This enables:
-- 1. Operations survive container restarts
-- 2. Pause/resume functionality
-- 3. Frontend can show active operations after restart

BEGIN;

-- Operation progress table
CREATE TABLE IF NOT EXISTS archon_operation_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    progress_id TEXT UNIQUE NOT NULL,
    operation_type TEXT NOT NULL,  -- 'crawl', 'upload', 'revectorize', 'resummarize'
    source_id TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress'  
        CHECK (status IN ('starting', 'in_progress', 'paused', 'completed', 'failed', 'cancelled')),
    progress INTEGER DEFAULT 0,
    current_url TEXT,
    total_pages INTEGER DEFAULT 0,
    processed_pages INTEGER DEFAULT 0,
    documents_created INTEGER DEFAULT 0,
    code_blocks_found INTEGER DEFAULT 0,
    stats JSONB DEFAULT '{}',  -- Additional stats as JSON
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_op_progress_status ON archon_operation_progress(status);
CREATE INDEX IF NOT EXISTS idx_op_progress_source ON archon_operation_progress(source_id);
CREATE INDEX IF NOT EXISTS idx_op_progress_type ON archon_operation_progress(operation_type);

-- Comments for documentation
COMMENT ON TABLE archon_operation_progress IS 
    'Persisted operation progress for restart/resume capability';
COMMENT ON COLUMN archon_operation_progress.progress_id IS 
    'Unique progress identifier (UUID)';
COMMENT ON COLUMN archon_operation_progress.operation_type IS 
    'Type: crawl, upload, revectorize, resummarize';
COMMENT ON COLUMN archon_operation_progress.status IS 
    'Current status: starting, in_progress, paused, completed, failed, cancelled';
COMMENT ON COLUMN archon_operation_progress.stats IS 
    'Additional stats: {pages_crawled, documents_created, code_blocks, errors}';
COMMENT ON COLUMN archon_operation_progress.current_url IS 
    'URL currently being processed';

-- Enable RLS
ALTER TABLE archon_operation_progress ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role has full access
CREATE POLICY "Service role full access to operation_progress" ON archon_operation_progress
    FOR ALL USING (true) WITH CHECK (true);

COMMIT;

-- Record migration application
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '015_add_operation_progress')
ON CONFLICT (version, migration_name) DO NOTHING;
