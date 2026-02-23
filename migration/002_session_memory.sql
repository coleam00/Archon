-- =====================================================
-- Phase 2: Session Memory & Semantic Search
-- Migration 002: Session Tables and Embeddings
-- =====================================================
-- Date: 2026-02-14
-- Author: Claude (Archon Agent)
-- Purpose: Add session tracking and semantic search capabilities
-- Project: Shared Memory System Implementation
-- =====================================================

-- =====================================================
-- SECTION 1: SESSION MANAGEMENT TABLES
-- =====================================================

-- Sessions Table
-- Tracks agent work sessions with AI-generated summaries
CREATE TABLE IF NOT EXISTS archon_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent VARCHAR(50) NOT NULL,
    project_id UUID REFERENCES archon_projects(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    summary TEXT,
    context JSONB DEFAULT '{}',
    embedding VECTOR(1024),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Session Events Table
-- Logs significant events within sessions
CREATE TABLE IF NOT EXISTS archon_session_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id UUID REFERENCES archon_sessions(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    embedding VECTOR(1024),
    metadata JSONB DEFAULT '{}'
);

-- =====================================================
-- SECTION 2: ADD EMBEDDINGS TO EXISTING TABLES
-- =====================================================

-- Add embeddings to tasks for semantic search
ALTER TABLE archon_tasks
ADD COLUMN IF NOT EXISTS embedding VECTOR(1024);

-- Add embeddings to projects for semantic search
ALTER TABLE archon_projects
ADD COLUMN IF NOT EXISTS embedding VECTOR(1024);

-- =====================================================
-- SECTION 3: INDEXES FOR PERFORMANCE
-- =====================================================

-- Session indexes
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON archon_sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON archon_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON archon_sessions(started_at DESC);

-- Session events indexes
CREATE INDEX IF NOT EXISTS idx_events_session ON archon_session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON archon_session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON archon_session_events(timestamp DESC);

-- Vector embedding indexes are created separately in fix_embedding_dimensions.sql
-- (ivfflat requires data to exist and can cause silent transaction rollback when run inline)

-- =====================================================
-- SECTION 4: TRIGGERS FOR AUTO-UPDATE
-- =====================================================

-- Update trigger for sessions (uses existing update_updated_at_column function)
DROP TRIGGER IF EXISTS update_archon_sessions_updated_at ON archon_sessions;
CREATE TRIGGER update_archon_sessions_updated_at
    BEFORE UPDATE ON archon_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SECTION 5: ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS on new tables
ALTER TABLE archon_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_session_events ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS "Allow service role full access on sessions" ON archon_sessions;
CREATE POLICY "Allow service role full access on sessions" ON archon_sessions
    FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Allow service role full access on events" ON archon_session_events;
CREATE POLICY "Allow service role full access on events" ON archon_session_events
    FOR ALL USING (auth.role() = 'service_role');

-- Authenticated users full access
DROP POLICY IF EXISTS "Allow authenticated users on sessions" ON archon_sessions;
CREATE POLICY "Allow authenticated users on sessions" ON archon_sessions
    FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated users on events" ON archon_session_events;
CREATE POLICY "Allow authenticated users on events" ON archon_session_events
    FOR ALL TO authenticated USING (true);

-- =====================================================
-- SECTION 6: HELPER FUNCTIONS
-- =====================================================

-- Function to get recent sessions for an agent
CREATE OR REPLACE FUNCTION get_recent_sessions(
    p_agent VARCHAR(50),
    p_days INT DEFAULT 7,
    p_limit INT DEFAULT 20
)
RETURNS TABLE (
    id UUID,
    agent VARCHAR(50),
    project_id UUID,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    summary TEXT,
    event_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        s.agent,
        s.project_id,
        s.started_at,
        s.ended_at,
        s.summary,
        COUNT(e.id) as event_count
    FROM archon_sessions s
    LEFT JOIN archon_session_events e ON s.id = e.session_id
    WHERE s.agent = p_agent
      AND s.started_at > NOW() - (p_days || ' days')::INTERVAL
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to search sessions by semantic similarity
CREATE OR REPLACE FUNCTION search_sessions_semantic(
    p_query_embedding VECTOR(1024),
    p_limit INT DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    id UUID,
    agent VARCHAR(50),
    summary TEXT,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        s.agent,
        s.summary,
        1 - (s.embedding <=> p_query_embedding) as similarity
    FROM archon_sessions s
    WHERE s.embedding IS NOT NULL
      AND (1 - (s.embedding <=> p_query_embedding)) > p_threshold
    ORDER BY s.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Function to get last session for an agent
CREATE OR REPLACE FUNCTION get_last_session(p_agent VARCHAR(50))
RETURNS TABLE (
    id UUID,
    agent VARCHAR(50),
    project_id UUID,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    summary TEXT,
    context JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        s.agent,
        s.project_id,
        s.started_at,
        s.ended_at,
        s.summary,
        s.context
    FROM archon_sessions s
    WHERE s.agent = p_agent
    ORDER BY s.started_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to count sessions by agent
CREATE OR REPLACE FUNCTION count_sessions_by_agent(
    p_agent VARCHAR(50),
    p_days INT DEFAULT 30
)
RETURNS BIGINT AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)
        FROM archon_sessions
        WHERE agent = p_agent
          AND started_at > NOW() - (p_days || ' days')::INTERVAL
    );
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- SECTION 7: VIEWS FOR COMMON QUERIES
-- =====================================================

-- View: Recent sessions with event counts
CREATE OR REPLACE VIEW v_recent_sessions AS
SELECT
    s.id,
    s.agent,
    s.project_id,
    p.title as project_title,
    s.started_at,
    s.ended_at,
    s.summary,
    EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) / 60 as duration_minutes,
    COUNT(e.id) as event_count,
    s.created_at,
    s.updated_at
FROM archon_sessions s
LEFT JOIN archon_projects p ON s.project_id = p.id
LEFT JOIN archon_session_events e ON s.id = e.session_id
WHERE s.started_at > NOW() - INTERVAL '30 days'
GROUP BY s.id, p.title
ORDER BY s.started_at DESC;

-- View: Active sessions (not yet ended)
CREATE OR REPLACE VIEW v_active_sessions AS
SELECT
    s.id,
    s.agent,
    s.project_id,
    p.title as project_title,
    s.started_at,
    EXTRACT(EPOCH FROM (NOW() - s.started_at)) / 60 as duration_minutes,
    COUNT(e.id) as event_count
FROM archon_sessions s
LEFT JOIN archon_projects p ON s.project_id = p.id
LEFT JOIN archon_session_events e ON s.id = e.session_id
WHERE s.ended_at IS NULL
GROUP BY s.id, p.title
ORDER BY s.started_at DESC;

-- =====================================================
-- SECTION 8: COMMENTS FOR DOCUMENTATION
-- =====================================================

COMMENT ON TABLE archon_sessions IS 'Tracks agent work sessions for short-term memory. Each session represents a continuous work period by an agent.';
COMMENT ON TABLE archon_session_events IS 'Logs significant events within agent sessions for detailed activity tracking and pattern recognition.';

COMMENT ON COLUMN archon_sessions.agent IS 'Agent identifier (claude, gemini, gpt, user) - who performed the work';
COMMENT ON COLUMN archon_sessions.project_id IS 'Optional link to project being worked on during this session';
COMMENT ON COLUMN archon_sessions.started_at IS 'When the session began (automatically set)';
COMMENT ON COLUMN archon_sessions.ended_at IS 'When the session ended (null for active sessions)';
COMMENT ON COLUMN archon_sessions.summary IS 'AI-generated summary of what was accomplished in this session';
COMMENT ON COLUMN archon_sessions.context IS 'Arbitrary JSON data for session-specific context';
COMMENT ON COLUMN archon_sessions.embedding IS 'Vector embedding of session summary for semantic search';
COMMENT ON COLUMN archon_sessions.metadata IS 'Additional metadata (key_events, decisions, outcomes, next_steps)';

COMMENT ON COLUMN archon_session_events.session_id IS 'Reference to parent session';
COMMENT ON COLUMN archon_session_events.event_type IS 'Event category: task_created, task_updated, task_completed, decision_made, error_encountered, pattern_identified, context_shared';
COMMENT ON COLUMN archon_session_events.event_data IS 'JSON data specific to this event type';
COMMENT ON COLUMN archon_session_events.timestamp IS 'When this event occurred';
COMMENT ON COLUMN archon_session_events.embedding IS 'Vector embedding of event data for semantic search';

COMMENT ON FUNCTION get_recent_sessions IS 'Get recent sessions for an agent with event counts';
COMMENT ON FUNCTION search_sessions_semantic IS 'Search sessions using semantic similarity (requires embedding vector)';
COMMENT ON FUNCTION get_last_session IS 'Get the most recent session for an agent';
COMMENT ON FUNCTION count_sessions_by_agent IS 'Count sessions for an agent in the last N days';

-- =====================================================
-- SECTION 9: SAMPLE DATA (FOR TESTING)
-- =====================================================

-- Uncomment to insert test data
/*
INSERT INTO archon_sessions (agent, summary, metadata)
VALUES (
    'claude',
    'Phase 2 database migration completed. Created session tracking tables and added embedding support.',
    jsonb_build_object(
        'key_events', ARRAY['migration_created', 'tables_created', 'indexes_added'],
        'decisions', ARRAY['use pgvector for embeddings', 'add helper functions'],
        'outcomes', ARRAY['database ready for session tracking'],
        'next_steps', ARRAY['implement SessionService', 'create API endpoints']
    )
)
RETURNING id;
*/

-- =====================================================
-- SECTION 10: MIGRATION TRACKING
-- =====================================================

-- Record this migration (if archon_migrations table exists)
INSERT INTO archon_migrations (version, name, description, executed_at)
VALUES (
    '002',
    'session_memory',
    'Add session tracking tables and embeddings for semantic search. Creates archon_sessions and archon_session_events tables, adds embedding columns to archon_tasks and archon_projects, creates indexes and helper functions.',
    NOW()
)
ON CONFLICT (version) DO UPDATE SET
    executed_at = NOW(),
    description = EXCLUDED.description;

-- =====================================================
-- Migration Complete ✅
-- =====================================================
-- Expected outcomes:
-- - 2 new tables (archon_sessions, archon_session_events)
-- - 2 new columns (embedding on tasks and projects)
-- - 8 indexes for performance
-- - 4 helper functions
-- - 2 views for common queries
-- - RLS policies for security
--
-- Next steps:
-- 1. Verify tables created: SELECT * FROM archon_sessions LIMIT 1;
-- 2. Test helper function: SELECT * FROM get_recent_sessions('claude', 7, 10);
-- 3. Proceed to Day 2: Implement SessionService
-- =====================================================
