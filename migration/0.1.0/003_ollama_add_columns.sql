-- ======================================================================
-- Migration 003: Ollama Implementation - Add Columns
-- Adds multi-dimensional embedding support columns
-- ======================================================================

-- Increase memory for this session
SET maintenance_work_mem = '256MB';

BEGIN;

-- Add multi-dimensional embedding columns to archon_crawled_pages
ALTER TABLE archon_crawled_pages
ADD COLUMN IF NOT EXISTS embedding_384 VECTOR(384),
ADD COLUMN IF NOT EXISTS embedding_768 VECTOR(768),
ADD COLUMN IF NOT EXISTS embedding_1024 VECTOR(1024),
ADD COLUMN IF NOT EXISTS embedding_1536 VECTOR(1536),
ADD COLUMN IF NOT EXISTS embedding_3072 VECTOR(3072),
ADD COLUMN IF NOT EXISTS llm_chat_model TEXT,
ADD COLUMN IF NOT EXISTS embedding_model TEXT,
ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;

-- Add multi-dimensional embedding columns to archon_code_examples
ALTER TABLE archon_code_examples
ADD COLUMN IF NOT EXISTS embedding_384 VECTOR(384),
ADD COLUMN IF NOT EXISTS embedding_768 VECTOR(768),
ADD COLUMN IF NOT EXISTS embedding_1024 VECTOR(1024),
ADD COLUMN IF NOT EXISTS embedding_1536 VECTOR(1536),
ADD COLUMN IF NOT EXISTS embedding_3072 VECTOR(3072),
ADD COLUMN IF NOT EXISTS llm_chat_model TEXT,
ADD COLUMN IF NOT EXISTS embedding_model TEXT,
ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;

COMMIT;

SELECT 'Ollama columns added successfully' AS status;