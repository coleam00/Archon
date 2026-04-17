-- Add default_branch column to remote_agent_codebases.
-- Mirrors the SQLite schema which already has this column (DEFAULT 'main').
-- Existing rows get 'main' as the default; users on a different branch can
-- update the value directly or re-register the codebase.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch TEXT DEFAULT 'main';
