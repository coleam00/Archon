-- Add per-codebase default branch (captured at clone/register time).
-- Used by the chat-tick sync to target a stable branch without auto-detection
-- on every message. Nullable: pre-existing rows fall back to runtime detection.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch TEXT;
