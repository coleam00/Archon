-- Add per-codebase consent bit for subprocess .env key leakage
-- DEFAULT FALSE = safe by default; user must explicitly opt in
ALTER TABLE remote_agent_codebases
  ADD COLUMN allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE;
