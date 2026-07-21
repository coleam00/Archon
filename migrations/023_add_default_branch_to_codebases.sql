-- Add detected default branch for registered codebases.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch VARCHAR(255);
