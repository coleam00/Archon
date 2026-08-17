/**
 * Subprocess-driven tests for
 * `packages/core/scripts/normalize-stale-user-ai-prefs.ts` (#25df78a1).
 *
 * Why subprocess, not import-and-call: the script's contract is the CLI
 * one — exit codes, stdout format, and the actual row rewrite. Mocking
 * `process.exit` and `pool.query` to fake those would test the
 * implementation, not the behavior.
 *
 * Setup pattern mirrors `scripts/migrate-state-dir.test.ts`: a real
 * SQLite DB at a temp `ARCHON_HOME`, a temp `.archon/config.yaml`
 * carrying the operator preset (`Power Tools`), and a seeded
 * `remote_agent_user_ai_prefs` row carrying the pre-`1fac9e3`
 * `<providerId>/<modelId>` literal pair.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Database } from 'bun:sqlite';

const SCRIPT = resolve(import.meta.dir, 'normalize-stale-user-ai-prefs.ts');
// This test lives under packages/core/src/cli/; the SCRIPT path is its
// sibling. REPO_ROOT climbs one level (out of cli/) to packages/core, then
// one more level to the repo root.
const REPO_ROOT = resolve(import.meta.dir, '..', '..');

let sandbox: string;
let archonHome: string;
let configPath: string;
let dbPath: string;
let originalArchonHome: string | undefined;

// `getArchonConfigPath()` returns `${ARCHON_HOME}/config.yaml` directly —
// NOT `${ARCHON_HOME}/.archon/config.yaml`. The `.archon/` directory is
// a per-repo convention layered on top via `loadRepoConfig`. Mirror that.
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'archon-normalize-ai-prefs-'));
  archonHome = join(sandbox, 'home');
  configPath = join(archonHome, 'config.yaml');
  dbPath = join(archonHome, 'archon.db');
  await mkdir(archonHome, { recursive: true });
  await writeFile(
    configPath,
    'tiers:\n  small:\n    provider: aiderdesk\n    model: Power Tools\n',
    'utf8'
  );
  // Apply the core schema (idempotent). Mirrors what the engine does on
  // boot via `migrations/000_combined.sql` for Postgres and `createSchema`
  // for SQLite — the relevant table for this script is small enough to
  // declare inline here.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_agent_user_ai_prefs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      tiers TEXT,
      aliases TEXT,
      default_provider TEXT,
      default_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.close();
  originalArchonHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = archonHome;
});

afterEach(async () => {
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  await rm(sandbox, { recursive: true, force: true });
});

async function spawnScript(args: readonly string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  // Inherited env from the host can carry a `DATABASE_URL` that points
  // at a Postgres instance we cannot reach during tests. Strip it so the
  // engine falls back to SQLite at `${ARCHON_HOME}/archon.db` — exactly
  // what a solo install would do. Production callers running against
  // Postgres are unaffected: their `DATABASE_URL` is intentional.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'DATABASE_URL') env[k] = v;
  }
  env.ARCHON_HOME = archonHome;
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function seedAiPrefsRow(
  tiersJson: string,
  defaultProvider: string | null,
  defaultModel: string | null
): string {
  const userId = 'user-' + Math.random().toString(36).slice(2, 8);
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO remote_agent_user_ai_prefs
       (id, user_id, tiers, aliases, default_provider, default_model, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    'row-' + Math.random().toString(36).slice(2, 8),
    userId,
    tiersJson,
    defaultProvider,
    defaultModel,
    '2026-08-17T00:00:00Z',
    '2026-08-17T00:00:00Z'
  );
  db.close();
  return userId;
}

function readTiersJson(userId: string): string | null {
  const db = new Database(dbPath);
  const row = db
    .prepare('SELECT tiers FROM remote_agent_user_ai_prefs WHERE user_id = ?')
    .get(userId) as { tiers: string | null } | undefined;
  db.close();
  return row?.tiers ?? null;
}

describe('normalize-stale-user-ai-prefs', () => {
  test('--help: prints usage and exits 0', async () => {
    const { stdout, exitCode } = await spawnScript(['--help']);
    expect(stdout).toMatch(/Usage:/);
    expect(exitCode).toBe(0);
  });

  test('--bogus: rejects unknown arg with exit 1', async () => {
    const { stderr, exitCode } = await spawnScript(['--bogus']);
    expect(stderr).toMatch(/Unknown argument: '--bogus'/);
    expect(exitCode).toBe(1);
  });

  test('refuses (exit 2) when ~/.archon/config.yaml has no tiers.small', async () => {
    await rm(configPath);
    const { stderr, exitCode } = await spawnScript(['--apply']);
    expect(stderr).toMatch(/refused:.*no 'tiers\.small'/);
    expect(exitCode).toBe(2);
  });

  test('refuses (exit 2) when tiers.small.model itself is a stale literal', async () => {
    await writeFile(
      configPath,
      'tiers:\n  small:\n    provider: aiderdesk\n    model: ollama/gemma4:8b-8k\n',
      'utf8'
    );
    const { stderr, exitCode } = await spawnScript(['--apply']);
    expect(stderr).toMatch(/refused:.*itself a/);
    expect(exitCode).toBe(2);
  });

  test('dry-run: prints scan summary without rewriting (exit 0)', async () => {
    const userId = seedAiPrefsRow(
      JSON.stringify({ small: { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' } }),
      null,
      null
    );
    // Snapshot the on-disk tier JSON so we can prove the write was skipped.
    const before = readTiersJson(userId);

    const { stdout, exitCode } = await spawnScript([]);
    expect(stdout).toMatch(/destination preset: provider='aiderdesk' model='Power Tools'/);
    expect(stdout).toMatch(/dry-run \(no writes/);
    expect(stdout).toMatch(new RegExp(`${userId}: 1 stale model`));
    expect(stdout).toMatch(/scanned 1 rows, 1 would be rewritten, 0 errors/);
    expect(exitCode).toBe(0);

    const after = readTiersJson(userId);
    expect(after).toBe(before);
  });

  test('--apply: rewrites the stale entry to the operator preset (exit 0)', async () => {
    const userId = seedAiPrefsRow(
      JSON.stringify({ small: { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' } }),
      null,
      null
    );

    const { stdout, exitCode } = await spawnScript(['--apply']);
    expect(stdout).toMatch(/--apply \(writes\)/);
    expect(exitCode).toBe(0);

    const after = JSON.parse(readTiersJson(userId) as string) as {
      small: { provider: string; model: string };
    };
    expect(after.small).toEqual({ provider: 'aiderdesk', model: 'Power Tools' });
  });

  test('clean rows are reported but never rewritten', async () => {
    const userId = seedAiPrefsRow(
      JSON.stringify({ small: { provider: 'aiderdesk', model: 'Power Tools' } }),
      null,
      null
    );

    const { stdout, exitCode } = await spawnScript(['--apply']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/scanned 1 rows, 0 would be rewritten, 0 errors/);
    // The user-id row must not be in the "rewritten" block.
    expect(stdout).not.toMatch(new RegExp(`${userId}:`));
  });

  test('non-aiderdesk rows pass through untouched even with "/" in model', async () => {
    const userId = seedAiPrefsRow(
      JSON.stringify({ small: { provider: 'pi', model: 'openrouter/qwen3-coder' } }),
      null,
      null
    );
    const before = readTiersJson(userId);

    const { stdout, exitCode } = await spawnScript(['--apply']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/scanned 1 rows, 0 would be rewritten, 0 errors/);

    const after = readTiersJson(userId);
    expect(after).toBe(before);
  });

  test('mixed valid + stale entry: only the stale one is rewritten', async () => {
    const userId = seedAiPrefsRow(
      JSON.stringify({
        small: { provider: 'aiderdesk', model: 'ollama/internlm/internlm2.5:7b-8k' },
        large: { provider: 'aiderdesk', model: 'Poe' },
      }),
      null,
      null
    );

    const { exitCode } = await spawnScript(['--apply']);
    expect(exitCode).toBe(0);

    const after = JSON.parse(readTiersJson(userId) as string) as Record<
      string,
      {
        provider: string;
        model: string;
      }
    >;
    expect(after.small).toEqual({ provider: 'aiderdesk', model: 'Power Tools' });
    expect(after.large).toEqual({ provider: 'aiderdesk', model: 'Poe' });
  });

  test('idempotent: a second run finds zero findings', async () => {
    seedAiPrefsRow(
      JSON.stringify({ small: { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' } }),
      null,
      null
    );
    const first = await spawnScript(['--apply']);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/scanned 1 rows, 1 would be rewritten, 0 errors/);

    const second = await spawnScript(['--apply']);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/scanned 1 rows, 0 would be rewritten, 0 errors/);
  });
});
