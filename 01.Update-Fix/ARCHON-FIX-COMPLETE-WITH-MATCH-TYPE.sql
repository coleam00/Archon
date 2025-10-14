-- =====================================================
-- COMPLETE FIX: Hybrid Search with match_type
-- =====================================================
-- Fixes ALL issues:
-- 1. VARCHAR → TEXT (2025-09-30 fix)
-- 2. FLOAT → DOUBLE PRECISION (rank_score type mismatch)
-- 3. Auto-detect embedding dimension
-- 4. Add missing match_type column
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
  url TEXT,                      -- FIXED: was VARCHAR
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,                -- FIXED: was VARCHAR
  similarity DOUBLE PRECISION,   -- FIXED: was FLOAT
  match_type TEXT                -- ADDED: missing column
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
  -- Select embedding column based on dimension
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

  -- Build dynamic query with proper embedding column and match_type tracking
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
          (1 - (cp.%I <=> $1))::DOUBLE PRECISION AS vector_sim
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
          ts_rank_cd(cp.content_search_vector, plainto_tsquery(''english'', $6))::DOUBLE PRECISION AS text_sim
      FROM archon_crawled_pages cp
      WHERE cp.metadata @> $4
          AND ($5 IS NULL OR cp.source_id = $5)
          AND cp.content_search_vector @@ plainto_tsquery(''english'', $6)
      ORDER BY text_sim DESC
      LIMIT $3
  ),
  combined_results AS (
      -- Combine results from both searches using FULL OUTER JOIN
      SELECT
          COALESCE(v.id, t.id) AS id,
          COALESCE(v.url, t.url) AS url,
          COALESCE(v.chunk_number, t.chunk_number) AS chunk_number,
          COALESCE(v.content, t.content) AS content,
          COALESCE(v.metadata, t.metadata) AS metadata,
          COALESCE(v.source_id, t.source_id) AS source_id,
          -- Use vector similarity if available, otherwise text similarity
          COALESCE(v.vector_sim, t.text_sim, 0)::DOUBLE PRECISION AS similarity,
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

-- =====================================================
-- FIX: hybrid_search_archon_crawled_pages (wrapper)
-- =====================================================

DROP FUNCTION IF EXISTS hybrid_search_archon_crawled_pages(vector, text, integer, jsonb, text);

CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages (
  query_embedding VECTOR,        -- REMOVED dimension constraint
  query_text TEXT,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
  id BIGINT,
  url TEXT,                      -- FIXED: was VARCHAR
  chunk_number INTEGER,
  content TEXT,
  metadata JSONB,
  source_id TEXT,                -- FIXED: was VARCHAR
  similarity DOUBLE PRECISION,   -- FIXED: was FLOAT
  match_type TEXT                -- ADDED: missing column
)
LANGUAGE plpgsql
AS $$
DECLARE
  detected_dimension INT;
BEGIN
  -- AUTO-DETECT dimension from query_embedding
  detected_dimension := vector_dims(query_embedding);

  -- Call multi-dimensional function with detected dimension
  RETURN QUERY SELECT * FROM hybrid_search_archon_crawled_pages_multi(
    query_embedding,
    detected_dimension,          -- AUTO-DETECTED!
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
-- Test Query (Optional)
-- =====================================================
-- Uncomment to test with actual data:
--
-- WITH test_emb AS (
--     SELECT embedding_768 FROM archon_crawled_pages
--     WHERE source_id = 'a0e86e00d806739a' AND embedding_768 IS NOT NULL
--     LIMIT 1
-- )
-- SELECT
--     id, url, similarity, match_type
-- FROM hybrid_search_archon_crawled_pages(
--     (SELECT embedding_768 FROM test_emb),
--     'Archon MCP server',
--     5
-- )
-- WHERE source_id = 'a0e86e00d806739a';

-- =====================================================
-- NOTES:
-- =====================================================
-- Changes Made:
-- 1. VARCHAR → TEXT for url and source_id columns
-- 2. FLOAT → DOUBLE PRECISION for similarity and rank_score
-- 3. Removed VECTOR(1536) constraint → generic VECTOR
-- 4. Auto-detect dimension using vector_dims() function
-- 5. ADDED match_type column with proper FULL OUTER JOIN logic
--
-- How match_type Works:
-- - 'hybrid': Found by both vector and text search (best matches)
-- - 'vector': Found only by semantic/vector search
-- - 'keyword': Found only by full-text/keyword search
--
-- Why FULL OUTER JOIN:
-- - Ensures we get results from BOTH search methods
-- - Tracks which method found each result
-- - Provides better coverage than pure vector search
-- =====================================================
