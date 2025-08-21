-- Quick migration to create archon_ prefixed tables
-- Run this if you get "archon_settings does not exist" error

BEGIN;

-- Create archon_settings table if it doesn't exist
CREATE TABLE IF NOT EXISTS archon_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,
    encrypted_value TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    category VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_archon_settings_key ON archon_settings(key);
CREATE INDEX IF NOT EXISTS idx_archon_settings_category ON archon_settings(category);

-- Enable RLS
ALTER TABLE archon_settings ENABLE ROW LEVEL SECURITY;

-- Create basic RLS policies
CREATE POLICY "Allow service role full access" ON archon_settings
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read" ON archon_settings
    FOR SELECT USING (auth.role() = 'authenticated');

-- Insert default settings if they don't exist
INSERT INTO archon_settings (key, value, is_encrypted, category, description)
VALUES 
    ('USE_CONTEXTUAL_EMBEDDINGS', 'false', false, 'rag_strategy', 'Enable contextual embeddings'),
    ('USE_HYBRID_SEARCH', 'true', false, 'rag_strategy', 'Enable hybrid search'),
    ('USE_AGENTIC_RAG', 'true', false, 'rag_strategy', 'Enable agentic RAG'),
    ('USE_RERANKING', 'true', false, 'rag_strategy', 'Enable reranking'),
    ('MODEL_CHOICE', 'gpt-4.1-nano', false, 'rag_strategy', 'Default model choice'),
    ('LLM_PROVIDER', 'openai', false, 'rag_strategy', 'LLM provider')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verify the table was created
SELECT COUNT(*) as settings_count FROM archon_settings;