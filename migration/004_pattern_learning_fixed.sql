-- =====================================================
-- DEPRECATED: Use 005_pattern_tables_minimal.sql + 006_pattern_indexes_rls.sql instead.
-- This file has an inline ivfflat index that causes silent transaction rollback
-- in Supabase Cloud SQL Editor. See ISSUE-20260219-009.
-- =====================================================

-- =====================================================
-- Phase 3: Pattern Learning System
-- Migration 004 FIXED: Includes missing trigger function
-- =====================================================
-- Fix: update_updated_at_column() was missing, causing
-- the original migration to rollback entirely.
-- =====================================================

-- Step 1: Ensure trigger helper function exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- =====================================================
-- SECTION 1: PATTERN TABLES
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_patterns (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    pattern_type VARCHAR(50) NOT NULL,
    domain VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    context JSONB DEFAULT '{}',
    action TEXT NOT NULL,
    outcome TEXT,
    embedding VECTOR(1536),
    metadata JSONB DEFAULT '{}',
    created_by VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
-- SECTION 3: SEARCH FUNCTION
-- =====================================================

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
-- SECTION 4: TRIGGER
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
