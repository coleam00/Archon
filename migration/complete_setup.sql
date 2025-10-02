-- =====================================================
-- Archon Complete Database Setup
-- =====================================================
-- This script combines all migrations into a single file
-- for easy one-time database initialization
--
-- Run this script in your Supabase SQL Editor to set up
-- the complete Archon database schema and initial data
-- =====================================================

-- =====================================================
-- SECTION 1: EXTENSIONS
-- =====================================================

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================
-- SECTION 2: CREDENTIALS AND SETTINGS
-- =====================================================

-- Credentials and Configuration Management Table
-- This table stores both encrypted sensitive data and plain configuration settings
CREATE TABLE IF NOT EXISTS archon_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,                    -- For plain text config values
    encrypted_value TEXT,          -- For encrypted sensitive data (bcrypt hashed)
    is_encrypted BOOLEAN DEFAULT FALSE,
    category VARCHAR(100),         -- Group related settings (e.g., 'rag_strategy', 'api_keys', 'server_config')
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_archon_settings_key ON archon_settings(key);
CREATE INDEX IF NOT EXISTS idx_archon_settings_category ON archon_settings(category);

-- Create trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_archon_settings_updated_at
    BEFORE UPDATE ON archon_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create RLS (Row Level Security) policies for settings
ALTER TABLE archon_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON archon_settings
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read and update" ON archon_settings
    FOR ALL TO authenticated
    USING (true);

-- =====================================================
-- SECTION 3: INITIAL SETTINGS DATA
-- =====================================================

-- Server Configuration
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('MCP_TRANSPORT', 'dual', false, 'server_config', 'MCP server transport mode - sse (web clients), stdio (IDE clients), or dual (both)'),
('HOST', 'localhost', false, 'server_config', 'Host to bind to if using sse as the transport (leave empty if using stdio)'),
('PORT', '8051', false, 'server_config', 'Port to listen on if using sse as the transport (leave empty if using stdio)'),
('MODEL_CHOICE', 'gpt-4.1-nano', false, 'rag_strategy', 'The LLM you want to use for summaries and contextual embeddings. Generally this is a very cheap and fast LLM like gpt-4.1-nano');

-- RAG Strategy Configuration (all default to true)
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('USE_CONTEXTUAL_EMBEDDINGS', 'false', false, 'rag_strategy', 'Enhances embeddings with contextual information for better retrieval'),
('CONTEXTUAL_EMBEDDINGS_MAX_WORKERS', '3', false, 'rag_strategy', 'Maximum parallel workers for contextual embedding generation (1-10)'),
('USE_HYBRID_SEARCH', 'true', false, 'rag_strategy', 'Combines vector similarity search with keyword search for better results'),
('USE_AGENTIC_RAG', 'true', false, 'rag_strategy', 'Enables code example extraction, storage, and specialized code search functionality'),
('USE_RERANKING', 'true', false, 'rag_strategy', 'Applies cross-encoder reranking to improve search result relevance');

-- Monitoring Configuration
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('LOGFIRE_ENABLED', 'true', false, 'monitoring', 'Enable or disable Pydantic Logfire logging and observability platform'),
('PROJECTS_ENABLED', 'true', false, 'features', 'Enable or disable Projects and Tasks functionality');

-- Placeholder for sensitive credentials (to be added via Settings UI)
INSERT INTO archon_settings (key, encrypted_value, is_encrypted, category, description) VALUES
('OPENAI_API_KEY', NULL, true, 'api_keys', 'OpenAI API Key for embedding model (text-embedding-3-small). Get from: https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key');

-- LLM Provider configuration settings
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('LLM_PROVIDER', 'openai', false, 'rag_strategy', 'LLM provider to use: openai, ollama, or google'),
('LLM_BASE_URL', NULL, false, 'rag_strategy', 'Custom base URL for LLM provider (mainly for Ollama, e.g., http://host.docker.internal:11434/v1)'),
('EMBEDDING_MODEL', 'text-embedding-3-small', false, 'rag_strategy', 'Embedding model for vector search and similarity matching (required for all embedding operations)')
ON CONFLICT (key) DO NOTHING;

-- Add provider API key placeholders
INSERT INTO archon_settings (key, encrypted_value, is_encrypted, category, description) VALUES
('GOOGLE_API_KEY', NULL, true, 'api_keys', 'Google API Key for Gemini models. Get from: https://aistudio.google.com/apikey')
ON CONFLICT (key) DO NOTHING;

