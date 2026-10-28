// @archon-test-isolated
import { describe, test, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { trackTempRoots } from '@archon/paths/test-utils';
import { LEGACY_VENDOR_ALIASES } from '@archon/providers/credential-catalog';
import { getSchemaSQL } from '../bundled-schema';
import { SqliteAdapter } from './sqlite';
import { isSqliteSchemaCurrent } from './sqlite-schema-state';
import { prepareAll, prepareGet } from './sqlite-statements';
import { raw_indexes, raw_pragma, raw_query } from './sqlite-test-harness';

const trackTempRoot = trackTempRoots();

/** A fresh on-disk database path for one upgrade fixture, reclaimed after the test. */
async function upgradeFixturePath(): Promise<string> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-sqlite-upgrade-')));
  return join(root, 'archon.db');
}

/**
 * Produce a database in the state it had BEFORE event_order existed: current
 * schema in every other respect, with the column, its index and its trigger
 * removed. Building it this way (rather than hand-writing an old schema) keeps
 * the fixture realistic — the upgrade path that broke was an otherwise-current
 * database missing exactly this one column.
 */
async function makeDbWithoutEventOrder(): Promise<string> {
  const path = await upgradeFixturePath();
  await new SqliteAdapter(path).close(); // writes the current schema
  const raw = new Database(path);
  try {
    raw.run('DROP TRIGGER IF EXISTS remote_agent_workflow_events_assign_order');
    raw.run('DROP INDEX IF EXISTS idx_workflow_events_run_order');
    raw.run('DROP INDEX IF EXISTS idx_workflow_events_order');
    raw.run('DROP TABLE IF EXISTS remote_agent_workflow_event_sequence');
    raw.run('ALTER TABLE remote_agent_workflow_events DROP COLUMN event_order');
  } finally {
    raw.close();
  }
  return path;
}

function columnsOf(path: string, table: string): string[] {
  const raw = new Database(path);
  const stmt = raw.prepare(`PRAGMA table_info('${table}')`);
  try {
    return (stmt.all() as { name: string }[]).map(c => c.name);
  } finally {
    stmt.finalize();
    raw.close();
  }
}

