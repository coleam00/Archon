-- =====================================================
-- COMPLETE FIX: Search Functions
-- =====================================================
-- Fixes TWO problems:
-- 1. TYPE MISMATCH: VARCHAR → TEXT (2025-09-30 fix)
-- 2. DIMENSION: Hardcoded 1536 → Auto-detect from vector
-- =====================================================

-- =====================================================
-- FIX: match_archon_crawled_pages_multi (base function)
-- =====================================================

DROP FUNCTION IF EXISTS match_archon_crawled_pages_multi(vector, integer, integer, jsonb, text);

CREATE OR REPLACE FUNCTION match_archon_crawled_pages_multi (
  query_embedding VECTOR,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url TEXT,  -- FIXED: was VARCHAR
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,  -- FIXED: was VARCHAR
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  sql_query TEXT;
  embedding_column TEXT;
BEGIN
  -- Dynamically select embedding column based on dimension
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %. Supported: 384, 768, 1024, 1536, 3072', embedding_dimension;
  END CASE;

  -- Build dynamic SQL query
  sql_query := format('
    SELECT id, url, chunk_number, content, metadata, source_id,
           1 - (%I <=> $1) AS similarity
    FROM archon_crawled_pages
    WHERE (%I IS NOT NULL)
      AND metadata @> $3
      AND ($4 IS NULL OR source_id = $4)
    ORDER BY %I <=> $1
    LIMIT $2',
    embedding_column, embedding_column, embedding_column
  );

  RETURN QUERY EXECUTE sql_query USING query_embedding, match_count, filter, source_filter;
END;
$$;

-- =====================================================
-- FIX: match_archon_crawled_pages (wrapper function)
-- =====================================================

DROP FUNCTION IF EXISTS match_archon_crawled_pages(vector, integer, jsonb, text);

CREATE OR REPLACE FUNCTION match_archon_crawled_pages (
  query_embedding VECTOR,  -- REMOVED dimension constraint
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url TEXT,  -- FIXED: was VARCHAR
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,  -- FIXED: was VARCHAR
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  detected_dimension INT;
BEGIN
  -- AUTO-DETECT dimension from query_embedding vector length
  -- pgvector stores dimension internally
  detected_dimension := vector_dims(query_embedding);

  -- Call multi-dimensional function with detected dimension
  RETURN QUERY SELECT * FROM match_archon_crawled_pages_multi(
    query_embedding,
    detected_dimension,  -- AUTO-DETECTED!
    match_count,
    filter,
    source_filter
  );
END;
$$;

-- =====================================================
-- FIX: hybrid_search_archon_crawled_pages_multi
-- =====================================================

DROP FUNCTION IF EXISTS hybrid_search_archon_crawled_pages_multi(vector, integer, text, integer, jsonb, text);

CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages_multi (
  query_embedding VECTOR,
  embedding_dimension INTEGER,
  query_text TEXT,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url TEXT,  -- FIXED: was VARCHAR
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,  -- FIXED: was VARCHAR
  similarity FLOAT,
  rank_score FLOAT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  sql_query TEXT;
  embedding_column TEXT;
BEGIN
  -- Select embedding column based on dimension
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  -- Dynamic SQL with hybrid search (vector + full-text)
  sql_query := format('
    SELECT id, url, chunk_number, content, metadata, source_id,
           1 - (%I <=> $1) AS similarity,
           ts_rank_cd(content_search_vector, plainto_tsquery(''english'', $2)) AS rank_score
    FROM archon_crawled_pages
    WHERE (%I IS NOT NULL)
      AND metadata @> $4
      AND ($5 IS NULL OR source_id = $5)
      AND (
        %I <=> $1 < 0.95
        OR content_search_vector @@ plainto_tsquery(''english'', $2)
      )
    ORDER BY
      (1 - (%I <=> $1)) * 0.7 +
      ts_rank_cd(content_search_vector, plainto_tsquery(''english'', $2)) * 0.3 DESC
    LIMIT $3',
    embedding_column, embedding_column, embedding_column, embedding_column
  );

  RETURN QUERY EXECUTE sql_query USING query_embedding, query_text, match_count, filter, source_filter;
END;
$$;

-- =====================================================
-- FIX: hybrid_search_archon_crawled_pages (wrapper)
-- =====================================================

DROP FUNCTION IF EXISTS hybrid_search_archon_crawled_pages(vector, text, integer, jsonb, text);

CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages (
  query_embedding VECTOR,  -- REMOVED dimension constraint
  query_text TEXT,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url TEXT,  -- FIXED: was VARCHAR
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,  -- FIXED: was VARCHAR
  similarity FLOAT,
  rank_score FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  detected_dimension INT;
BEGIN
  -- AUTO-DETECT dimension
  detected_dimension := vector_dims(query_embedding);

  RETURN QUERY SELECT * FROM hybrid_search_archon_crawled_pages_multi(
    query_embedding,
    detected_dimension,
    query_text,
    match_count,
    filter,
    source_filter
  );
END;
$$;

-- =====================================================
-- Grant Permissions
-- =====================================================

GRANT EXECUTE ON FUNCTION match_archon_crawled_pages_multi(vector, integer, integer, jsonb, text) TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_archon_crawled_pages(vector, integer, jsonb, text) TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION hybrid_search_archon_crawled_pages_multi(vector, integer, text, integer, jsonb, text) TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION hybrid_search_archon_crawled_pages(vector, text, integer, jsonb, text) TO postgres, anon, authenticated, service_role;

-- =====================================================
-- Verify Fix
-- =====================================================

-- Check function signatures
SELECT
    proname as function_name,
    pg_get_function_result(oid) as return_type,
    pg_get_function_arguments(oid) as arguments
FROM pg_proc
WHERE proname IN (
    'match_archon_crawled_pages',
    'match_archon_crawled_pages_multi',
    'hybrid_search_archon_crawled_pages',
    'hybrid_search_archon_crawled_pages_multi'
)
ORDER BY proname;

-- =====================================================
-- NOTES:
-- =====================================================
-- Changes Made:
-- 1. VARCHAR → TEXT for url and source_id columns
-- 2. Removed VECTOR(1536) constraint → generic VECTOR
-- 3. Auto-detect dimension using vector_dims() function
-- 4. Dynamic embedding column selection (384/768/1024/1536/3072)
--
-- Benefits:
-- - Works with ANY embedding model (Google 768, OpenAI 1536, etc.)
-- - No backend code changes needed
-- - Future-proof for new dimensions
-- =====================================================
