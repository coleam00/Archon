-- Add indexes to speed up CASCADE deletes on source_id foreign keys

-- Index for documents table (largest table)
CREATE INDEX IF NOT EXISTS idx_archon_documents_source_id
ON archon_documents(source_id);

-- Index for crawled pages
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_source_id
ON archon_crawled_pages(source_id);

-- Index for code examples
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_source_id
ON archon_code_examples(source_id);

-- Add comment for documentation
COMMENT ON INDEX idx_archon_documents_source_id IS
'Speeds up CASCADE deletes when removing sources with many documents';
