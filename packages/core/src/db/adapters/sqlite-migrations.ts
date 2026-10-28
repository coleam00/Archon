/**
 * Additive upgrades for SQLite databases created before newer schema additions.
 * SQLite's CREATE TABLE IF NOT EXISTS skips entirely for existing tables, so new
 * columns must be added via ALTER TABLE for databases created before the columns
 * were added to createSchema().
 */
import type { Database } from 'bun:sqlite';
import { createLogger } from '@archon/paths';
import { LEGACY_VENDOR_ALIASES } from '@archon/providers/credential-catalog';
import { isSqliteBusy } from './sqlite-busy';
import { prepareAll, prepareGet } from './sqlite-statements';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.sqlite');
  return cachedLog;
}

/**
 * One upgrade step. A `tolerated` step logs its failure and lets the database open,
 * so one bad table cannot abort schema init. A `required` step's failure aborts the
 * open.
 */
type Migration = {
  apply: (db: Database, resourceSlotHoldersTable: (name: string) => string) => void;
} & ({ kind: 'tolerated'; failureEvent: string } | { kind: 'required' }) &
  ({ scope: 'schema' } | { scope: 'data'; pending: (db: Database) => boolean });

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    prepareAll<{ name: string }>(db, `PRAGMA table_info('${table}')`).map(c => c.name)
  );
}

/**
 * Apply every migration in order. False when a tolerated step failed: a database
 * missing a failed migration must NOT be stamped as fully applied by this build, or
 * the vintage becomes a wrong answer that gets believed.
 *
 * `resourceSlotHoldersTable` is the holders table definition createSchema() also
 * uses; it stays in sqlite.ts, where the vintage extractor resolves createSchema()'s
 * interpolations.
 */
export function migrateColumns(
  db: Database,
  resourceSlotHoldersTable: (name: string) => string
): boolean {
  let allApplied = true;
  for (const migration of sqliteMigrations) {
    if (migration.kind === 'required') {
      migration.apply(db, resourceSlotHoldersTable);
      continue;
    }
    try {
      migration.apply(db, resourceSlotHoldersTable);
    } catch (e: unknown) {
      if (isSqliteBusy(e)) throw e;
      getLog().warn({ err: e as Error }, migration.failureEvent);
      allApplied = false;
    }
  }
  return allApplied;
}

/** The migrations, in the order they run. */
const sqliteMigrations: readonly Migration[] = [
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_schema_fingerprint_failed',
    apply: db => {
      if (!columnNames(db, 'remote_agent_schema_version').has('schema_fingerprint')) {
        db.run('ALTER TABLE remote_agent_schema_version ADD COLUMN schema_fingerprint TEXT');
      }
    },
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_users_columns_failed',
    apply: addUserRole,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_codebases_columns_failed',
    apply: addCodebaseColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_conversations_columns_failed',
    apply: addConversationColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_workflow_runs_columns_failed',
    apply: addWorkflowRunColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_session_columns_failed',
    apply: addSessionColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_messages_columns_failed',
    apply: addMessageColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_isolation_environments_columns_failed',
    apply: addIsolationEnvironmentColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_user_ai_prefs_columns_failed',
    apply: addUserAiPrefsColumns,
  },
  {
    kind: 'required',
    scope: 'data',
    apply: addWorkflowEventOrder,
    pending: hasPendingEventSequence,
  },
  {
    kind: 'tolerated',
    scope: 'data',
    pending: hasLegacyProviderKeys,
    failureEvent: 'db.sqlite_migration_provider_key_vendor_ids_failed',
    apply: renameProviderKeysToVendorIds,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_resource_slot_holders_failed',
    apply: widenResourceSlotHolders,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_receipt_bindings_columns_failed',
    apply: addReceiptBindingColumns,
  },
  {
    kind: 'tolerated',
    scope: 'schema',
    failureEvent: 'db.sqlite_migration_state_revisions_columns_failed',
    apply: addStateRevisionColumns,
  },
  { kind: 'required', scope: 'schema', apply: alignEventArchiveColumns },
];

