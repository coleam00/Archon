-- =====================================================
-- Complete Provider-Agnostic Schema
-- Self-contained migration that replaces all previous migrations
-- Supports all embedding providers with equal priority
-- =====================================================

-- ===============================
-- Phase 1: Foundation Tables
-- ===============================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Model Configuration Table (Enhanced)
CREATE TABLE IF NOT EXISTS public.model_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name TEXT NOT NULL UNIQUE,
    model_string TEXT NOT NULL,
    temperature FLOAT DEFAULT 0.7,
    max_tokens INTEGER,
    embedding_dimensions INTEGER,
    batch_size INTEGER DEFAULT 100,
    provider_name TEXT GENERATED ALWAYS AS (split_part(model_string, ':', 1)) STORED,
    model_id TEXT GENERATED ALWAYS AS (split_part(model_string, ':', 2)) STORED,
    supports_dimensions_param BOOLEAN DEFAULT true,
    optimal_batch_size INTEGER,
    cost_per_million_tokens DECIMAL(12, 8),
    max_input_tokens INTEGER,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by TEXT DEFAULT 'system',
    CONSTRAINT valid_model_string CHECK (model_string LIKE '%:%'),
    CONSTRAINT valid_embedding_dims CHECK (embedding_dimensions IN (384, 768, 1024, 1536, 3072) OR embedding_dimensions IS NULL)
);

-- API Keys Table
CREATE TABLE IF NOT EXISTS public.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL UNIQUE,
    encrypted_key TEXT NOT NULL,
    base_url TEXT,
    headers JSONB,
    is_active BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Service Registry Table
CREATE TABLE IF NOT EXISTS public.service_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    category TEXT NOT NULL CHECK (category IN ('agent', 'service')),
    service_type TEXT NOT NULL CHECK (service_type IN ('pydantic_ai', 'backend_service', 'embedding_service')),
    model_type TEXT NOT NULL CHECK (model_type IN ('llm', 'embedding')),
    location TEXT CHECK (location IN ('agents_server', 'main_server', 'external')),
    supports_temperature BOOLEAN DEFAULT true,
    supports_max_tokens BOOLEAN DEFAULT true,
    default_model TEXT,
    cost_profile TEXT CHECK (cost_profile IN ('low', 'medium', 'high')),
    expected_requests_per_day INTEGER DEFAULT 0,
    avg_tokens_per_request INTEGER DEFAULT 2000,
    is_active BOOLEAN DEFAULT true,
    is_deprecated BOOLEAN DEFAULT false,
    deprecation_reason TEXT,
    replacement_service TEXT,
    owner_team TEXT,
    contact_email TEXT,
    documentation_url TEXT,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_used TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT valid_replacement CHECK ((is_deprecated = false) OR (is_deprecated = true AND replacement_service IS NOT NULL))
);

-- Available Models Table (For OpenRouter and other model catalogs)
CREATE TABLE IF NOT EXISTS public.available_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_string TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    context_length INTEGER,
    input_cost DECIMAL(12, 8),
    output_cost DECIMAL(12, 8),
    supports_vision BOOLEAN DEFAULT false,
    supports_tools BOOLEAN DEFAULT false,
    supports_reasoning BOOLEAN DEFAULT false,
    is_embedding BOOLEAN DEFAULT false,
    is_free BOOLEAN DEFAULT false,
    cost_tier TEXT,
    is_active BOOLEAN DEFAULT true,
    source TEXT DEFAULT 'openrouter',
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_model UNIQUE(provider, model_id),
    CONSTRAINT valid_model_string_models CHECK (model_string = provider || ':' || model_id),
    CONSTRAINT valid_cost_tier CHECK (cost_tier IN ('free', 'low', 'medium', 'high'))
);

-- Model Usage Tracking Table
CREATE TABLE IF NOT EXISTS public.model_usage (
    id UUID DEFAULT gen_random_uuid(),
    service_name TEXT NOT NULL,
    model_string TEXT NOT NULL,
    request_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    estimated_cost DECIMAL(10, 6) DEFAULT 0,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (service_name, model_string, period_start)
);