describe('SqliteAdapter upgrade path', () => {
  test('upgrades the shipped MAX allocator and keeps its head after deletes and reopen', async () => {
    const path = await upgradeFixturePath();
    await new SqliteAdapter(path).close();
    const raw = new Database(path);
    try {
      raw.run('DROP TRIGGER remote_agent_workflow_events_assign_order');
      raw.run('DROP TABLE remote_agent_workflow_event_sequence');
      raw.run(`CREATE TRIGGER remote_agent_workflow_events_assign_order AFTER INSERT ON remote_agent_workflow_events
        WHEN NEW.event_order IS NULL BEGIN
        UPDATE remote_agent_workflow_events SET event_order = (SELECT COALESCE(MAX(event_order), 0) + 1 FROM remote_agent_workflow_events) WHERE rowid = NEW.rowid; END`);
      raw.run(
        "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('feed-conversation', 'test', 'feed')"
      );
      raw.run(
        "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message) VALUES ('feed-run', 'feed-conversation', 'feed', '')"
      );
      for (const id of ['first', 'second'])
        raw.run(
          "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES (?, 'feed-run', 'workflow_started')",
          [id]
        );
    } finally {
      raw.close();
    }
    let db = new SqliteAdapter(path);
    try {
      await db.query("DELETE FROM remote_agent_workflow_events WHERE id = 'second'");
      await db.query(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ('third', 'feed-run', 'workflow_started')"
      );
      expect(
        (
          await db.query<{ event_order: number }>(
            "SELECT event_order FROM remote_agent_workflow_events WHERE id = 'third'"
          )
        ).rows
      ).toEqual([{ event_order: 3 }]);
      await db.query('DELETE FROM remote_agent_workflow_events');
      await db.close();
      db = new SqliteAdapter(path);
      expect(
        (
          await db.query<{ id: string }>(
            'SELECT id FROM remote_agent_workflow_event_archive ORDER BY event_order'
          )
        ).rows
      ).toEqual([{ id: 'first' }, { id: 'second' }, { id: 'third' }]);
      await db.query(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ('fourth', 'feed-run', 'workflow_started')"
      );
      expect(
        (
          await db.query<{ event_order: number }>(
            "SELECT event_order FROM remote_agent_workflow_events WHERE id = 'fourth'"
          )
        ).rows
      ).toEqual([{ event_order: 4 }]);
    } finally {
      await db.close();
    }
  });

  // Regression: the event_order index and trigger were briefly created inside
  // createSchema(). Both reference a column absent from any database predating
  // it, and CREATE INDEX on a missing column aborts the entire createSchema()
  // exec block — so createSchema() threw and migrateColumns(), which adds the
  // column, never ran. Every existing SQLite install was bricked on upgrade,
  // and the migration that would fix it could never execute.
  // The archive trigger copies by position; an events column added after the archive
  // existed made every event delete fail until the archive gained it too.
  test('archives deleted events after the events table gains a column', async () => {
    const path = await upgradeFixturePath();
    await new SqliteAdapter(path).close();
    const raw = new Database(path);
    try {
      raw.run('ALTER TABLE remote_agent_workflow_events ADD COLUMN later_column TEXT');
    } finally {
      raw.close();
    }
    const db = new SqliteAdapter(path);
    try {
      await db.query(
        "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('c', 'test', 'c')"
      );
      await db.query(
        "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message) VALUES ('r', 'c', 'w', '')"
      );
      await db.query(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, later_column) VALUES ('e', 'r', 'workflow_started', 'kept')"
      );
      await db.query('DELETE FROM remote_agent_workflow_events');
      expect(
        (
          await db.query<{ id: string; later_column: string }>(
            'SELECT id, later_column FROM remote_agent_workflow_event_archive'
          )
        ).rows
      ).toEqual([{ id: 'e', later_column: 'kept' }]);
    } finally {
      await db.close();
    }
  });

  test('converges a database that predates event_order', async () => {
    const path = await makeDbWithoutEventOrder();
    expect(columnsOf(path, 'remote_agent_workflow_events')).not.toContain('event_order');

    // Must not throw, and must converge.
    const upgraded = new SqliteAdapter(path);
    await upgraded.close();

    expect(columnsOf(path, 'remote_agent_workflow_events')).toContain('event_order');

    const raw = new Database(path);
    const stmt = raw.prepare('SELECT name FROM sqlite_master WHERE name IN (?, ?)');
    let objects: string[];
    try {
      objects = (
        stmt.all('idx_workflow_events_run_order', 'remote_agent_workflow_events_assign_order') as {
          name: string;
        }[]
      ).map(o => o.name);
    } finally {
      stmt.finalize();
      raw.close();
    }

    expect(objects).toContain('idx_workflow_events_run_order');
    expect(objects).toContain('remote_agent_workflow_events_assign_order');
  });

  test('adds the authored outcome column idempotently to an existing workflow-runs table', async () => {
    const path = await upgradeFixturePath();
    await new SqliteAdapter(path).close();
    const raw = new Database(path);
    try {
      raw.run('ALTER TABLE remote_agent_workflow_runs DROP COLUMN outcome');
    } finally {
      raw.close();
    }
    expect(columnsOf(path, 'remote_agent_workflow_runs')).not.toContain('outcome');

    const upgraded = new SqliteAdapter(path);
    await upgraded.close();
    const reopened = new SqliteAdapter(path);
    await reopened.close();

    expect(columnsOf(path, 'remote_agent_workflow_runs')).toContain('outcome');
  });
});

