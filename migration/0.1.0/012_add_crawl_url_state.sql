-- Migration: Add crawl URL state tracking for checkpoint/resume functionality
-- Purpose: Track per-URL crawl status to enable resuming interrupted crawls
-- 
-- Status values:
--   pending   - URL discovered, not yet processed
--   fetched   - URL has been fetched (crawled)
--   embedded  - URL content has been embedded (complete)
--   failed    - URL processing failed (will retry up to max_retries)

BEGIN;

-- Create crawl URL state table
CREATE TABLE IF NOT EXISTS archon_crawl_url_state (
    id BIGSERIAL PRIMARY KEY,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'embedded', 'failed')),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(source_id, url)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_crawl_url_state_source ON archon_crawl_url_state(source_id);
CREATE INDEX IF NOT EXISTS idx_crawl_url_state_status ON archon_crawl_url_state(status);
CREATE INDEX IF NOT EXISTS idx_crawl_url_state_source_status ON archon_crawl_url_state(source_id, status);

-- Add comments
COMMENT ON TABLE archon_crawl_url_state IS 'Tracks crawl progress per-URL to enable resume after interruption';
COMMENT ON COLUMN archon_crawl_url_state.source_id IS 'Foreign key to archon_sources.source_id';
COMMENT ON COLUMN archon_crawl_url_state.url IS 'The URL being tracked';
COMMENT ON COLUMN archon_crawl_url_state.status IS 'Current processing status: pending, fetched, embedded, or failed';
COMMENT ON COLUMN archon_crawl_url_state.error_message IS 'Error message if status is failed';
COMMENT ON COLUMN archon_crawl_url_state.retry_count IS 'Number of times this URL has been retried';
COMMENT ON COLUMN archon_crawl_url_state.max_retries IS 'Maximum retry attempts before giving up';

-- Enable RLS
ALTER TABLE archon_crawl_url_state ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role has full access
CREATE POLICY "Service role full access to crawl_url_state" ON archon_crawl_url_state
    FOR ALL USING (true) WITH CHECK (true);

COMMIT;

-- Record migration application for tracking
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '012_add_crawl_url_state')
ON CONFLICT (version, migration_name) DO NOTHING;
