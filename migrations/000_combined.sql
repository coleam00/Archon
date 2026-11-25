-- Remote Coding Agent - Combined Schema
-- Description: Complete database schema (idempotent - safe to run multiple times)
--
-- Layout (load-bearing, not cosmetic — see the final section for why):
--   * CREATE TABLE and ALTER TABLE ... ADD COLUMN come first, in feature order.
--   * Everything that NAMES A COLUMN — every CREATE INDEX, every
--     COMMENT ON COLUMN — goes in the final "Indexes and column comments"
--     section, below every ADD COLUMN.
--
-- Table sections below define the schema; additive ALTER sections upgrade older installs.
-- See the final "Indexes and column comments" section after all column definitions.

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
  kind VARCHAR(10) NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo', 'folder')),
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

-- Add FK from conversations to isolation_environments (deferred to avoid circular dependency)
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS isolation_env_id UUID
    REFERENCES remote_agent_isolation_environments(id) ON DELETE SET NULL;

COMMENT ON TABLE remote_agent_isolation_environments IS
  'Work-centric isolated environments with independent lifecycle';

-- ============================================================================
-- Table 5: Workflow Runs
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
  origin JSONB,
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  current_step_index INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled, paused
  outcome VARCHAR(20) CHECK (outcome IN ('succeeded', 'failed')),
  user_message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  parent_conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
  parent_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  adopted_from_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  active_phase_started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  working_path TEXT,
  output_root TEXT,
  checkout_baseline JSONB
);

COMMENT ON TABLE remote_agent_workflow_runs IS
  'Tracks workflow execution state for resumption and observability';

-- ============================================================================
-- Table 6: Workflow Events
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  event_order BIGINT,
  event_type VARCHAR(50) NOT NULL,
  step_index INTEGER,
  step_name VARCHAR(255),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE remote_agent_workflow_events IS
  'Lean UI-relevant workflow events for observability (step transitions, artifacts, errors)';

