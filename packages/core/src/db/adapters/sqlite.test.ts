// @archon-test-isolated
import {
  postgresArchonColumns,
  stripSqlComments,
  readBalancedParens,
} from './sqlite-schema-test-helpers';
import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import {
  resourceStartOverlapSchema,
  resourceStartRequestStatusSchema,
  startBindingPreparationStatusSchema,
  sourceReceiptOutcomeSchema,
} from '@archon/workflows/schemas/resource-start';
import { SqliteAdapter, sqliteDialect } from './sqlite';
import { getSchemaSQL } from '../bundled-schema';
import { APP_VERSION, readSchemaVersion } from '../schema-version';
import { webPushSubscriptionRowSchema } from '../../schemas/web-push';
import { Database, SQLiteError, type Statement } from 'bun:sqlite';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { trackTempRoots } from '@archon/paths/test-utils';
import { raw_indexes, raw_pragma, raw_query } from './sqlite-test-harness';

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

const trackTempRoot = trackTempRoots();

/**
 * A fresh on-disk database path for one upgrade fixture, reclaimed after the test.
 *
 * A real file, not a `file:...?mode=memory&cache=shared` URI: bun:sqlite opens without
 * `SQLITE_OPEN_URI`, so SQLite reads such a URI as a literal filename and creates it in
 * the process cwd — which is how these fixtures used to leave `file:archon-test-sqlite-*`
 * files under `packages/core/`. The adapter has no URI requirement, and the fixture only
 * needs a database that survives being reopened.
 */
async function upgradeFixturePath(): Promise<string> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-sqlite-upgrade-')));
  return join(root, 'archon.db');
}

