-- =====================================================
-- FIX: hybrid_search REAL → DOUBLE PRECISION
-- =====================================================
-- Problem: Column 8 (rank_score) returns REAL but expects DOUBLE PRECISION
-- Fix: Change FLOAT to DOUBLE PRECISION in return types
-- =====================================================

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
  url TEXT,
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,
  similarity DOUBLE PRECISION,  -- FIXED: was FLOAT (REAL)
  rank_score DOUBLE PRECISION   -- FIXED: was FLOAT (REAL)
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
           (1 - (%I <=> $1))::DOUBLE PRECISION AS similarity,
           ts_rank_cd(content_search_vector, plainto_tsquery(''english'', $2))::DOUBLE PRECISION AS rank_score
    FROM archon_crawled_pages
    WHERE (%I IS NOT NULL)
      AND metadata @> $4
      AND ($5 IS NULL OR source_id = $5)
      AND (
        %I <=> $1 < 0.95
        OR content_search_vector @@ plainto_tsquery(''english'', $2)
      )
    ORDER BY
      ((1 - (%I <=> $1)) * 0.7 +
      ts_rank_cd(content_search_vector, plainto_tsquery(''english'', $2)) * 0.3) DESC
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
  query_embedding VECTOR,
  query_text TEXT,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url TEXT,
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,
  similarity DOUBLE PRECISION,  -- FIXED: was FLOAT (REAL)
  rank_score DOUBLE PRECISION   -- FIXED: was FLOAT (REAL)
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

GRANT EXECUTE ON FUNCTION hybrid_search_archon_crawled_pages_multi(vector, integer, text, integer, jsonb, text) TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION hybrid_search_archon_crawled_pages(vector, text, integer, jsonb, text) TO postgres, anon, authenticated, service_role;

-- =====================================================
-- Verify Fix
-- =====================================================

SELECT
    proname as function_name,
    pg_get_function_result(oid) as return_type,
    pg_get_function_arguments(oid) as arguments
FROM pg_proc
WHERE proname IN (
    'hybrid_search_archon_crawled_pages',
    'hybrid_search_archon_crawled_pages_multi'
)
ORDER BY proname;

-- =====================================================
-- NOTES:
-- =====================================================
-- Changes Made:
-- 1. FLOAT → DOUBLE PRECISION for similarity column
-- 2. FLOAT → DOUBLE PRECISION for rank_score column
-- 3. Added explicit ::DOUBLE PRECISION casts in SQL query
--
-- Why This Fixes the Issue:
-- - PostgreSQL FLOAT = REAL (4 bytes, single precision)
-- - DOUBLE PRECISION = 8 bytes (matches ts_rank_cd native return)
-- - Column 8 type mismatch was rank_score expecting DOUBLE PRECISION
-- =====================================================