-- Code Extraction Settings Migration
-- Adds configurable settings for the code extraction service

-- Insert Code Extraction Configuration Settings
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
-- Length Settings
('MIN_CODE_BLOCK_LENGTH', '250', false, 'code_extraction', 'Base minimum length for code blocks in characters'),
('MAX_CODE_BLOCK_LENGTH', '5000', false, 'code_extraction', 'Maximum length before stopping code block extension in characters'),
('CONTEXT_WINDOW_SIZE', '1000', false, 'code_extraction', 'Number of characters of context to preserve before and after code blocks'),

-- Detection Features
('ENABLE_COMPLETE_BLOCK_DETECTION', 'true', false, 'code_extraction', 'Extend code blocks to natural boundaries like closing braces'),
('ENABLE_LANGUAGE_SPECIFIC_PATTERNS', 'true', false, 'code_extraction', 'Use specialized patterns for different programming languages'),
('ENABLE_CONTEXTUAL_LENGTH', 'true', false, 'code_extraction', 'Adjust minimum length based on surrounding context (example, snippet, implementation)'),

-- Content Filtering
('ENABLE_PROSE_FILTERING', 'true', false, 'code_extraction', 'Filter out documentation text mistakenly wrapped in code blocks'),
('MAX_PROSE_RATIO', '0.15', false, 'code_extraction', 'Maximum allowed ratio of prose indicators (0-1) in code blocks'),
('MIN_CODE_INDICATORS', '3', false, 'code_extraction', 'Minimum number of code patterns required (brackets, operators, keywords)'),
('ENABLE_DIAGRAM_FILTERING', 'true', false, 'code_extraction', 'Exclude diagram languages like Mermaid, PlantUML from code extraction'),

-- Processing Settings
('CODE_EXTRACTION_MAX_WORKERS', '3', false, 'code_extraction', 'Number of parallel workers for generating code summaries'),
('ENABLE_CODE_SUMMARIES', 'true', false, 'code_extraction', 'Generate AI-powered summaries and names for extracted code examples')

-- Only insert if they don't already exist
ON CONFLICT (key) DO NOTHING;

-- Crawling Performance Settings (from add_performance_settings.sql)
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('CRAWL_BATCH_SIZE', '50', false, 'rag_strategy', 'Number of URLs to crawl in parallel per batch (10-100)'),
('CRAWL_MAX_CONCURRENT', '10', false, 'rag_strategy', 'Maximum concurrent browser sessions for crawling (1-20)'),
('CRAWL_WAIT_STRATEGY', 'domcontentloaded', false, 'rag_strategy', 'When to consider page loaded: domcontentloaded, networkidle, or load'),
('CRAWL_PAGE_TIMEOUT', '30000', false, 'rag_strategy', 'Maximum time to wait for page load in milliseconds'),
('CRAWL_DELAY_BEFORE_HTML', '0.5', false, 'rag_strategy', 'Time to wait for JavaScript rendering in seconds (0.1-5.0)')
ON CONFLICT (key) DO NOTHING;

-- Document Storage Performance Settings (from add_performance_settings.sql and optimize_batch_sizes.sql)
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('DOCUMENT_STORAGE_BATCH_SIZE', '100', false, 'rag_strategy', 'Number of document chunks to process per batch (50-200) - increased for better performance'),
('EMBEDDING_BATCH_SIZE', '200', false, 'rag_strategy', 'Number of embeddings to create per API call (100-500) - increased for better throughput'),
('DELETE_BATCH_SIZE', '100', false, 'rag_strategy', 'Number of URLs to delete in one database operation (50-200) - increased for better performance'),
('ENABLE_PARALLEL_BATCHES', 'true', false, 'rag_strategy', 'Enable parallel processing of document batches')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description;

-- Advanced Performance Settings (from add_performance_settings.sql and optimize_batch_sizes.sql)
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('MEMORY_THRESHOLD_PERCENT', '80', false, 'rag_strategy', 'Memory usage threshold for crawler dispatcher (50-90)'),
('DISPATCHER_CHECK_INTERVAL', '0.5', false, 'rag_strategy', 'How often to check memory usage in seconds (0.1-2.0)'),
('CODE_EXTRACTION_BATCH_SIZE', '40', false, 'rag_strategy', 'Number of code blocks to extract per batch (20-100) - increased for better performance'),
('CODE_SUMMARY_MAX_WORKERS', '3', false, 'rag_strategy', 'Maximum parallel workers for code summarization (1-10)'),
('CONTEXTUAL_EMBEDDING_BATCH_SIZE', '50', false, 'rag_strategy', 'Number of chunks to process in contextual embedding batch API calls (20-100)')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description;

