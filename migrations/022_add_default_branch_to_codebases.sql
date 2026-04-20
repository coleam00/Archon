-- Add default_branch to codebases so syncWorkspace resets to the correct branch.
-- DEFAULT 'main' preserves existing behaviour for rows created before this migration.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch VARCHAR(255) DEFAULT 'main';
