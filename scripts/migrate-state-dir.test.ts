/**
 * Tests for `scripts/migrate-state-dir.ts` (#2200).
 *
 * Driven as a SUBPROCESS rather than by importing internals, because the
 * contract that matters here is the CLI one: exit codes, what ends up on disk,
 * and — above all — whether `.initialized` was written. That marker tells the
 * triage workflows' `state-preflight` gate "this state directory is complete";
 * writing it after a partial migration would wave through exactly the reset the
 * gate exists to prevent.
 *
 * `ARCHON_HOME` is redirected to a temp dir, so an unregistered repo resolves to
 * the `_cwd/<basename>` pseudo-project and the destination is predictable
 * without touching a real project.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, 'migrate-state-dir.ts');

let sandbox: string;
let archonHome: string;
let repo: string;
let legacyDir: string;
let stateRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'archon-migrate-'));
  archonHome = join(sandbox, 'home');
  repo = join(sandbox, 'repo');
  legacyDir = join(repo, '.archon', 'state');
  // basename('<sandbox>/repo') === 'repo' → the _cwd pseudo-project segment.
  stateRoot = join(archonHome, 'workspaces', '_cwd', 'repo', 'state');
  await mkdir(archonHome, { recursive: true });
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runMigration(...args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, '--cwd', repo, ...args], {
    env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function seedLegacy(files: Record<string, string>): Promise<void> {
  await mkdir(legacyDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(legacyDir, name), content);
  }
}

async function isMarked(): Promise<boolean> {
  try {
    await readFile(join(stateRoot, '.initialized'));
    return true;
  } catch {
    return false;
  }
}

async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe('migrate-state-dir', () => {
  test('--apply moves every file, marks the destination, and empties the source', async () => {
    await seedLegacy({ 'triage-state.json': '{"a":1}', 'pr-state.json': '{"b":2}' });

    const result = await runMigration('--apply');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Migrated 2 entries');
    expect(await listOrEmpty(stateRoot)).toEqual([
      '.initialized',
      'pr-state.json',
      'triage-state.json',
    ]);
    expect(await listOrEmpty(legacyDir)).toEqual([]);
    // Contents survive the copy — not just the filenames.
    expect(await readFile(join(stateRoot, 'triage-state.json'), 'utf-8')).toBe('{"a":1}');
  });

  test('dry run is the default and mutates nothing — no move, no marker', async () => {
    await seedLegacy({ 'triage-state.json': '{"a":1}' });

    const result = await runMigration();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('would move');
    expect(result.stdout).toContain('Dry run — nothing was moved');
    expect(await listOrEmpty(legacyDir)).toEqual(['triage-state.json']);
    expect(await isMarked()).toBe(false);
    // The destination is not even created by a dry run.
    expect(await listOrEmpty(stateRoot)).toEqual([]);
  });

  test('a destination collision exits 2, moves nothing, and does NOT mark', async () => {
    await seedLegacy({ 'triage-state.json': '{"new":true}' });
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, 'triage-state.json'), '{"existing":true}');

    const result = await runMigration('--apply');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Refusing to migrate');
    expect(result.stderr).toContain('Already present in $STATE_DIR');
    expect(result.stderr).toContain('NOT marked initialized');
    // Neither side was touched.
    expect(await readFile(join(stateRoot, 'triage-state.json'), 'utf-8')).toBe('{"existing":true}');
    expect(await listOrEmpty(legacyDir)).toEqual(['triage-state.json']);
    expect(await isMarked()).toBe(false);
  });

  test('a nested directory is a hard failure — nothing moves and nothing is marked', async () => {
    // Regression guard: this used to `continue` past the directory, then write
    // the marker anyway and report the PRE-SKIP count as migrated — a partial
    // migration announced as complete.
    await seedLegacy({ 'triage-state.json': '{"a":1}' });
    await mkdir(join(legacyDir, 'nested'), { recursive: true });
    await writeFile(join(legacyDir, 'nested', 'inner.json'), '{}');

    const result = await runMigration('--apply');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Nested directories');
    expect(result.stderr).toContain('NOT marked initialized');
    expect(result.stdout).not.toContain('Migrated');
    // The sibling file must NOT have been moved — the pre-flight decides the
    // whole migration before touching anything.
    expect(await listOrEmpty(legacyDir)).toEqual(['nested', 'triage-state.json']);
    expect(await isMarked()).toBe(false);
  });

  test('no legacy directory is a success that still marks the destination', async () => {
    const result = await runMigration('--apply');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no legacy .archon/state/ directory');
    // Without this, an operator who correctly runs the migration on a project
    // that has nothing to migrate would be left with an unmarked $STATE_DIR.
    expect(await isMarked()).toBe(true);
  });

  test('an empty legacy directory is a success that still marks the destination', async () => {
    await mkdir(legacyDir, { recursive: true });

    const result = await runMigration('--apply');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('legacy .archon/state/ is empty');
    expect(await isMarked()).toBe(true);
  });

  test('a no-op dry run reports without marking', async () => {
    const result = await runMigration();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('re-run with --apply');
    expect(await isMarked()).toBe(false);
  });

  test('re-running after a successful migration is an idempotent no-op', async () => {
    await seedLegacy({ 'triage-state.json': '{"a":1}' });
    expect((await runMigration('--apply')).exitCode).toBe(0);

    const second = await runMigration('--apply');

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('legacy .archon/state/ is empty');
    expect(await readFile(join(stateRoot, 'triage-state.json'), 'utf-8')).toBe('{"a":1}');
    expect(await isMarked()).toBe(true);
  });
});
