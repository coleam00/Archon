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
('LLM_BASE_URL', NULL, false, 'rag_strategy', 'Custom base URL for LLM provider (mainly for Ollama, e.g., http://localhost:11434/v1)'),
('EMBEDDING_MODEL', 'text-embedding-3-small', false, 'rag_strategy', 'Embedding model for vector search and similarity matching (required for all embedding operations)')
ON CONFLICT (key) DO NOTHING;

-- Placeholder for sensitive credentials (to be added via Settings UI)
INSERT INTO archon_settings (key, encrypted_value, is_encrypted, category, description) VALUES
('GOOGLE_API_KEY', NULL, true, 'api_keys', 'Google API Key for Gemini models. Get from: https://aistudio.google.com/apikey')
ON CONFLICT (key) DO NOTHING;

-- Document Storage Performance Settings
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('DOCUMENT_STORAGE_BATCH_SIZE', '50', false, 'rag_strategy', 'Number of document chunks to process per batch (50-200)'),
('EMBEDDING_BATCH_SIZE', '200', false, 'rag_strategy', 'Number of embeddings to create per API call (100-500)'),
('DELETE_BATCH_SIZE', '100', false, 'rag_strategy', 'Number of URLs to delete in one database operation (50-200)'),
('ENABLE_PARALLEL_BATCHES', 'true', false, 'rag_strategy', 'Enable parallel processing of document batches'),
('CONTEXTUAL_EMBEDDING_BATCH_SIZE', '50', false, 'rag_strategy', 'Number of chunks to process in contextual embedding batch API calls (20-100)')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description;

-- Add a comment to document when this migration was added
COMMENT ON TABLE archon_settings IS 'Stores application configuration including API keys, RAG settings, and code extraction parameters';
