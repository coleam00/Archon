/**
 * Real-Postgres integration test for scripts/migrate-sqlite-to-postgres.ts.
 *
 * Boots a postgres:17-alpine container via 'docker run', runs the migration
 * against a fresh SQLite source (mixed 32-char hex + 36-char canonical
 * UUIDs), and asserts the type-coercion matrix from
 * docs/plans/archon-postgres-migration.md.
 *
 * Skips automatically if Docker is not available. Uses port 5433 to avoid
 * clashing with a local Postgres on 5432.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { $ } from 'bun';
import { Database } from 'bun:sqlite';
import { Pool } from 'pg';
import { resolve } from 'path';
import { spawn } from 'bun';
import type { Subprocess } from 'bun';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const CONTAINER_PORT = 5433;
const POSTGRES_USER = 'archon_test';
const POSTGRES_PASSWORD = 'test';
const POSTGRES_DB = 'archon_test';
const IMAGE = 'postgres:17-alpine';
const PING_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 500;
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const COMBINED_SCHEMA = resolve(REPO_ROOT, 'migrations', '000_combined.sql');
const MIGRATE_SCRIPT = resolve(REPO_ROOT, 'scripts', 'migrate-sqlite-to-postgres.ts');

let containerId: string | null = null;
let dockerAvailable = false;
let pool: Pool | null = null;
let sourceDbPath: string | null = null;
let tmpDir: string | null = null;

function waitForPostgresReady(): Promise<void> {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const start = Date.now();
  const tick = async (): Promise<void> => {
    if (Date.now() - start > PING_TIMEOUT_MS) {
      reject(new Error(`pg_isready timed out after ${PING_TIMEOUT_MS}ms`));
      return;
    }
    if (containerId !== null) {
      const dockerPing = await $`docker exec ${containerId} pg_isready -U ${POSTGRES_USER}`
        .quiet()
        .nothrow();
      if (dockerPing.exitCode === 0) {
        resolve();
        return;
      }
    }
    setTimeout(tick, PING_INTERVAL_MS);
  };
  void tick();
  return ready;
}

function pgConnectionUrl(): string {
  return `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${CONTAINER_PORT}/${POSTGRES_DB}`;
}

function seedSqlite(path: string): void {
  const db = new Database(path);
  // All 10 application tables — most empty, but the migration reads
  // every one in FK order, so the schema must mirror the live DB.
  db.exec(`
    CREATE TABLE remote_agent_users (
      id TEXT PRIMARY KEY, display_name TEXT, email TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE remote_agent_user_identities (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      platform TEXT NOT NULL, platform_user_id TEXT NOT NULL,
      platform_display_name TEXT, created_at TEXT
    );
    CREATE TABLE remote_agent_codebases (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repository_url TEXT,
      default_cwd TEXT NOT NULL, default_branch TEXT DEFAULT 'main',
      ai_assistant_type TEXT DEFAULT 'claude',
      commands TEXT DEFAULT '{}',
      created_at TEXT, updated_at TEXT,
      allow_env_keys INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE remote_agent_codebase_env_vars (
      id TEXT PRIMARY KEY, codebase_id TEXT NOT NULL,
      key TEXT NOT NULL, value TEXT NOT NULL,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE remote_agent_conversations (
      id TEXT PRIMARY KEY, platform_type TEXT NOT NULL,
      platform_conversation_id TEXT NOT NULL,
      ai_assistant_type TEXT DEFAULT 'claude',
      codebase_id TEXT, cwd TEXT, isolation_env_id TEXT,
      title TEXT, deleted_at TEXT, hidden INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT, last_activity_at TEXT, user_id TEXT
    );
    CREATE TABLE remote_agent_sessions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, codebase_id TEXT,
      ai_assistant_type TEXT NOT NULL DEFAULT 'claude',
      assistant_session_id TEXT, active INTEGER DEFAULT 1,
      metadata TEXT DEFAULT '{}',
      started_at TEXT, ended_at TEXT, parent_session_id TEXT,
      transition_reason TEXT, ended_reason TEXT
    );
    CREATE TABLE remote_agent_isolation_environments (
      id TEXT PRIMARY KEY, codebase_id TEXT NOT NULL,
      workflow_type TEXT NOT NULL, workflow_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'worktree',
      working_path TEXT NOT NULL, branch_name TEXT NOT NULL,
      created_by_platform TEXT, metadata TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT, updated_at TEXT, created_by_user_id TEXT
    );
    CREATE TABLE remote_agent_workflow_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, codebase_id TEXT,
      workflow_name TEXT NOT NULL, user_message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step_index INTEGER, metadata TEXT DEFAULT '{}',
      parent_conversation_id TEXT,
      started_at TEXT, completed_at TEXT, last_activity_at TEXT,
      working_path TEXT, user_id TEXT
    );
    CREATE TABLE remote_agent_workflow_events (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL, step_index INTEGER, step_name TEXT,
      data TEXT DEFAULT '{}', created_at TEXT
    );
    CREATE TABLE remote_agent_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', metadata TEXT DEFAULT '{}',
      created_at TEXT, user_id TEXT
    );
  `);

  const ID32_CODEBASE = 'aaaa1111bbbb2222cccc3333dddd4444';
  const ID32_CONV = '1111aaaa2222bbbb3333cccc4444dddd';
  const ID32_RUN = '2222aaaa3333bbbb4444cccc5555dddd';
  const ID36_EVENT = 'aabbccdd-eeff-0011-2233-445566778899';

  db.prepare(
    `INSERT INTO remote_agent_codebases
       (id, name, default_cwd, default_branch, commands, allow_env_keys, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ID32_CODEBASE,
    'test-codebase',
    '/tmp/test',
    'main',
    '{"scripts":{"lint":"eslint ."}}',
    0,
    '2026-06-03T10:00:00.000Z',
    '2026-06-03T10:00:00.000Z'
  );
  db.prepare(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id, codebase_id, hidden, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ID32_CONV,
    'cli',
    'test-conv-1',
    ID32_CODEBASE,
    1,
    '2026-06-03T10:01:00.000Z',
    '2026-06-03T10:01:00.000Z',
    '2026-06-03T10:01:00.000Z'
  );
  db.prepare(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(ID32_RUN, ID32_CONV, 'test-wf', 'run me', 'pending', '2026-06-03T10:02:00.000Z');
  db.prepare(
    `INSERT INTO remote_agent_workflow_events
       (id, workflow_run_id, event_type, data, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(ID36_EVENT, ID32_RUN, 'started', '{"step":1,"ok":true}', '2026-06-03T10:02:30.000Z');

  db.close();
}

async function runMigrationCli(args: string[]): Promise<number> {
  const proc: Subprocess = spawn({
    cmd: ['bun', 'run', MIGRATE_SCRIPT, ...args],
    env: { ...process.env, DATABASE_URL: pgConnectionUrl() },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.error(
      `migration script exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    );
  }
  return code;
}

async function sql<T = unknown>(sqlText: string, params: unknown[] = []): Promise<T[]> {
  if (pool === null) throw new Error('pool not initialized');
  const result = await pool.query<T>(sqlText, params);
  return result.rows;
}

describe('archon migrate-sqlite-to-postgres (real Postgres)', () => {
  beforeAll(async () => {
    const dockerCheck = await $`which docker`.quiet().nothrow();
    if (dockerCheck.exitCode !== 0) {
      dockerAvailable = false;
      // eslint-disable-next-line no-console
      console.warn('docker not available — skipping integration test');
      return;
    }
    dockerAvailable = true;

    tmpDir = mkdtempSync(resolve(tmpdir(), 'archon-migration-int-'));
    sourceDbPath = resolve(tmpDir, 'source.db');
    seedSqlite(sourceDbPath);

    const runResult =
      await $`docker run -d --rm -p ${CONTAINER_PORT}:5432 -e POSTGRES_USER=${POSTGRES_USER} -e POSTGRES_PASSWORD=${POSTGRES_PASSWORD} -e POSTGRES_DB=${POSTGRES_DB} ${IMAGE}`.quiet();
    containerId = runResult.stdout.toString().trim();
    if (!containerId) {
      throw new Error('docker run produced no container id');
    }

    try {
      await waitForPostgresReady();
    } catch (err) {
      await $`docker stop ${containerId}`.quiet().nothrow();
      containerId = null;
      throw err;
    }

    await $`docker exec -i ${containerId} env PGPASSWORD=${POSTGRES_PASSWORD} psql -U ${POSTGRES_USER} -d ${POSTGRES_DB} -v ON_ERROR_STOP=1 < ${COMBINED_SCHEMA}`.quiet();

    pool = new Pool({
      connectionString: pgConnectionUrl(),
      max: 2,
      statement_timeout: 30_000,
    });

    const code = await runMigrationCli(['--from', sourceDbPath, '--to', pgConnectionUrl()]);
    if (code !== 0) {
      throw new Error(`initial migration run failed with exit code ${code}`);
    }
  }, 90_000);

  afterAll(async () => {
    if (pool) {
      await pool.end().catch(() => undefined);
      pool = null;
    }
    if (containerId !== null) {
      await $`docker stop ${containerId}`.quiet().nothrow();
      containerId = null;
    }
    if (tmpDir !== null) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      tmpDir = null;
      sourceDbPath = null;
    }
  });

  describe('migration transforms', () => {
    test('all four populated tables landed in Postgres', async () => {
      if (!dockerAvailable) return;
      const cbCount = (
        await sql<{ count: string }>(`SELECT count(*)::text AS count FROM remote_agent_codebases`)
      )[0]?.count;
      const convCount = (
        await sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM remote_agent_conversations`
        )
      )[0]?.count;
      const runCount = (
        await sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM remote_agent_workflow_runs`
        )
      )[0]?.count;
      const evCount = (
        await sql<{ count: string }>(
          `SELECT count(*)::text AS count FROM remote_agent_workflow_events`
        )
      )[0]?.count;
      expect(cbCount).toBe('1');
      expect(convCount).toBe('1');
      expect(runCount).toBe('1');
      expect(evCount).toBe('1');
    });

    test('32-char hex IDs become canonical UUIDs', async () => {
      if (!dockerAvailable) return;
      const rows = await sql<{ id: string; name: string }>(
        `SELECT id, name FROM remote_agent_codebases WHERE name = 'test-codebase'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('36-char canonical UUIDs pass through', async () => {
      if (!dockerAvailable) return;
      const rows = await sql<{ id: string }>(`SELECT id FROM remote_agent_workflow_events LIMIT 1`);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe('aabbccdd-eeff-0011-2233-445566778899');
    });

    test('INTEGER 0/1 becomes BOOLEAN (column type + value)', async () => {
      if (!dockerAvailable) return;
      const typeRows = await sql<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'remote_agent_conversations' AND column_name = 'hidden'`
      );
      expect(typeRows[0]?.data_type).toBe('boolean');
      const rows = await sql<{ hidden: boolean }>(
        `SELECT hidden FROM remote_agent_conversations WHERE platform_conversation_id = 'test-conv-1'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.hidden).toBe(true);
    });

    test('TEXT JSON becomes JSONB (column type + shape preserved)', async () => {
      if (!dockerAvailable) return;
      const typeRows = await sql<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'remote_agent_codebases' AND column_name = 'commands'`
      );
      expect(typeRows[0]?.data_type).toBe('jsonb');
      const rows = await sql<{ commands: { scripts?: { lint?: string } } }>(
        `SELECT commands FROM remote_agent_codebases WHERE name = 'test-codebase'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.commands.scripts?.lint).toBe('eslint .');
    });

    test('ISO timestamps become TIMESTAMP WITH TIME ZONE (round-trip)', async () => {
      if (!dockerAvailable) return;
      // `last_activity_at` is `TIMESTAMP WITH TIME ZONE` in the schema.
      // (`created_at`/`updated_at` on conversations are plain `TIMESTAMP`
      // due to a stale migration 001 declaration — outside the plan's
      // scope. The migration's `coerceTimestamp` returns the ISO string
      // verbatim; Postgres' column type determines the final shape.)
      const typeRows = await sql<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'remote_agent_conversations' AND column_name = 'last_activity_at'`
      );
      expect(typeRows[0]?.data_type).toBe('timestamp with time zone');
      const rows = await sql<{ last_activity_at: Date }>(
        `SELECT last_activity_at FROM remote_agent_conversations WHERE platform_conversation_id = 'test-conv-1'`
      );
      expect(rows.length).toBe(1);
      expect(new Date(rows[0]!.last_activity_at).toISOString()).toBe('2026-06-03T10:01:00.000Z');
    });

    test('codebases.default_branch is preserved', async () => {
      if (!dockerAvailable) return;
      const rows = await sql<{ default_branch: string }>(
        `SELECT default_branch FROM remote_agent_codebases WHERE name = 'test-codebase'`
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.default_branch).toBe('main');
    });
  });

  describe('--verify mode', () => {
    test('exits 0 when row counts match', async () => {
      if (!dockerAvailable) return;
      if (sourceDbPath === null) return;
      const code = await runMigrationCli([
        '--from',
        sourceDbPath,
        '--to',
        pgConnectionUrl(),
        '--verify',
      ]);
      expect(code).toBe(0);
    }, 60_000);

    test('exits non-zero (3) when target has rows the source does not', async () => {
      if (!dockerAvailable) return;
      if (sourceDbPath === null) return;
      // Delete a row from the SOURCE — the migration's
      // `ON CONFLICT (id) DO NOTHING` would re-insert any target row
      // we deleted, defeating the test. By shrinking the source, the
      // migration re-runs with fewer rows, leaves the extra target row
      // alone, and `--verify` reports the mismatch.
      const sourceDb = new Database(sourceDbPath);
      sourceDb.exec(`DELETE FROM remote_agent_workflow_events`);
      sourceDb.close();
      const code = await runMigrationCli([
        '--from',
        sourceDbPath,
        '--to',
        pgConnectionUrl(),
        '--verify',
      ]);
      expect(code).toBe(3);
    }, 60_000);
  });
});
