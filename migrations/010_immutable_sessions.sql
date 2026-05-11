-- Migration: Add parent linkage and transition tracking for immutable session audit trail
-- Backward compatible: new columns are nullable

-- Link sessions in a chain (child points to parent)
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES remote_agent_sessions(id);

-- Record why this session was created
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS transition_reason TEXT;

-- Index for walking session chains efficiently
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON remote_agent_sessions(parent_session_id);

-- Index for finding session history by conversation (most recent first)
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
  ON remote_agent_sessions(conversation_id, started_at DESC);

-- Comment for documentation
COMMENT ON COLUMN remote_agent_sessions.parent_session_id IS
  'Links to the previous session in this conversation (for audit trail)';
COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