-- ============================================================================
-- Workflow run node sessions (private same-run session lineage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS remote_agent_workflow_run_node_sessions (
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  node_id VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (workflow_run_id, node_id)
);

COMMENT ON TABLE remote_agent_workflow_run_node_sessions IS
  'Private provider session handles produced by top-level nodes within one workflow run. Cascades with the owning run and is never exposed through run or event APIs.';

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

COMMENT ON TABLE remote_agent_workflow_node_sessions IS
  'Per-node provider session IDs persisted across workflow re-runs. Keyed by (workflow, node, scope, provider). Scope is the launching conversation UUID for persist_session, or item:<item_id> for context: same. No cascade on conversation delete (soft delete + never-reused UUID = harmless orphans); a future hard-delete path must delete by scope_key.';

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

-- From migration 024: project kind discriminator ('repo' | 'folder').
-- Folder projects are non-git workspaces (multi-repo roots or plain ops folders)
-- that run in place with named artifact/log storage under _folder/<slug>/.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'repo';

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

-- Run-tree parent (#2121 Phase 2): a `workflow:` sub-run links back to the run
-- that spawned it. Self-referential FK, ON DELETE SET NULL so deleting a parent
-- orphans children rather than cascade-deleting their audit trail. First
-- self-referential FK on this table — declared identically on SQLite (sqlite.ts).
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS parent_run_id UUID
    REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL;

-- Durable output root (#2200): the resolved `~/.archon/workspaces/<project>/`
-- directory this run's artifacts, logs, and state live under, written once at
-- run start. Readers prefer it and only re-derive from codebase identity when
-- it is NULL (pre-existing rows), so historical artifacts stay addressable
-- across a codebase rename (#1192). Declared identically on SQLite (sqlite.ts).
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS output_root TEXT;

-- Run checkout baseline (#3305): the checkout observation taken once when the run
-- won its execution claim, before its first node. Write-once; NULL means not
-- recorded (runs from before the column, or runs that never started). Declared
-- identically on SQLite (sqlite.ts) as TEXT holding the same JSON.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS checkout_baseline JSONB;
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS active_phase_started_at TIMESTAMP WITH TIME ZONE;

-- Between-run continuation (#2747): the terminal run whose estate (worktree/
-- branch + artifacts-by-reference) this run explicitly adopted. Mirrors
-- `parent_run_id` exactly — nullable, self-referential, SET NULL — and like it
-- is written once at run creation, never on resume. Reverse lookup (`adopted_by`)
-- reads the same column; no second column. Declared identically on SQLite.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS adopted_from_run_id UUID
    REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL;

-- Authored workflow verdict (#2618), independent from lifecycle status. Nullable
-- means undeclared or not yet authored; no default/backfill so historical rows
-- remain unknown rather than being reinterpreted from current workflow YAML.
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS outcome VARCHAR(20)
    CHECK (outcome IN ('succeeded', 'failed'));

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

-- Vendor rows win conflicts with legacy rows, then remaining legacy rows are
-- renamed. sqlite-migrations.test.ts executes this portable DML against every
-- alias in the provider catalog to enforce conformance with the SQLite repair.
DELETE FROM remote_agent_user_provider_keys
WHERE provider IN ('claude', 'codex', 'copilot', 'azure-openai-responses')
  AND EXISTS (
    SELECT 1 FROM remote_agent_user_provider_keys v
    WHERE v.user_id = remote_agent_user_provider_keys.user_id
      AND v.provider = CASE remote_agent_user_provider_keys.provider
        WHEN 'claude' THEN 'anthropic'
        WHEN 'codex' THEN 'openai'
        WHEN 'copilot' THEN 'github-copilot'
        WHEN 'azure-openai-responses' THEN 'azure'
      END
  );
UPDATE remote_agent_user_provider_keys SET provider = 'anthropic' WHERE provider = 'claude';
UPDATE remote_agent_user_provider_keys SET provider = 'openai' WHERE provider = 'codex';
UPDATE remote_agent_user_provider_keys SET provider = 'github-copilot' WHERE provider = 'copilot';
UPDATE remote_agent_user_provider_keys SET provider = 'azure' WHERE provider = 'azure-openai-responses';

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
  default_model VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- #1998: per-user default CHAT model, written atomically with
-- default_provider (a model pin is only meaningful for the provider it was
-- set with). Idempotent upgrade for installs that created the table before
-- this column existed.
ALTER TABLE remote_agent_user_ai_prefs
  ADD COLUMN IF NOT EXISTS default_model VARCHAR(255);

-- ============================================================================
-- Web auth (opt-in): role on the canonical user + Better Auth tables
-- ============================================================================
--
-- Keep 'admin' for older writers and existing rows. New writers explicitly
-- insert 'member'; SQLite cannot change a column default without a table rebuild.
ALTER TABLE remote_agent_users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'admin';

-- Lifecycle ordering (#2359 follow-up): timestamps can tie, especially on
-- SQLite (one-second precision), so a database-assigned order breaks the tie and
-- preserves event chronology. `id` cannot serve this role — it is a random UUID,
-- not monotonic.
--
-- Deliberately a plain column plus a sequence DEFAULT, NOT `GENERATED ... AS
-- IDENTITY`. Adding an identity column REWRITES the whole table under ACCESS
-- EXCLUSIVE (verified on postgres:18: relfilenode changes), and this is the
-- largest table in the schema while the schema auto-applies on startup — that is
-- a boot-time stall proportional to event history. ADD COLUMN with no default is
-- metadata-only, and SET DEFAULT afterwards applies to future inserts only.
--
-- It also keeps both databases honest: existing rows stay NULL on Postgres AND
-- SQLite, so the COALESCE(event_order, 0) fallback in read queries behaves
-- identically. An identity column would have back-filled Postgres rows (1, 2,
-- 3...) while SQLite left them NULL.
ALTER TABLE remote_agent_workflow_events
  ADD COLUMN IF NOT EXISTS event_order BIGINT;
CREATE SEQUENCE IF NOT EXISTS remote_agent_workflow_events_event_order_seq
  OWNED BY remote_agent_workflow_events.event_order;
ALTER TABLE remote_agent_workflow_events
  ALTER COLUMN event_order SET DEFAULT nextval('remote_agent_workflow_events_event_order_seq');

-- Both dialects retain the committed head after event deletion. PostgreSQL
-- draws final positions from its sequence, beyond values reserved by defaults;
-- SQLite allocates from this row under its single writer.
CREATE TABLE IF NOT EXISTS remote_agent_workflow_event_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value BIGINT NOT NULL DEFAULT 0
);
INSERT INTO remote_agent_workflow_event_sequence (id, value)
  SELECT 1, COALESCE(MAX(event_order), 0) FROM remote_agent_workflow_events
  ON CONFLICT (id) DO UPDATE
    SET value = GREATEST(remote_agent_workflow_event_sequence.value, EXCLUDED.value);

-- Retain removed payloads independently of current-state recovery and run cleanup.
-- Derive the row shape from its owner; no foreign key may cascade into the feed.
CREATE TABLE IF NOT EXISTS remote_agent_workflow_event_archive AS
  SELECT * FROM remote_agent_workflow_events WHERE false;
CREATE OR REPLACE FUNCTION archon_archive_workflow_event() RETURNS trigger AS $$
BEGIN
  INSERT INTO remote_agent_workflow_event_archive SELECT (OLD).*;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS archon_workflow_event_archive ON remote_agent_workflow_events;
CREATE TRIGGER archon_workflow_event_archive
  BEFORE DELETE ON remote_agent_workflow_events
  FOR EACH ROW EXECUTE FUNCTION archon_archive_workflow_event();

-- Deferred on purpose: the global ordering lock is taken only after the writer
-- has acquired its other locks, avoiding deadlocks with other event writers.
-- Allocation and the high-water update commit atomically with the event rows.
CREATE OR REPLACE FUNCTION archon_assign_workflow_event_order() RETURNS trigger AS $$
DECLARE
  assigned_order BIGINT;
BEGIN
  -- 3334 is arbitrary; it only has to differ from the schema lock (1796).
  PERFORM pg_advisory_xact_lock(3334);
  UPDATE remote_agent_workflow_event_sequence
    SET value = nextval('remote_agent_workflow_events_event_order_seq')
    WHERE id = 1 RETURNING value INTO assigned_order;
  UPDATE remote_agent_workflow_events
     SET event_order = assigned_order
   WHERE id = NEW.id;
  IF NOT FOUND THEN
    UPDATE remote_agent_workflow_event_archive
       SET event_order = assigned_order
     WHERE event_order = NEW.event_order AND id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS archon_workflow_event_order ON remote_agent_workflow_events;
CREATE CONSTRAINT TRIGGER archon_workflow_event_order
  AFTER INSERT ON remote_agent_workflow_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION archon_assign_workflow_event_order();

-- ============================================================================
-- Schema vintage (#2316)
-- ============================================================================
--
-- Which Archon build created this database, and which last applied schema to it.
-- Diagnostic only — nothing gates, refuses, or warns on these values. Single row
-- (id = 1); the row's VALUES are written by the adapters from APP_VERSION
-- (packages/core/src/db/schema-version.ts) so the version string has exactly one
-- source of truth. created_app_version is NULL for databases that predate this
-- table and is never back-filled with a guess. schema_fingerprint is separate,
-- adapter-owned completion metadata, not diagnostic vintage.
CREATE TABLE IF NOT EXISTS remote_agent_schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  created_app_version VARCHAR(64),
  app_version VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  schema_fingerprint TEXT
);
ALTER TABLE remote_agent_schema_version ADD COLUMN IF NOT EXISTS schema_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS remote_agent_state_revisions (
  project_key TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  value TEXT,
  operation TEXT NOT NULL,
  writer_kind TEXT NOT NULL CHECK (writer_kind IN ('run', 'operator')),
  writer_run_id TEXT,
  writer_node_path TEXT,
  writer_identity TEXT,
  writer_via TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  lease_run_id TEXT,
  lease_node_path TEXT,
  lease_taken_at TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (project_key, name, revision)
);

CREATE TABLE IF NOT EXISTS remote_agent_start_receipts (
  id UUID PRIMARY KEY,
  source_instance_id TEXT NOT NULL,
  delivery_id TEXT,
  content_digest TEXT NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE,
  source_actor TEXT,
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('matched', 'unmatched', 'unsupported', 'malformed')),
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(source_instance_id, delivery_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_start_receipt_bindings (
  receipt_id UUID NOT NULL REFERENCES remote_agent_start_receipts(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL,
  binding_revision TEXT,
  host_id TEXT,
  intent TEXT,
  event_input_names TEXT,
  item_key TEXT,
  checkout_from TEXT,
  preparation_status VARCHAR(20) NOT NULL CHECK (preparation_status IN ('pending', 'preparing', 'failed', 'rejected', 'unmatched', 'complete')),
  preparation_owner TEXT,
  preparation_process TEXT,
  preparation_error TEXT,
  forge_refusal TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (receipt_id, binding_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_resource_slots (
  resource_key TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- The install hold (#5911): a row means no new run is admitted until an operator lifts it.
CREATE TABLE IF NOT EXISTS remote_agent_install_hold (
  id TEXT PRIMARY KEY,
  set_by TEXT NOT NULL,
  set_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remote_agent_resource_slot_holders (
  resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
  holder_kind VARCHAR(10) NOT NULL CHECK (holder_kind IN ('run', 'attempt')),
  holder_id TEXT NOT NULL,
  acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- The owner process of an 'attempt' holder; NULL for 'run' holders.
  owner_host TEXT,
  owner_pid INTEGER,
  owner_instance TEXT,
  PRIMARY KEY (resource_key, holder_kind, holder_id)
);

CREATE TABLE IF NOT EXISTS remote_agent_resource_start_requests (
  id UUID PRIMARY KEY,
  queue_position BIGSERIAL NOT NULL UNIQUE,
  resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
  host_id TEXT NOT NULL,
  overlap_policy VARCHAR(10) NOT NULL CHECK (overlap_policy IN ('skip', 'queue')),
  status VARCHAR(12) NOT NULL CHECK (status IN ('queued', 'admitted', 'skipped', 'withdrawn')),
  blocker_run_id UUID,
  blocker_kind VARCHAR(10) CHECK (blocker_kind IN ('run', 'request')),
  launch TEXT NOT NULL,
  receipt_id UUID,
  binding_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  admitted_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (receipt_id, binding_id) REFERENCES remote_agent_start_receipt_bindings(receipt_id, binding_id) ON DELETE SET NULL
);

-- Provider-attempt holders on the shared resource slot (#2816): owner process
-- columns, and the holder-kind CHECK widened from ('run'). Unreleased dev databases
-- created the narrow CHECK; re-adding the named constraint converges them. Every
-- existing row is a 'run' holder, so the new constraint always validates.
ALTER TABLE remote_agent_resource_slot_holders
  ADD COLUMN IF NOT EXISTS owner_host TEXT;
ALTER TABLE remote_agent_resource_slot_holders
  ADD COLUMN IF NOT EXISTS owner_pid INTEGER;
ALTER TABLE remote_agent_resource_slot_holders
  ADD COLUMN IF NOT EXISTS owner_instance TEXT;
ALTER TABLE remote_agent_resource_slot_holders
  DROP CONSTRAINT IF EXISTS remote_agent_resource_slot_holders_holder_kind_check;
ALTER TABLE remote_agent_resource_slot_holders
  ADD CONSTRAINT remote_agent_resource_slot_holders_holder_kind_check
    CHECK (holder_kind IN ('run', 'attempt'));

COMMENT ON TABLE remote_agent_schema_version IS
  'Diagnostic schema vintage: the Archon build that created this database and the one that last applied schema to it.';

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

-- Optional provenance leaves shipped conversation columns valid for older writers.
ALTER TABLE remote_agent_workflow_runs ADD COLUMN IF NOT EXISTS origin JSONB;

-- Names of a binding's event-derived inputs, kept beside the intent: older binaries
-- parse `intent` strictly and would refuse an extra key.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS event_input_names TEXT;
-- A run-ended start's checkout hand-off (branch, commit, source run), kept beside the
-- intent for the same reason.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS checkout_from TEXT;

-- The item a source plugin's binding mapped from its event; null means the receipt's
-- item_key, if any. One receipt can start several bindings, not all on an item.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS item_key TEXT;

-- A binding refused for its pack's forge needs: the typed reasons and remedies, beside
-- preparation_error, which keeps only the failed boundary.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS forge_refusal TEXT;

-- The process preparing a binding (host, pid and instance, JSON), written when it claims the
-- preparation. Only with it can a reader prove a preparer that died is gone; null (an older
-- binary's claim) leaves the preparer unknown.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS preparation_process TEXT;

-- Why a binding start was refused (JSON: a reason code, and a start limit's standing), written
-- by the write that refuses it, so a read names the reason without parsing preparation_error.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS refusal TEXT;

-- A binding's start limit (JSON) and the name of the limit it grants (#6109), beside the
-- intent for the same reason as event_input_names. On each start request, the limit it
-- counted under and the limit it granted, each JSON with the window it was counted in:
-- the count is derived from these rows, so no counter has to agree with them.
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS start_limit TEXT;
ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN IF NOT EXISTS grants_limit TEXT;
ALTER TABLE remote_agent_resource_start_requests ADD COLUMN IF NOT EXISTS start_limit TEXT;
ALTER TABLE remote_agent_resource_start_requests ADD COLUMN IF NOT EXISTS grants_limit TEXT;

-- The durable thing runs are about: a key within a project, and when it was first named.
-- No status, stage or config; where an item stands is derived from its runs. project_key
-- is the engine's project identity, the one remote_agent_state_revisions scopes by.
CREATE TABLE IF NOT EXISTS remote_agent_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(project_key, key)
);
-- A receipt records the key a start named, before any item exists. Preparation resolves
-- the project, writes the item and points the start request at it; the run takes the
-- request's item at admission.
ALTER TABLE remote_agent_start_receipts ADD COLUMN IF NOT EXISTS item_key TEXT;
ALTER TABLE remote_agent_resource_start_requests
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES remote_agent_items(id);
ALTER TABLE remote_agent_workflow_runs
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES remote_agent_items(id);

-- The outcome a run completed with (#5660), from its workflow's returns.outcome: an enum
-- value as it is, a boolean as 'succeeded' or 'failed'. Written only by the write that
-- completes the run, so it is never set on a run that has not ended. The older outcome
-- column keeps its constraint and meaning; it cannot hold an enum value.
ALTER TABLE remote_agent_workflow_runs ADD COLUMN IF NOT EXISTS completed_outcome TEXT;

-- Rulings on an item: decisions an operator recorded about it, with no question asked.
-- Append-only facts, like the item itself: a row is a ruling (text set) or the withdrawal
-- of one (withdraws set), never updated, and no column records where the item stands.
-- The engine stores the text and never reads it. id is TEXT so a lookup by a malformed
-- id finds nothing instead of failing a UUID cast; UNIQUE(withdraws) refuses a second
-- withdrawal. from_run_id has no foreign key, so run cleanup keeps the ruling.
CREATE TABLE IF NOT EXISTS remote_agent_item_rulings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- Recording order. Timestamps tie within a millisecond and `id` is random, so rulings
  -- are ordered by this database-assigned sequence.
  seq BIGSERIAL NOT NULL UNIQUE,
  item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  withdraws TEXT UNIQUE REFERENCES remote_agent_item_rulings(id),
  text TEXT,
  by_declared TEXT,
  by_user_id TEXT,
  via TEXT NOT NULL,
  from_run_id TEXT,
  from_node_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CHECK ((withdraws IS NULL) = (text IS NOT NULL))
);

-- Ends of an item: an operator's statement that nothing more will happen on it. Append-only,
-- like rulings: no row is updated or deleted, and nothing writes one by itself. from_run_id
-- has no foreign key, so run cleanup keeps the end.
CREATE TABLE IF NOT EXISTS remote_agent_item_ends (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- Recording order; timestamps tie within a millisecond and `id` is random.
  seq BIGSERIAL NOT NULL UNIQUE,
  item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  reason TEXT NOT NULL,
  by_declared TEXT,
  by_user_id TEXT,
  via TEXT NOT NULL,
  from_run_id TEXT,
  from_node_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- The runs an end saw on its item and below its runs, copied in the transaction that records
-- it, each with its execution_claim, the run's metadata claim that every resume writes fresh.
-- The end holds while every run in the item's tree is one it saw, unresumed since, and none is live: a run created or resumed later, even by a
-- transaction that overlapped the end's, opens the item while that run exists. The rule reads
-- only the runs that exist, so deleting a run changes nothing stored: deleting runs the end
-- saw leaves it holding, and deleting the run that opened the item makes it hold again.
-- run_id has no foreign key, so run cleanup keeps the row.
CREATE TABLE IF NOT EXISTS remote_agent_item_end_runs (
  end_id TEXT NOT NULL REFERENCES remote_agent_item_ends(id),
  run_id TEXT NOT NULL,
  execution_claim TEXT,
  PRIMARY KEY (end_id, run_id)
);

-- The merge of an item's change, as the forge reported it to the caller that recorded it.
-- An append-only fact beside the item, like a ruling: the primary key on item_id makes it
-- recorded once, so a second report keeps the first. change is the forge's identity of
-- the merged change (a pull request URL), stored and never parsed. from_run_id has no
-- foreign key, so run cleanup keeps the fact.
CREATE TABLE IF NOT EXISTS remote_agent_item_merges (
  item_id UUID PRIMARY KEY REFERENCES remote_agent_items(id),
  change TEXT NOT NULL,
  merge_commit TEXT,
  merged_at TIMESTAMP WITH TIME ZONE NOT NULL,
  via TEXT NOT NULL,
  from_run_id TEXT,
  from_node_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- The branch an item's change lands on (`archon workflow landing`): a fresh run on the item,
-- or on an item `part_of` it, is cut from it and proposes against it. One row per item;
-- recording again replaces the row, and a run already started keeps the base it recorded.
-- from_run_id has no foreign key, so run cleanup keeps the fact.
CREATE TABLE IF NOT EXISTS remote_agent_item_landings (
  item_id UUID PRIMARY KEY REFERENCES remote_agent_items(id),
  branch TEXT NOT NULL,
  from_run_id TEXT,
  from_node_path TEXT,
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- One row per item tracker destination ('tracker:<project>'). The row exists once the
-- destination's activation baseline is committed, so a later activation does not baseline
-- again. The pass_owner_* columns name the process running the destination's pass, NULL
-- when none: one pass writes at a time across processes. pass_requested is 1 when a
-- process found the pass held and asked the holder for one more. What the tracker showed
-- stays in its attention_notice_sent ledger, not here.
CREATE TABLE IF NOT EXISTS remote_agent_item_tracker_destinations (
  destination TEXT PRIMARY KEY,
  activated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  pass_owner_host TEXT,
  pass_owner_pid INTEGER,
  pass_owner_instance TEXT,
  pass_started_at TIMESTAMP WITH TIME ZONE,
  pass_requested INTEGER NOT NULL DEFAULT 0
);

-- Links between items: accepted, directed relations, read from from_item_id to to_item_id.
-- One row per link. The link and who recorded it are written at insert and never change;
-- ending a link writes the ended_* columns once, so the original fact and who ended it and
-- when stay readable. Rows are never deleted. While active, the same (from, to, kind) is
-- stored once (idx_item_links_active). The schema lets a link join items of two projects.
-- The engine stores and reports links; only an active part_of carries meaning, the landing
-- branch of the item it points at (remote_agent_item_landings). id is TEXT, as for
-- rulings; from_run_id and ended_from_run_id have no foreign key.
CREATE TABLE IF NOT EXISTS remote_agent_item_links (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- Recording order; timestamps tie within a millisecond and `id` is random.
  seq BIGSERIAL NOT NULL UNIQUE,
  from_item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  to_item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  kind TEXT NOT NULL,
  by_declared TEXT,
  by_user_id TEXT,
  via TEXT NOT NULL,
  from_run_id TEXT,
  from_node_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE,
  ended_by_declared TEXT,
  ended_by_user_id TEXT,
  ended_via TEXT,
  ended_from_run_id TEXT,
  ended_from_node_path TEXT,
  CHECK (from_item_id <> to_item_id),
  CHECK ((ended_at IS NULL) = (ended_via IS NULL))
);

-- Asks: decisions a completed run left for an operator on its item (returns.asks). A row
-- opens in the write that completes the run and closes once: answered, withdrawn, or
-- replaced when a later completed run of the same workflow on the same item leaves its
-- own set. run_id is the run that left it and names the set; like from_run_id on a
-- ruling it has no foreign key, so run cleanup keeps the record. `ask` is the JSON the
-- run left, read tolerantly because more than one binary reads it.
-- closed_as is checked in code, not by a constraint: a later binary may close an ask in a
-- way this one does not know, and a reader treats that row as unreadable, not as open.
CREATE TABLE IF NOT EXISTS remote_agent_item_asks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  run_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  ask JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_as TEXT,
  answer JSONB,
  closed_at TIMESTAMP WITH TIME ZONE,
  closed_via TEXT,
  closed_by_declared TEXT,
  closed_by_user_id TEXT,
  closed_from_run_id TEXT,
  closed_from_node_path TEXT,
  replaced_by_run_id TEXT
);

-- Start-limit resets (#6109): a run completed on an item that has a start limit or a grant,
-- recorded under the admission lock in the write that completes it. A limit whose resetOn
-- names the workflow counts only the starts after it: requests with a queue_position above
-- after_position, and those in queued_ids (a JSON array), which were still waiting at the
-- reset and run after it. Event order, not time, so a reset in the same second as a start is
-- exact. Kept apart from the run row, which run cleanup deletes. Rows are only inserted.
CREATE TABLE IF NOT EXISTS remote_agent_start_limit_resets (
  id BIGSERIAL PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  workflow_name TEXT NOT NULL,
  reset_at TIMESTAMP WITH TIME ZONE NOT NULL,
  after_position BIGINT NOT NULL,
  queued_ids TEXT NOT NULL
);

-- Waits: what a completed run said its item now waits for outside Archon (returns.waits).
-- A row opens in the write that completes the run and closes once: met by an accepted
-- event (met_by_* name the receipt binding it started, written in the same transaction),
-- replaced by a later completed run of the same workflow on the same item, or withdrawn.
-- The waits one run left are a set and close together. Nothing fires at deadline_at: an
-- open wait past it is listed as overdue. run_id has no foreign key, like an ask's.
-- closed_as is checked in code, not by a constraint, as on an ask.
CREATE TABLE IF NOT EXISTS remote_agent_item_waits (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  item_id UUID NOT NULL REFERENCES remote_agent_items(id),
  run_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  event TEXT NOT NULL,
  about TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deadline_at TIMESTAMP WITH TIME ZONE NOT NULL,
  closed_as TEXT,
  closed_at TIMESTAMP WITH TIME ZONE,
  met_by_receipt_id TEXT,
  met_by_binding_id TEXT,
  replaced_by_run_id TEXT
);

-- The surface a state write outside a run came through (cli, api, ...). Nullable:
-- rows written before it existed came through the CLI.
ALTER TABLE remote_agent_state_revisions ADD COLUMN IF NOT EXISTS writer_via TEXT;
-- A run's lease on the document as of this revision; its liveness is read from the holder run.
ALTER TABLE remote_agent_state_revisions ADD COLUMN IF NOT EXISTS lease_run_id TEXT;
ALTER TABLE remote_agent_state_revisions ADD COLUMN IF NOT EXISTS lease_node_path TEXT;
ALTER TABLE remote_agent_state_revisions ADD COLUMN IF NOT EXISTS lease_taken_at TIMESTAMP WITH TIME ZONE;

-- The model a persisted node session ran on (#5711), or NULL when the node resolved
-- none. A `context: same` node does not continue a session from another model. Rows
-- written before the column existed read as NULL.
ALTER TABLE remote_agent_workflow_node_sessions ADD COLUMN IF NOT EXISTS model TEXT;

-- ============================================================================
-- Indexes and column comments
-- ============================================================================
--
-- Every statement that names a COLUMN lives here, below every ADD COLUMN above.
-- This placement is structural, not stylistic.
--
-- `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
-- table, so a column declared only in a CREATE TABLE body does not exist while
-- that block runs on an upgrade — it appears later, when the additive ALTER
-- TABLE block runs. An index or COMMENT ON COLUMN written next to its
-- CREATE TABLE therefore succeeds on a fresh install and fails on an upgrade
-- with `ERROR 42703: column ... does not exist`. Because initSchema() applies
-- this file as one transaction and re-throws at fatal, that single statement
-- rolls back the entire apply and crash-loops every boot (#2508, #2443).
--
-- Keeping these statements below the additive block makes that failure
-- unrepresentable instead of something each author has to remember. Add new
-- indexes and column comments HERE, never beside the table body — and add new
-- `ALTER TABLE ... ADD COLUMN` statements ABOVE this section, not after it, so
-- this section stays last. (Both mistakes fail migration-statement-order.test.ts
-- rather than reaching a user's upgrade.)
--
-- Guarded by packages/core/src/db/migration-statement-order.test.ts and
-- exercised against real PostgreSQL upgrades by scripts/check-schema-upgrades.ts.

-- Start-limit resets: the latest reset of a workflow on an item
CREATE INDEX IF NOT EXISTS idx_start_limit_resets_item
  ON remote_agent_start_limit_resets(item_id, workflow_name);

-- Item rulings
CREATE INDEX IF NOT EXISTS idx_item_rulings_item_id
  ON remote_agent_item_rulings(item_id);
CREATE INDEX IF NOT EXISTS idx_item_ends_item_id
  ON remote_agent_item_ends(item_id);

-- Item links
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_links_active
  ON remote_agent_item_links(from_item_id, to_item_id, kind) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_item_links_from_item_id
  ON remote_agent_item_links(from_item_id);
CREATE INDEX IF NOT EXISTS idx_item_links_to_item_id
  ON remote_agent_item_links(to_item_id);
-- Item asks
CREATE INDEX IF NOT EXISTS idx_item_asks_open
  ON remote_agent_item_asks(item_id, workflow_name) WHERE closed_as IS NULL;
CREATE INDEX IF NOT EXISTS idx_item_asks_run_id
  ON remote_agent_item_asks(run_id);
-- Item waits
CREATE INDEX IF NOT EXISTS idx_item_waits_open
  ON remote_agent_item_waits(workflow_name, event, about) WHERE closed_as IS NULL;
CREATE INDEX IF NOT EXISTS idx_item_waits_run_id
  ON remote_agent_item_waits(run_id);

-- What may resume a due continuation (a paused wait past its deadline, an answered gate,
-- a released source): `archon serve` and `archon workflow wake --watch` record a `process`
-- row (host, pid, instance) when they start, `wake schedule install` a `schedule` row that
-- `wake schedule remove` deletes, and a one-shot `archon workflow wake` a `pass` row. The
-- attention queue lists a due continuation only when every row is a process provably gone,
-- or there is none. id names the waker, so a restart of the same waker updates its row.
CREATE TABLE IF NOT EXISTS remote_agent_continuation_wakers (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  kind TEXT NOT NULL,
  pid INTEGER,
  instance TEXT,
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Codebase env vars
CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id
  ON remote_agent_codebase_env_vars(codebase_id);

-- User identities
CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON remote_agent_user_identities(user_id);

-- Better Auth core models (generated by auth@1.6.30)
CREATE INDEX IF NOT EXISTS "remote_agent_auth_session_userId_idx"
  ON remote_agent_auth_session("userId");
CREATE INDEX IF NOT EXISTS "remote_agent_auth_account_userId_idx"
  ON remote_agent_auth_account("userId");
CREATE INDEX IF NOT EXISTS "remote_agent_auth_verification_identifier_idx"
  ON remote_agent_auth_verification("identifier");

-- Conversations
CREATE INDEX IF NOT EXISTS idx_remote_agent_conversations_codebase
  ON remote_agent_conversations(codebase_id);
CREATE INDEX IF NOT EXISTS idx_conversations_hidden
  ON remote_agent_conversations(hidden);
CREATE INDEX IF NOT EXISTS idx_conversations_codebase
  ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id
  ON remote_agent_conversations(isolation_env_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON remote_agent_conversations(user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN remote_agent_conversations.isolation_env_id IS
  'UUID reference to isolation_environments table (the only isolation reference)';

-- Sessions
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

-- Isolation environments
-- Partial unique index: only active environments need uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_isolation_env_codebase
  ON remote_agent_isolation_environments(codebase_id);
CREATE INDEX IF NOT EXISTS idx_isolation_env_status
  ON remote_agent_isolation_environments(status);
CREATE INDEX IF NOT EXISTS idx_isolation_env_workflow
  ON remote_agent_isolation_environments(workflow_type, workflow_id);

COMMENT ON COLUMN remote_agent_isolation_environments.workflow_type IS
  'Type of work: issue, pr, review, thread, task';
COMMENT ON COLUMN remote_agent_isolation_environments.workflow_id IS
  'Identifier for the work (issue number, PR number, thread hash, etc.)';

-- Workflow runs
COMMENT ON COLUMN remote_agent_workflow_runs.conversation_id IS
  'Owning conversation. ON DELETE CASCADE erases the run rows on a hard conversation delete, silently dropping the live-run cleanup pin for its isolation environments (#2868); soft delete is the only supported path. A future hard-delete must resolve live runs first.';
CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
  ON remote_agent_workflow_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON remote_agent_workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv
  ON remote_agent_workflow_runs(parent_conversation_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id
  ON remote_agent_workflow_runs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_run
  ON remote_agent_workflow_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_item
  ON remote_agent_workflow_runs(item_id) WHERE item_id IS NOT NULL;
-- Open-work inbox (#2747): adopter lookup by adopted run.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_adopted_from
  ON remote_agent_workflow_runs(adopted_from_run_id) WHERE adopted_from_run_id IS NOT NULL;
-- Partial index for efficient staleness queries on running workflows
CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
  ON remote_agent_workflow_runs(last_activity_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_state_revisions_created_at ON remote_agent_state_revisions(created_at);

CREATE INDEX IF NOT EXISTS idx_resource_start_queue
  ON remote_agent_resource_start_requests(resource_key, status, queue_position);
CREATE INDEX IF NOT EXISTS idx_resource_start_host_queue
  ON remote_agent_resource_start_requests(host_id, status, resource_key, queue_position);
-- An item's queued and skipped starts, and a receipt binding's start (the item read).
CREATE INDEX IF NOT EXISTS idx_resource_start_item
  ON remote_agent_resource_start_requests(item_id, status);
CREATE INDEX IF NOT EXISTS idx_resource_start_receipt
  ON remote_agent_resource_start_requests(receipt_id, binding_id);
CREATE INDEX IF NOT EXISTS idx_start_binding_preparation
  ON remote_agent_start_receipt_bindings(host_id, preparation_status, created_at);

-- Workflow events
CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id
  ON remote_agent_workflow_events(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type
  ON remote_agent_workflow_events(event_type);
-- Per-run reads of chosen event types (runEventsSql), without reading the
-- high-volume provider_event rows of each run.
CREATE INDEX IF NOT EXISTS idx_workflow_events_run_type
  ON remote_agent_workflow_events(workflow_run_id, event_type);
-- Global created_at index. No cross-run created_at reader remains; it stays
-- because shipped schema is additive-only.
CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at
  ON remote_agent_workflow_events(created_at);
-- Metric completions (listMetricRecords). Its predicate must equal the query's.
CREATE INDEX IF NOT EXISTS idx_workflow_events_metrics
  ON remote_agent_workflow_events(created_at)
  WHERE event_type = 'node_completed'
    AND data->'structured_output'->>'metrics' IS NOT NULL;
-- Tie-breaker order within a run; NULL for rows written before event_order
-- existed, which the partial predicate keeps out of the unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_run_order
  ON remote_agent_workflow_events(workflow_run_id, event_order)
  WHERE event_order IS NOT NULL;

-- Workflow node sessions
CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_scope
  ON remote_agent_workflow_node_sessions(scope_key);
CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_workflow
  ON remote_agent_workflow_node_sessions(workflow_name);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON remote_agent_messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS remote_agent_web_push_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The global feed pages by commit order independently of run membership.
CREATE INDEX IF NOT EXISTS idx_workflow_events_order
  ON remote_agent_workflow_events(event_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_event_archive_order
  ON remote_agent_workflow_event_archive(event_order);

-- The archive trigger copies an event row by position, and CREATE TABLE AS ran
-- only once. Give the archive every column a later ADD COLUMN gave the events
-- table, in the same order, so deleting an event never fails on a shape mismatch.
DO $$
DECLARE
  missing record;
BEGIN
  FOR missing IN
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
     WHERE a.attrelid = 'remote_agent_workflow_events'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped
       AND NOT EXISTS (
         SELECT 1 FROM pg_attribute b
          WHERE b.attrelid = 'remote_agent_workflow_event_archive'::regclass
            AND b.attname = a.attname AND NOT b.attisdropped)
     ORDER BY a.attnum
  LOOP
    EXECUTE format('ALTER TABLE remote_agent_workflow_event_archive ADD COLUMN %I %s',
      missing.attname, missing.type);
  END LOOP;
END $$;
