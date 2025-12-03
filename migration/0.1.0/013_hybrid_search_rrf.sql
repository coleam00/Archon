-- =====================================================
-- Hybrid Search with Reciprocal Rank Fusion (RRF)
-- =====================================================
-- This migration fixes the hybrid search scoring by implementing RRF,
-- which properly combines vector and text search results regardless
-- of their original score scales.
--
-- Problem: Previous implementation compared vector_sim (0-1 cosine)
-- directly with text_sim (ts_rank_cd, different scale), leading to
-- inconsistent ranking.
--
-- Solution: RRF uses ranks instead of scores:
--   RRF_score = 1/(vector_rank + k) + 1/(text_rank + k)
--   where k=60 (experimentally optimal, no tuning needed)
-- =====================================================

-- Multi-dimensional hybrid search with RRF for archon_crawled_pages
CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages_multi(
    query_embedding VECTOR,
    embedding_dimension INTEGER,
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL,
    embedding_model_filter TEXT DEFAULT NULL
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
    -- Fetch more candidates for better RRF fusion (will be reduced after scoring)
    candidate_count INT;
    sql_query TEXT;
    embedding_column TEXT;
    rrf_k INT := 60;  -- RRF constant (experimentally optimal)
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

    -- Fetch more candidates than requested for better fusion quality
    candidate_count := LEAST(match_count * 3, 100);

    -- Build dynamic query with RRF scoring
    sql_query := format('
    WITH vector_results AS (
        -- Vector similarity search with rank
        SELECT
            cp.id,
            cp.url,
            cp.chunk_number,
            cp.content,
            cp.metadata,
            cp.source_id,
            ROW_NUMBER() OVER (ORDER BY cp.%I <=> $1) AS vector_rank
        FROM archon_crawled_pages cp
        WHERE cp.metadata @> $4
            AND ($5 IS NULL OR cp.source_id = $5)
            AND ($7 IS NULL OR cp.embedding_model = $7)
            AND cp.%I IS NOT NULL
        ORDER BY cp.%I <=> $1
        LIMIT $2
    ),
    text_results AS (
        -- Full-text search with rank
        SELECT
            cp.id,
            cp.url,
            cp.chunk_number,
            cp.content,
            cp.metadata,
            cp.source_id,
            ROW_NUMBER() OVER (ORDER BY ts_rank_cd(cp.content_search_vector, plainto_tsquery(''english'', $6)) DESC) AS text_rank
        FROM archon_crawled_pages cp
        WHERE cp.metadata @> $4
            AND ($5 IS NULL OR cp.source_id = $5)
            AND ($7 IS NULL OR cp.embedding_model = $7)
            AND cp.content_search_vector @@ plainto_tsquery(''english'', $6)
        ORDER BY ts_rank_cd(cp.content_search_vector, plainto_tsquery(''english'', $6)) DESC
        LIMIT $2
    ),
    combined_results AS (
        -- Combine results using Reciprocal Rank Fusion
        SELECT
            COALESCE(v.id, t.id) AS id,
            COALESCE(v.url, t.url) AS url,
            COALESCE(v.chunk_number, t.chunk_number) AS chunk_number,
            COALESCE(v.content, t.content) AS content,
            COALESCE(v.metadata, t.metadata) AS metadata,
            COALESCE(v.source_id, t.source_id) AS source_id,
            -- RRF Score: 1/(rank + k) for each result set, sum them
            -- k=60 is experimentally optimal and works across domains
            (
                COALESCE(1.0 / (v.vector_rank + $8), 0) +
                COALESCE(1.0 / (t.text_rank + $8), 0)
            )::float8 AS similarity,
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
    LIMIT $3',
    embedding_column, embedding_column, embedding_column);

    -- Execute dynamic query
    RETURN QUERY EXECUTE sql_query USING query_embedding, candidate_count, match_count, filter, source_filter, query_text, embedding_model_filter, rrf_k;
END;
$$;

-- Multi-dimensional hybrid search with RRF for archon_code_examples
CREATE OR REPLACE FUNCTION hybrid_search_archon_code_examples_multi(
    query_embedding VECTOR,
    embedding_dimension INTEGER,
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL,
    embedding_model_filter TEXT DEFAULT NULL
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
    candidate_count INT;
    sql_query TEXT;
    embedding_column TEXT;
    rrf_k INT := 60;
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

    -- Fetch more candidates for better fusion
    candidate_count := LEAST(match_count * 3, 100);

    -- Build dynamic query with RRF scoring
    sql_query := format('
    WITH vector_results AS (
        SELECT
            ce.id,
            ce.url,
            ce.chunk_number,
            ce.content,
            ce.summary,
            ce.metadata,
            ce.source_id,
            ROW_NUMBER() OVER (ORDER BY ce.%I <=> $1) AS vector_rank
        FROM archon_code_examples ce
        WHERE ce.metadata @> $4
            AND ($5 IS NULL OR ce.source_id = $5)
            AND ($7 IS NULL OR ce.embedding_model = $7)
            AND ce.%I IS NOT NULL
        ORDER BY ce.%I <=> $1
        LIMIT $2
    ),
    text_results AS (
        SELECT
            ce.id,
            ce.url,
            ce.chunk_number,
            ce.content,
            ce.summary,
            ce.metadata,
            ce.source_id,
            ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ce.content_search_vector, plainto_tsquery(''english'', $6)) DESC) AS text_rank
        FROM archon_code_examples ce
        WHERE ce.metadata @> $4
            AND ($5 IS NULL OR ce.source_id = $5)
            AND ($7 IS NULL OR ce.embedding_model = $7)
            AND ce.content_search_vector @@ plainto_tsquery(''english'', $6)
        ORDER BY ts_rank_cd(ce.content_search_vector, plainto_tsquery(''english'', $6)) DESC
        LIMIT $2
    ),
    combined_results AS (
        SELECT
            COALESCE(v.id, t.id) AS id,
            COALESCE(v.url, t.url) AS url,
            COALESCE(v.chunk_number, t.chunk_number) AS chunk_number,
            COALESCE(v.content, t.content) AS content,
            COALESCE(v.summary, t.summary) AS summary,
            COALESCE(v.metadata, t.metadata) AS metadata,
            COALESCE(v.source_id, t.source_id) AS source_id,
            -- RRF Score
            (
                COALESCE(1.0 / (v.vector_rank + $8), 0) +
                COALESCE(1.0 / (t.text_rank + $8), 0)
            )::float8 AS similarity,
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
    LIMIT $3',
    embedding_column, embedding_column, embedding_column);

    RETURN QUERY EXECUTE sql_query USING query_embedding, candidate_count, match_count, filter, source_filter, query_text, embedding_model_filter, rrf_k;
END;
$$;

-- Update comments
COMMENT ON FUNCTION hybrid_search_archon_crawled_pages_multi IS 'Multi-dimensional hybrid search using Reciprocal Rank Fusion (RRF) for proper score combination';
COMMENT ON FUNCTION hybrid_search_archon_code_examples_multi IS 'Multi-dimensional hybrid search on code examples using RRF scoring';

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- Hybrid search now uses RRF for proper score fusion.
-- The similarity field now contains the RRF score (0.0-0.033 range).
-- Results are correctly ranked regardless of original score scales.
-- =====================================================
