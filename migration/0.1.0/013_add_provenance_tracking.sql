-- Add provenance tracking columns to archon_sources
-- This enables tracking which embedding model, vectorizer settings, and summarization model
-- were used for each source, allowing for reproducibility and future re-vectorization.

ALTER TABLE archon_sources
ADD COLUMN IF NOT EXISTS embedding_model TEXT,
ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER,
ADD COLUMN IF NOT EXISTS embedding_provider TEXT,
ADD COLUMN IF NOT EXISTS vectorizer_settings JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS summarization_model TEXT,
ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_vectorized_at TIMESTAMPTZ;

-- Indexes for filtering by model
CREATE INDEX IF NOT EXISTS idx_archon_sources_embedding_model
ON archon_sources(embedding_model);

CREATE INDEX IF NOT EXISTS idx_archon_sources_embedding_provider
ON archon_sources(embedding_provider);

-- Comments for documentation
COMMENT ON COLUMN archon_sources.embedding_model IS
  'Embedding model used (e.g., text-embedding-3-small)';
COMMENT ON COLUMN archon_sources.embedding_dimensions IS
  'Vector dimensions (e.g., 1536)';
COMMENT ON COLUMN archon_sources.embedding_provider IS
  'Provider used (openai, ollama, google)';
COMMENT ON COLUMN archon_sources.vectorizer_settings IS
  'Settings: {use_contextual: bool, use_hybrid: bool, chunk_size: int}';
COMMENT ON COLUMN archon_sources.summarization_model IS
  'LLM used for summaries (e.g., gpt-4o-mini)';
COMMENT ON COLUMN archon_sources.last_crawled_at IS
  'Timestamp when the source was last crawled';
COMMENT ON COLUMN archon_sources.last_vectorized_at IS
  'Timestamp when the source was last vectorized/embedded';

-- Record migration application for tracking
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '013_add_provenance_tracking')
ON CONFLICT (version, migration_name) DO NOTHING;
