-- Users table and auth-related columns for Keycloak/OIDC multi-user mode.
-- Only applied when running PostgreSQL (multi-user mode requires DATABASE_URL).

CREATE TABLE IF NOT EXISTS remote_agent_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_sub VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255),
  username VARCHAR(255),
  display_name VARCHAR(255),
  github_oauth_token TEXT,         -- AES-256-GCM encrypted, nullable
  github_username VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL;

ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES remote_agent_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_created_by ON remote_agent_conversations(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_by ON remote_agent_workflow_runs(created_by_user_id);