describe('migrateColumns on an existing database', () => {
  let db: SqliteAdapter;
  let currentDbPath = '';

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(currentDbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
  });

  describe('upgrade from pre-0.4.0 schema (regression for the v0.4.0 init bug)', () => {
    /**
     * v0.4.0 added user_id columns to conversations/workflow_runs/messages and
     * created_by_user_id on isolation_environments via migrateColumns(). It also
     * added CREATE INDEX statements referencing those columns directly inside
     * createSchema(). On an existing pre-0.4.0 database, createSchema()'s
     * CREATE INDEX hit a "no such column: user_id" because migrateColumns()
     * runs AFTER createSchema(), aborting the entire init and leaving every
     * subsequent query broken. This test reproduces that exact pre-0.4.0 shape
     * and asserts that SqliteAdapter construction now completes cleanly and
     * adds both the columns and the indexes.
     */
    test('migrates user_id columns and indexes onto an existing pre-0.4.0 database', () => {
      const dbPath = join(
        import.meta.dir,
        `.test-sqlite-pre040-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      currentDbPath = dbPath;

      // Seed the file with a minimal pre-0.4.0 shape: the four tables that
      // gained user_id-flavored columns in 0.4.0, with everything EXCEPT
      // those new columns. CREATE TABLE IF NOT EXISTS in createSchema() will
      // then be a no-op for these tables, so the migration path is the one
      // under test.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE remote_agent_codebases (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          name TEXT NOT NULL,
          default_cwd TEXT NOT NULL,
          repository_url TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE remote_agent_conversations (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          platform_type TEXT NOT NULL,
          platform_conversation_id TEXT NOT NULL,
          ai_assistant_type TEXT,
          codebase_id TEXT,
          cwd TEXT,
          isolation_env_id TEXT,
          hidden INTEGER DEFAULT 0,
          deleted_at TEXT,
          last_activity_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE remote_agent_workflow_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workflow_name TEXT NOT NULL,
          conversation_id TEXT,
          codebase_id TEXT,
          status TEXT DEFAULT 'pending',
          user_message TEXT,
          metadata TEXT DEFAULT '{}',
          parent_conversation_id TEXT,
          last_activity_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE remote_agent_messages (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE remote_agent_isolation_environments (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          codebase_id TEXT NOT NULL,
          workflow_type TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'worktree',
          working_path TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          created_by_platform TEXT,
          metadata TEXT DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      raw.close();

      // Construction must not throw. Before the fix, this errored with
      // "no such column: user_id" on the CREATE INDEX inside createSchema().
      db = new SqliteAdapter(dbPath);

      // The migration should have added every user_id column.
      const codebaseCols = raw_pragma(dbPath, 'remote_agent_codebases');
      expect(codebaseCols).toContain('default_branch');
      // …and the folder-project `kind` discriminator (runtime ALTER on old DBs).
      expect(codebaseCols).toContain('kind');
      // A row inserted without `kind` backfills to 'repo' via the column DEFAULT.
      const writable = new Database(dbPath);
      try {
        writable.run(
          "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('cb-old', 'legacy', '/tmp/legacy')"
        );
      } finally {
        writable.close();
      }
      const kindRow = raw_query(
        dbPath,
        "SELECT kind FROM remote_agent_codebases WHERE id = 'cb-old'"
      );
      expect(kindRow).toEqual([{ kind: 'repo' }]);

      const conversationCols = raw_pragma(dbPath, 'remote_agent_conversations');
      expect(conversationCols).toContain('user_id');

      const workflowRunCols = raw_pragma(dbPath, 'remote_agent_workflow_runs');
      expect(workflowRunCols).toContain('user_id');

      const messageCols = raw_pragma(dbPath, 'remote_agent_messages');
      expect(messageCols).toContain('user_id');

      const isolationCols = raw_pragma(dbPath, 'remote_agent_isolation_environments');
      expect(isolationCols).toContain('created_by_user_id');

      // And the indexes that previously failed must now exist.
      const indexes = raw_indexes(dbPath);
      expect(indexes).toContain('idx_conversations_user_id');
      expect(indexes).toContain('idx_workflow_runs_user_id');

      // Sanity: querying the table that previously errored at init now works.
      const probe = raw_query(
        dbPath,
        'SELECT COUNT(*) AS n FROM remote_agent_conversations WHERE user_id IS NOT NULL'
      );
      expect(probe).toEqual([{ n: 0 }]);
    });

    /**
     * Same failure shape, three more columns. `hidden` and `deleted_at` on
     * conversations and `parent_conversation_id` on workflow_runs are added by
     * migrateColumns(), so a database created before they existed does not have
     * them — yet createSchema(), which runs FIRST, was indexing all three. The
     * adapter constructor threw "no such column: parent_conversation_id" and the
     * database could not be opened at all. The indexes now live in
     * migrateColumns() next to their ALTER TABLE.
     */
    test('opens a database that predates hidden / deleted_at / parent_conversation_id', () => {
      const dbPath = join(
        import.meta.dir,
        `.test-sqlite-preidx-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      currentDbPath = dbPath;

      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE remote_agent_codebases (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          name TEXT NOT NULL,
          default_cwd TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE remote_agent_conversations (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          platform_type TEXT NOT NULL,
          platform_conversation_id TEXT NOT NULL,
          codebase_id TEXT,
          cwd TEXT,
          isolation_env_id TEXT,
          last_activity_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE remote_agent_workflow_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workflow_name TEXT NOT NULL,
          conversation_id TEXT,
          codebase_id TEXT,
          status TEXT DEFAULT 'pending',
          user_message TEXT,
          metadata TEXT DEFAULT '{}',
          last_activity_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      raw.close();

      db = new SqliteAdapter(dbPath);

      const conversationCols = raw_pragma(dbPath, 'remote_agent_conversations');
      expect(conversationCols).toContain('hidden');
      expect(conversationCols).toContain('deleted_at');

      const workflowRunCols = raw_pragma(dbPath, 'remote_agent_workflow_runs');
      expect(workflowRunCols).toContain('parent_conversation_id');

      // The upgrade must also land the indexes, not merely survive.
      const indexes = raw_indexes(dbPath);
      expect(indexes).toContain('idx_conversations_hidden');
      expect(indexes).toContain('idx_conversations_codebase');
      expect(indexes).toContain('idx_workflow_runs_parent_conv');

      const probe = raw_query(
        dbPath,
        'SELECT COUNT(*) AS n FROM remote_agent_workflow_runs WHERE parent_conversation_id IS NOT NULL'
      );
      expect(probe).toEqual([{ n: 0 }]);
    });
  });

  describe('provider-key vendor-id migration (#1955)', () => {
    test.each(
      Object.entries(LEGACY_VENDOR_ALIASES).flatMap(([legacy, vendor]) =>
        ['sqlite', 'postgres DML'].map(migration => [migration, legacy, vendor] as const)
      )
    )(
      '%s normalizes %s to %s and preserves the vendor row on conflict',
      async (migration, legacy, vendor) => {
        const path = await upgradeFixturePath();
        await new SqliteAdapter(path).close();
        const raw = new Database(path);
        try {
          const cookie = () => prepareGet(raw, 'PRAGMA main.schema_version');
          const before = cookie();
          raw.run("INSERT INTO remote_agent_users (id) VALUES ('legacy'), ('conflict')");
          const kind = vendor === 'github-copilot' ? 'oauth' : 'api_key';
          const encrypted = kind === 'api_key' ? 'legacy-key' : null;
          for (const user of ['legacy', 'conflict']) {
            raw.run(
              `INSERT INTO remote_agent_user_provider_keys (id, user_id, provider, kind, api_key_encrypted, label)
                VALUES (?, ?, ?, ?, ?, 'legacy')`,
              [`${user}-${legacy}`, user, legacy, kind, encrypted]
            );
          }
          raw.run(
            `INSERT INTO remote_agent_user_provider_keys (id, user_id, provider, kind, api_key_encrypted, label)
              VALUES (?, 'conflict', ?, 'api_key', 'vendor-key', 'vendor')`,
            [`vendor-${vendor}`, vendor]
          );
          expect(cookie()).toEqual(before);
          expect(
            raw.transaction(() => isSqliteSchemaCurrent(raw, SqliteAdapter.schemaDigest)).deferred()
          ).toBe(false);
          const apply = async () => {
            if (migration === 'sqlite') {
              await new SqliteAdapter(path).close();
            } else {
              // This portable DML is executed verbatim to enforce SQL/catalog conformance.
              const sql = getSchemaSQL();
              const start = sql.indexOf('DELETE FROM remote_agent_user_provider_keys');
              const end = sql.indexOf('-- Phase 3:', start);
              expect(start).toBeGreaterThan(-1);
              expect(end).toBeGreaterThan(start);
              raw.exec(sql.slice(start, end));
            }
          };
          await apply();
          const expected = [
            {
              user_id: 'conflict',
              provider: vendor,
              label: 'vendor',
              kind: 'api_key',
              api_key_encrypted: 'vendor-key',
            },
            {
              user_id: 'legacy',
              provider: vendor,
              label: 'legacy',
              kind,
              api_key_encrypted: encrypted,
            },
          ];
          const rows = () =>
            prepareAll(
              raw,
              'SELECT user_id, provider, label, kind, api_key_encrypted FROM remote_agent_user_provider_keys ORDER BY user_id, provider'
            );
          expect(rows()).toEqual(expected);
          expect(
            raw.transaction(() => isSqliteSchemaCurrent(raw, SqliteAdapter.schemaDigest)).deferred()
          ).toBe(true);
          const convergedCookie = cookie();
          await apply();
          expect(rows()).toEqual(expected);
          expect(cookie()).toEqual(convergedCookie);
        } finally {
          raw.close();
        }
      }
    );
  });
});
