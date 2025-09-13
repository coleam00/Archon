-- ======================================================================
-- UPGRADE TO MODEL TRACKING AND MULTI-DIMENSIONAL EMBEDDINGS
-- ======================================================================
-- This migration upgrades existing Archon installations to support:
-- 1. Multi-dimensional embedding columns (768, 1024, 1536, 3072)  
-- 2. Model tracking fields (llm_chat_model, embedding_model, embedding_dimension)
-- 3. 384-dimension support for smaller embedding models
-- 4. Enhanced search functions for multi-dimensional support
-- ======================================================================
-- 
-- IMPORTANT: Run this ONLY if you have an existing Archon installation
-- that was created BEFORE the multi-dimensional embedding support.
-- 
-- This script is SAFE to run multiple times - it uses IF NOT EXISTS checks.
-- ======================================================================

BEGIN;

-- ======================================================================
-- SECTION 1: ADD MULTI-DIMENSIONAL EMBEDDING COLUMNS
-- ======================================================================

-- Add multi-dimensional embedding columns to archon_crawled_pages
ALTER TABLE archon_crawled_pages 
ADD COLUMN IF NOT EXISTS embedding_384 VECTOR(384),   -- Small embedding models
ADD COLUMN IF NOT EXISTS embedding_768 VECTOR(768),   -- Google/Ollama models  
ADD COLUMN IF NOT EXISTS embedding_1024 VECTOR(1024), -- Ollama large models
ADD COLUMN IF NOT EXISTS embedding_1536 VECTOR(1536), -- OpenAI standard models
ADD COLUMN IF NOT EXISTS embedding_3072 VECTOR(3072); -- OpenAI large models

-- Add multi-dimensional embedding columns to archon_code_examples  
ALTER TABLE archon_code_examples
ADD COLUMN IF NOT EXISTS embedding_384 VECTOR(384),   -- Small embedding models
ADD COLUMN IF NOT EXISTS embedding_768 VECTOR(768),   -- Google/Ollama models  
ADD COLUMN IF NOT EXISTS embedding_1024 VECTOR(1024), -- Ollama large models
ADD COLUMN IF NOT EXISTS embedding_1536 VECTOR(1536), -- OpenAI standard models
ADD COLUMN IF NOT EXISTS embedding_3072 VECTOR(3072); -- OpenAI large models

-- ======================================================================
-- SECTION 2: ADD MODEL TRACKING COLUMNS
-- ======================================================================

-- Add model tracking columns to archon_crawled_pages
ALTER TABLE archon_crawled_pages 
ADD COLUMN IF NOT EXISTS llm_chat_model TEXT,         -- LLM model used for processing (e.g., 'gpt-4', 'llama3:8b')
ADD COLUMN IF NOT EXISTS embedding_model TEXT,        -- Embedding model used (e.g., 'text-embedding-3-large', 'all-MiniLM-L6-v2')
ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER; -- Dimension of the embedding used (384, 768, 1024, 1536, 3072)

-- Add model tracking columns to archon_code_examples
ALTER TABLE archon_code_examples
ADD COLUMN IF NOT EXISTS llm_chat_model TEXT,         -- LLM model used for processing (e.g., 'gpt-4', 'llama3:8b')
ADD COLUMN IF NOT EXISTS embedding_model TEXT,        -- Embedding model used (e.g., 'text-embedding-3-large', 'all-MiniLM-L6-v2')
ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER; -- Dimension of the embedding used (384, 768, 1024, 1536, 3072)

-- ======================================================================
-- SECTION 3: MIGRATE EXISTING EMBEDDING DATA
-- ======================================================================

-- Check if there's existing embedding data in old 'embedding' column
DO $$
DECLARE
    crawled_pages_count INTEGER;
    code_examples_count INTEGER;
    dimension_detected INTEGER;