// Keep 'admin' for older writers and existing rows; new writers insert 'member'.
// Changing a SQLite column default would require a table rebuild.
// Better Auth's own tables are PostgreSQL-only — web auth is never enabled
// on SQLite — so only the role column is backfilled here.
function addUserRole(db: Database): void {
  if (!columnNames(db, 'remote_agent_users').has('role')) {
    db.run("ALTER TABLE remote_agent_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  }
}

function addCodebaseColumns(db: Database): void {
  const codebaseColNames = columnNames(db, 'remote_agent_codebases');
  if (!codebaseColNames.has('default_branch')) {
    db.run('ALTER TABLE remote_agent_codebases ADD COLUMN default_branch TEXT');
  }
  if (!codebaseColNames.has('kind')) {
    db.run("ALTER TABLE remote_agent_codebases ADD COLUMN kind TEXT NOT NULL DEFAULT 'repo'");
  }
}

function addConversationColumns(db: Database): void {
  const colNames = columnNames(db, 'remote_agent_conversations');
  if (!colNames.has('title')) {
    db.run('ALTER TABLE remote_agent_conversations ADD COLUMN title TEXT');
  }
  if (!colNames.has('deleted_at')) {
    db.run('ALTER TABLE remote_agent_conversations ADD COLUMN deleted_at TEXT');
  }
  if (!colNames.has('hidden')) {
    db.run('ALTER TABLE remote_agent_conversations ADD COLUMN hidden INTEGER DEFAULT 0');
  }
  if (!colNames.has('user_id')) {
    db.run(
      'ALTER TABLE remote_agent_conversations ADD COLUMN user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL'
    );
  }
  // Indexes must be created here, not in createSchema(): these columns don't
  // exist on older databases until the ALTER TABLE statements above run, and
  // CREATE INDEX on a missing column aborts the entire createSchema()
  // exec block. Idempotent so they're safe to run unconditionally.
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON remote_agent_conversations(user_id) WHERE user_id IS NOT NULL'
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_conversations_hidden ON remote_agent_conversations(hidden)'
  );
  // idx_conversations_codebase was originally non-partial. Replace it once,
  // not on every open: an unconditional DROP + CREATE rebuilds the index
  // each time the adapter is constructed, and leaves a window where the
  // index is gone if the re-create fails.
  const existingCodebaseIdx = prepareGet<{ sql: string | null }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_codebase'"
  );
  if (existingCodebaseIdx && !(existingCodebaseIdx.sql ?? '').includes('deleted_at IS NULL')) {
    db.run('DROP INDEX idx_conversations_codebase');
  }
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_conversations_codebase ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL'
  );
}

function addWorkflowRunColumns(db: Database): void {
  const wfColNames = columnNames(db, 'remote_agent_workflow_runs');
  if (!wfColNames.has('parent_conversation_id')) {
    db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN parent_conversation_id TEXT');
  }
  if (!wfColNames.has('origin')) {
    db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN origin TEXT');
  }
  if (!wfColNames.has('working_path')) {
    db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN working_path TEXT');
  }
  if (!wfColNames.has('user_id')) {
    db.run(
      'ALTER TABLE remote_agent_workflow_runs ADD COLUMN user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL'
    );
  }
  // Run-tree parent (#2121 Phase 2). Self-referential FK — a `workflow:` sub-run
  // links back to its spawning parent. ON DELETE SET NULL so deleting a parent
  // orphans children rather than cascade-deleting their audit trail.
  if (!wfColNames.has('parent_run_id')) {
    db.run(
      'ALTER TABLE remote_agent_workflow_runs ADD COLUMN parent_run_id TEXT REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL'
    );
  }
  // Between-run continuation (#2747). Self-referential FK mirroring
  // parent_run_id — written once at run creation, never on resume.
  if (!wfColNames.has('adopted_from_run_id')) {
    db.run(
      'ALTER TABLE remote_agent_workflow_runs ADD COLUMN adopted_from_run_id TEXT REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL'
    );
  }
  // Durable output root (#2200). The resolved ~/.archon/workspaces/<project>/
  // directory this run's artifacts, logs, and state live under, written once
  // at run start so historical artifacts survive a codebase rename (#1192).
  if (!wfColNames.has('output_root')) {
    db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN output_root TEXT');
  }
  // Run checkout baseline (#3305): JSON checkout observation written once when the
  // run wins its execution claim. NULL means not recorded.
  if (!wfColNames.has('checkout_baseline')) {
    db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN checkout_baseline TEXT');
  }
  if (!wfColNames.has('outcome')) {
    db.run(
      "ALTER TABLE remote_agent_workflow_runs ADD COLUMN outcome TEXT CHECK (outcome IN ('succeeded', 'failed'))"
    );
  }
  // Same rationale as idx_conversations_user_id in addConversationColumns.
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_id ON remote_agent_workflow_runs(user_id) WHERE user_id IS NOT NULL'
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_run ON remote_agent_workflow_runs(parent_run_id) WHERE parent_run_id IS NOT NULL'
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_workflow_runs_adopted_from ON remote_agent_workflow_runs(adopted_from_run_id) WHERE adopted_from_run_id IS NOT NULL'
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv ON remote_agent_workflow_runs(parent_conversation_id)'
  );
}

