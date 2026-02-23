-- =====================================================
-- DEPRECATED: Use 005_pattern_tables_minimal.sql + 006_pattern_indexes_rls.sql instead.
-- This file has an inline ivfflat index that causes silent transaction rollback
-- in Supabase Cloud SQL Editor. See ISSUE-20260219-009.
-- =====================================================

-- =====================================================
-- Phase 3: Pattern Learning System
-- Migration 004: Pattern Tables and Functions
-- =====================================================
-- Date: 2026-02-14
-- Author: Gemini (Archon Agent)
-- Purpose: Add pattern recognition and storage
-- Project: Shared Memory System Implementation
-- =====================================================

-- =====================================================
-- SECTION 1: PATTERN TABLES
-- =====================================================

-- Patterns Table
-- Stores identified behavioral or technical patterns
CREATE TABLE IF NOT EXISTS archon_patterns (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    pattern_type VARCHAR(50) NOT NULL, -- 'success', 'failure', 'technical', 'process'
    domain VARCHAR(100) NOT NULL,      -- 'development', 'management', 'hvac', etc.
    description TEXT NOT NULL,
    context JSONB DEFAULT '{}',        -- Environmental context when pattern was seen
    action TEXT NOT NULL,              -- The action that constitutes the pattern
    outcome TEXT,                      -- Result of the action
    embedding VECTOR(1536),            -- For semantic search
    metadata JSONB DEFAULT '{}',       -- confidence_score, frequency, etc.
    created_by VARCHAR(50),            -- agent name or 'user'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pattern Observations Table
-- Tracks every time a pattern is seen or applied
CREATE TABLE IF NOT EXISTS archon_pattern_observations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    pattern_id UUID REFERENCES archon_patterns(id) ON DELETE CASCADE,
    session_id UUID REFERENCES archon_sessions(id) ON DELETE SET NULL,
    observed_at TIMESTAMPTZ DEFAULT NOW(),
    success_rating INT CHECK (success_rating >= 1 AND success_rating <= 5),
    feedback TEXT,
    metadata JSONB DEFAULT '{}'
);

-- =====================================================
-- SECTION 2: INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_patterns_type ON archon_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_patterns_domain ON archon_patterns(domain);
CREATE INDEX IF NOT EXISTS idx_patterns_embedding ON archon_patterns
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_pattern_obs_pattern ON archon_pattern_observations(pattern_id);
CREATE INDEX IF NOT EXISTS idx_pattern_obs_session ON archon_pattern_observations(session_id);

-- =====================================================
-- SECTION 3: FUNCTIONS
-- =====================================================

-- Function to search patterns by semantic similarity
CREATE OR REPLACE FUNCTION search_patterns_semantic(
    p_query_embedding VECTOR(1536),
    p_limit INT DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    id UUID,
    pattern_type VARCHAR,
    domain VARCHAR,
    description TEXT,
    action TEXT,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.pattern_type,
        p.domain,
        p.description,
        p.action,
        1 - (p.embedding <=> p_query_embedding) as similarity
    FROM archon_patterns p
    WHERE p.embedding IS NOT NULL
      AND (1 - (p.embedding <=> p_query_embedding)) > p_threshold
    ORDER BY p.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- SECTION 4: TRIGGERS
-- =====================================================

CREATE TRIGGER update_archon_patterns_updated_at
    BEFORE UPDATE ON archon_patterns
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SECTION 5: RLS
-- =====================================================

ALTER TABLE archon_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_pattern_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access on patterns" ON archon_patterns
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users on patterns" ON archon_patterns
    FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow authenticated users on observations" ON archon_pattern_observations
    FOR ALL TO authenticated USING (true);