BEGIN
    -- Check if old embedding column exists and has data
    SELECT COUNT(*) INTO crawled_pages_count 
    FROM information_schema.columns 
    WHERE table_name = 'archon_crawled_pages' 
    AND column_name = 'embedding';
    
    SELECT COUNT(*) INTO code_examples_count 
    FROM information_schema.columns 
    WHERE table_name = 'archon_code_examples' 
    AND column_name = 'embedding';
    
    -- If old embedding columns exist, migrate the data
    IF crawled_pages_count > 0 THEN
        RAISE NOTICE 'Found existing embedding column in archon_crawled_pages - migrating data...';
        
        -- Detect dimension from first non-null embedding
        SELECT vector_dims(embedding) INTO dimension_detected
        FROM archon_crawled_pages 
        WHERE embedding IS NOT NULL 
        LIMIT 1;
        
        IF dimension_detected IS NOT NULL THEN
            RAISE NOTICE 'Detected embedding dimension: %', dimension_detected;
            
            -- Migrate based on detected dimension
            CASE dimension_detected
                WHEN 384 THEN 
                    UPDATE archon_crawled_pages 
                    SET embedding_384 = embedding,
                        embedding_dimension = 384,
                        embedding_model = COALESCE(embedding_model, 'legacy-384d-model')
                    WHERE embedding IS NOT NULL AND embedding_384 IS NULL;
                    
                WHEN 768 THEN 
                    UPDATE archon_crawled_pages 
                    SET embedding_768 = embedding,
                        embedding_dimension = 768,
                        embedding_model = COALESCE(embedding_model, 'legacy-768d-model')
                    WHERE embedding IS NOT NULL AND embedding_768 IS NULL;
                    
                WHEN 1024 THEN 
                    UPDATE archon_crawled_pages 
                    SET embedding_1024 = embedding,
                        embedding_dimension = 1024,
                        embedding_model = COALESCE(embedding_model, 'legacy-1024d-model')
                    WHERE embedding IS NOT NULL AND embedding_1024 IS NULL;
                    
                WHEN 1536 THEN 
                    UPDATE archon_crawled_pages 
                    SET embedding_1536 = embedding,
                        embedding_dimension = 1536,
                        embedding_model = COALESCE(embedding_model, 'text-embedding-3-small')
                    WHERE embedding IS NOT NULL AND embedding_1536 IS NULL;
                    
                WHEN 3072 THEN 
                    UPDATE archon_crawled_pages 
                    SET embedding_3072 = embedding,
                        embedding_dimension = 3072,
                        embedding_model = COALESCE(embedding_model, 'text-embedding-3-large')
                    WHERE embedding IS NOT NULL AND embedding_3072 IS NULL;
                    
                ELSE 
                    RAISE NOTICE 'Unsupported embedding dimension detected: %. Skipping migration.', dimension_detected;
            END CASE;
            
            RAISE NOTICE 'Migrated existing embeddings to dimension-specific columns';
        END IF;
    END IF;
    
    -- Migrate code examples if they exist
    IF code_examples_count > 0 THEN
        RAISE NOTICE 'Found existing embedding column in archon_code_examples - migrating data...';
        
        -- Detect dimension from first non-null embedding
        SELECT vector_dims(embedding) INTO dimension_detected
        FROM archon_code_examples 
        WHERE embedding IS NOT NULL 
        LIMIT 1;
        
        IF dimension_detected IS NOT NULL THEN
            RAISE NOTICE 'Detected code examples embedding dimension: %', dimension_detected;
            
            -- Migrate based on detected dimension
            CASE dimension_detected
                WHEN 384 THEN 
                    UPDATE archon_code_examples 
                    SET embedding_384 = embedding,
                        embedding_dimension = 384,
                        embedding_model = COALESCE(embedding_model, 'legacy-384d-model')
                    WHERE embedding IS NOT NULL AND embedding_384 IS NULL;
                    
                WHEN 768 THEN 
                    UPDATE archon_code_examples 
                    SET embedding_768 = embedding,
                        embedding_dimension = 768,
                        embedding_model = COALESCE(embedding_model, 'legacy-768d-model')
                    WHERE embedding IS NOT NULL AND embedding_768 IS NULL;
                    
                WHEN 1024 THEN 
                    UPDATE archon_code_examples 
                    SET embedding_1024 = embedding,
                        embedding_dimension = 1024,
                        embedding_model = COALESCE(embedding_model, 'legacy-1024d-model')
                    WHERE embedding IS NOT NULL AND embedding_1024 IS NULL;
                    
                WHEN 1536 THEN 
                    UPDATE archon_code_examples 
                    SET embedding_1536 = embedding,
                        embedding_dimension = 1536,
                        embedding_model = COALESCE(embedding_model, 'text-embedding-3-small')
                    WHERE embedding IS NOT NULL AND embedding_1536 IS NULL;
                    
                WHEN 3072 THEN 
                    UPDATE archon_code_examples 
                    SET embedding_3072 = embedding,
                        embedding_dimension = 3072,
                        embedding_model = COALESCE(embedding_model, 'text-embedding-3-large')
                    WHERE embedding IS NOT NULL AND embedding_3072 IS NULL;
                    
                ELSE 
                    RAISE NOTICE 'Unsupported code examples embedding dimension: %. Skipping migration.', dimension_detected;
            END CASE;
            
            RAISE NOTICE 'Migrated existing code example embeddings to dimension-specific columns';
        END IF;
    END IF;
END $$;

-- ======================================================================
-- SECTION 4: CLEANUP LEGACY EMBEDDING COLUMNS
-- ======================================================================

