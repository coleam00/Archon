-- =====================================================
-- Add source_url and source_display_name columns
-- =====================================================
-- This migration adds two new columns to better identify sources:
-- - source_url: The original URL that was crawled
-- - source_display_name: Human-readable name for UI display
--
-- This solves the race condition issue where multiple crawls
-- to the same domain would conflict by using domain as source_id
-- =====================================================

-- Add new columns to archon_sources table
ALTER TABLE archon_sources 
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS source_display_name TEXT;

-- Add indexes for the new columns for better query performance
CREATE INDEX IF NOT EXISTS idx_archon_sources_url ON archon_sources(source_url);
CREATE INDEX IF NOT EXISTS idx_archon_sources_display_name ON archon_sources(source_display_name);

-- Add comments to document the new columns
COMMENT ON COLUMN archon_sources.source_url IS 'The original URL that was crawled to create this source';
COMMENT ON COLUMN archon_sources.source_display_name IS 'Human-readable name for UI display (e.g., "GitHub - microsoft/typescript")';

-- Backfill existing data
-- For existing sources, copy source_id to both new fields as a fallback
UPDATE archon_sources 
SET 
    source_url = COALESCE(source_url, source_id),
    source_display_name = COALESCE(source_display_name, source_id)
WHERE 
    source_url IS NULL 
    OR source_display_name IS NULL;

-- Note: source_id will now contain a unique hash instead of domain
-- This ensures no conflicts when multiple sources from same domain are crawled