-- ===============================
-- Foundation Table Indexes
-- ===============================

-- Model config indexes
CREATE INDEX IF NOT EXISTS idx_model_config_service ON public.model_config(service_name);
CREATE INDEX IF NOT EXISTS idx_model_config_provider ON public.model_config(provider_name) WHERE provider_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_config_embedding ON public.model_config(embedding_dimensions) WHERE embedding_dimensions IS NOT NULL;

-- API keys indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON public.api_keys(provider) WHERE is_active = true;

-- Service registry indexes
CREATE INDEX IF NOT EXISTS idx_service_registry_active ON public.service_registry(is_active, service_type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_service_registry_category ON public.service_registry(category, is_active);
CREATE INDEX IF NOT EXISTS idx_service_registry_model_type ON public.service_registry(model_type, is_active);

-- Available models indexes
CREATE INDEX IF NOT EXISTS idx_available_models_provider ON public.available_models(provider) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_available_models_type ON public.available_models(is_embedding, is_active);

-- Model usage indexes
CREATE INDEX IF NOT EXISTS idx_model_usage_period ON public.model_usage(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_model_usage_service ON public.model_usage(service_name, period_start DESC);

-- ===============================
-- Foundation Table RLS
-- ===============================

-- Enable RLS on foundation tables
ALTER TABLE public.model_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.available_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_registry ENABLE ROW LEVEL SECURITY;

-- Create service role policies (drop existing first to avoid conflicts)
DROP POLICY IF EXISTS "Service role full access to model_config" ON public.model_config;
DROP POLICY IF EXISTS "Service role full access to api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "Service role full access to model_usage" ON public.model_usage;
DROP POLICY IF EXISTS "Service role full access to available_models" ON public.available_models;
DROP POLICY IF EXISTS "Service role full access to service_registry" ON public.service_registry;

CREATE POLICY "Service role full access to model_config" ON public.model_config FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to api_keys" ON public.api_keys FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to model_usage" ON public.model_usage FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to available_models" ON public.available_models FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to service_registry" ON public.service_registry FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ===============================
-- Phase 2: Complete Dimension Support
-- ===============================

-- Create embedding tables for ALL known dimensions (provider-agnostic)

-- 384 dimensions (Cohere light, Ollama all-minilm)
CREATE TABLE IF NOT EXISTS archon_crawled_pages_384 (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(384),
    embedding_model TEXT NOT NULL,  -- Track which model created this embedding
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number, embedding_model),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- 768 dimensions (Google, Ollama nomic-embed)  
CREATE TABLE IF NOT EXISTS archon_crawled_pages_768 (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(768),
    embedding_model TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number, embedding_model),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- 1024 dimensions (Cohere standard, Mistral, Ollama mxbai)
CREATE TABLE IF NOT EXISTS archon_crawled_pages_1024 (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(1024),
    embedding_model TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number, embedding_model),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- 1536 dimensions (OpenAI small/ada-002)
CREATE TABLE IF NOT EXISTS archon_crawled_pages_1536 (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(1536),
    embedding_model TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number, embedding_model),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- 3072 dimensions (OpenAI large)
CREATE TABLE IF NOT EXISTS archon_crawled_pages_3072 (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(3072),
    embedding_model TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(url, chunk_number, embedding_model),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id)
);

-- ===============================
-- Phase 3: Optimized Indexes
-- ===============================

-- Create vector similarity indexes where supported (<=2000 dimensions)
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_384_embedding ON archon_crawled_pages_384 USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_768_embedding ON archon_crawled_pages_768 USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1024_embedding ON archon_crawled_pages_1024 USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1536_embedding ON archon_crawled_pages_1536 USING ivfflat (embedding vector_cosine_ops);
-- 3072D table uses sequential scan (exceeds pgvector 2000 dimension limit)

-- Create standard indexes for all tables
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_384_url ON archon_crawled_pages_384(url);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_768_url ON archon_crawled_pages_768(url);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1024_url ON archon_crawled_pages_1024(url);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1536_url ON archon_crawled_pages_1536(url);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_3072_url ON archon_crawled_pages_3072(url);

-- Create metadata indexes for filtering
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_384_metadata ON archon_crawled_pages_384 USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_768_metadata ON archon_crawled_pages_768 USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1024_metadata ON archon_crawled_pages_1024 USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1536_metadata ON archon_crawled_pages_1536 USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_3072_metadata ON archon_crawled_pages_3072 USING gin(metadata);

-- Create embedding_model indexes for model-specific queries
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_384_model ON archon_crawled_pages_384(embedding_model);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_768_model ON archon_crawled_pages_768(embedding_model);  
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1024_model ON archon_crawled_pages_1024(embedding_model);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_1536_model ON archon_crawled_pages_1536(embedding_model);
CREATE INDEX IF NOT EXISTS idx_archon_crawled_pages_3072_model ON archon_crawled_pages_3072(embedding_model);

-- ===============================
-- Phase 4: Provider-Aware RLS
-- ===============================

-- Enable RLS for all dimension tables
ALTER TABLE archon_crawled_pages_384 ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawled_pages_768 ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawled_pages_1024 ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawled_pages_1536 ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_crawled_pages_3072 ENABLE ROW LEVEL SECURITY;

-- Create unified RLS policies for all tables
DROP POLICY IF EXISTS "Allow public read access to archon_crawled_pages_384" ON archon_crawled_pages_384;
DROP POLICY IF EXISTS "Allow public read access to archon_crawled_pages_768" ON archon_crawled_pages_768;
DROP POLICY IF EXISTS "Allow public read access to archon_crawled_pages_1024" ON archon_crawled_pages_1024;
DROP POLICY IF EXISTS "Allow public read access to archon_crawled_pages_1536" ON archon_crawled_pages_1536;
DROP POLICY IF EXISTS "Allow public read access to archon_crawled_pages_3072" ON archon_crawled_pages_3072;

CREATE POLICY "Allow public read access to archon_crawled_pages_384" ON archon_crawled_pages_384 FOR SELECT USING (true);
CREATE POLICY "Allow public read access to archon_crawled_pages_768" ON archon_crawled_pages_768 FOR SELECT USING (true);
CREATE POLICY "Allow public read access to archon_crawled_pages_1024" ON archon_crawled_pages_1024 FOR SELECT USING (true);
CREATE POLICY "Allow public read access to archon_crawled_pages_1536" ON archon_crawled_pages_1536 FOR SELECT USING (true);
CREATE POLICY "Allow public read access to archon_crawled_pages_3072" ON archon_crawled_pages_3072 FOR SELECT USING (true);

-- ===============================
-- Phase 5: Seed Provider Configurations  
-- ===============================

-- Update model_config with provider-specific optimizations
UPDATE public.model_config SET
    supports_dimensions_param = false,
    optimal_batch_size = 50,
    cost_per_million_tokens = 0.025,
    max_input_tokens = 2048
WHERE provider_name = 'google';

UPDATE public.model_config SET  
    supports_dimensions_param = true,
    optimal_batch_size = 100,
    cost_per_million_tokens = 0.02,
    max_input_tokens = 8191
WHERE provider_name = 'openai';

UPDATE public.model_config SET
    supports_dimensions_param = false,
    optimal_batch_size = 25,
    cost_per_million_tokens = 0.10,
    max_input_tokens = 512
WHERE provider_name = 'cohere';

UPDATE public.model_config SET
    supports_dimensions_param = true,  
    optimal_batch_size = 75,
    cost_per_million_tokens = 0.10,
    max_input_tokens = 8000
WHERE provider_name = 'mistral';

UPDATE public.model_config SET
    supports_dimensions_param = false,
    optimal_batch_size = 25,
    cost_per_million_tokens = 0.0,
    max_input_tokens = 8192  
WHERE provider_name = 'ollama';

-- ===============================
-- Phase 6: Provider-Agnostic Views
-- ===============================

-- Create unified view for all embeddings (provider-agnostic)
CREATE OR REPLACE VIEW archon_embeddings_unified 
WITH (security_invoker = true) AS
SELECT id, url, chunk_number, content, embedding, metadata, source_id, embedding_model, created_at, 384 as dimensions FROM archon_crawled_pages_384
UNION ALL
SELECT id, url, chunk_number, content, embedding, metadata, source_id, embedding_model, created_at, 768 as dimensions FROM archon_crawled_pages_768
UNION ALL  
SELECT id, url, chunk_number, content, embedding, metadata, source_id, embedding_model, created_at, 1024 as dimensions FROM archon_crawled_pages_1024
UNION ALL
SELECT id, url, chunk_number, content, embedding, metadata, source_id, embedding_model, created_at, 1536 as dimensions FROM archon_crawled_pages_1536
UNION ALL
SELECT id, url, chunk_number, content, embedding, metadata, source_id, embedding_model, created_at, 3072 as dimensions FROM archon_crawled_pages_3072;

-- ===============================
-- Phase 7: Utility Functions
-- ===============================

-- Function to get table name for any supported dimension
CREATE OR REPLACE FUNCTION get_embedding_table_for_dimensions(dims integer)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
    CASE dims
        WHEN 384 THEN RETURN 'archon_crawled_pages_384';
        WHEN 768 THEN RETURN 'archon_crawled_pages_768';
        WHEN 1024 THEN RETURN 'archon_crawled_pages_1024';
        WHEN 1536 THEN RETURN 'archon_crawled_pages_1536';
        WHEN 3072 THEN RETURN 'archon_crawled_pages_3072';
        ELSE RAISE EXCEPTION 'Unsupported embedding dimension: %. Supported: 384, 768, 1024, 1536, 3072', dims;
    END CASE;
END;
$$;

-- Function to get optimal batch size for a provider
CREATE OR REPLACE FUNCTION get_optimal_batch_size(provider_name text, default_size integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    batch_size integer;
BEGIN
    SELECT optimal_batch_size INTO batch_size
    FROM model_config 
    WHERE model_config.provider_name = get_optimal_batch_size.provider_name
    AND optimal_batch_size IS NOT NULL
    LIMIT 1;
    
    RETURN COALESCE(batch_size, default_size);
END;
$$;

-- Function to check if provider supports dimensions parameter
CREATE OR REPLACE FUNCTION provider_supports_dimensions(provider_name text)  
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    supports boolean;
BEGIN
    SELECT supports_dimensions_param INTO supports
    FROM model_config
    WHERE model_config.provider_name = provider_supports_dimensions.provider_name
    LIMIT 1;
    
    RETURN COALESCE(supports, true);  -- Default to true for unknown providers
END;
$$;

-- ===============================
-- Summary and Validation
-- ===============================

-- Display provider support summary
SELECT 'PROVIDER SUPPORT SUMMARY:' as info;
SELECT 
    provider_name,
    COUNT(*) as models_count,
    array_agg(DISTINCT embedding_dimensions) FILTER (WHERE embedding_dimensions IS NOT NULL) as supported_dimensions,
    MIN(cost_per_million_tokens) as min_cost,
    MAX(cost_per_million_tokens) as max_cost,
    BOOL_AND(supports_dimensions_param) as all_support_dimensions_param
FROM model_config 
WHERE provider_name IS NOT NULL
GROUP BY provider_name
ORDER BY provider_name;

-- Display available embedding dimensions
SELECT 'AVAILABLE EMBEDDING DIMENSIONS:' as info;
SELECT 
    CAST(SUBSTRING(table_name FROM 'archon_crawled_pages_([0-9]+)') AS INTEGER) as dimension,
    table_name
FROM information_schema.tables 
WHERE table_name LIKE 'archon_crawled_pages_%' 
AND table_name ~ '^archon_crawled_pages_[0-9]+$'
ORDER BY dimension;

-- ===============================
-- Phase 8: Essential Service Seeds
-- ===============================

-- Seed essential model configurations (provider-agnostic)
INSERT INTO public.model_config (
    service_name, model_string, temperature, max_tokens, embedding_dimensions, batch_size, 
    supports_dimensions_param, optimal_batch_size, cost_per_million_tokens, max_input_tokens,
    updated_at, updated_by
) VALUES
    -- Core embedding service (Google by default, easily switchable)
    ('embedding', 'google:text-embedding-004', 0.0, NULL, 768, 100, false, 50, 0.025, 2048, NOW(), 'seed'),
    
    -- Core LLM service (Google by default, easily switchable)
    ('llm_primary', 'google:gemini-2.5-flash', 0.7, NULL, NULL, NULL, true, NULL, 0.075, 1000000, NOW(), 'seed'),
    
    -- Essential agents (only ones that actually exist in codebase)
    ('document_agent', 'google:gemini-2.5-flash', 0.7, NULL, NULL, NULL, true, NULL, 0.075, 1000000, NOW(), 'seed'),
    ('rag_agent', 'google:gemini-2.5-flash', 0.7, NULL, NULL, NULL, true, NULL, 0.075, 1000000, NOW(), 'seed'),
    
    -- Backend services that actually exist
    ('code_analysis', 'google:gemini-2.5-flash', 0.2, NULL, NULL, NULL, true, NULL, 0.075, 1000000, NOW(), 'seed'),
    ('source_summary', 'google:gemini-2.5-flash', 0.5, NULL, NULL, NULL, true, NULL, 0.075, 1000000, NOW(), 'seed')
ON CONFLICT (service_name) DO UPDATE SET
    model_string = EXCLUDED.model_string,
    embedding_dimensions = EXCLUDED.embedding_dimensions,
    batch_size = EXCLUDED.batch_size,
    supports_dimensions_param = EXCLUDED.supports_dimensions_param,
    optimal_batch_size = EXCLUDED.optimal_batch_size,
    cost_per_million_tokens = EXCLUDED.cost_per_million_tokens,
    max_input_tokens = EXCLUDED.max_input_tokens,
    updated_at = EXCLUDED.updated_at,
    updated_by = EXCLUDED.updated_by;

-- Manually populate service registry (since auto-discovery trigger doesn't work with ON CONFLICT)
INSERT INTO public.service_registry (
    service_name, display_name, description, icon, category, service_type, model_type,
    location, supports_temperature, supports_max_tokens, default_model, cost_profile, owner_team,
    updated_at
) VALUES
    ('embedding', 'Embedding', 'Core embedding service using google:text-embedding-004', '🧩', 'service', 'embedding_service', 'embedding', 'main_server', false, false, 'google:text-embedding-004', 'low', 'system', NOW()),
    ('llm_primary', 'Llm Primary', 'Primary LLM service using google:gemini-2.5-flash', '🔧', 'service', 'backend_service', 'llm', 'main_server', true, true, 'google:gemini-2.5-flash', 'low', 'system', NOW()),
    ('document_agent', 'Document Agent', 'Document processing agent using google:gemini-2.5-flash', '🤖', 'agent', 'pydantic_ai', 'llm', 'agents_server', true, true, 'google:gemini-2.5-flash', 'low', 'system', NOW()),
    ('rag_agent', 'Rag Agent', 'RAG query agent using google:gemini-2.5-flash', '🤖', 'agent', 'pydantic_ai', 'llm', 'agents_server', true, true, 'google:gemini-2.5-flash', 'low', 'system', NOW()),
    ('code_analysis', 'Code Analysis', 'Code analysis service using google:gemini-2.5-flash', '🔧', 'service', 'backend_service', 'llm', 'main_server', true, true, 'google:gemini-2.5-flash', 'low', 'system', NOW()),
    ('source_summary', 'Source Summary', 'Source summarization service using google:gemini-2.5-flash', '🔧', 'service', 'backend_service', 'llm', 'main_server', true, true, 'google:gemini-2.5-flash', 'low', 'system', NOW())
ON CONFLICT (service_name) DO UPDATE SET
    default_model = EXCLUDED.default_model,
    updated_at = EXCLUDED.updated_at;

-- ===============================
-- Phase 9: Permission Management
-- ===============================

-- Revoke all other access
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;

-- ===============================
-- Final Status
-- ===============================

SELECT 'PROVIDER-AGNOSTIC SCHEMA COMPLETE!' as status;
SELECT 'Ready for multi-provider embedding support with dimensions: 384, 768, 1024, 1536, 3072' as capabilities;