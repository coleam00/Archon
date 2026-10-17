
      -- Schema vintage (#2316): which Archon build created this database, and which
      -- last applied schema to it. Diagnostic only — nothing gates on these values.
      -- Single row (id = 1); written by recordSchemaVersion() from APP_VERSION so the
      -- version string has exactly one source of truth.
      CREATE TABLE IF NOT EXISTS remote_agent_schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        created_app_version TEXT,
        app_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Users table (Archon identity, platform-agnostic)
      CREATE TABLE IF NOT EXISTS remote_agent_users (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        display_name TEXT,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- User identities table (per-platform mapping → users.id)
      CREATE TABLE IF NOT EXISTS remote_agent_user_identities (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        platform_display_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(platform, platform_user_id)
      );

      -- User GitHub tokens (per-user device-flow tokens, encrypted at rest) [PR-C]
      CREATE TABLE IF NOT EXISTS remote_agent_user_github_tokens (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
        github_user_id INTEGER NOT NULL,
        github_login TEXT NOT NULL,
        access_token_encrypted TEXT NOT NULL,
        refresh_token_encrypted TEXT,
        access_token_expires_at TEXT,
        refresh_token_expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id)
      );

      -- User AI-provider credentials (Phase 2): one row per (user_id, provider).
      -- Exactly one of api_key_encrypted / oauth_creds_encrypted is populated;
      -- the kind column records which. Encrypted at rest with TOKEN_ENCRYPTION_KEY.
      CREATE TABLE IF NOT EXISTS remote_agent_user_provider_keys (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        api_key_encrypted TEXT,
        oauth_creds_encrypted TEXT,
        label TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, provider)
      );

      -- User AI preferences (Phase 3): personal model tiers, @custom aliases,
      -- and default assistant. NON-encrypted — model names are not secrets
      -- (mirrors codebase_env_vars, not the provider-key store). One row per
      -- user; cascades on user deletion. tiers/aliases are JSON-as-TEXT (parsed
      -- in the store layer so SQLite and Postgres behave identically).
      CREATE TABLE IF NOT EXISTS remote_agent_user_ai_prefs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
        tiers TEXT,
        aliases TEXT,
        default_provider TEXT,
        default_model TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id)
      );

      -- Codebases table
      CREATE TABLE IF NOT EXISTS remote_agent_codebases (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        repository_url TEXT,
        default_cwd TEXT NOT NULL,
        default_branch TEXT,
        ai_assistant_type TEXT DEFAULT 'claude',
        kind TEXT NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo', 'folder')),
        commands TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Codebase env vars table
      CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(codebase_id, key)
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS remote_agent_conversations (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        platform_type TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL,
        ai_assistant_type TEXT DEFAULT 'claude',
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        cwd TEXT,
        isolation_env_id TEXT,
        title TEXT,
        deleted_at TEXT,
        hidden INTEGER DEFAULT 0,
        user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_activity_at TEXT DEFAULT (datetime('now')),
        UNIQUE(platform_type, platform_conversation_id)
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS remote_agent_sessions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        ai_assistant_type TEXT NOT NULL DEFAULT 'claude',
        assistant_session_id TEXT,
        active INTEGER DEFAULT 1,
        metadata TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        parent_session_id TEXT REFERENCES remote_agent_sessions(id),
        transition_reason TEXT,
        ended_reason TEXT
      );

      -- Isolation environments table
      CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        workflow_type TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'worktree',
        working_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        created_by_platform TEXT,
        created_by_user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL,
        metadata TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
        -- Note: uniqueness enforced via partial index below (only active environments)
      );

      -- Partial unique index: only active environments need uniqueness
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
        ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
        WHERE status = 'active';

      -- Workflow runs table
      -- conversation_id's ON DELETE CASCADE would erase run rows (and with them
      -- the live-run cleanup pin for isolation environments, #2868) on a hard
      -- conversation delete; soft delete is the only supported path. Mirrors
      -- the COMMENT ON COLUMN in migrations/000_combined.sql.
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        workflow_name TEXT NOT NULL,
        user_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
        current_step_index INTEGER,
        metadata TEXT DEFAULT '{}',
        parent_conversation_id TEXT REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
        user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL,
        parent_run_id TEXT REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
        adopted_from_run_id TEXT REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now')),
        working_path TEXT,
        output_root TEXT,
        checkout_baseline TEXT
      );

      CREATE TABLE IF NOT EXISTS remote_agent_start_receipts (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        delivery_id TEXT,
        content_digest TEXT NOT NULL,
        received_at TEXT NOT NULL,
        occurred_at TEXT,
        source_actor TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'unmatched', 'unsupported', 'malformed')),
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_instance_id, delivery_id)
      );

      CREATE TABLE IF NOT EXISTS remote_agent_start_receipt_bindings (
        receipt_id TEXT NOT NULL REFERENCES remote_agent_start_receipts(id) ON DELETE CASCADE,
        binding_id TEXT NOT NULL,
        binding_revision TEXT,
        host_id TEXT,
        intent TEXT,
        preparation_status TEXT NOT NULL CHECK (preparation_status IN ('pending', 'preparing', 'failed', 'rejected', 'unmatched', 'complete')),
        preparation_owner TEXT,
        preparation_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (receipt_id, binding_id)
      );

      CREATE TABLE IF NOT EXISTS remote_agent_resource_slots (
        resource_key TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS remote_agent_resource_slot_holders (
        resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
        holder_kind TEXT NOT NULL CHECK (holder_kind IN ('run', 'attempt')),
        holder_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        owner_host TEXT,
        owner_pid INTEGER,
        owner_instance TEXT,
        PRIMARY KEY (resource_key, holder_kind, holder_id)
      );

      CREATE TABLE IF NOT EXISTS remote_agent_resource_start_requests (
        queue_position INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
        host_id TEXT NOT NULL,
        overlap_policy TEXT NOT NULL CHECK (overlap_policy IN ('skip', 'queue')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'skipped', 'withdrawn')),
        blocker_run_id TEXT,
        blocker_kind TEXT CHECK (blocker_kind IN ('run', 'request')),
        launch TEXT NOT NULL,
        receipt_id TEXT,
        binding_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        admitted_at TEXT,
        FOREIGN KEY (receipt_id, binding_id) REFERENCES remote_agent_start_receipt_bindings(receipt_id, binding_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_resource_start_queue
        ON remote_agent_resource_start_requests(resource_key, status, queue_position);
      CREATE INDEX IF NOT EXISTS idx_resource_start_host_queue
        ON remote_agent_resource_start_requests(host_id, status, resource_key, queue_position);
      CREATE INDEX IF NOT EXISTS idx_start_binding_preparation
        ON remote_agent_start_receipt_bindings(host_id, preparation_status, created_at);

      -- Workflow events table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        workflow_run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        event_order INTEGER,
        event_type TEXT NOT NULL,
        step_index INTEGER,
        step_name TEXT,
        data TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Private provider session handles scoped to one workflow run
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_run_node_sessions (
        workflow_run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (workflow_run_id, node_id)
      );

      -- Messages table (conversation history for Web UI)
      CREATE TABLE IF NOT EXISTS remote_agent_messages (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        metadata TEXT DEFAULT '{}',
        user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Per-node provider session IDs persisted across workflow re-runs.
      -- scope_key carries no FK, so a conversation delete does not reach these
      -- rows: soft delete plus a never-reused UUID leaves harmless orphans, and a
      -- future hard-delete must delete by scope_key itself (the mirror of the
      -- workflow_runs cascade caveat above). Mirrors the COMMENT ON TABLE in
      -- migrations/000_combined.sql.
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_node_sessions (
        workflow_name TEXT NOT NULL,
        node_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        last_run_id TEXT REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (workflow_name, node_id, scope_key, provider)
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id ON remote_agent_codebase_env_vars(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON remote_agent_conversations(platform_type, platform_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON remote_agent_sessions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON remote_agent_sessions(active);
      CREATE INDEX IF NOT EXISTS idx_isolation_codebase ON remote_agent_isolation_environments(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_workflow ON remote_agent_isolation_environments(workflow_type, workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation ON remote_agent_workflow_runs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON remote_agent_workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id ON remote_agent_workflow_events(workflow_run_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON remote_agent_workflow_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_created_at ON remote_agent_workflow_events(created_at);
      -- NOTE: the idx_workflow_events_run_order index and the assign_order trigger
      -- are deliberately NOT created here. Both reference event_order, which does
      -- not exist on databases created before it was introduced — and CREATE INDEX
      -- (or a TRIGGER body) referencing a missing column aborts this entire exec
      -- block, so createSchema() throws before migrateColumns() can ever add the
      -- column. That is exactly the failure the user_id index comment above warns
      -- about. migrateColumns() creates both, after its ALTER TABLE, idempotently.
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON remote_agent_messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_scope ON remote_agent_workflow_node_sessions(scope_key);
      CREATE INDEX IF NOT EXISTS idx_workflow_node_sessions_workflow ON remote_agent_workflow_node_sessions(workflow_name);
      -- NOTE: idx_workflow_runs_parent_conv, idx_conversations_hidden and the
      -- partial idx_conversations_codebase are NOT created here either. They
      -- reference parent_conversation_id / hidden / deleted_at, which
      -- migrateColumns() adds — so they are missing on any database created
      -- before those columns existed, and a CREATE INDEX on a missing column
      -- aborts this whole exec block before migrateColumns() can run.
      CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id ON remote_agent_conversations(isolation_env_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_codebase ON remote_agent_sessions(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_env_status ON remote_agent_isolation_environments(status);

      -- From PG migration 009: staleness detection for running workflows
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
        ON remote_agent_workflow_runs(last_activity_at) WHERE status = 'running';

      -- From PG migration 010: session audit trail
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON remote_agent_sessions(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
        ON remote_agent_sessions(conversation_id, started_at DESC);

      -- User identity index. user_identities is a new table created above
      -- so its user_id column always exists. Indexes for the user_id columns
      -- added by migrateColumns() onto pre-existing tables (conversations,
      -- workflow_runs) are created there, alongside the ALTER TABLE — see
      -- the comment in migrateColumns() for why this is order-sensitive.
      CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
        ON remote_agent_user_identities(user_id);
    