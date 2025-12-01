-- ======================================================================
-- Migration 012: Add Embedding Model Filter to Search Functions
-- Allows filtering search results by embedding model to prevent
-- mixing incompatible vector spaces from different models
-- ======================================================================

BEGIN;

-- Update multi-dimensional search for crawled pages with embedding model filter
CREATE OR REPLACE FUNCTION match_archon_crawled_pages_multi (
  query_embedding VECTOR,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL,
  embedding_model_filter TEXT DEFAULT NULL
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
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  sql_query := format('
    SELECT id, url, chunk_number, content, metadata, source_id,
           1 - (%I <=> $1) AS similarity
    FROM archon_crawled_pages
    WHERE (%I IS NOT NULL)
      AND metadata @> $3
      AND ($4 IS NULL OR source_id = $4)
      AND ($5 IS NULL OR embedding_model = $5)
    ORDER BY %I <=> $1
    LIMIT $2',
    embedding_column, embedding_column, embedding_column);

  RETURN QUERY EXECUTE sql_query USING query_embedding, match_count, filter, source_filter, embedding_model_filter;
END;
$$;

-- Update multi-dimensional search for code examples with embedding model filter
CREATE OR REPLACE FUNCTION match_archon_code_examples_multi (
  query_embedding VECTOR,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL,
  embedding_model_filter TEXT DEFAULT NULL
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
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  sql_query := format('
    SELECT id, url, chunk_number, content, summary, metadata, source_id,
           1 - (%I <=> $1) AS similarity
    FROM archon_code_examples
    WHERE (%I IS NOT NULL)
      AND metadata @> $3
      AND ($4 IS NULL OR source_id = $4)
      AND ($5 IS NULL OR embedding_model = $5)
    ORDER BY %I <=> $1
    LIMIT $2',
    embedding_column, embedding_column, embedding_column);

  RETURN QUERY EXECUTE sql_query USING query_embedding, match_count, filter, source_filter, embedding_model_filter;
END;
$$;

-- Update hybrid search function for crawled pages
CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages_multi (
  query_embedding VECTOR,
  query_text TEXT,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL,
  embedding_model_filter TEXT DEFAULT NULL,
  full_text_weight FLOAT DEFAULT 1.0,
  semantic_weight FLOAT DEFAULT 1.0,
  rrf_k INT DEFAULT 60
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
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  sql_query := format('
    WITH semantic_search AS (
      SELECT id, RANK() OVER (ORDER BY %I <=> $1) AS rank
      FROM archon_crawled_pages
      WHERE %I IS NOT NULL
        AND metadata @> $4
        AND ($5 IS NULL OR source_id = $5)
        AND ($10 IS NULL OR embedding_model = $10)
      ORDER BY %I <=> $1
      LIMIT $9
    ),
    keyword_search AS (
      SELECT id, RANK() OVER (ORDER BY ts_rank(fts, websearch_to_tsquery($2)) DESC) AS rank
      FROM archon_crawled_pages
      WHERE fts @@ websearch_to_tsquery($2)
        AND metadata @> $4
        AND ($5 IS NULL OR source_id = $5)
        AND ($10 IS NULL OR embedding_model = $10)
      ORDER BY ts_rank(fts, websearch_to_tsquery($2)) DESC
      LIMIT $9
    )
    SELECT
      p.id, p.url, p.chunk_number, p.content, p.metadata, p.source_id,
      COALESCE(1.0 / ($6 + semantic_search.rank), 0.0) * $7 +
      COALESCE(1.0 / ($6 + keyword_search.rank), 0.0) * $8 AS similarity
    FROM archon_crawled_pages p
    LEFT JOIN semantic_search ON p.id = semantic_search.id
    LEFT JOIN keyword_search ON p.id = keyword_search.id
    WHERE semantic_search.id IS NOT NULL OR keyword_search.id IS NOT NULL
    ORDER BY similarity DESC
    LIMIT $3',
    embedding_column, embedding_column, embedding_column);

  RETURN QUERY EXECUTE sql_query USING
    query_embedding, query_text, match_count, filter, source_filter,
    rrf_k, semantic_weight, full_text_weight, match_count * 2, embedding_model_filter;
END;
$$;

-- Update hybrid search function for code examples
CREATE OR REPLACE FUNCTION hybrid_search_archon_code_examples_multi (
  query_embedding VECTOR,
  query_text TEXT,
  embedding_dimension INTEGER,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb,
  source_filter TEXT DEFAULT NULL,
  embedding_model_filter TEXT DEFAULT NULL,
  full_text_weight FLOAT DEFAULT 1.0,
  semantic_weight FLOAT DEFAULT 1.0,
  rrf_k INT DEFAULT 60
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
  CASE embedding_dimension
    WHEN 384 THEN embedding_column := 'embedding_384';
    WHEN 768 THEN embedding_column := 'embedding_768';
    WHEN 1024 THEN embedding_column := 'embedding_1024';
    WHEN 1536 THEN embedding_column := 'embedding_1536';
    WHEN 3072 THEN embedding_column := 'embedding_3072';
    ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %', embedding_dimension;
  END CASE;

  sql_query := format('
    WITH semantic_search AS (
      SELECT id, RANK() OVER (ORDER BY %I <=> $1) AS rank
      FROM archon_code_examples
      WHERE %I IS NOT NULL
        AND metadata @> $4
        AND ($5 IS NULL OR source_id = $5)
        AND ($10 IS NULL OR embedding_model = $10)
      ORDER BY %I <=> $1
      LIMIT $9
    ),
    keyword_search AS (
      SELECT id, RANK() OVER (ORDER BY ts_rank(fts, websearch_to_tsquery($2)) DESC) AS rank
      FROM archon_code_examples
      WHERE fts @@ websearch_to_tsquery($2)
        AND metadata @> $4
        AND ($5 IS NULL OR source_id = $5)
        AND ($10 IS NULL OR embedding_model = $10)
      ORDER BY ts_rank(fts, websearch_to_tsquery($2)) DESC
      LIMIT $9
    )
    SELECT
      p.id, p.url, p.chunk_number, p.content, p.summary, p.metadata, p.source_id,
      COALESCE(1.0 / ($6 + semantic_search.rank), 0.0) * $7 +
      COALESCE(1.0 / ($6 + keyword_search.rank), 0.0) * $8 AS similarity
    FROM archon_code_examples p
    LEFT JOIN semantic_search ON p.id = semantic_search.id
    LEFT JOIN keyword_search ON p.id = keyword_search.id
    WHERE semantic_search.id IS NOT NULL OR keyword_search.id IS NOT NULL
    ORDER BY similarity DESC
    LIMIT $3',
    embedding_column, embedding_column, embedding_column);

  RETURN QUERY EXECUTE sql_query USING
    query_embedding, query_text, match_count, filter, source_filter,
    rrf_k, semantic_weight, full_text_weight, match_count * 2, embedding_model_filter;
END;
$$;

COMMIT;

SELECT 'Embedding model filter added to search functions' AS status;
