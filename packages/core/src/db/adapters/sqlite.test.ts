import { describe, test, expect, afterEach } from 'bun:test';
import { SqliteAdapter } from './sqlite';
import { getSchemaSQL } from '../bundled-schema';
import { APP_VERSION, readSchemaVersion } from '../schema-version';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'node:os';

let currentDbPath = '';

function createTestDb(): SqliteAdapter {
  currentDbPath = join(
    import.meta.dir,
    `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return new SqliteAdapter(currentDbPath);
}

/** Insert a parent codebase row to satisfy FK constraints */
async function insertCodebase(db: SqliteAdapter, id: string): Promise<void> {
  await db.query(`INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`, [
    id,
    `test-codebase-${id}`,
    '/tmp/test-cwd',
  ]);
}

/**
 * Produce a database in the state it had BEFORE event_order existed: current
 * schema in every other respect, with the column, its index and its trigger
 * removed. Building it this way (rather than hand-writing an old schema) keeps
 * the fixture realistic — the upgrade path that broke was an otherwise-current
 * database missing exactly this one column.
 */
async function makeDbWithoutEventOrder(): Promise<string> {
  // OS temp dir, not the repo: on Windows bun:sqlite does not always release the
  // file handle synchronously, so cleanup can hit EBUSY. A stranded file in
  // tmpdir is harmless and self-cleaning; a stranded file in packages/ is repo
  // pollution that shows up in everyone's `git status`.
  const path = join(
    tmpdir(),
    `archon-test-sqlite-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const seed = new SqliteAdapter(path); // writes the current schema
  // MUST await: close() is async, and on Windows an unreleased SQLite handle
  // locks the file, so the Database opened below fails. Harmless on POSIX,
  // which is why the first version of this test passed locally and failed CI.
  await seed.close();
  const raw = new Database(path);
  try {
    raw.run('DROP TRIGGER IF EXISTS remote_agent_workflow_events_assign_order');
    raw.run('DROP INDEX IF EXISTS idx_workflow_events_run_order');
    raw.run('ALTER TABLE remote_agent_workflow_events DROP COLUMN event_order');
  } finally {
    raw.close();
  }
  return path;
}

function columnsOf(path: string, table: string): string[] {
  const raw = new Database(path);
  // Finalize the statement before closing. On Windows an un-finalized prepared
  // statement keeps the file handle open past close(), so the afterEach unlink
  // fails with EBUSY — which is what this test hit on windows-latest while
  // passing on POSIX.
  const stmt = raw.prepare(`PRAGMA table_info('${table}')`);
  try {
    return (stmt.all() as { name: string }[]).map(c => c.name);
  } finally {
    stmt.finalize();
    raw.close();
  }
}

describe('SqliteAdapter upgrade path', () => {
  let legacyPath = '';
  afterEach(() => {
    if (legacyPath) {
      try {
        unlinkSync(legacyPath);
      } catch (e: unknown) {
        // Tolerate exactly two cases, and nothing else:
        //   ENOENT — already gone, fine.
        //   EBUSY  — Windows only. bun:sqlite does not reliably release the file
        //            handle synchronously on close(), even with statements
        //            finalized. The fixture is a uniquely-named file in tmpdir,
        //            so a stranded one is harmless. Tolerated rather than
        //            swallowed: any other errno still fails the test loudly,
        //            which is what caught the real leak in the first place.
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EBUSY') throw e;
      }
      legacyPath = '';
    }
  });

  // Regression: the event_order index and trigger were briefly created inside
  // createSchema(). Both reference a column absent from any database predating
  // it, and CREATE INDEX on a missing column aborts the entire createSchema()
  // exec block — so createSchema() threw and migrateColumns(), which adds the
  // column, never ran. Every existing SQLite install was bricked on upgrade,
  // and the migration that would fix it could never execute.
  test('converges a database that predates event_order', async () => {
    legacyPath = await makeDbWithoutEventOrder();
    expect(columnsOf(legacyPath, 'remote_agent_workflow_events')).not.toContain('event_order');

    // Must not throw, and must converge.
    const upgraded = new SqliteAdapter(legacyPath);
    await upgraded.close();

    expect(columnsOf(legacyPath, 'remote_agent_workflow_events')).toContain('event_order');

    const raw = new Database(legacyPath);
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
});

describe('SqliteAdapter', () => {
  let db: SqliteAdapter;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    try {
      unlinkSync(currentDbPath);
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(currentDbPath + '-wal');
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(currentDbPath + '-shm');
    } catch {
      /* may not exist */
    }
  });

  describe('INSERT with RETURNING', () => {
    test('returns inserted row via native RETURNING', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      const result = await db.query<{ id: string; status: string }>(
        `INSERT INTO remote_agent_isolation_environments
         (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        ['test-id', 'cb-1', 'issue', '1', 'worktree', '/tmp/test', 'issue-1', 'active']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('test-id');
      expect(result.rows[0].status).toBe('active');
    });

    test('returns correct row on ON CONFLICT DO UPDATE', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      // Insert initial row
      await db.query(
        `INSERT INTO remote_agent_isolation_environments
         (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['orig-id', 'cb-1', 'issue', '42', 'worktree', '/tmp/original', 'issue-42', 'active']
      );

      // Upsert with ON CONFLICT -- this is the scenario that was broken
      const result = await db.query<{ id: string; working_path: string; branch_name: string }>(
        `INSERT INTO remote_agent_isolation_environments
         (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (codebase_id, workflow_type, workflow_id) WHERE status = 'active'
         DO UPDATE SET
           working_path = EXCLUDED.working_path,
           branch_name = EXCLUDED.branch_name,
           status = 'active'
         RETURNING *`,
        ['cb-1', 'issue', '42', 'worktree', '/tmp/updated', 'issue-42-v2']
      );

      expect(result.rows).toHaveLength(1);
      // Must return the updated row, not a random/wrong row
      expect(result.rows[0].id).toBe('orig-id');
      expect(result.rows[0].working_path).toBe('/tmp/updated');
      expect(result.rows[0].branch_name).toBe('issue-42-v2');
    });
  });

  describe('placeholder conversion (#999 regression)', () => {
    test('$N inside SQL comments is treated as a placeholder — avoid $N in comments', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      // A query with $1 and $2 as real params, but $3 only appears in a comment.
      // convertPlaceholders replaces ALL $N occurrences including inside comments,
      // producing 3 ? marks for only 2 params → SQLite error.
      const sql = `SELECT * FROM remote_agent_codebases WHERE id = $1 AND name = $2 -- $3 is not a real param`;
      await expect(db.query(sql, ['cb-1', 'test-codebase-cb-1'])).rejects.toThrow();
    });

    test('query succeeds when $N placeholders match param count', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      const result = await db.query<{ id: string }>(
        `SELECT id FROM remote_agent_codebases WHERE id = $1 AND name = $2`,
        ['cb-1', 'test-codebase-cb-1']
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('cb-1');
    });
  });

  describe('UPDATE/DELETE with RETURNING', () => {
    test('throws error for UPDATE RETURNING', async () => {
      db = createTestDb();

      await expect(
        db.query(
          `UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2 RETURNING *`,
          ['destroyed', 'test-id']
        )
      ).rejects.toThrow('does not support RETURNING clause on UPDATE/DELETE');
    });
  });

  describe('datetime() chronological vs lexical comparison', () => {
    // Documents the SQLite-specific bug fixed in getActiveWorkflowRunByPath.
    // `started_at` is TEXT in "YYYY-MM-DD HH:MM:SS" format. Comparing it
    // directly to an ISO param "YYYY-MM-DDTHH:MM:SS.mmmZ" with `<` is
    // LEXICAL: char 11 is space (0x20) in the column vs T (0x54) in the
    // param, so every column value lex-sorts before every ISO param,
    // making the comparison ALWAYS true regardless of actual time.
    //
    // Wrapping both sides in datetime() forces chronological comparison.

    test('lexical comparison gives wrong answer for SQLite stored format vs ISO param', async () => {
      db = createTestDb();
      // Column-format value (afternoon) is chronologically AFTER the ISO
      // param (morning), but lex compares char-11 (space < T) → wrong.
      const result = await db.query<{ broken: number }>(
        `SELECT ('2026-04-14 12:00:00' < $1) AS broken`,
        ['2026-04-14T10:00:00.000Z']
      );
      // Expected by chronology: FALSE. Lex says: TRUE.
      expect(result.rows[0].broken).toBe(1);
    });

    test('datetime() wrap on both sides gives chronological comparison', async () => {
      db = createTestDb();
      const result = await db.query<{ correct: number }>(
        `SELECT (datetime('2026-04-14 12:00:00') < datetime($1)) AS correct`,
        ['2026-04-14T10:00:00.000Z']
      );
      // 12:00 < 10:00 is FALSE — datetime() comparison agrees with reality.
      expect(result.rows[0].correct).toBe(0);
    });

    test('datetime() handles equality across formats', async () => {
      db = createTestDb();
      const result = await db.query<{ equal: number }>(
        `SELECT (datetime('2026-04-14 10:00:00') = datetime($1)) AS equal`,
        ['2026-04-14T10:00:00.000Z']
      );
      expect(result.rows[0].equal).toBe(1);
    });
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
  });

  describe('provider-key vendor-id migration (#1955)', () => {
    test('renames legacy rows and lets an existing vendor row win on conflict', async () => {
      db = createTestDb();
      const dbPath = currentDbPath;
      // Seed users + legacy/vendor credential rows post-construction…
      await db.query(`INSERT INTO remote_agent_users (id) VALUES ('u1'), ('u2')`, []);
      await db.query(
        `INSERT INTO remote_agent_user_provider_keys (id, user_id, provider, kind, api_key_encrypted, label)
         VALUES
           ('k1', 'u1', 'claude',  'api_key', 'enc-legacy-claude', 'legacy'),
           ('k2', 'u1', 'anthropic', 'api_key', 'enc-vendor-anthropic', 'vendor'),
           ('k3', 'u2', 'codex',   'api_key', 'enc-legacy-codex', NULL),
           ('k4', 'u2', 'copilot', 'oauth',   NULL, 'subscription')`,
        []
      );
      await db.close();

      // …then reopen: migrateColumns() runs the idempotent vendor-id data fix.
      db = new SqliteAdapter(dbPath);
      const rows = raw_query(
        dbPath,
        'SELECT user_id, provider, label FROM remote_agent_user_provider_keys ORDER BY user_id, provider'
      ) as { user_id: string; provider: string; label: string | null }[];
      expect(rows).toEqual([
        // u1: legacy 'claude' row dropped — the explicit 'anthropic' row wins.
        { user_id: 'u1', provider: 'anthropic', label: 'vendor' },
        // u2: no conflicts — legacy ids renamed in place.
        { user_id: 'u2', provider: 'github-copilot', label: 'subscription' },
        { user_id: 'u2', provider: 'openai', label: null },
      ]);

      // Idempotent: a third open changes nothing.
      await db.close();
      db = new SqliteAdapter(dbPath);
      const again = raw_query(
        dbPath,
        'SELECT COUNT(*) AS n FROM remote_agent_user_provider_keys'
      ) as { n: number }[];
      expect(again).toEqual([{ n: 3 }]);
    });
  });

  describe('schema parity with the Postgres migration (000_combined.sql)', () => {
    /**
     * The SQLite schema (createSchema() in sqlite.ts) and the Postgres schema
     * (migrations/000_combined.sql) are two independently hand-maintained
     * sources of truth. Before this test nothing compared them, so a table
     * added to the migration but forgotten in sqlite.ts shipped silently and
     * threw `no such table: <name>` on SQLite. That regression actually
     * happened with remote_agent_user_ai_prefs (Phase 3 / credentials epic):
     * added to the migration, missed in sqlite.ts, invisible on the Postgres
     * VPS. The lookup is caught (runs degrade to config-only), but it spammed
     * two ERROR log lines on every SQLite run.
     *
     * Better Auth's remote_agent_auth_* tables are intentionally Postgres-only
     * (web auth never runs on SQLite — see migrateColumns() and CLAUDE.md), so
     * the parity checks exclude that prefix. The separate, exact
     * remote_agent_codebases.allow_env_keys column exception is tracked by
     * #2318; keep it column-specific. A genuinely new Postgres-only table
     * must be added to the table allowlist with a justifying comment.
     *
     * Table discovery is deliberately independent of column-body parsing: a
     * table that is present in the migration but missing from sqlite.ts is the
     * original drift class (PR #2033), and it must stay caught even if its
     * CREATE body is unparseable for any reason.
     */
    const POSTGRES_ONLY_PREFIX = 'remote_agent_auth_';
    // #2318 owns this known dead Postgres-only residue. Keep the exception
    // column-specific so every other codebases column remains protected.
    const POSTGRES_ONLY_COLUMNS = new Set(['remote_agent_codebases.allow_env_keys']);
    // Reverse-direction residue: declared in sqlite.ts, never added to the
    // migration, and read by nothing. Harmless but real — and reverse drift is
    // the works-locally / breaks-on-the-Postgres-VPS direction, so the check
    // itself is worth keeping even though today it costs one entry.
    const SQLITE_ONLY_COLUMNS = new Set(['remote_agent_isolation_environments.updated_at']);
    const TABLE_CONSTRAINTS = new Set(['check', 'constraint', 'foreign', 'primary', 'unique']);
    /**
     * Floor for the number of non-auth columns actually compared. A parser bug
     * that silently drops columns (rather than mismatching them) makes the
     * comparison pass vacuously, which is exactly how a truncating body regex
     * shipped: a `);` inside a comment cut a table from 7 columns to 3 and the
     * suite stayed green. Adjust when the schema legitimately changes size —
     * the failure names the count, so the intended value is never a guess.
     */
    const MIN_NON_AUTH_COLUMNS = 136;

    /**
     * Archon table names declared by the Postgres migration. Body-independent
     * on purpose — see the note above about the PR #2033 drift class.
     */
    function postgresArchonTables(): string[] {
      const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z0-9_]+)"?/gi;
      // All Archon tables share this prefix (CLAUDE.md).
      const names = [...stripSqlComments(getSchemaSQL()).matchAll(re)]
        .map(m => m[1].toLowerCase())
        .filter(name => name.startsWith('remote_agent_'));
      return [...new Set(names)];
    }

    /** Extract Archon table columns declared or added by the Postgres migration. */
    function postgresArchonColumns(): Map<string, Set<string>> {
      // Comments are stripped first: `migrations/000_combined.sql` writes `);`
      // inside prose comments as a matter of house style, and any paren- or
      // semicolon-sensitive scan would otherwise end a table body early.
      const sql = stripSqlComments(getSchemaSQL());
      const columnsByTable = new Map<string, Set<string>>();
      const createTableRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z0-9_]+)"?\s*\(/gi;

      for (const match of sql.matchAll(createTableRe)) {
        const table = match[1].toLowerCase();
        if (!table.startsWith('remote_agent_')) continue;

        const columns = columnsByTable.get(table) ?? new Set<string>();
        // Depth-tracked so nested parens in REFERENCES / CHECK / DEFAULT
        // clauses cannot terminate the body or split a declaration.
        const body = readBalancedParens(sql, match.index + match[0].length - 1);
        for (const declaration of splitTopLevelCommas(body)) {
          const identifier = declaration.trim().match(/^(?:"([^"]+)"|([a-z_][a-z0-9_]*))/i);
          if (!identifier) continue;

          const column = identifier[1] ?? identifier[2].toLowerCase();
          if (!TABLE_CONSTRAINTS.has(column.toLowerCase())) columns.add(column);
        }
        columnsByTable.set(table, columns);
      }

      const addColumnRe =
        /ALTER TABLE\s+"?([a-z0-9_]+)"?\s+ADD COLUMN IF NOT EXISTS\s+"?([a-z_][a-z0-9_]*)"?/gi;
      for (const match of sql.matchAll(addColumnRe)) {
        const table = match[1].toLowerCase();
        if (!table.startsWith('remote_agent_')) continue;
        const columns = columnsByTable.get(table) ?? new Set<string>();
        columns.add(match[2].toLowerCase());
        columnsByTable.set(table, columns);
      }

      return columnsByTable;
    }

    /** Table → columns as the fresh SQLite schema (createSchema()) built them. */
    async function sqliteSchemaColumns(): Promise<Map<string, Set<string>>> {
      const result = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      return new Map(result.rows.map(r => [r.name, new Set(raw_pragma(currentDbPath, r.name))]));
    }

    test('every non-auth Postgres table is created by the SQLite schema', async () => {
      db = createTestDb();
      const result = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      const sqliteTables = new Set(result.rows.map(r => r.name));

      const expected = postgresArchonTables().filter(
        table => !table.startsWith(POSTGRES_ONLY_PREFIX)
      );
      // Sanity: the parse found the table set, including the exact table whose
      // absence triggered this regression — guards against the regex silently
      // missing a name and the assertion below passing vacuously.
      expect(expected.length).toBeGreaterThan(10);
      expect(expected).toContain('remote_agent_user_ai_prefs');

      const missing = expected.filter(name => !sqliteTables.has(name)).sort();
      expect(missing).toEqual([]);
    });

    test('every non-auth Postgres column exists in a fresh SQLite schema', async () => {
      db = createTestDb();
      const postgresColumns = postgresArchonColumns();
      const sqliteColumns = await sqliteSchemaColumns();

      // Anti-vacuity checks cover a CREATE declaration and an ALTER-only one.
      // Deliberately NOT an allowlisted column: fixing a listed drift should
      // require editing the allowlist and nothing else.
      expect(postgresColumns.get('remote_agent_codebases')?.has('default_cwd')).toBe(true);
      expect(postgresColumns.get('remote_agent_users')?.has('role')).toBe(true);

      const missing: string[] = [];
      let compared = 0;
      for (const table of postgresArchonTables()) {
        if (table.startsWith(POSTGRES_ONLY_PREFIX)) continue;
        const expectedColumns = postgresColumns.get(table) ?? new Set<string>();
        const actualColumns = sqliteColumns.get(table) ?? new Set<string>();
        for (const column of expectedColumns) {
          compared++;
          const qualifiedColumn = `${table}.${column}`;
          if (!actualColumns.has(column) && !POSTGRES_ONLY_COLUMNS.has(qualifiedColumn)) {
            missing.push(qualifiedColumn);
          }
        }
      }

      // Drift FIRST. The vacuity floor below is a guard on this test's own
      // reach, not a drift assertion -- and asserting it first lets it mask the
      // thing you actually need to see: two legitimate column removals plus one
      // real drift made the floor fire and the drift list never printed.
      expect(missing.sort()).toEqual([]);

      // Anti-vacuity: if the parser silently loses columns again (it did -- an
      // in-body `);` once cut workflow_events from 7 columns to 3 with the suite
      // still green), `missing` stays empty because there is nothing left to
      // compare. Thrown rather than expect()ed so the message explains itself:
      // a bare `Expected: >= 136 / Received: 135` under this test's name reads
      // as drift when it is either a parser regression or a legitimate removal.
      if (compared < MIN_NON_AUTH_COLUMNS) {
        throw new Error(
          `Schema-parity coverage collapsed: compared ${compared} non-auth columns, ` +
            `expected at least ${MIN_NON_AUTH_COLUMNS}. Either the migration parser has ` +
            `silently lost columns (check the CREATE TABLE body extraction), or columns ` +
            `were legitimately removed from migrations/000_combined.sql -- in which case ` +
            `lower MIN_NON_AUTH_COLUMNS to the new count. No drift was detected either way.`
        );
      }
    });

    test('every SQLite column exists in the Postgres migration', async () => {
      db = createTestDb();
      const postgresColumns = postgresArchonColumns();
      const sqliteColumns = await sqliteSchemaColumns();

      const extra: string[] = [];
      for (const [table, actualColumns] of sqliteColumns) {
        const expectedColumns = postgresColumns.get(table);
        // No Postgres counterpart at all: a SQLite-only table. Nothing else
        // checks this direction, so report the whole table rather than 20
        // individual column lines.
        if (!expectedColumns) {
          extra.push(`${table}.*`);
          continue;
        }
        for (const column of actualColumns) {
          const qualifiedColumn = `${table}.${column}`;
          if (!expectedColumns.has(column) && !SQLITE_ONLY_COLUMNS.has(qualifiedColumn)) {
            extra.push(qualifiedColumn);
          }
        }
      }

      expect(extra.sort()).toEqual([]);
    });

    /**
     * Self-expiring allowlists: an entry stops being an exception the moment
     * the drift it names is fixed, so assert each one still describes reality.
     * Fixing #2318 (dropping allow_env_keys from the migration) fails here
     * until the allowlist entry is deleted — the exception cannot outlive its
     * reason and quietly keep a real column unprotected.
     */
    test('parity allowlists still describe real drift', async () => {
      db = createTestDb();
      const postgresColumns = postgresArchonColumns();
      const sqliteColumns = await sqliteSchemaColumns();

      const stale: string[] = [];
      for (const qualifiedColumn of POSTGRES_ONLY_COLUMNS) {
        const [table, column] = qualifiedColumn.split('.');
        if (!postgresColumns.get(table)?.has(column)) {
          stale.push(`${qualifiedColumn} (no longer in the Postgres migration)`);
        }
        if (sqliteColumns.get(table)?.has(column)) {
          stale.push(`${qualifiedColumn} (now exists in SQLite)`);
        }
      }
      for (const qualifiedColumn of SQLITE_ONLY_COLUMNS) {
        const [table, column] = qualifiedColumn.split('.');
        if (!sqliteColumns.get(table)?.has(column)) {
          stale.push(`${qualifiedColumn} (no longer in the SQLite schema)`);
        }
        if (postgresColumns.get(table)?.has(column)) {
          stale.push(`${qualifiedColumn} (now exists in the Postgres migration)`);
        }
      }

      expect(stale.sort()).toEqual([]);
    });

    test('parent_run_id index exists on a fresh SQLite schema', () => {
      db = createTestDb();
      const indexes = raw_indexes(currentDbPath);
      expect(indexes).toContain('idx_workflow_runs_parent_run');
    });

    /**
     * Same rationale as parent_run_id above: `output_root` (#2200) is the
     * durable pointer to a run's storage tree. Missing on SQLite it would be
     * invisible on the Postgres VPS while breaking every default install.
     */
    test('output_root column present on a fresh SQLite schema and in the Postgres migration', () => {
      db = createTestDb();
      expect(raw_pragma(currentDbPath, 'remote_agent_workflow_runs')).toContain('output_root');
      expect(getSchemaSQL()).toContain('output_root');
    });
  });

  /**
   * Schema vintage (#2316). The value that matters most is the one the adapter
   * refuses to invent: a database created before this table existed has an
   * unknowable creation vintage, and must report NULL rather than today's build.
   */
  describe('schema version', () => {
    test('records the creating build on a fresh database', () => {
      db = createTestDb();
      const rows = raw_query(
        currentDbPath,
        'SELECT id, created_app_version, app_version FROM remote_agent_schema_version'
      ) as { id: number; created_app_version: string | null; app_version: string }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(1);
      expect(rows[0]?.created_app_version).toBe(APP_VERSION);
      expect(rows[0]?.app_version).toBe(APP_VERSION);
    });

    test('reopening a database does not revise the creation vintage', async () => {
      db = createTestDb();
      const dbPath = currentDbPath;
      await db.close();

      // Second open of the same file: created_app_version must survive untouched,
      // which is what makes it a record of the database rather than of this process.
      const reopened = new SqliteAdapter(dbPath);
      try {
        const rows = raw_query(
          dbPath,
          'SELECT created_app_version, app_version FROM remote_agent_schema_version'
        ) as { created_app_version: string | null; app_version: string }[];

        expect(rows).toHaveLength(1);
        expect(rows[0]?.created_app_version).toBe(APP_VERSION);
        expect(rows[0]?.app_version).toBe(APP_VERSION);
      } finally {
        await reopened.close();
        db = reopened;
      }
    });

    test('records a NULL creation vintage for a database that predates the table', async () => {
      // Simulate a pre-#2316 database: core tables already present, no version row.
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const seed = new Database(currentDbPath);
      seed.run(
        `CREATE TABLE remote_agent_codebases (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           default_cwd TEXT NOT NULL
         )`
      );
      seed.close();

      db = new SqliteAdapter(currentDbPath);
      const rows = raw_query(
        currentDbPath,
        'SELECT created_app_version, app_version FROM remote_agent_schema_version'
      ) as { created_app_version: string | null; app_version: string }[];

      expect(rows).toHaveLength(1);
      // Never back-filled with a guess — the unknowability is the reportable fact.
      expect(rows[0]?.created_app_version).toBeNull();
      expect(rows[0]?.app_version).toBe(APP_VERSION);
    });

    /**
     * migrateColumns() suppresses each table's failure so one bad ALTER cannot abort
     * startup — which means the schema may genuinely be incomplete. Stamping this
     * build onto that database would make the vintage a wrong answer that gets
     * believed, which is worse than no answer at all.
     */
    test('does not record a vintage when a column migration failed', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      // Seed a `remote_agent_users` whose shape makes migrateColumns' ALTER fail:
      // adding a NOT NULL column with a DEFAULT is fine, so instead occupy the name
      // with an incompatible object — a view cannot be ALTERed.
      const seed = new Database(currentDbPath);
      seed.run('CREATE TABLE remote_agent_users_backing (id TEXT PRIMARY KEY)');
      seed.run('CREATE VIEW remote_agent_users AS SELECT id FROM remote_agent_users_backing');
      seed.close();

      db = new SqliteAdapter(currentDbPath);

      const rows = raw_query(
        currentDbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='remote_agent_schema_version'"
      ) as { name: string }[];
      // The table itself is created by createSchema(); the row must be absent.
      expect(rows).toHaveLength(1);

      const versionRows = raw_query(
        currentDbPath,
        'SELECT app_version FROM remote_agent_schema_version'
      ) as { app_version: string }[];
      expect(versionRows).toHaveLength(0);
      expect(await readSchemaVersion(db)).toBeNull();
    });

    test('readSchemaVersion surfaces the row through the adapter', async () => {
      db = createTestDb();
      const info = await readSchemaVersion(db);

      expect(info).not.toBeNull();
      expect(info?.createdAppVersion).toBe(APP_VERSION);
      expect(info?.appVersion).toBe(APP_VERSION);
      expect(info?.appliedAt).toBeTruthy();
    });
  });
});