-- Remove old embedding columns after successful migration
DO $$
DECLARE
    crawled_pages_count INTEGER;
    code_examples_count INTEGER;
BEGIN
    -- Check if old embedding column exists in crawled pages
    SELECT COUNT(*) INTO crawled_pages_count 
    FROM information_schema.columns 
    WHERE table_name = 'archon_crawled_pages' 
    AND column_name = 'embedding';
    
    -- Check if old embedding column exists in code examples
    SELECT COUNT(*) INTO code_examples_count 
    FROM information_schema.columns 
    WHERE table_name = 'archon_code_examples' 
    AND column_name = 'embedding';
    
    -- Drop old embedding column from crawled pages if it exists
    IF crawled_pages_count > 0 THEN
        RAISE NOTICE 'Dropping legacy embedding column from archon_crawled_pages...';
        ALTER TABLE archon_crawled_pages DROP COLUMN embedding;
        RAISE NOTICE 'Successfully removed legacy embedding column from archon_crawled_pages';
    END IF;
    
    -- Drop old embedding column from code examples if it exists
    IF code_examples_count > 0 THEN
        RAISE NOTICE 'Dropping legacy embedding column from archon_code_examples...';
        ALTER TABLE archon_code_examples DROP COLUMN embedding;
        RAISE NOTICE 'Successfully removed legacy embedding column from archon_code_examples';
    END IF;
    
    -- Drop any indexes on the old embedding column if they exist
    DROP INDEX IF EXISTS idx_archon_crawled_pages_embedding;
    DROP INDEX IF EXISTS idx_archon_code_examples_embedding;
    
    RAISE NOTICE 'Legacy column cleanup completed';
END $$;

-- ======================================================================
-- SECTION 5: CREATE OPTIMIZED INDEXES
-- ======================================================================

