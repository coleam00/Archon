/**
 * SQLite adapter using bun:sqlite
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Database, SQLiteError, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IDatabase, QueryResult, SqlDialect } from './types';
import { createLogger } from '@archon/paths';
import { APP_VERSION } from '../schema-version';
import { migrateColumns } from './sqlite-migrations';
import { prepareAll, prepareGet } from './sqlite-statements';
import { isSqliteBusy, retryWhileBusy, retryWhileBusySync } from './sqlite-busy';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.sqlite');
  return cachedLog;
}

/**
 * The resource slot holders table. One definition serves fresh creation and the
 * one-time rebuild that widens a dev database's narrow holder-kind CHECK.
 * `owner_*` name the process that owns an 'attempt' holder and are NULL for 'run'.
 */
function resourceSlotHoldersTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
        resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
        holder_kind TEXT NOT NULL CHECK (holder_kind IN ('run', 'attempt')),
        holder_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        owner_host TEXT,
        owner_pid INTEGER,
        owner_instance TEXT,
        PRIMARY KEY (resource_key, holder_kind, holder_id)
      );`;
}

export class SqliteAdapter implements IDatabase {
  private db: Database;
  readonly dialect = 'sqlite' as const;
  readonly sql: SqlDialect = sqliteDialect;
  /**
   * Tail of the connection queue. bun:sqlite is a single connection, so two
   * overlapping `withTransaction` blocks would interleave their BEGINs and throw
   * "cannot start a transaction within a transaction", and a plain `query()` would
   * run inside whichever transaction is open. Chaining every transaction and every
   * plain statement onto this tail serializes them: the second waits for the first to COMMIT,
   * then sees its committed state — exactly what the approval-gate CAS needs so a
   * concurrent second resolver cleanly loses (rowCount 0) instead of erroring.
   */
  private txTail: Promise<unknown> = Promise.resolve();

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Set this before WAL initialization: opening two CLI processes can make
    // `journal_mode = WAL` itself contend on the database header.
    this.db.run('PRAGMA busy_timeout = 5000');

    // Enable WAL mode for better concurrent performance
    retryWhileBusySync(() => this.db.run('PRAGMA journal_mode = WAL'));

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed
    this.initSchema();
  }

  /**
   * Marks code running inside one of this adapter's transaction blocks. The public
   * query() and withTransaction() queue behind that open transaction, so calling them
   * from inside it would wait forever; they throw instead.
   */
  private readonly transactionScope = new AsyncLocalStorage<SqliteAdapter>();

  private assertNotInOwnTransaction(): void {
    if (this.transactionScope.getStore() === this) {
      throw new Error(
        "SQLite query() or withTransaction() was called inside withTransaction; use the transaction's query instead"
      );
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.assertNotInOwnTransaction();
    // bun:sqlite is one connection shared by every caller. Queue each attempt behind
    // open transactions, or the statement would join another caller's transaction
    // and vanish if that transaction rolls back.
    return retryWhileBusy('statement', () => this.serialize(() => this.execute<T>(sql, params)));
  }

  private async execute<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Convert $1, $2, etc. to ? placeholders and reorder params to match
    const { sql: convertedSql, params: reorderedParams } = this.convertPlaceholders(
      sql,
      params ?? []
    );

    try {
      // Determine if this is a SELECT or mutation
      const trimmedSql = sql.trim().toUpperCase();
      const isSelect = trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('WITH');

      // Cast params to SQLite's expected type
      const sqliteParams = reorderedParams as SQLQueryBindings[];

      if (isSelect) {
        const rows = prepareAll<T>(this.db, convertedSql, sqliteParams);
        return { rows, rowCount: rows.length };
      }
      const upperSql = sql.toUpperCase();

      // Handle INSERT with RETURNING using native SQLite RETURNING (3.35+)
      // We must use .all() instead of .run() because .run() discards
      // RETURNING results, and its lastInsertRowid is unreliable when
      // ON CONFLICT DO UPDATE fires.
      if (upperSql.includes('RETURNING') && upperSql.includes('INSERT')) {
        const rows = prepareAll<T>(this.db, convertedSql, sqliteParams);
        return { rows, rowCount: rows.length };
      }

      // UPDATE/DELETE with RETURNING not supported
      if (upperSql.includes('RETURNING')) {
        throw new Error(
          'SQLite adapter does not support RETURNING clause on UPDATE/DELETE statements. ' +
            `Query: ${convertedSql.substring(0, 100)}... ` +
            'Hint: Use a SELECT before the mutation if you need the row data.'
        );
      }

      // Standard INSERT/UPDATE/DELETE without RETURNING
      const rowCount = this.prepareRun(convertedSql, sqliteParams);
      return { rows: [], rowCount };
    } catch (error) {
      // A busy statement is retried by query() or withTransaction(), which log the wait.
      if (!isSqliteBusy(error)) {
        // Driver messages and stacks can echo bound values (e.g. invalid JSON paths).
        getLog().error(
          {
            err: {
              message: 'Query failed (error details withheld to protect bound values)',
              ...(error instanceof SQLiteError ? { code: error.code, errno: error.errno } : {}),
            },
            sql,
            paramCount: params?.length ?? 0,
          },
          'db.sqlite_query_failed'
        );
      }
      throw error;
    }
  }

  async withTransaction<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T> {
    this.assertNotInOwnTransaction();
    // A busy snapshot requires replaying the whole transaction, never a single statement.
    const execute = this.execute.bind(this);
    const runOnce = async (): Promise<T> => {
      // Remember busy errors even when the callback catches or wraps them.
      let busy: SQLiteError | undefined;
      const blockQuery = async <U>(sql: string, params?: unknown[]): Promise<QueryResult<U>> => {
        try {
          return await execute<U>(sql, params);
        } catch (error) {
          if (isSqliteBusy(error)) busy = error;
          throw error;
        }
      };
      await execute('BEGIN');
      try {
        const result = await this.transactionScope.run(this, () => fn(blockQuery));
        if (busy) throw busy;
        await execute('COMMIT');
        return result;
      } catch (e) {
        try {
          await execute('ROLLBACK');
        } catch (rollbackError) {
          getLog().error({ err: rollbackError as Error }, 'db.sqlite_transaction_rollback_failed');
        }
        throw busy ?? e;
      }
    };
    // A busy failure anywhere in the block, COMMIT included, has already rolled back,
    // so the block reruns from BEGIN against fresh state.
    return this.serialize(() => retryWhileBusy('transaction', runOnce));
  }

  /**
   * Run `work` after every queued transaction and statement (see `txTail`). The stored tail is
   * made non-rejecting so one failure never blocks the next.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.txTail.then(work, work);
    this.txTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private prepareRun(sql: string, params: SQLQueryBindings[] = []): number {
    const stmt = this.db.prepare(sql);
    try {
      const changes = stmt.run(...params).changes;
      // Bun includes foreign-key actions in .changes; rowCount must describe only
      // the statement's rows, as PostgreSQL does (not children updated by SET NULL).
      return changes === 0
        ? 0
        : (prepareGet<{ count: number }>(this.db, 'SELECT changes() AS count')?.count ?? 0);
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Convert PostgreSQL $1, $2 placeholders to SQLite ? placeholders.
   *
   * PostgreSQL uses explicit indices ($1, $2) so params can appear in any order
   * in SQL. SQLite uses positional ? — so params must be reordered to match the
   * left-to-right order of placeholders in the SQL string.
   *
   * Example: SQL has "$2 ... $1" with params [id, json] →
   *   converted SQL: "? ... ?" with reordered params [json, id]
   */
  private convertPlaceholders(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    // Collect $N placeholders in order of appearance
    const placeholderOrder: number[] = [];
    const convertedSql = sql
      .replace(/\$(\d+)/g, (_match, indexStr: string) => {
        placeholderOrder.push(Number(indexStr));
        return '?';
      })
      .replace(/::jsonb/g, '')
      .replace(/::INTERVAL/g, '');

    // Reorder params to match the positional order of ? in the SQL.
    // $N is 1-based, so $1 → params[0], $2 → params[1], etc.
    const reordered =
      placeholderOrder.length > 0 ? placeholderOrder.map(idx => params[idx - 1]) : params;

    return { sql: convertedSql, params: reordered };
  }

  /**
   * Initialize database schema.
   * Always runs createSchema() since all statements use IF NOT EXISTS,
   * ensuring new tables from migrations are created in existing databases.
   */
  private initSchema(): void {
    // Probe BEFORE createSchema(): once CREATE TABLE IF NOT EXISTS has run there is
    // no way left to tell a fresh database from one that predates version tracking.
    const preExisting = this.hasAnyArchonTable();
    if (preExisting) {
      // Every statement is an IF NOT EXISTS no-op on an existing database, so this takes
      // no write lock beside a running server.
      this.createSchema();
    } else {
      // A fresh database gets its schema in one commit instead of one per statement:
      // each commit is an fsync, and on a slow disk dozens of them took seconds. IMMEDIATE
      // makes a second process creating the same fresh file wait (busy_timeout) and then
      // find every table present, instead of failing to upgrade a stale read.
      this.db.run('BEGIN IMMEDIATE');
      try {
        this.createSchema();
        this.db.run('COMMIT');
      } catch (error) {
        // SQLite may already have rolled back (SQLITE_FULL, SQLITE_IOERR); a ROLLBACK
        // then would throw and hide the error that explains the failure.
        if (this.db.inTransaction) this.db.run('ROLLBACK');
        throw error;
      }
    }
    const allApplied = migrateColumns(this.db, resourceSlotHoldersTable);
    this.recordSchemaVersion(preExisting, allApplied);
  }

  /** True when core Archon tables already exist — i.e. this is not a fresh database. */
  private hasAnyArchonTable(): boolean {
    const row = prepareGet(
      this.db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ['remote_agent_codebases']
    );
    return row !== null && row !== undefined;
  }

  /**
   * Record which Archon build created this database and which last applied schema
   * to it (#2316). Diagnostic only — nothing gates on these values.
   *
   * Writes only when the value actually changes, so the common case (every CLI
   * invocation is a fresh process opening a fresh connection) stays read-only.
   *
   * Skipped entirely when `allApplied` is false: migrateColumns() suppresses each
   * table's failure so one bad ALTER cannot abort startup, which means the schema
   * may be genuinely incomplete. Stamping this build's version onto that database
   * would turn the vintage into a wrong answer that gets believed — strictly worse
   * than the "not recorded" / stale-version state a reader can act on. The next
   * successful open records it.
   */
  private recordSchemaVersion(preExisting: boolean, allApplied: boolean): void {
    if (!allApplied) {
      getLog().warn(
        { appVersion: APP_VERSION },
        'db.sqlite_schema_version_skipped_incomplete_migration'
      );
      return;
    }
    try {
      const existing = prepareGet<{ app_version: string }>(
        this.db,
        'SELECT app_version FROM remote_agent_schema_version WHERE id = 1'
      );

      if (!existing) {
        this.db.run(
          'INSERT INTO remote_agent_schema_version (id, created_app_version, app_version) VALUES (1, ?, ?)',
          // NULL, not a guess: a database that predates this table has an unknowable
          // creation vintage, and that unknowability is the fact worth reporting.
          [preExisting ? null : APP_VERSION, APP_VERSION]
        );
      } else if (existing.app_version !== APP_VERSION) {
        this.db.run(
          "UPDATE remote_agent_schema_version SET app_version = ?, applied_at = datetime('now') WHERE id = 1",
          [APP_VERSION]
        );
      }
    } catch (e: unknown) {
      // Deliberate, logged fallback: the vintage row is diagnostic metadata and must
      // never be able to stop the database from opening (e.g. a read-only DB file).
      getLog().warn({ err: e as Error }, 'db.sqlite_schema_version_record_failed');
    }
  }

  /**
   * Create all tables.
   *
   * NOTE: NOT NULL constraint changes on existing columns (e.g., branch_name in
   * isolation_environments, user_message in workflow_runs, name in codebases) are only
   * enforced for new databases. For existing databases, CREATE TABLE IF NOT EXISTS is a
   * no-op so the old schema remains. SQLite lacks ALTER COLUMN support; enforcing new
   * constraints on existing tables would require a table rebuild via migrateColumns().
   */
  private createSchema(): void {
    this.db.run(`
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
        origin TEXT,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_key, name, revision)
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
        event_input_names TEXT,
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

      ${resourceSlotHoldersTable('remote_agent_resource_slot_holders')}

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

      CREATE INDEX IF NOT EXISTS idx_state_revisions_created_at ON remote_agent_state_revisions(created_at);

      CREATE INDEX IF NOT EXISTS idx_resource_start_queue
        ON remote_agent_resource_start_requests(resource_key, status, queue_position);
      CREATE INDEX IF NOT EXISTS idx_resource_start_host_queue
        ON remote_agent_resource_start_requests(host_id, status, resource_key, queue_position);
      CREATE INDEX IF NOT EXISTS idx_start_binding_preparation
        ON remote_agent_start_receipt_bindings(host_id, preparation_status, created_at);

      CREATE TABLE IF NOT EXISTS remote_agent_web_push_subscriptions (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES remote_agent_users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

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
    `);
    getLog().info('db.sqlite_schema_initialized');
  }
}

/**
 * SQLite SQL dialect helpers
 */
export const sqliteDialect: SqlDialect = {
  generateUuid(): string {
    return crypto.randomUUID();
  },

  now(): string {
    return "datetime('now')";
  },

  jsonMerge(column: string, paramIndex: number): string {
    // SQLite json_patch: merges two JSON objects
    // Use $N placeholder (not raw ?) so convertPlaceholders can reorder params correctly
    return `json_patch(${column}, $${String(paramIndex)})`;
  },

  nowMinusDays(paramIndex: number): string {
    return `datetime('now', '-' || $${String(paramIndex)} || ' days')`;
  },

  daysSince(column: string): string {
    return `(julianday('now') - julianday(${column}))`;
  },

  jsonText(column: string, path: string): string {
    return `json_extract(${column}, '$.${path}')`;
  },

  jsonRemove(column: string, ...keys: string[]): string {
    return `json_remove(${[column, ...keys.map(key => `'$.${key}'`)].join(', ')})`;
  },

  rowLock(): string {
    return '';
  },
};