/**
 * Advance past a SQL string literal / quoted identifier that opens at `start`,
 * returning the index of its closing quote. Doubled quotes escape.
 */
function skipQuoted(sql: string, start: number): number {
  const quote = sql[start];
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue;
    // A doubled quote escapes itself — not the end of the literal.
    if (sql[i + 1] === quote) i++;
    else return i;
  }
  return sql.length;
}

/** Remove SQL line and block comments, preserving quoted text. */
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'" || sql[i] === '"') {
      const end = skipQuoted(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/**
 * Return the text between the `(` at `openIndex` and its matching `)`, tracking
 * nesting depth so `REFERENCES t(id)` / `CHECK (id = 1)` / `DEFAULT NOW()` do
 * not end the body early. Throws rather than returning a truncated body — a
 * silently short column list is the failure mode this whole parser guards.
 */
function readBalancedParens(sql: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i++) {
    if (sql[i] === "'" || sql[i] === '"') i = skipQuoted(sql, i);
    else if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return sql.slice(openIndex + 1, i);
  }
  throw new Error(`Unbalanced parentheses in schema SQL at index ${openIndex}`);
}

/** Split a CREATE TABLE body on its top-level commas (depth- and quote-aware). */
function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'" || body[i] === '"') i = skipQuoted(body, i);
    else if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function raw_pragma(dbPath: string, table: string): string[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[];
    return rows.map(r => r.name);
  } finally {
    raw.close();
  }
}

function raw_indexes(dbPath: string): string[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
      name: string;
    }[];
    return rows.map(r => r.name);
  } finally {
    raw.close();
  }
}

function raw_query(dbPath: string, sql: string): unknown[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.prepare(sql).all();
  } finally {
    raw.close();
  }
}
