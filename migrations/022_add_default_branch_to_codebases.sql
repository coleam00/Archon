-- Add default_branch column to remote_agent_codebases.
-- NULL means "not yet detected"; syncWorkspace falls back to auto-detection
-- (pre-existing behaviour). New clones set this via the branch-detect path in
-- clone.ts. Using no DEFAULT so existing rows stay NULL rather than being
-- silently set to 'main' (which could trigger an unwanted hard-reset for
-- managed clones on a non-main branch).
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch TEXT;
