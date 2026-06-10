import { describe, test, expect, afterEach } from 'bun:test';
import { SqliteAdapter } from './sqlite';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';

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
});

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