function addSessionColumns(db: Database): void {
  if (!columnNames(db, 'remote_agent_sessions').has('ended_reason')) {
    db.run('ALTER TABLE remote_agent_sessions ADD COLUMN ended_reason TEXT');
  }
}

function addMessageColumns(db: Database): void {
  if (!columnNames(db, 'remote_agent_messages').has('user_id')) {
    db.run(
      'ALTER TABLE remote_agent_messages ADD COLUMN user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL'
    );
  }
}

function addIsolationEnvironmentColumns(db: Database): void {
  if (!columnNames(db, 'remote_agent_isolation_environments').has('created_by_user_id')) {
    db.run(
      'ALTER TABLE remote_agent_isolation_environments ADD COLUMN created_by_user_id TEXT REFERENCES remote_agent_users(id) ON DELETE SET NULL'
    );
  }
}

// #1998: default_model is the per-user default CHAT model, written atomically with
// default_provider. The table itself shipped with Phase 3 (#1948), so pre-existing
// installs need this ALTER — CREATE TABLE IF NOT EXISTS in createSchema() is a no-op
// for them.
function addUserAiPrefsColumns(db: Database): void {
  if (!columnNames(db, 'remote_agent_user_ai_prefs').has('default_model')) {
    db.run('ALTER TABLE remote_agent_user_ai_prefs ADD COLUMN default_model TEXT');
  }
}

