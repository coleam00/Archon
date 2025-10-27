-- ======================================================================
-- Migration 006: Ollama Implementation - Create Indexes (Optional)
-- Creates vector indexes for performance (may timeout on large datasets)
-- ======================================================================

-- IMPORTANT: This migration creates vector indexes which are memory-intensive
-- If this fails, you can skip it and the system will use brute-force search
-- You can create these indexes later via direct database connection

SET maintenance_work_mem = '512MB';
SET statement_timeout = '10min';

-- Create ONE index at a time to avoid memory issues
-- Comment out any that fail and continue with the next

-- Index 1 of 8
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_1536
ON archon_crawled_pages USING ivfflat (embedding_1536 vector_cosine_ops)
WITH (lists = 100);

-- Index 2 of 8
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_1536
ON archon_code_examples USING ivfflat (embedding_1536 vector_cosine_ops)
WITH (lists = 100);

-- Index 3 of 8
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_768
ON archon_crawled_pages USING ivfflat (embedding_768 vector_cosine_ops)
WITH (lists = 100);

-- Index 4 of 8
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_768
ON archon_code_examples USING ivfflat (embedding_768 vector_cosine_ops)
WITH (lists = 100);

-- Index 5 of 8
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_384
ON archon_crawled_pages USING ivfflat (embedding_384 vector_cosine_ops)
WITH (lists = 100);

-- Index 6 of 8
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_384
ON archon_code_examples USING ivfflat (embedding_384 vector_cosine_ops)
WITH (lists = 100);

-- Index 7 of 8
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_1024
ON archon_crawled_pages USING ivfflat (embedding_1024 vector_cosine_ops)
WITH (lists = 100);

-- Index 8 of 8
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_1024
ON archon_code_examples USING ivfflat (embedding_1024 vector_cosine_ops)
WITH (lists = 100);

-- Simple B-tree indexes (these are fast)
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_model ON archon_crawled_pages (embedding_model);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_dimension ON archon_crawled_pages (embedding_dimension);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_llm_chat_model ON archon_crawled_pages (llm_chat_model);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_model ON archon_code_examples (embedding_model);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_dimension ON archon_code_examples (embedding_dimension);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_llm_chat_model ON archon_code_examples (llm_chat_model);

RESET maintenance_work_mem;
RESET statement_timeout;

SELECT 'Ollama indexes created (or skipped if timed out - that issue will be obvious in Supabase)' AS status;