-- Add a comment to document when this migration was added
COMMENT ON TABLE archon_settings IS 'Stores application configuration including API keys, RAG settings, and code extraction parameters';

-- =====================================================
-- SECTION 4: KNOWLEDGE BASE TABLES
-- =====================================================

-- Create the sources table
CREATE TABLE IF NOT EXISTS archon_sources (
    source_id TEXT PRIMARY KEY,
    source_url TEXT,
    source_display_name TEXT,
    summary TEXT,
    total_word_count INTEGER DEFAULT 0,
    title TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_archon_sources_title ON archon_sources(title);
CREATE INDEX IF NOT EXISTS idx_archon_sources_url ON archon_sources(source_url);
CREATE INDEX IF NOT EXISTS idx_archon_sources_display_name ON archon_sources(source_display_name);
CREATE INDEX IF NOT EXISTS idx_archon_sources_metadata ON archon_sources USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_sources_knowledge_type ON archon_sources((metadata->>'knowledge_type'));

-- Add comments to document the columns
COMMENT ON COLUMN archon_sources.source_id IS 'Unique hash identifier for the source (16-char SHA256 hash of URL)';
COMMENT ON COLUMN archon_sources.source_url IS 'The original URL that was crawled to create this source';
COMMENT ON COLUMN archon_sources.source_display_name IS 'Human-readable name for UI display (e.g., "GitHub - microsoft/typescript")';
COMMENT ON COLUMN archon_sources.title IS 'Descriptive title for the source (e.g., "Pydantic AI API Reference")';
COMMENT ON COLUMN archon_sources.metadata IS 'JSONB field storing knowledge_type, tags, and other metadata';

-- Create the documentation chunks table
CREATE TABLE IF NOT EXISTS archon_crawled_pages (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    -- Multi-dimensional embedding support for different models
    embedding_384 VECTOR(384),   -- Small embedding models
    embedding_768 VECTOR(768),   -- Google/Ollama models  
    embedding_1024 VECTOR(1024), -- Ollama large models
    embedding_1536 VECTOR(1536), -- OpenAI standard models
    embedding_3072 VECTOR(3072), -- OpenAI large models
    -- Model tracking columns
    llm_chat_model TEXT,                -- LLM model used for processing (e.g., 'gpt-4', 'llama3:8b')
    embedding_model TEXT,                -- Embedding model used (e.g., 'text-embedding-3-large', 'all-MiniLM-L6-v2')
    embedding_dimension INTEGER,         -- Dimension of the embedding used (384, 768, 1024, 1536, 3072)
    -- Hybrid search support
    content_search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,

    -- Add a unique constraint to prevent duplicate chunks for the same URL
    UNIQUE(url, chunk_number),

    -- Add foreign key constraint to sources table
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- Multi-dimensional indexes
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_384 ON archon_crawled_pages USING ivfflat (embedding_384 vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_768 ON archon_crawled_pages USING ivfflat (embedding_768 vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_1024 ON archon_crawled_pages USING ivfflat (embedding_1024 vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_embedding_1536 ON archon_crawled_pages USING ivfflat (embedding_1536 vector_cosine_ops) WITH (lists = 100);
-- Note: 3072-dimensional embeddings cannot have vector indexes due to PostgreSQL vector extension 2000 dimension limit
-- The embedding_3072 column exists but cannot be indexed with current pgvector version

-- Other indexes for archon_crawled_pages
CREATE INDEX idx_archon_crawled_pages_metadata ON archon_crawled_pages USING GIN (metadata);
CREATE INDEX idx_archon_crawled_pages_source_id ON archon_crawled_pages (source_id);
-- Hybrid search indexes
CREATE INDEX idx_archon_crawled_pages_content_search ON archon_crawled_pages USING GIN (content_search_vector);
CREATE INDEX idx_archon_crawled_pages_content_trgm ON archon_crawled_pages USING GIN (content gin_trgm_ops);
-- Multi-dimensional embedding indexes
CREATE INDEX idx_archon_crawled_pages_embedding_model ON archon_crawled_pages (embedding_model);
CREATE INDEX idx_archon_crawled_pages_embedding_dimension ON archon_crawled_pages (embedding_dimension);
CREATE INDEX idx_archon_crawled_pages_llm_chat_model ON archon_crawled_pages (llm_chat_model);

-- Create the code_examples table
CREATE TABLE IF NOT EXISTS archon_code_examples (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,  -- The code example content
    summary TEXT NOT NULL,  -- Summary of the code example
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    -- Multi-dimensional embedding support for different models
    embedding_384 VECTOR(384),   -- Small embedding models
    embedding_768 VECTOR(768),   -- Google/Ollama models  
    embedding_1024 VECTOR(1024), -- Ollama large models
    embedding_1536 VECTOR(1536), -- OpenAI standard models
    embedding_3072 VECTOR(3072), -- OpenAI large models
    -- Model tracking columns
    llm_chat_model TEXT,                -- LLM model used for processing (e.g., 'gpt-4', 'llama3:8b')
    embedding_model TEXT,                -- Embedding model used (e.g., 'text-embedding-3-large', 'all-MiniLM-L6-v2')
    embedding_dimension INTEGER,         -- Dimension of the embedding used (384, 768, 1024, 1536, 3072)
    -- Hybrid search support
    content_search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content || ' ' || COALESCE(summary, ''))) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,

    -- Add a unique constraint to prevent duplicate chunks for the same URL
    UNIQUE(url, chunk_number),

    -- Add foreign key constraint to sources table
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- Multi-dimensional indexes
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_384 ON archon_code_examples USING ivfflat (embedding_384 vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_768 ON archon_code_examples USING ivfflat (embedding_768 vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_1024 ON archon_code_examples USING ivfflat (embedding_1024 vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_archon_code_examples_embedding_1536 ON archon_code_examples USING ivfflat (embedding_1536 vector_cosine_ops) WITH (lists = 100);
-- Note: 3072-dimensional embeddings cannot have vector indexes due to PostgreSQL vector extension 2000 dimension limit
-- The embedding_3072 column exists but cannot be indexed with current pgvector version

-- Other indexes for archon_code_examples
CREATE INDEX idx_archon_code_examples_metadata ON archon_code_examples USING GIN (metadata);
CREATE INDEX idx_archon_code_examples_source_id ON archon_code_examples (source_id);
-- Hybrid search indexes
CREATE INDEX idx_archon_code_examples_content_search ON archon_code_examples USING GIN (content_search_vector);
CREATE INDEX idx_archon_code_examples_content_trgm ON archon_code_examples USING GIN (content gin_trgm_ops);
CREATE INDEX idx_archon_code_examples_summary_trgm ON archon_code_examples USING GIN (summary gin_trgm_ops);
-- Multi-dimensional embedding indexes
CREATE INDEX idx_archon_code_examples_embedding_model ON archon_code_examples (embedding_model);
CREATE INDEX idx_archon_code_examples_embedding_dimension ON archon_code_examples (embedding_dimension);
CREATE INDEX idx_archon_code_examples_llm_chat_model ON archon_code_examples (llm_chat_model);

-- =====================================================
-- SECTION 4.5: MULTI-DIMENSIONAL EMBEDDING HELPER FUNCTIONS
-- =====================================================

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

-- =====================================================
-- SECTION 5: SEARCH FUNCTIONS
-- =====================================================

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

-- Legacy compatibility function (defaults to 1536D)
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

-- Legacy compatibility function (defaults to 1536D)
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

-- =====================================================
-- SECTION 5B: HYBRID SEARCH FUNCTIONS WITH TS_VECTOR
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

-- Add comments to document the new functionality
COMMENT ON FUNCTION hybrid_search_archon_crawled_pages_multi IS 'Multi-dimensional hybrid search combining vector similarity and full-text search with configurable embedding dimensions';
COMMENT ON FUNCTION hybrid_search_archon_crawled_pages IS 'Legacy hybrid search function for backward compatibility (uses 1536D embeddings)';
COMMENT ON FUNCTION hybrid_search_archon_code_examples_multi IS 'Multi-dimensional hybrid search on code examples with configurable embedding dimensions';
COMMENT ON FUNCTION hybrid_search_archon_code_examples IS 'Legacy hybrid search function for code examples (uses 1536D embeddings)';

-- =====================================================
-- SECTION 6: RLS POLICIES FOR KNOWLEDGE BASE
-- =====================================================

-- Enable RLS on the knowledge base tables
ALTER TABLE archon_crawled_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_code_examples ENABLE ROW LEVEL SECURITY;

-- Create policies that allow anyone to read
CREATE POLICY "Allow public read access to archon_crawled_pages"
  ON archon_crawled_pages
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public read access to archon_sources"
  ON archon_sources
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public read access to archon_code_examples"
  ON archon_code_examples
  FOR SELECT
  TO public
  USING (true);

-- =====================================================
-- SECTION 7: PROJECTS AND TASKS MODULE
-- =====================================================

-- Task status enumeration
-- Create task_status enum if it doesn't exist
DO $$ BEGIN
    CREATE TYPE task_status AS ENUM ('todo','doing','review','done');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create task_priority enum if it doesn't exist
DO $$ BEGIN
    CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Assignee is now a text field to allow any agent name
-- No longer using enum to support flexible agent assignments

-- Projects table
CREATE TABLE IF NOT EXISTS archon_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  docs JSONB DEFAULT '[]'::jsonb,
  features JSONB DEFAULT '[]'::jsonb,
  data JSONB DEFAULT '[]'::jsonb,
  github_repo TEXT,
  pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks table
CREATE TABLE IF NOT EXISTS archon_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
  parent_task_id UUID REFERENCES archon_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status task_status DEFAULT 'todo',
  assignee TEXT DEFAULT 'User' CHECK (assignee IS NOT NULL AND assignee != ''),
  task_order INTEGER DEFAULT 0,
  priority task_priority DEFAULT 'medium' NOT NULL,
  feature TEXT,
  sources JSONB DEFAULT '[]'::jsonb,
  code_examples JSONB DEFAULT '[]'::jsonb,
  archived BOOLEAN DEFAULT false,
  archived_at TIMESTAMPTZ NULL,
  archived_by TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project Sources junction table for many-to-many relationship
CREATE TABLE IF NOT EXISTS archon_project_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL, -- References sources in the knowledge base
  linked_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT DEFAULT 'system',
  notes TEXT,
  -- Unique constraint to prevent duplicate links
  UNIQUE(project_id, source_id)
);

-- Document Versions table for version control of project JSONB fields only
CREATE TABLE IF NOT EXISTS archon_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES archon_tasks(id) ON DELETE CASCADE, -- DEPRECATED: No longer used, kept for historical data
  field_name TEXT NOT NULL, -- 'docs', 'features', 'data', 'prd' (task fields no longer versioned)
  version_number INTEGER NOT NULL,
  content JSONB NOT NULL, -- Full snapshot of the field content
  change_summary TEXT, -- Human-readable description of changes
  change_type TEXT DEFAULT 'update', -- 'create', 'update', 'delete', 'restore', 'backup'
  document_id TEXT, -- For docs array, store the specific document ID
  created_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Ensure we have either project_id OR task_id, not both
  CONSTRAINT chk_project_or_task CHECK (
    (project_id IS NOT NULL AND task_id IS NULL) OR
    (project_id IS NULL AND task_id IS NOT NULL)
  ),
  -- Unique constraint to prevent duplicate version numbers per field
  UNIQUE(project_id, task_id, field_name, version_number)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_archon_tasks_project_id ON archon_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_status ON archon_tasks(status);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_assignee ON archon_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_order ON archon_tasks(task_order);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_priority ON archon_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_archived ON archon_tasks(archived);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_archived_at ON archon_tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_archon_project_sources_project_id ON archon_project_sources(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_project_sources_source_id ON archon_project_sources(source_id);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_project_id ON archon_document_versions(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_task_id ON archon_document_versions(task_id);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_field_name ON archon_document_versions(field_name);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_version_number ON archon_document_versions(version_number);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_created_at ON archon_document_versions(created_at);

-- Apply triggers to tables
CREATE OR REPLACE TRIGGER update_archon_projects_updated_at
    BEFORE UPDATE ON archon_projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_archon_tasks_updated_at
    BEFORE UPDATE ON archon_tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Soft delete function for tasks
CREATE OR REPLACE FUNCTION archive_task(
    task_id_param UUID,
    archived_by_param TEXT DEFAULT 'system'
)
RETURNS BOOLEAN AS $$
DECLARE
    task_exists BOOLEAN;
BEGIN
    -- Check if task exists and is not already archived
    SELECT EXISTS(
        SELECT 1 FROM archon_tasks
        WHERE id = task_id_param AND archived = FALSE
    ) INTO task_exists;

    IF NOT task_exists THEN
        RETURN FALSE;
    END IF;

    -- Archive the task
    UPDATE archon_tasks
    SET
        archived = TRUE,
        archived_at = NOW(),
        archived_by = archived_by_param,
        updated_at = NOW()
    WHERE id = task_id_param;

    -- Also archive all subtasks
    UPDATE archon_tasks
    SET
        archived = TRUE,
        archived_at = NOW(),
        archived_by = archived_by_param,
        updated_at = NOW()
    WHERE parent_task_id = task_id_param AND archived = FALSE;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Add comments to document the soft delete fields
COMMENT ON COLUMN archon_tasks.assignee IS 'The agent or user assigned to this task. Can be any valid agent name or "User"';
COMMENT ON COLUMN archon_tasks.priority IS 'Task priority level independent of visual ordering - used for semantic importance (low, medium, high, critical)';
COMMENT ON COLUMN archon_tasks.archived IS 'Soft delete flag - TRUE if task is archived/deleted';
COMMENT ON COLUMN archon_tasks.archived_at IS 'Timestamp when task was archived';
COMMENT ON COLUMN archon_tasks.archived_by IS 'User/system that archived the task';

-- Add comments for versioning table
COMMENT ON TABLE archon_document_versions IS 'Version control for JSONB fields in projects only - task versioning has been removed to simplify MCP operations';
COMMENT ON COLUMN archon_document_versions.field_name IS 'Name of JSONB field being versioned (docs, features, data) - task fields and prd removed as unused';
COMMENT ON COLUMN archon_document_versions.content IS 'Full snapshot of field content at this version';
COMMENT ON COLUMN archon_document_versions.change_type IS 'Type of change: create, update, delete, restore, backup';
COMMENT ON COLUMN archon_document_versions.document_id IS 'For docs arrays, the specific document ID that was changed';
COMMENT ON COLUMN archon_document_versions.task_id IS 'DEPRECATED: No longer used for new versions, kept for historical task version data';

-- =====================================================
-- SECTION 7: MIGRATION TRACKING
-- =====================================================

-- Create archon_migrations table for tracking applied database migrations
CREATE TABLE IF NOT EXISTS archon_migrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  version VARCHAR(20) NOT NULL,
  migration_name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  checksum VARCHAR(32),
  UNIQUE(version, migration_name)
);

-- Add indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_archon_migrations_version ON archon_migrations(version);
CREATE INDEX IF NOT EXISTS idx_archon_migrations_applied_at ON archon_migrations(applied_at DESC);

-- Add comments describing table purpose
COMMENT ON TABLE archon_migrations IS 'Tracks database migrations that have been applied to maintain schema version consistency';
COMMENT ON COLUMN archon_migrations.version IS 'Archon version that introduced this migration';
COMMENT ON COLUMN archon_migrations.migration_name IS 'Filename of the migration SQL file';
COMMENT ON COLUMN archon_migrations.applied_at IS 'Timestamp when migration was applied';
COMMENT ON COLUMN archon_migrations.checksum IS 'Optional MD5 checksum of migration file content';

-- Record all migrations as applied since this is a complete setup
-- This ensures the migration system knows the database is fully up-to-date
INSERT INTO archon_migrations (version, migration_name)
VALUES
  ('0.1.0', '001_add_source_url_display_name'),
  ('0.1.0', '002_add_hybrid_search_tsvector'),
  ('0.1.0', '003_ollama_add_columns'),
  ('0.1.0', '004_ollama_migrate_data'),
  ('0.1.0', '005_ollama_create_functions'),
  ('0.1.0', '006_ollama_create_indexes_optional'),
  ('0.1.0', '007_add_priority_column_to_tasks'),
  ('0.1.0', '008_add_migration_tracking')
ON CONFLICT (version, migration_name) DO NOTHING;

-- Enable Row Level Security on migrations table
ALTER TABLE archon_migrations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (makes this idempotent)
DROP POLICY IF EXISTS "Allow service role full access to archon_migrations" ON archon_migrations;
DROP POLICY IF EXISTS "Allow authenticated users to read archon_migrations" ON archon_migrations;

-- Create RLS policies for migrations table
-- Service role has full access
CREATE POLICY "Allow service role full access to archon_migrations" ON archon_migrations
    FOR ALL USING (auth.role() = 'service_role');

-- Authenticated users can only read migrations (they cannot modify migration history)
CREATE POLICY "Allow authenticated users to read archon_migrations" ON archon_migrations
    FOR SELECT TO authenticated
    USING (true);

-- =====================================================
-- SECTION 8: PROMPTS TABLE
-- =====================================================

-- Prompts table for managing agent system prompts
CREATE TABLE IF NOT EXISTS archon_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_name TEXT UNIQUE NOT NULL,
  prompt TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_archon_prompts_name ON archon_prompts(prompt_name);

-- Add trigger to automatically update updated_at timestamp
CREATE OR REPLACE TRIGGER update_archon_prompts_updated_at
    BEFORE UPDATE ON archon_prompts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SECTION 9: RLS POLICIES FOR PROJECTS MODULE
-- =====================================================

-- Enable Row Level Security (RLS) for all tables
ALTER TABLE archon_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_project_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_prompts ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for service role (full access)
CREATE POLICY "Allow service role full access to archon_projects" ON archon_projects
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_tasks" ON archon_tasks
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_project_sources" ON archon_project_sources
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_document_versions" ON archon_document_versions
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_prompts" ON archon_prompts
    FOR ALL USING (auth.role() = 'service_role');

-- Create RLS policies for authenticated users
CREATE POLICY "Allow authenticated users to read and update archon_projects" ON archon_projects
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read and update archon_tasks" ON archon_tasks
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read and update archon_project_sources" ON archon_project_sources
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read archon_document_versions" ON archon_document_versions
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read archon_prompts" ON archon_prompts
    FOR SELECT TO authenticated
    USING (true);

-- =====================================================
-- SECTION 10: DEFAULT PROMPTS DATA
-- =====================================================

-- Seed with default prompts for each content type
INSERT INTO archon_prompts (prompt_name, prompt, description) VALUES
('document_builder', 'SYSTEM PROMPT – Document-Builder Agent

⸻

1. Mission

You are the Document-Builder Agent. Your sole purpose is to transform a user''s natural-language description of work (a project, feature, or refactor) into a structured JSON record stored in the docs table. Produce documentation that is concise yet thorough—clear enough for an engineer to act after a single read-through.

⸻

2. Workflow
    1.    Classify request → Decide which document type fits best:
    •    PRD – net-new product or major initiative.
    •    FEATURE_SPEC – incremental feature expressed in user-story form.
    •    REFACTOR_PLAN – internal code quality improvement.
    2.    Clarify (if needed) → If the description is ambiguous, ask exactly one clarifying question, then continue.
    3.    Generate JSON → Build an object that follows the schema below and insert (or return) it for the docs table.

⸻

3. docs JSON Schema

{
  "id": "uuid|string",                // generate using uuid
  "doc_type": "PRD | FEATURE_SPEC | REFACTOR_PLAN",
  "title": "string",                  // short, descriptive
  "author": "string",                 // requestor name
  "body": { /* see templates below */ },
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}

⸻

4. Section Templates

PRD → body must include
    •    Background_and_Context
    •    Problem_Statement
    •    Goals_and_Success_Metrics
    •    Non_Goals
    •    Assumptions
    •    Stakeholders
    •    User_Personas
    •    Functional_Requirements           // bullet list or user stories
    •    Technical_Requirements            // tech stack, APIs, data
    •    UX_UI_and_Style_Guidelines
    •    Architecture_Overview             // diagram link or text
    •    Milestones_and_Timeline
    •    Risks_and_Mitigations
    •    Open_Questions

FEATURE_SPEC → body must include
    •    Epic
    •    User_Stories                      // list of { id, as_a, i_want, so_that }
    •    Acceptance_Criteria               // Given / When / Then
    •    Edge_Cases
    •    Dependencies
    •    Technical_Notes
    •    Design_References
    •    Metrics
    •    Risks

REFACTOR_PLAN → body must include
    •    Current_State_Summary
    •    Refactor_Goals
    •    Design_Principles_and_Best_Practices
    •    Proposed_Approach                 // step-by-step plan
    •    Impacted_Areas
    •    Test_Strategy
    •    Roll_Back_and_Recovery
    •    Timeline
    •    Risks

⸻

5. Writing Guidelines
    •    Brevity with substance: no fluff, no filler, no passive voice.
    •    Markdown inside strings: use headings, lists, and code fences for clarity.
    •    Consistent conventions: ISO dates, 24-hour times, SI units.
    •    Insert "TBD" where information is genuinely unknown.
    •    Produce valid JSON only—no comments or trailing commas.

⸻

6. Example Output (truncated)

{
  "id": "01HQ2VPZ62KSF185Y54MQ93VD2",
  "doc_type": "PRD",
  "title": "Real-time Collaboration for Docs",
  "author": "Sean",
  "body": {
    "Background_and_Context": "Customers need to co-edit documents ...",
    "Problem_Statement": "Current single-editor flow slows teams ...",
    "Goals_and_Success_Metrics": "Reduce hand-off time by 50% ..."
    /* remaining sections */
  },
  "created_at": "2025-06-17T00:10:00-04:00",
  "updated_at": "2025-06-17T00:10:00-04:00"
}

⸻

Remember: Your output is the JSON itself—no explanatory prose before or after. Stay sharp, write once, write right.', 'System prompt for DocumentAgent to create structured documentation following the Document-Builder pattern'),

('feature_builder', 'SYSTEM PROMPT – Feature-Builder Agent

⸻

1. Mission

You are the Feature-Builder Agent. Your purpose is to transform user descriptions of features into structured feature plans stored in the features array. Create feature documentation that developers can implement directly.

⸻

2. Feature JSON Schema

{
  "id": "uuid|string",                    // generate using uuid
  "feature_type": "feature_plan",         // always "feature_plan"
  "name": "string",                       // short feature name
  "title": "string",                      // descriptive title
  "content": {
    "feature_overview": {
      "name": "string",
      "description": "string",
      "priority": "high|medium|low",
      "estimated_effort": "string"
    },
    "user_stories": ["string"],           // list of user stories
    "react_flow_diagram": {               // optional visual flow
      "nodes": [...],
      "edges": [...],
      "viewport": {...}
    },
    "acceptance_criteria": ["string"],    // testable criteria
    "technical_notes": {
      "frontend_components": ["string"],
      "backend_endpoints": ["string"],
      "database_changes": "string"
    }
  },
  "created_by": "string"                  // author
}

⸻

3. Writing Guidelines
    •    Focus on implementation clarity
    •    Include specific technical details
    •    Define clear acceptance criteria
    •    Consider edge cases
    •    Keep descriptions actionable

⸻

Remember: Create structured, implementable feature plans.', 'System prompt for creating feature plans in the features array'),

('data_builder', 'SYSTEM PROMPT – Data-Builder Agent

⸻

1. Mission

You are the Data-Builder Agent. Your purpose is to transform descriptions of data models into structured ERDs and schemas stored in the data array. Create clear data models that can guide database implementation.

⸻

2. Data JSON Schema

{
  "id": "uuid|string",                    // generate using uuid
  "data_type": "erd",                     // always "erd" for now
  "name": "string",                       // system name
  "title": "string",                      // descriptive title
  "content": {
    "entities": [...],                    // entity definitions
    "relationships": [...],               // entity relationships
    "sql_schema": "string",              // Generated SQL
    "mermaid_diagram": "string",         // Optional diagram
    "notes": {
      "indexes": ["string"],
      "constraints": ["string"],
      "diagram_tool": "string",
      "normalization_level": "string",
      "scalability_notes": "string"
    }
  },
  "created_by": "string"                  // author
}

⸻

3. Writing Guidelines
    •    Follow database normalization principles
    •    Include proper indexes and constraints
    •    Consider scalability from the start
    •    Provide clear relationship definitions
    •    Generate valid, executable SQL

⸻

Remember: Create production-ready data models.', 'System prompt for creating data models in the data array');

-- =====================================================
-- SETUP COMPLETE
-- =====================================================
-- Your Archon database is now fully configured!
--
-- Next steps:
-- 1. Add your OpenAI API key via the Settings UI
-- 2. Enable Projects feature if needed
-- 3. Start crawling websites or uploading documents
-- =====================================================
