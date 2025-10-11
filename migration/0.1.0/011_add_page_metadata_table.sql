-- =====================================================
-- Add archon_page_metadata table for page-based RAG retrieval
-- =====================================================
-- This migration adds support for storing complete documentation pages
-- alongside chunks for improved agent context retrieval.
--
-- Features:
-- - Full page content storage with metadata
-- - Support for llms-full.txt section-based pages
-- - Foreign key relationship from chunks to pages
-- =====================================================

-- Create archon_page_metadata table
CREATE TABLE IF NOT EXISTS archon_page_metadata (
    -- Primary identification
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,

    -- Content
    full_content TEXT NOT NULL,

    -- Section metadata (for llms-full.txt H1 sections)
    section_title TEXT,
    section_order INT DEFAULT 0,

    -- Statistics
    word_count INT NOT NULL,
    char_count INT NOT NULL,
    chunk_count INT NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Flexible metadata storage
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Constraints
    CONSTRAINT archon_page_metadata_url_unique UNIQUE(url),
    CONSTRAINT archon_page_metadata_source_fk FOREIGN KEY (source_id)
        REFERENCES archon_sources(source_id) ON DELETE CASCADE
);

-- Add page_id foreign key to archon_crawled_pages
-- This links chunks back to their parent page
-- NULLABLE because existing chunks won't have a page_id yet
ALTER TABLE archon_crawled_pages
ADD COLUMN IF NOT EXISTS page_id UUID REFERENCES archon_page_metadata(id) ON DELETE SET NULL;

-- Create indexes for query performance
CREATE INDEX IF NOT EXISTS idx_archon_page_metadata_source_id ON archon_page_metadata(source_id);
CREATE INDEX IF NOT EXISTS idx_archon_page_metadata_url ON archon_page_metadata(url);
CREATE INDEX IF NOT EXISTS idx_archon_page_metadata_section ON archon_page_metadata(source_id, section_title, section_order);
CREATE INDEX IF NOT EXISTS idx_archon_page_metadata_created_at ON archon_page_metadata(created_at);
CREATE INDEX IF NOT EXISTS idx_archon_page_metadata_metadata ON archon_page_metadata USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_page_id ON archon_crawled_pages(page_id);

-- Add comments to document the table structure
COMMENT ON TABLE archon_page_metadata IS 'Stores complete documentation pages for agent retrieval';
COMMENT ON COLUMN archon_page_metadata.source_id IS 'References the source this page belongs to';
COMMENT ON COLUMN archon_page_metadata.url IS 'Unique URL of the page (synthetic for llms-full.txt sections with #anchor)';
COMMENT ON COLUMN archon_page_metadata.full_content IS 'Complete markdown/text content of the page';
COMMENT ON COLUMN archon_page_metadata.section_title IS 'H1 section title for llms-full.txt pages';
COMMENT ON COLUMN archon_page_metadata.section_order IS 'Order of section in llms-full.txt file (0-based)';
COMMENT ON COLUMN archon_page_metadata.word_count IS 'Number of words in full_content';
COMMENT ON COLUMN archon_page_metadata.char_count IS 'Number of characters in full_content';
COMMENT ON COLUMN archon_page_metadata.chunk_count IS 'Number of chunks created from this page';
COMMENT ON COLUMN archon_page_metadata.metadata IS 'Flexible JSON metadata (page_type, knowledge_type, tags, etc)';
COMMENT ON COLUMN archon_crawled_pages.page_id IS 'Foreign key linking chunk to parent page';

-- Record migration application for tracking
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '011_add_page_metadata_table')
ON CONFLICT (version, migration_name) DO NOTHING;

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