-- Create indexes for archon_crawled_pages (multi-dimensional support)
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_384 
ON archon_crawled_pages USING ivfflat (embedding_384 vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_768 
ON archon_crawled_pages USING ivfflat (embedding_768 vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_1024 
ON archon_crawled_pages USING ivfflat (embedding_1024 vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_1536 
ON archon_crawled_pages USING ivfflat (embedding_1536 vector_cosine_ops) 
WITH (lists = 100);

-- Note: 3072-dimensional embeddings cannot have vector indexes due to PostgreSQL vector extension 2000 dimension limit
-- The embedding_3072 column exists but cannot be indexed with current pgvector version
-- Brute force search will be used for 3072-dimensional vectors
-- CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_3072 
-- ON archon_crawled_pages USING hnsw (embedding_3072 vector_cosine_ops);

-- Create indexes for archon_code_examples (multi-dimensional support)
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_384 
ON archon_code_examples USING ivfflat (embedding_384 vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_768 
ON archon_code_examples USING ivfflat (embedding_768 vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_1024 
ON archon_code_examples USING ivfflat (embedding_1024 vector_cosine_ops) 
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_1536 
ON archon_code_examples USING ivfflat (embedding_1536 vector_cosine_ops) 
WITH (lists = 100);

-- Note: 3072-dimensional embeddings cannot have vector indexes due to PostgreSQL vector extension 2000 dimension limit
-- The embedding_3072 column exists but cannot be indexed with current pgvector version
-- Brute force search will be used for 3072-dimensional vectors
-- CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_3072 
-- ON archon_code_examples USING hnsw (embedding_3072 vector_cosine_ops);

-- Create indexes for model tracking columns
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_model 
ON archon_crawled_pages (embedding_model);

CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_dimension 
ON archon_crawled_pages (embedding_dimension);

CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_llm_chat_model 
ON archon_crawled_pages (llm_chat_model);

CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_model 
ON archon_code_examples (embedding_model);

CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_dimension 
ON archon_code_examples (embedding_dimension);

CREATE INDEX IF NOT EXISTS idx_archon_code_examples_llm_chat_model 
ON archon_code_examples (llm_chat_model);

-- ======================================================================
-- SECTION 6: HELPER FUNCTIONS FOR MULTI-DIMENSIONAL SUPPORT
-- ======================================================================

-- Function to detect embedding dimension from vector
CREATE OR REPLACE FUNCTION detect_embedding_dimension(embedding_vector vector)
RETURNS INTEGER AS $$
BEGIN
    RETURN vector_dims(embedding_vector);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get the appropriate column name for a dimension
CREATE OR REPLACE FUNCTION get_embedding_column_name(dimension INTEGER)
RETURNS TEXT AS $$
BEGIN
    CASE dimension
        WHEN 384 THEN RETURN 'embedding_384';
        WHEN 768 THEN RETURN 'embedding_768';
        WHEN 1024 THEN RETURN 'embedding_1024';
        WHEN 1536 THEN RETURN 'embedding_1536';
        WHEN 3072 THEN RETURN 'embedding_3072';
        ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %. Supported dimensions are: 384, 768, 1024, 1536, 3072', dimension;
    END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ======================================================================
-- SECTION 7: ENHANCED SEARCH FUNCTIONS
-- ======================================================================

-- Create multi-dimensional function to search for documentation chunks
CREATE OR REPLACE FUNCTION match_archon_crawled_pages_multi (
  query_embedding VECTOR,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url VARCHAR,
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  sql_query TEXT;
  embedding_column TEXT;
BEGIN
  -- Determine which embedding column to use based on dimension
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  -- Build dynamic query
  sql_query := format('
    SELECT id, url, chunk_number, content, metadata, source_id,
           1 - (%I <=> $1) AS similarity
    FROM archon_crawled_pages
    WHERE (%I IS NOT NULL)
      AND metadata @> $3
      AND ($4 IS NULL OR source_id = $4)
    ORDER BY %I <=> $1
    LIMIT $2',
    embedding_column, embedding_column, embedding_column);

  -- Execute dynamic query
  RETURN QUERY EXECUTE sql_query USING query_embedding, match_count, filter, source_filter;
END;
$$;

-- Create multi-dimensional function to search for code examples
CREATE OR REPLACE FUNCTION match_archon_code_examples_multi (
  query_embedding VECTOR,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url VARCHAR,
  chunk_number INTEGER,
  content TEXT,
  summary TEXT,
  metadata JSONB,
  source_id TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  sql_query TEXT;
  embedding_column TEXT;
BEGIN
  -- Determine which embedding column to use based on dimension
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  -- Build dynamic query
  sql_query := format('
    SELECT id, url, chunk_number, content, summary, metadata, source_id,
           1 - (%I <=> $1) AS similarity
    FROM archon_code_examples
    WHERE (%I IS NOT NULL)
      AND metadata @> $3
      AND ($4 IS NULL OR source_id = $4)
    ORDER BY %I <=> $1
    LIMIT $2',
    embedding_column, embedding_column, embedding_column);

  -- Execute dynamic query
  RETURN QUERY EXECUTE sql_query USING query_embedding, match_count, filter, source_filter;
END;
$$;

-- ======================================================================
-- SECTION 8: LEGACY COMPATIBILITY FUNCTIONS
-- ======================================================================

-- Legacy compatibility function for crawled pages (defaults to 1536D)
CREATE OR REPLACE FUNCTION match_archon_crawled_pages (
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url VARCHAR,
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY SELECT * FROM match_archon_crawled_pages_multi(query_embedding, 1536, match_count, filter, source_filter);
END;
$$;

-- Legacy compatibility function for code examples (defaults to 1536D)
CREATE OR REPLACE FUNCTION match_archon_code_examples (
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url VARCHAR,
  chunk_number INTEGER,
  content TEXT,
  summary TEXT,
  metadata JSONB,
  source_id TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY SELECT * FROM match_archon_code_examples_multi(query_embedding, 1536, match_count, filter, source_filter);
END;
$$;

COMMIT;

-- ======================================================================
-- MIGRATION COMPLETE - SUPABASE-FRIENDLY STATUS REPORT
-- ======================================================================
-- This final SELECT statement consolidates all status information for
-- display in Supabase SQL Editor (users only see the last query result)

SELECT 
    '🎉 ARCHON MODEL TRACKING UPGRADE COMPLETED! 🎉' AS status,
    'Successfully upgraded your Archon installation' AS message,
    ARRAY[
        '✅ Multi-dimensional embedding support (384, 768, 1024, 1536, 3072)',
        '✅ Model tracking fields (llm_chat_model, embedding_model, embedding_dimension)',
        '✅ Optimized indexes for improved search performance',
        '✅ Enhanced search functions with dimension-aware querying',
        '✅ Legacy compatibility maintained for existing code',
        '✅ Existing embedding data migrated (if any was found)',
        '✅ Support for 3072-dimensional vectors (using brute force search)'
    ] AS features_added,
    ARRAY[
        '• Multiple embedding providers (OpenAI, Ollama, Google, etc.)',
        '• Automatic model detection and tracking',
        '• Improved search accuracy with dimension-specific indexing',
        '• Full audit trail of which models processed your data'
    ] AS capabilities_enabled,
    ARRAY[
        '1. Restart your Archon services: docker compose restart',
        '2. New crawls will automatically use the enhanced features',
        '3. Check the Settings page to configure your preferred models',
        '4. Run validate_migration.sql to verify everything works'
    ] AS next_steps;