// The high-water row survives event deletion. SQLite serializes writers;
// PostgreSQL records its sequence allocation here in the deferred trigger.
function addWorkflowEventOrder(db: Database): void {
  db.transaction(() => {
    if (!columnNames(db, 'remote_agent_workflow_events').has('event_order')) {
      db.run('ALTER TABLE remote_agent_workflow_events ADD COLUMN event_order INTEGER');
    }
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_events_run_order
         ON remote_agent_workflow_events(workflow_run_id, event_order)
         WHERE event_order IS NOT NULL`
    );
    db.run(`CREATE TABLE IF NOT EXISTS remote_agent_workflow_event_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`INSERT INTO remote_agent_workflow_event_sequence (id, value)
      SELECT 1, COALESCE(MAX(event_order), 0) FROM remote_agent_workflow_events WHERE true
      ON CONFLICT(id) DO UPDATE SET value = MAX(value, excluded.value)`);
    db.run(`CREATE TABLE IF NOT EXISTS remote_agent_workflow_event_archive AS
          SELECT * FROM remote_agent_workflow_events WHERE false`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_event_archive_order
          ON remote_agent_workflow_event_archive(event_order)`);
    db.run(`CREATE TRIGGER IF NOT EXISTS remote_agent_workflow_events_archive
          BEFORE DELETE ON remote_agent_workflow_events
          BEGIN
            INSERT INTO remote_agent_workflow_event_archive
              SELECT * FROM remote_agent_workflow_events WHERE rowid = OLD.rowid;
          END`);
    db.run('DROP TRIGGER IF EXISTS remote_agent_workflow_events_assign_order');
    db.run(
      `CREATE TRIGGER remote_agent_workflow_events_assign_order
         AFTER INSERT ON remote_agent_workflow_events
         BEGIN
           UPDATE remote_agent_workflow_event_sequence SET value = value + 1 WHERE id = 1;
           UPDATE remote_agent_workflow_events
           SET event_order = (SELECT value FROM remote_agent_workflow_event_sequence WHERE id = 1)
           WHERE rowid = NEW.rowid;
         END`
    );
    db.run(`CREATE INDEX IF NOT EXISTS idx_workflow_events_order
      ON remote_agent_workflow_events(event_order)`);
  }).immediate();
}

/** The step of every migration, in order, for the startup fingerprint. */
export function sqliteMigrationSteps(): readonly Migration['apply'][] {
  return sqliteMigrations.map(migration => migration.apply);
}

export function hasPendingSqliteDataRepairs(db: Database): boolean {
  return sqliteMigrations.some(migration => migration.scope === 'data' && migration.pending(db));
}

function hasLegacyProviderKeys(db: Database): boolean {
  const legacyProviders = Object.keys(LEGACY_VENDOR_ALIASES);
  return !!prepareGet(
    db,
    `SELECT 1 FROM remote_agent_user_provider_keys WHERE provider IN (${legacyProviders.map(() => '?').join(',')}) LIMIT 1`,
    legacyProviders
  );
}

function hasPendingEventSequence(db: Database): boolean {
  return !prepareGet(
    db,
    `SELECT 1 FROM remote_agent_workflow_event_sequence
    WHERE id = 1 AND value >= (SELECT COALESCE(MAX(event_order), 0) FROM remote_agent_workflow_events)`
  );
}

// Vendor rows win conflicts with legacy rows. The SQL counterpart is checked
// against the provider catalog in sqlite-migrations.test.ts.
function renameProviderKeysToVendorIds(db: Database): void {
  db.transaction(() => {
    for (const [legacy, vendor] of Object.entries(LEGACY_VENDOR_ALIASES)) {
      db.run(
        `DELETE FROM remote_agent_user_provider_keys
        WHERE provider = ? AND EXISTS (
          SELECT 1 FROM remote_agent_user_provider_keys v
          WHERE v.user_id = remote_agent_user_provider_keys.user_id AND v.provider = ?
        )`,
        [legacy, vendor]
      );
      db.run('UPDATE remote_agent_user_provider_keys SET provider = ? WHERE provider = ?', [
        vendor,
        legacy,
      ]);
    }
  })();
}

// Resource slot holders gained the 'attempt' kind and its owner columns (#2816).
// SQLite cannot alter a CHECK, so a table created with the narrow ('run') CHECK is
// rebuilt once. Only unreleased dev builds created that shape. BEGIN IMMEDIATE and
// the re-check make a concurrent opener skip instead of rebuilding twice.
function widenResourceSlotHolders(
  db: Database,
  resourceSlotHoldersTable: (name: string) => string
): void {
  const holdersSql = (): string =>
    prepareGet<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'remote_agent_resource_slot_holders'"
    )?.sql ?? '';
  if (holdersSql().includes("'attempt'")) return;
  db.transaction(() => {
    if (!holdersSql().includes("'attempt'")) {
      db.run(resourceSlotHoldersTable('remote_agent_resource_slot_holders_next'));
      db.run(
        `INSERT INTO remote_agent_resource_slot_holders_next
                 (resource_key, holder_kind, holder_id, acquired_at)
               SELECT resource_key, holder_kind, holder_id, acquired_at
                 FROM remote_agent_resource_slot_holders`
      );
      db.run('DROP TABLE remote_agent_resource_slot_holders');
      db.run(
        'ALTER TABLE remote_agent_resource_slot_holders_next RENAME TO remote_agent_resource_slot_holders'
      );
    }
  }).immediate();
}

// Names of event-derived inputs live beside the binding intent, not in it: older
// binaries parse `intent` strictly and would refuse an extra key.
function addReceiptBindingColumns(db: Database): void {
  if (!columnNames(db, 'remote_agent_start_receipt_bindings').has('event_input_names')) {
    db.run('ALTER TABLE remote_agent_start_receipt_bindings ADD COLUMN event_input_names TEXT');
  }
}

// The surface a state write outside a run came through; older rows came through the CLI.
function addStateRevisionColumns(db: Database): void {
  const cols = columnNames(db, 'remote_agent_state_revisions');
  if (cols.size && !cols.has('writer_via')) {
    db.run('ALTER TABLE remote_agent_state_revisions ADD COLUMN writer_via TEXT');
  }
}

// The archive trigger copies an event row by position, and CREATE TABLE AS ran
// only once. Give the archive every column a later ADD COLUMN gave the events
// table, in the same order, so deleting an event never fails on a shape mismatch.
// The write transaction keeps a concurrent opener from adding the same column.
function alignEventArchiveColumns(db: Database): void {
  db.transaction(() => {
    const archived = columnNames(db, 'remote_agent_workflow_event_archive');
    for (const column of prepareAll<{ name: string; type: string }>(
      db,
      "PRAGMA table_info('remote_agent_workflow_events')"
    )) {
      if (!archived.has(column.name))
        db.run(
          `ALTER TABLE remote_agent_workflow_event_archive ADD COLUMN "${column.name}" ${column.type}`
        );
    }
  }).immediate();
}