describe('SqliteAdapter failure logging', () => {
  test.each(['query', 'transaction'] as const)(
    'keeps diagnostics without bound values for a failing %s insert',
    async mode => {
      const path = await upgradeFixturePath();
      const db = new SqliteAdapter(path);
      const sql =
        'INSERT INTO remote_agent_messages (conversation_id, role, content) VALUES ($1, $2, $3)';
      const secret = 'recognizable-private-message-3809';
      const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
      let failure: unknown;
      let lines: string[];
      try {
        const insert = (query: SqliteAdapter['query']) =>
          query(sql, ['missing-conversation', 'user', secret]);
        failure = await (mode === 'query'
          ? insert(db.query.bind(db))
          : db.withTransaction(insert)
        ).catch((error: unknown) => error);
        lines = output.mock.calls.map(call => String(call[0]));
      } finally {
        output.mockRestore();
        await db.close();
      }
      expect(failure).toBeInstanceOf(SQLiteError);
      if (!(failure instanceof SQLiteError)) throw new Error('Expected SQLite constraint failure');
      const record = lines
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .find(line => line.msg === 'db.sqlite_query_failed');
      expect(record).toMatchObject({
        sql,
        paramCount: 3,
        err: {
          code: failure.code,
          errno: failure.errno,
          message: 'Query failed (error details withheld to protect bound values)',
        },
      });
      expect(lines.join('')).not.toContain(secret);
      expect(lines.join('')).not.toContain('missing-conversation');
      expect(record).not.toHaveProperty('params');
    }
  );

  test.each(
    (['query', 'transaction'] as const).flatMap(mode =>
      [
        'SELECT json_extract($1, $2)',
        'WITH value AS (SELECT json_extract($1, $2) AS result) SELECT * FROM value',
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('test', json_extract($1, $2), '/tmp')",
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('test', json_extract($1, $2), '/tmp') RETURNING *",
      ].map(sql => ({ mode, sql }))
    )
  )('withholds driver-echoed values for $mode: $sql', async ({ mode, sql }) => {
    const db = new SqliteAdapter(await upgradeFixturePath());
    const secret = 'recognizable-private-json-path-3809';
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
    let failure: unknown;
    let lines: string[];
    try {
      const query = (execute: SqliteAdapter['query']) => execute(sql, ['{}', secret]);
      failure = await (mode === 'query'
        ? query(db.query.bind(db))
        : db.withTransaction(query)
      ).catch((error: unknown) => error);
      lines = output.mock.calls.map(call => String(call[0]));
    } finally {
      output.mockRestore();
      await db.close();
    }
    expect(failure).toBeInstanceOf(SQLiteError);
    if (!(failure instanceof SQLiteError)) throw new Error('Expected SQLite JSON-path failure');
    expect(failure.message).toContain(secret);
    const record = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.msg === 'db.sqlite_query_failed');
    expect(record).toMatchObject({
      sql,
      paramCount: 2,
      err: {
        code: failure.code,
        errno: failure.errno,
        message: 'Query failed (error details withheld to protect bound values)',
      },
    });
    expect(lines.join('')).not.toContain(secret);
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

    /** Table → columns as the fresh SQLite schema (createSchema()) built them. */
    async function sqliteSchemaColumns(): Promise<Map<string, Set<string>>> {
      const result = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      return new Map(result.rows.map(r => [r.name, new Set(raw_pragma(currentDbPath, r.name))]));
    }

    test('the subscription row schema matches both persisted table shapes', async () => {
      db = createTestDb();
      const table = 'remote_agent_web_push_subscriptions';
      const expected = Object.keys(webPushSubscriptionRowSchema.shape).sort();
      const sqliteColumns = (await sqliteSchemaColumns()).get(table);
      const postgresColumns = postgresArchonColumns().get(table);
      expect([...(sqliteColumns ?? [])].sort()).toEqual(expected);
      expect([...(postgresColumns ?? [])].sort()).toEqual(expected);
    });

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
      expect(postgresColumns.get('remote_agent_workflow_event_archive')?.has('event_order')).toBe(
        true
      );
      expect(postgresColumns.get('remote_agent_workflow_event_archive')).toEqual(
        postgresColumns.get('remote_agent_workflow_events')
      );

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

    test('admission CHECK vocabularies match their owning schemas in both dialects', async () => {
      db = createTestDb();
      const checks = [
        {
          table: 'remote_agent_start_receipts',
          column: 'outcome',
          values: sourceReceiptOutcomeSchema.options,
        },
        {
          table: 'remote_agent_start_receipt_bindings',
          column: 'preparation_status',
          values: startBindingPreparationStatusSchema.options,
        },
        {
          table: 'remote_agent_resource_start_requests',
          column: 'overlap_policy',
          values: resourceStartOverlapSchema.options,
        },
        {
          table: 'remote_agent_resource_start_requests',
          column: 'status',
          values: resourceStartRequestStatusSchema.options.map(option => option.value),
        },
      ];
      const postgres = stripSqlComments(getSchemaSQL());
      for (const { table, column, values } of checks) {
        const sqlite = await db.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $1",
          [table]
        );
        const declaration = new RegExp(
          `CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${table}\\s*\\(`
        ).exec(postgres);
        if (!declaration) throw new Error(`Missing Postgres table ${table}`);
        const pgBody = readBalancedParens(postgres, declaration.index + declaration[0].length - 1);
        for (const body of [sqlite.rows[0]?.sql, pgBody]) {
          const constraint = new RegExp(`${column} IN \\(([^)]+)\\)`).exec(body ?? '');
          expect(constraint).not.toBeNull();
          const stored = [...(constraint?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);
          expect(stored.sort()).toEqual([...values].sort());
        }
      }
    });

    test('authored outcome is nullable and constrained identically in both schema sources', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-outcome');
      await db.query(
        `INSERT INTO remote_agent_conversations
           (id, platform_type, platform_conversation_id, codebase_id)
         VALUES ($1, $2, $3, $4)`,
        ['conv-outcome', 'web', 'thread-outcome', 'cb-outcome']
      );
      await db.query(
        `INSERT INTO remote_agent_workflow_runs
           (id, conversation_id, workflow_name, user_message, outcome)
         VALUES ($1, $2, $3, $4, $5)`,
        ['run-outcome', 'conv-outcome', 'verify', 'test', 'succeeded']
      );
      const rows = await db.query<{ outcome: string | null }>(
        'SELECT outcome FROM remote_agent_workflow_runs WHERE id = $1',
        ['run-outcome']
      );
      expect(rows.rows[0]?.outcome).toBe('succeeded');
      await expect(
        db.query(
          `INSERT INTO remote_agent_workflow_runs
             (id, conversation_id, workflow_name, user_message, outcome)
           VALUES ($1, $2, $3, $4, $5)`,
          ['run-bad-outcome', 'conv-outcome', 'verify', 'test', 'unknown']
        )
      ).rejects.toThrow();
      expect(getSchemaSQL()).toContain("CHECK (outcome IN ('succeeded', 'failed'))");
    });

    test('run-scoped session handles cascade with their workflow run in both schema shapes', async (): Promise<void> => {
      db = createTestDb();
      await insertCodebase(db, 'cb-session-cascade');
      await db.query(
        `INSERT INTO remote_agent_conversations
           (id, platform_type, platform_conversation_id, codebase_id)
         VALUES ($1, $2, $3, $4)`,
        ['conv-session-cascade', 'web', 'thread-session-cascade', 'cb-session-cascade']
      );
      await db.query(
        `INSERT INTO remote_agent_workflow_runs
           (id, conversation_id, workflow_name, user_message)
         VALUES ($1, $2, $3, $4)`,
        ['run-session-cascade', 'conv-session-cascade', 'lineage', 'test']
      );
      await db.query(
        `INSERT INTO remote_agent_workflow_run_node_sessions
           (workflow_run_id, node_id, provider, provider_session_id)
         VALUES ($1, $2, $3, $4)`,
        ['run-session-cascade', 'scope', 'claude', 'session-secret']
      );

      await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [
        'run-session-cascade',
      ]);
      const rows = await db.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM remote_agent_workflow_run_node_sessions'
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
      expect(getSchemaSQL()).toMatch(
        /remote_agent_workflow_run_node_sessions[\s\S]*workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs\(id\) ON DELETE CASCADE/
      );
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

describe('SqliteAdapter native-resource finalization (#2875)', () => {
  let adapter: SqliteAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.close();
      adapter = undefined;
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(currentDbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
  });

  test('finalizes every statement it prepares by the time close() resolves', async () => {
    const originalPrepare = Database.prototype.prepare;
    let prepared = 0;
    let finalized = 0;
    Object.defineProperty(Database.prototype, 'prepare', {
      configurable: true,
      value(this: Database, ...args: Parameters<typeof originalPrepare>) {
        const stmt: Statement = originalPrepare.apply(this, args);
        prepared++;
        const nativeFinalize = stmt.finalize.bind(stmt);
        stmt.finalize = () => {
          finalized++;
          return nativeFinalize();
        };
        return stmt;
      },
    });

    try {
      adapter = createTestDb();
      await insertCodebase(adapter, 'cb-finalize');
      await adapter.query('SELECT id FROM remote_agent_codebases WHERE id = $1', ['cb-finalize']);

      // A statement that prepares cleanly but fails on execution (primary key
      // violation) must still be finalized (this is the finally-branch of the fix).
      await expect(insertCodebase(adapter, 'cb-finalize')).rejects.toThrow();

      await adapter.close();
      adapter = undefined;

      expect(prepared).toBeGreaterThan(0);
      expect(finalized).toBe(prepared);
    } finally {
      Object.defineProperty(Database.prototype, 'prepare', {
        configurable: true,
        value: originalPrepare,
      });
    }
  });

  test('close() leaves the database file immediately deletable', async () => {
    adapter = createTestDb();
    await insertCodebase(adapter, 'cb-delete');
    await adapter.query('SELECT id FROM remote_agent_codebases WHERE id = $1', ['cb-delete']);
    await adapter.close();
    adapter = undefined;

    // Passes trivially where POSIX unlink tolerates open handles, but on
    // windows-latest this fails with EBUSY while any statement is unfinalized.
    unlinkSync(currentDbPath);
  });
});

describe('SqliteAdapter busy locks', () => {
  let adapter: SqliteAdapter;
  let holder: Database;

  async function lockedAdapter(): Promise<string> {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-sqlite-busy-')));
    const path = join(root, 'archon.db');
    adapter = new SqliteAdapter(path);
    // The adapter's own 5 s busy_timeout would make these tests slow, not different.
    await adapter.query('PRAGMA busy_timeout = 20');
    holder = new Database(path);
    holder.run('BEGIN IMMEDIATE');
    return path;
  }

  afterEach(async () => {
    if (holder.inTransaction) holder.run('ROLLBACK');
    holder.close();
    await adapter.close();
  });

  /**
   * Settle `promise` and return its rejection message. On Windows, Bun's
   * `expect(promise).rejects` on a promise still waiting on a timer started inside
   * AsyncLocalStorage.run (the adapter's transaction scope) blocks the event loop, so
   * the timer never fires and the test hangs past its own timeout.
   */
  async function rejectionMessage(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async function codebaseCount(): Promise<number> {
    const result = await adapter.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM remote_agent_codebases'
    );
    return Number(result.rows[0]?.cnt);
  }

  test('a statement waits past busy_timeout and writes once', async () => {
    await lockedAdapter();
    // Several 20 ms busy timeouts elapse before the holder lets go.
    const released = Bun.sleep(150).then(() => holder.run('COMMIT'));

    await insertCodebase(adapter, 'cb-busy');
    await released;

    expect(await codebaseCount()).toBe(1);
  });

  test('a transaction rolls back and reruns from BEGIN until the lock clears', async () => {
    await lockedAdapter();
    const released = Bun.sleep(150).then(() => holder.run('COMMIT'));
    let attempts = 0;

    await adapter.withTransaction(async query => {
      attempts++;
      await query(
        `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
        ['cb-tx', 'cb-tx', '/tmp/test-cwd']
      );
    });
    await released;

    expect(attempts).toBeGreaterThan(1);
    expect(await codebaseCount()).toBe(1);
  });

  test('a non-replayable transaction retries its claim without replaying its callback', async () => {
    await lockedAdapter();
    const released = Bun.sleep(150).then(() => holder.run('COMMIT'));
    let attempts = 0;
    await adapter.withTransaction(
      async query => {
        attempts++;
        await query(
          `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
          ['cb-once', 'cb-once', '/tmp/test-cwd']
        );
      },
      { retryOnBusy: 'first-statement' }
    );
    await released;
    expect(attempts).toBe(1);
    expect(await codebaseCount()).toBe(1);
  });

  test('a busy failure after a side effect never replays destruction', async () => {
    const path = await lockedAdapter();
    const contender = new Database(path);
    let busy: unknown;
    try {
      contender.run('BEGIN IMMEDIATE');
    } catch (error) {
      busy = error;
    } finally {
      contender.close();
      holder.run('COMMIT');
    }
    expect(busy).toBeInstanceOf(SQLiteError);
    let destructions = 0;
    await expect(
      adapter.withTransaction(
        async query => {
          await query(
            `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
            ['cb-destroy', 'cb-destroy', '/tmp/test-cwd']
          );
          destructions++;
          if (destructions === 1) throw busy;
        },
        { retryOnBusy: 'first-statement' }
      )
    ).rejects.toBe(busy);
    expect(destructions).toBe(1);
    expect(await codebaseCount()).toBe(0);
  });

  test('a block that wraps the busy error in its own still reruns from BEGIN', async () => {
    await lockedAdapter();
    const released = Bun.sleep(150).then(() => holder.run('COMMIT'));
    let attempts = 0;

    await adapter.withTransaction(async query => {
      attempts++;
      try {
        await query(
          `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
          ['cb-wrapped', 'cb-wrapped', '/tmp/test-cwd']
        );
      } catch (error) {
        throw new Error(`Failed to create codebase: ${(error as Error).message}`);
      }
    });
    await released;

    expect(attempts).toBeGreaterThan(1);
    expect(await codebaseCount()).toBe(1);
  });

  test('a stale snapshot reruns the transaction instead of retrying the statement', async () => {
    await lockedAdapter();
    holder.run(
      "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('cb-holder', 'cb-holder', '/tmp')"
    );
    const seen: number[] = [];

    await adapter.withTransaction(async query => {
      const before = await query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM remote_agent_codebases'
      );
      seen.push(Number(before.rows[0]?.cnt));
      // The holder commits after this transaction took its read snapshot, so the
      // first write fails with SQLITE_BUSY_SNAPSHOT however long it waits.
      if (holder.inTransaction) holder.run('COMMIT');
      await query(
        `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
        ['cb-snapshot', 'cb-snapshot', '/tmp/test-cwd']
      );
    });

    expect(seen).toEqual([0, 1]);
    expect(await codebaseCount()).toBe(2);
  });

  test("a waiting statement does not retry into another caller's transaction", async () => {
    await lockedAdapter();
    const released = Bun.sleep(100).then(() => holder.run('COMMIT'));

    const statement = insertCodebase(adapter, 'cb-outside');
    // Let the statement fail busy once and start its backoff sleep.
    await Bun.sleep(30);
    // A transaction that stays open past the statement's retry, then rolls back.
    const transaction = adapter.withTransaction(async query => {
      await query('SELECT 1');
      await Bun.sleep(300);
      throw new Error('abort');
    });

    await statement;
    expect(await rejectionMessage(transaction)).toBe('abort');
    await released;

    expect(await codebaseCount()).toBe(1);
  });

  test("a plain statement never runs inside another caller's open transaction", async () => {
    await lockedAdapter();
    holder.run('COMMIT');

    const transaction = adapter.withTransaction(async query => {
      await query('SELECT 1');
      await Bun.sleep(100);
      throw new Error('abort');
    });
    // Issued while the transaction is open and waiting on something else.
    await Bun.sleep(20);
    const statement = insertCodebase(adapter, 'cb-plain');

    expect(await rejectionMessage(transaction)).toBe('abort');
    await statement;

    expect(await codebaseCount()).toBe(1);
  });

  test('the public query inside a transaction block fails instead of waiting on itself', async () => {
    await lockedAdapter();
    holder.run('COMMIT');

    await expect(
      adapter.withTransaction(async () => {
        await adapter.query('SELECT 1');
      })
    ).rejects.toThrow("use the transaction's query instead");
    await expect(
      adapter.withTransaction(() => adapter.withTransaction(async () => undefined))
    ).rejects.toThrow("use the transaction's query instead");
    // The connection is still usable afterwards.
    await insertCodebase(adapter, 'cb-after');
    expect(await codebaseCount()).toBe(1);
  });

  test('a non-busy error still fails on the first attempt', async () => {
    await lockedAdapter();
    holder.run('COMMIT');
    await insertCodebase(adapter, 'cb-dup');
    let attempts = 0;

    await expect(insertCodebase(adapter, 'cb-dup')).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
    await expect(
      adapter.withTransaction(async query => {
        attempts++;
        await query(
          `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
          ['cb-dup', 'cb-dup', '/tmp/test-cwd']
        );
      })
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    expect(attempts).toBe(1);
  });
});

/** Read a child's stdout line by line until `done` accepts one; the stream may split lines. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  done: (line: string) => boolean
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    if (lines.some(line => done(line.trim()))) return;
  }
  throw new Error('stream ended before the expected line');
}

describe('SqliteAdapter fresh schema', () => {
  /** Commit frames in the WAL: one per committed write transaction since the last checkpoint. */
  function walCommits(path: string): number {
    const wal = readFileSync(`${path}-wal`);
    const pageSize = wal.readUInt32BE(8);
    let commits = 0;
    for (let offset = 32; offset + 24 <= wal.length; offset += 24 + pageSize) {
      if (wal.readUInt32BE(offset + 4) !== 0) commits++;
    }
    return commits;
  }

  test('a fresh database receives its tables in one commit, not one per table', async () => {
    // Each commit is an fsync; per-statement commits made a first open cost seconds on
    // a slow disk.
    const path = await upgradeFixturePath();
    const adapter = new SqliteAdapter(path);
    try {
      const tables = raw_query(
        path,
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'"
      ) as { n: number }[];
      expect(walCommits(path)).toBeLessThan(Number(tables[0]?.n) / 2);
    } finally {
      await adapter.close();
    }
  });

  test('opening waits out another process that holds a fresh file instead of failing', async () => {
    // Switching a file to WAL fails with SQLITE_BUSY at once, without busy_timeout,
    // while another connection holds a write lock on it. The holder releases only after
    // the opener has reported waiting, so the test always exercises the contention.
    const path = await upgradeFixturePath();
    const holder = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(path)});
// COMMIT needs the opener's read lock gone; without a timeout it can fail SQLITE_BUSY.
db.run('PRAGMA busy_timeout = 30000');
db.run('CREATE TABLE IF NOT EXISTS held (a)');
db.run('BEGIN IMMEDIATE');
db.run('INSERT INTO held VALUES (1)');
console.log('held');
for await (const _ of console) break;
db.run('COMMIT');`,
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' }
    );
    await readUntil(holder.stdout, line => line === 'held');
    const opener = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const { SqliteAdapter } = await import(${JSON.stringify(join(import.meta.dir, 'sqlite.ts'))});
const adapter = new SqliteAdapter(${JSON.stringify(path)});
await adapter.query('SELECT COUNT(*) FROM remote_agent_codebases');
await adapter.close();`,
      ],
      { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, LOG_LEVEL: 'warn' } }
    );
    try {
      await readUntil(opener.stdout, line => line.includes('db.sqlite_busy_waiting'));
    } finally {
      holder.stdin.write('release\n');
      await holder.stdin.end();
    }
    expect(await holder.exited).toBe(0);
    expect(await opener.exited).toBe(0);
  });

  test('processes opening the same fresh file at once all get the full schema', async () => {
    const path = await upgradeFixturePath();
    const source = `const { SqliteAdapter } = await import(${JSON.stringify(join(import.meta.dir, 'sqlite.ts'))});
await new SqliteAdapter(${JSON.stringify(path)}).close();`;
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, '-e', source], { stdout: 'ignore', stderr: 'pipe' })
    );
    const results = await Promise.all(
      children.map(async child => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      }))
    );
    expect(results.filter(result => result.code !== 0)).toEqual([]);
    const reopened = new SqliteAdapter(path);
    try {
      await reopened.query('SELECT COUNT(*) FROM remote_agent_codebases');
    } finally {
      await reopened.close();
    }
  });
});

describe('sqliteDialect', () => {
  test('jsonText reads a dotted path with json_extract', () => {
    expect(sqliteDialect.jsonText('w.metadata', 'approval.attempt')).toBe(
      "json_extract(w.metadata, '$.approval.attempt')"
    );
  });

  test('jsonRemove removes every key in one json_remove', () => {
    expect(sqliteDialect.jsonRemove('metadata', 'approval', 'wait')).toBe(
      "json_remove(metadata, '$.approval', '$.wait')"
    );
  });

  test('rowLock is empty because SQLite has no row locks', () => {
    expect(sqliteDialect.rowLock('w')).toBe('');
  });
});
