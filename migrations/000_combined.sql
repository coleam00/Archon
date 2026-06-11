-- Remote Coding Agent - Combined Schema
-- Version: Combined (final state after migrations 001-020)
-- Description: Complete database schema (idempotent - safe to run multiple times)
--
-- 14 Tables (+ the remote_agent_auth_* Better Auth tables, listed inline below):
--   1. remote_agent_codebases
--   1b. remote_agent_codebase_env_vars
--   1c. remote_agent_users
--   1d. remote_agent_user_identities
--   2. remote_agent_conversations
--   3. remote_agent_sessions
--   4. remote_agent_isolation_environments
--   5. remote_agent_workflow_runs
--   6. remote_agent_workflow_events
--   6b. remote_agent_workflow_node_sessions
--   7. remote_agent_messages
--   8. remote_agent_user_github_tokens
--   9. remote_agent_user_provider_keys
--   10. remote_agent_user_ai_prefs
--
-- Dropped tables (via migrations):
--   - remote_agent_command_templates (017)
--
-- Dropped columns (via migrations):
--   - conversations.worktree_path (007)
--   - conversations.isolation_env_id_legacy (007)
--   - conversations.isolation_provider (007)

-- ============================================================================
-- Table 1: Codebases
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  repository_url VARCHAR(500),
  default_cwd VARCHAR(500) NOT NULL,
  default_branch VARCHAR(255),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE,
  commands JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_codebases IS
  'Repository metadata: name, URL, working directory, default branch, AI assistant type, and command paths (JSONB)';

-- ============================================================================
-- Table 1b: Codebase Env Vars
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(codebase_id, key)
);

CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id
  ON remote_agent_codebase_env_vars(codebase_id);

COMMENT ON TABLE remote_agent_codebase_env_vars IS
  'Per-project env vars merged into Options.env on Claude SDK calls. Managed via Web UI or config.';

-- ============================================================================
-- Table 1c: Users (Archon identity, platform-agnostic)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(255),
  email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE remote_agent_users IS
  'Archon-internal user identity. Created on first sight by any adapter; populated via per-platform user-info lookups.';

-- ============================================================================
-- Table 1d: User Identities (per-platform mapping → users.id)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  platform VARCHAR(32) NOT NULL,
  platform_user_id VARCHAR(255) NOT NULL,
  platform_display_name VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON remote_agent_user_identities(user_id);

COMMENT ON TABLE remote_agent_user_identities IS
  'Maps platform-native user IDs (Slack U-ids, Telegram chat ids, GitHub logins, Discord snowflakes) to Archon user UUIDs.';

