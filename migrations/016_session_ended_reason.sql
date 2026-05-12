-- Migration: Add ended_reason to track why sessions were deactivated
-- Completes the audit trail started in migration 010 (transition_reason for creation)
-- Backward compatible: new column is nullable

ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;

COMMENT ON COLUMN remote_agent_sessions.ended_reason IS
  'Why this session was deactivated: reset-requested, cwd-changed, conversation-closed, etc.';
