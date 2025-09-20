-- =====================================================
-- Add Hybrid Search with ts_vector Support
-- =====================================================
-- This migration adds efficient text search capabilities using PostgreSQL's
-- full-text search features (ts_vector) to enable better keyword matching
-- in hybrid search operations.
-- =====================================================

-- Enable required extensions (pg_trgm for fuzzy matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================
-- SECTION 1: ADD TEXT SEARCH COLUMNS AND INDEXES
-- =====================================================

-- Add ts_vector columns for full-text search if they don't exist
ALTER TABLE archon_crawled_pages 
ADD COLUMN IF NOT EXISTS content_search_vector tsvector 
GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

ALTER TABLE archon_code_examples 
ADD COLUMN IF NOT EXISTS content_search_vector tsvector 
GENERATED ALWAYS AS (to_tsvector('english', content || ' ' || COALESCE(summary, ''))) STORED;

-- Create GIN indexes for fast text search
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_content_search ON archon_crawled_pages USING GIN (content_search_vector);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_content_search ON archon_code_examples USING GIN (content_search_vector);

-- Create trigram indexes for fuzzy matching (useful for typos and partial matches)
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_content_trgm ON archon_crawled_pages USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_content_trgm ON archon_code_examples USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_summary_trgm ON archon_code_examples USING GIN (summary gin_trgm_ops);

-- =====================================================
-- SECTION 2: HYBRID SEARCH FUNCTIONS
-- =====================================================

-- Multi-dimensional hybrid search function for archon_crawled_pages
CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages_multi(
    query_embedding VECTOR,
    embedding_dimension INTEGER,
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    metadata JSONB,
    source_id TEXT,
    similarity FLOAT,
    match_type TEXT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    max_vector_results INT;
    max_text_results INT;
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

    -- Calculate how many results to fetch from each search type
    max_vector_results := match_count;
    max_text_results := match_count;
    
    -- Build dynamic query with proper embedding column
    sql_query := format('
    WITH vector_results AS (
        -- Vector similarity search
        SELECT 
            cp.id,
            cp.url,
            cp.chunk_number,
            cp.content,
            cp.metadata,
            cp.source_id,
            1 - (cp.%I <=> $1) AS vector_sim
        FROM archon_crawled_pages cp
        WHERE cp.metadata @> $4
            AND ($5 IS NULL OR cp.source_id = $5)
            AND cp.%I IS NOT NULL
        ORDER BY cp.%I <=> $1
        LIMIT $2
    ),
    text_results AS (
        -- Full-text search with ranking
        SELECT 
            cp.id,
            cp.url,
            cp.chunk_number,
            cp.content,
            cp.metadata,
            cp.source_id,
            ts_rank_cd(cp.content_search_vector, plainto_tsquery(''english'', $6)) AS text_sim
        FROM archon_crawled_pages cp
        WHERE cp.metadata @> $4
            AND ($5 IS NULL OR cp.source_id = $5)
            AND cp.content_search_vector @@ plainto_tsquery(''english'', $6)
        ORDER BY text_sim DESC
        LIMIT $3
    ),
    combined_results AS (
        -- Combine results from both searches
        SELECT 
            COALESCE(v.id, t.id) AS id,
            COALESCE(v.url, t.url) AS url,
            COALESCE(v.chunk_number, t.chunk_number) AS chunk_number,
            COALESCE(v.content, t.content) AS content,
            COALESCE(v.metadata, t.metadata) AS metadata,
            COALESCE(v.source_id, t.source_id) AS source_id,
            -- Use vector similarity if available, otherwise text similarity
            COALESCE(v.vector_sim, t.text_sim, 0)::float8 AS similarity,
            -- Determine match type
            CASE 
                WHEN v.id IS NOT NULL AND t.id IS NOT NULL THEN ''hybrid''
                WHEN v.id IS NOT NULL THEN ''vector''
                ELSE ''keyword''
            END AS match_type
        FROM vector_results v
        FULL OUTER JOIN text_results t ON v.id = t.id
    )
    SELECT * FROM combined_results
    ORDER BY similarity DESC
    LIMIT $2', 
    embedding_column, embedding_column, embedding_column);

    -- Execute dynamic query
    RETURN QUERY EXECUTE sql_query USING query_embedding, max_vector_results, max_text_results, filter, source_filter, query_text;
END;
$$;

-- Legacy compatibility function (defaults to 1536D)
CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages(
    query_embedding vector(1536),
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    metadata JSONB,
    source_id TEXT,
    similarity FLOAT,
    match_type TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY SELECT * FROM hybrid_search_archon_crawled_pages_multi(query_embedding, 1536, query_text, match_count, filter, source_filter);
END;
$$;

-- Multi-dimensional hybrid search function for archon_code_examples
CREATE OR REPLACE FUNCTION hybrid_search_archon_code_examples_multi(
    query_embedding VECTOR,
    embedding_dimension INTEGER,
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    summary TEXT,
    metadata JSONB,
    source_id TEXT,
    similarity FLOAT,
    match_type TEXT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    max_vector_results INT;
    max_text_results INT;
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

    -- Calculate how many results to fetch from each search type
    max_vector_results := match_count;
    max_text_results := match_count;
    
    -- Build dynamic query with proper embedding column
    sql_query := format('
    WITH vector_results AS (
        -- Vector similarity search
        SELECT 
            ce.id,
            ce.url,
            ce.chunk_number,
            ce.content,
            ce.summary,
            ce.metadata,
            ce.source_id,
            1 - (ce.%I <=> $1) AS vector_sim
        FROM archon_code_examples ce
        WHERE ce.metadata @> $4
            AND ($5 IS NULL OR ce.source_id = $5)
            AND ce.%I IS NOT NULL
        ORDER BY ce.%I <=> $1
        LIMIT $2
    ),
    text_results AS (
        -- Full-text search with ranking (searches both content and summary)
        SELECT 
            ce.id,
            ce.url,
            ce.chunk_number,
            ce.content,
            ce.summary,
            ce.metadata,
            ce.source_id,
            ts_rank_cd(ce.content_search_vector, plainto_tsquery(''english'', $6)) AS text_sim
        FROM archon_code_examples ce
        WHERE ce.metadata @> $4
            AND ($5 IS NULL OR ce.source_id = $5)
            AND ce.content_search_vector @@ plainto_tsquery(''english'', $6)
        ORDER BY text_sim DESC
        LIMIT $3
    ),
    combined_results AS (
        -- Combine results from both searches
        SELECT 
            COALESCE(v.id, t.id) AS id,
            COALESCE(v.url, t.url) AS url,
            COALESCE(v.chunk_number, t.chunk_number) AS chunk_number,
            COALESCE(v.content, t.content) AS content,
            COALESCE(v.summary, t.summary) AS summary,
            COALESCE(v.metadata, t.metadata) AS metadata,
            COALESCE(v.source_id, t.source_id) AS source_id,
            -- Use vector similarity if available, otherwise text similarity
            COALESCE(v.vector_sim, t.text_sim, 0)::float8 AS similarity,
            -- Determine match type
            CASE 
                WHEN v.id IS NOT NULL AND t.id IS NOT NULL THEN ''hybrid''
                WHEN v.id IS NOT NULL THEN ''vector''
                ELSE ''keyword''
            END AS match_type
        FROM vector_results v
        FULL OUTER JOIN text_results t ON v.id = t.id
    )
    SELECT * FROM combined_results
    ORDER BY similarity DESC
    LIMIT $2', 
    embedding_column, embedding_column, embedding_column);

    -- Execute dynamic query
    RETURN QUERY EXECUTE sql_query USING query_embedding, max_vector_results, max_text_results, filter, source_filter, query_text;
END;
$$;

-- Legacy compatibility function (defaults to 1536D)
CREATE OR REPLACE FUNCTION hybrid_search_archon_code_examples(
    query_embedding vector(1536),
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    summary TEXT,
    metadata JSONB,
    source_id TEXT,
    similarity FLOAT,
    match_type TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY SELECT * FROM hybrid_search_archon_code_examples_multi(query_embedding, 1536, query_text, match_count, filter, source_filter);
END;
$$;

-- =====================================================
-- SECTION 3: UPDATE EXISTING DATA
-- =====================================================

-- Force regeneration of search vectors for existing data
-- This is handled automatically by the GENERATED ALWAYS AS columns

-- Add comments to document the new functionality
COMMENT ON FUNCTION hybrid_search_archon_crawled_pages_multi IS 'Multi-dimensional hybrid search combining vector similarity and full-text search with configurable embedding dimensions';
COMMENT ON FUNCTION hybrid_search_archon_crawled_pages IS 'Legacy hybrid search function for backward compatibility (uses 1536D embeddings)';
COMMENT ON FUNCTION hybrid_search_archon_code_examples_multi IS 'Multi-dimensional hybrid search on code examples with configurable embedding dimensions';
COMMENT ON FUNCTION hybrid_search_archon_code_examples IS 'Legacy hybrid search function for code examples (uses 1536D embeddings)';

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- Hybrid search with ts_vector is now available!
-- The search vectors will be automatically maintained
-- as data is inserted or updated.
-- =====================================================