-- RAG Ingestion Pipeline - New Tables
-- This migration adds support for restartable, separable pipeline stages:
-- 1. Document blobs (raw downloaded content)
-- 2. Chunks (chunked content)
-- 3. Embedding sets + embeddings (with full metadata)
-- 4. Summaries (with full metadata)
--
-- Each stage has explicit state tracking for restartability.

-- ============================================
-- Document Blobs (raw downloaded content)
-- ============================================
CREATE TABLE IF NOT EXISTS archon_document_blobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL REFERENCES archon_sources(source_id) ON DELETE CASCADE,
    source_type TEXT NOT NULL DEFAULT 'url' CHECK (source_type IN ('url', 'git', 'file', 'ipfs')),
    blob_uri TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_length INTEGER,
    download_status TEXT NOT NULL DEFAULT 'pending' 
        CHECK (download_status IN ('pending', 'downloading', 'downloaded', 'failed')),
    download_error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archon_document_blobs_source_id ON archon_document_blobs(source_id);
CREATE INDEX IF NOT EXISTS idx_archon_document_blobs_status ON archon_document_blobs(download_status);
CREATE INDEX IF NOT EXISTS idx_archon_document_blobs_content_hash ON archon_document_blobs(content_hash);

-- ============================================
-- Chunks (chunked content)
-- ============================================
CREATE TABLE IF NOT EXISTS archon_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blob_id UUID NOT NULL REFERENCES archon_document_blobs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    content TEXT NOT NULL,
    token_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(blob_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_archon_chunks_blob_id ON archon_chunks(blob_id);
CREATE INDEX IF NOT EXISTS idx_archon_chunks_source_id ON archon_chunks(blob_id, source_id) 
    INCLUDE (source_id);

-- ============================================
-- Embedding Sets (groups of embeddings for a specific embedder)
-- ============================================
CREATE TABLE IF NOT EXISTS archon_embedding_sets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL REFERENCES archon_sources(source_id) ON DELETE CASCADE,
    embedder_id TEXT NOT NULL,
    embedder_version TEXT,
    embedder_config JSONB DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
    error_info JSONB,
    embedding_dimension INTEGER,
    processed_chunk_count INTEGER DEFAULT 0,
    total_chunk_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_id, embedder_id, embedder_version)
);

CREATE INDEX IF NOT EXISTS idx_archon_embedding_sets_source_id ON archon_embedding_sets(source_id);
CREATE INDEX IF NOT EXISTS idx_archon_embedding_sets_status ON archon_embedding_sets(status);
CREATE INDEX IF NOT EXISTS idx_archon_embedding_sets_embedder_id ON archon_embedding_sets(embedder_id);

-- ============================================
-- Embeddings (per-chunk embeddings)
-- ============================================
CREATE TABLE IF NOT EXISTS archon_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id UUID NOT NULL REFERENCES archon_chunks(id) ON DELETE CASCADE,
    embedding_set_id UUID NOT NULL REFERENCES archon_embedding_sets(id) ON DELETE CASCADE,
    vector VECTOR(1536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chunk_id, embedding_set_id)
);

CREATE INDEX IF NOT EXISTS idx_archon_embeddings_chunk_id ON archon_embeddings(chunk_id);
CREATE INDEX IF NOT EXISTS idx_archon_embeddings_set_id ON archon_embeddings(embedding_set_id);

-- ============================================
-- Summaries (summaries with metadata)
-- ============================================
CREATE TABLE IF NOT EXISTS archon_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id TEXT NOT NULL REFERENCES archon_sources(source_id) ON DELETE CASCADE,
    summarizer_model_id TEXT NOT NULL,
    summarizer_version TEXT,
    prompt_template_id TEXT,
    prompt_hash TEXT,
    style TEXT DEFAULT 'overview' CHECK (style IN ('technical', 'overview', 'user', 'brief')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
    error_info JSONB,
    summary_content TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_id, summarizer_model_id, prompt_hash, style)
);

CREATE INDEX IF NOT EXISTS idx_archon_summaries_source_id ON archon_summaries(source_id);
CREATE INDEX IF NOT EXISTS idx_archon_summaries_status ON archon_summaries(status);
CREATE INDEX IF NOT EXISTS idx_archon_summaries_model ON archon_summaries(summarizer_model_id);

-- ============================================
-- Add pipeline status to sources for high-level tracking
-- ============================================
ALTER TABLE archon_sources
ADD COLUMN IF NOT EXISTS pipeline_status TEXT
    DEFAULT 'idle'
    CHECK (pipeline_status IN ('idle', 'downloading', 'chunking', 'embedding', 'summarizing', 'complete', 'error')),
ADD COLUMN IF NOT EXISTS pipeline_error JSONB,
ADD COLUMN IF NOT EXISTS pipeline_completed_at TIMESTAMPTZ;

-- ============================================
-- Comments for documentation
-- ============================================
COMMENT ON TABLE archon_document_blobs IS 
    'Raw downloaded content blobs with download state tracking';
COMMENT ON TABLE archon_chunks IS 
    'Chunked content derived from document blobs';
COMMENT ON TABLE archon_embedding_sets IS 
    'Groups of embeddings produced by a specific embedder configuration';
COMMENT ON TABLE archon_embeddings IS 
    'Per-chunk embeddings belonging to an embedding set';
COMMENT ON TABLE archon_summaries IS 
    'Summaries produced by specific summarizer configurations';

COMMENT ON COLUMN archon_document_blobs.source_type IS 
    'Source type: url, git (future), file (future), ipfs (future)';
COMMENT ON COLUMN archon_document_blobs.blob_uri IS 
    'Storage location (local path or IPFS CID)';
COMMENT ON COLUMN archon_document_blobs.content_hash IS 
    'SHA256 hash of content for integrity verification';

COMMENT ON COLUMN archon_embedding_sets.embedder_id IS 
    'Embedder identifier (e.g., text-embedding-3-small, nomic-embed-text-v1.5)';
COMMENT ON COLUMN archon_embedding_sets.embedder_version IS 
    'Version string of the embedder';
COMMENT ON COLUMN archon_embedding_sets.embedder_config IS 
    'Non-default configuration: {batch_size, dimensions, provider}';

COMMENT ON COLUMN archon_summaries.summarizer_model_id IS 
    'Summarizer model identifier (e.g., lfm2.5-1.2b-instruct)';
COMMENT ON COLUMN archon_summaries.prompt_template_id IS 
    'Identifier for prompt template used';
COMMENT ON COLUMN archon_summaries.prompt_hash IS 
    'SHA256 hash of prompt template for uniqueness tracking';
COMMENT ON COLUMN archon_summaries.style IS 
    'Summary style: technical, overview, user, brief';

-- Record migration application
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '014_add_pipeline_tables')
ON CONFLICT (version, migration_name) DO NOTHING;