-- ============================================================================
-- Table 2: Conversations
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_type VARCHAR(20) NOT NULL,
  platform_conversation_id VARCHAR(255) NOT NULL,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  cwd VARCHAR(500),
  ai_assistant_type VARCHAR(20) DEFAULT 'claude',
  isolation_env_id UUID,  -- FK added after isolation_environments table exists
  title VARCHAR(255),
  deleted_at TIMESTAMP WITH TIME ZONE,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(platform_type, platform_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_conversations_codebase
  ON remote_agent_conversations(codebase_id);
CREATE INDEX IF NOT EXISTS idx_conversations_hidden
  ON remote_agent_conversations(hidden);
CREATE INDEX IF NOT EXISTS idx_conversations_codebase
  ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;

COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';

-- ============================================================================
-- Table 3: Sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  ai_assistant_type VARCHAR(20) NOT NULL,
  assistant_session_id VARCHAR(255),
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'::jsonb,
  parent_session_id UUID REFERENCES remote_agent_sessions(id),
  transition_reason TEXT,
  ended_reason TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_conversation
  ON remote_agent_sessions(conversation_id, active);
CREATE INDEX IF NOT EXISTS idx_remote_agent_sessions_codebase
  ON remote_agent_sessions(codebase_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON remote_agent_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
  ON remote_agent_sessions(conversation_id, started_at DESC);

COMMENT ON COLUMN remote_agent_sessions.parent_session_id IS
  'Links to the previous session in this conversation (for audit trail)';
COMMENT ON COLUMN remote_agent_sessions.transition_reason IS
  'Why this session was created: plan-to-execute, isolation-changed, reset-requested, etc.';
COMMENT ON COLUMN remote_agent_sessions.ended_reason IS
  'Why this session was deactivated: reset-requested, cwd-changed, conversation-closed, etc.';

-- ============================================================================
-- Table 4: Isolation Environments
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,

  -- Workflow identification (what work this is for)
  workflow_type         TEXT NOT NULL,        -- 'issue', 'pr', 'review', 'thread', 'task'
  workflow_id           TEXT NOT NULL,        -- '42', 'pr-99', 'thread-abc123'

  -- Implementation details
  provider              TEXT NOT NULL DEFAULT 'worktree',
  working_path          TEXT NOT NULL,        -- Actual filesystem path
  branch_name           TEXT NOT NULL,        -- Git branch name

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'active',  -- 'active', 'destroyed'
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_platform   TEXT,                 -- 'github', 'slack', etc.

  -- Cross-reference metadata (for linking)
  metadata              JSONB DEFAULT '{}'
);

-- Partial unique index: only active environments need uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_isolation_env_codebase
  ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX IF NOT EXISTS idx_isolation_env_status
  ON remote_agent_isolation_environments(status);
CREATE INDEX IF NOT EXISTS idx_isolation_env_workflow
  ON remote_agent_isolation_environments(workflow_type, workflow_id);

-- Add FK from conversations to isolation_environments (deferred to avoid circular dependency)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id
  ON remote_agent_conversations(isolation_env_id);

COMMENT ON TABLE remote_agent_isolation_environments IS
  'Work-centric isolated environments with independent lifecycle';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_type IS
  'Type of work: issue, pr, review, thread, task';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_id IS
  'Identifier for the work (issue number, PR number, thread hash, etc.)';

-- ============================================================================
-- Table 5: Workflow Runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  current_step_index INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  user_message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  parent_conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  working_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
  ON remote_agent_workflow_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON remote_agent_workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv
  ON remote_agent_workflow_runs(parent_conversation_id);

-- Partial index for efficient staleness queries on running workflows
CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
  ON remote_agent_workflow_runs(last_activity_at)
  WHERE status = 'running';

COMMENT ON TABLE remote_agent_workflow_runs IS
  'Tracks workflow execution state for resumption and observability';

-- ============================================================================
-- Table 6: Workflow Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  step_index INTEGER,
  step_name VARCHAR(255),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id
  ON remote_agent_workflow_events(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type
  ON remote_agent_workflow_events(event_type);
-- Global created_at index for the dashboard event poller's cross-run tail
-- (WHERE created_at >= $1 ORDER BY created_at ASC).
CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at
  ON remote_agent_workflow_events(created_at);

COMMENT ON TABLE remote_agent_workflow_events IS
  'Lean UI-relevant workflow events for observability (step transitions, artifacts, errors)';

-- ============================================================================
-- Workflow node sessions (persist_session opt-in across re-runs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_node_sessions (
  workflow_name VARCHAR(255) NOT NULL,
  node_id VARCHAR(255) NOT NULL,
  scope_key TEXT NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id TEXT NOT NULL,
  last_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (workflow_name, node_id, scope_key, provider)
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_scope
  ON remote_agent_workflow_node_sessions(scope_key);
CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_workflow
  ON remote_agent_workflow_node_sessions(workflow_name);

COMMENT ON TABLE remote_agent_workflow_node_sessions IS
  'Per-node provider session IDs persisted across workflow re-runs. Keyed by (workflow, node, scope, provider). Scope is typically conversation UUID. No cascade on conversation delete (soft delete + never-reused UUID = harmless orphans); a future hard-delete path must delete by scope_key.';

-- ============================================================================
-- Table 7: Messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON remote_agent_messages(conversation_id, created_at ASC);

-- ============================================================================
-- Cleanup: Drop legacy objects from older schemas
-- ============================================================================

-- Drop command_templates table (replaced by file-based commands in .archon/commands)
DROP TABLE IF EXISTS remote_agent_command_templates;
DROP INDEX IF EXISTS idx_remote_agent_command_templates_name;

-- Drop legacy columns from conversations (if upgrading from older schema)
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS worktree_path;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_env_id_legacy;
ALTER TABLE remote_agent_conversations DROP COLUMN IF EXISTS isolation_provider;
DROP INDEX IF EXISTS idx_conversations_isolation;

-- Drop legacy constraint from isolation_environments (if upgrading from older schema)
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

-- ============================================================================
-- Idempotent ALTER statements for upgrading existing databases
-- (These are no-ops on fresh installs since columns exist in CREATE TABLE above)
-- ============================================================================

-- From migration 006: isolation_env_id + last_activity_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 009: last_activity_at on workflow_runs
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- From migration 010: parent_session_id + transition_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES remote_agent_sessions(id);
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS transition_reason TEXT;

-- From migration 013: title + deleted_at on conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS title VARCHAR(255);
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- From migration 015: parent_conversation_id + hidden
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_conversation_id UUID
    REFERENCES remote_agent_conversations(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;

-- From migration 016: ended_reason on sessions
ALTER TABLE remote_agent_sessions
  ADD COLUMN IF NOT EXISTS ended_reason TEXT;

-- From migration 021: allow_env_keys on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS allow_env_keys BOOLEAN NOT NULL DEFAULT FALSE;

-- From migration 023: detected default branch on codebases
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS default_branch VARCHAR(255);

-- User identity foreign keys (nullable on the four primary tables).
-- All FKs use ON DELETE SET NULL so future user deletion never cascades destructively.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_messages
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;
ALTER TABLE remote_agent_isolation_environments
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID
    REFERENCES remote_agent_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON remote_agent_conversations(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id
  ON remote_agent_workflow_runs(user_id) WHERE user_id IS NOT NULL;

-- From PR-C: per-user GitHub user-to-server tokens (device flow), encrypted at rest.
-- One row per Archon user; cascades on user deletion. github_user_id is the
-- numeric anchor for the commit no-reply email (survives username changes).
CREATE TABLE IF NOT EXISTS remote_agent_user_github_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  github_user_id BIGINT NOT NULL,
  github_login VARCHAR(255) NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  access_token_expires_at TIMESTAMP WITH TIME ZONE,
  refresh_token_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Phase 2: per-user AI-provider credentials (BYO API key + subscription login),
-- encrypted at rest with the existing token-crypto key. One row per
-- (user_id, provider); cascades on user deletion. Exactly one of
-- api_key_encrypted / oauth_creds_encrypted is populated per row; `kind`
-- records which. Gated on TOKEN_ENCRYPTION_KEY at the application layer.
CREATE TABLE IF NOT EXISTS remote_agent_user_provider_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  api_key_encrypted TEXT,
  oauth_creds_encrypted TEXT,
  label VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- #1955: credential rows are vendor-keyed (claude→anthropic, codex→openai,
-- copilot→github-copilot) so one credential can serve every agent that
-- consumes the vendor. Idempotent data fix: where both a legacy and a vendor
-- row exist for the same user, the vendor row wins (rare — requires having
-- connected both ids pre-rename); then legacy rows are renamed in place.
-- Tested on SQLite (adapters/sqlite.test.ts covers rename, conflict, and
-- idempotency); the Postgres DML below is the same statements but is NOT
-- covered by an automated test — verified manually on the multi-user smoke.
-- Survivable either way: reads normalize legacy ids (normalizeCredentialVendor).
DELETE FROM remote_agent_user_provider_keys
WHERE provider IN ('claude', 'codex', 'copilot')
  AND EXISTS (
    SELECT 1 FROM remote_agent_user_provider_keys v
    WHERE v.user_id = remote_agent_user_provider_keys.user_id
      AND v.provider = CASE remote_agent_user_provider_keys.provider
        WHEN 'claude' THEN 'anthropic'
        WHEN 'codex' THEN 'openai'
        WHEN 'copilot' THEN 'github-copilot'
      END
  );
UPDATE remote_agent_user_provider_keys SET provider = 'anthropic' WHERE provider = 'claude';
UPDATE remote_agent_user_provider_keys SET provider = 'openai' WHERE provider = 'codex';
UPDATE remote_agent_user_provider_keys SET provider = 'github-copilot' WHERE provider = 'copilot';

-- Phase 3: per-user AI preferences (model tiers, @custom aliases, default
-- assistant). NON-encrypted — model names are not secrets (mirrors
-- codebase_env_vars, not the provider-key store). One row per user; cascades
-- on user deletion. `tiers` / `aliases` are JSON-as-TEXT (parsed in the
-- store layer so SQLite and Postgres behave identically).
CREATE TABLE IF NOT EXISTS remote_agent_user_ai_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  tiers TEXT,
  aliases TEXT,
  default_provider VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================================================
-- Web auth (opt-in): role on the canonical user + Better Auth tables
-- ============================================================================
--
-- `role` is the durable identity seam: everyone defaults to 'admin' for now;
-- 'member' is reserved for future per-resource scoping. Visibility stays open.
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'admin';

-- Better Auth tables (PostgreSQL only). Generated by `@better-auth/cli generate`
-- against packages/server/src/auth/instance.ts (modelName-renamed to the
-- `remote_agent_auth_*` prefix), then made idempotent with IF NOT EXISTS so the
-- bundled-schema auto-apply on startup converges. Better Auth owns these tables
-- and the column shape (text ids, camelCase columns) — Archon never queries them
-- directly; a session is mapped to the canonical remote_agent_users row via
-- user_identities('web', <betterAuthUserId>). Always created on Postgres (the
-- IF NOT EXISTS apply runs on every boot); populated only when web auth is
-- enabled (BETTER_AUTH_SECRET + DATABASE_URL), harmless empty tables otherwise.
CREATE TABLE IF NOT EXISTS remote_agent_auth_user (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_session (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES remote_agent_auth_user ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_account (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES remote_agent_auth_user ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_agent_auth_verification (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);
