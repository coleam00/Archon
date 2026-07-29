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
const REPO_ROOT = resolve(import.meta.dir, '..');

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

/** Run with raw argv — no implicit `--cwd`, for argument-parsing cases. */
async function runRaw(...args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
    cwd: repo,
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

async function isMarked(at: string = stateRoot): Promise<boolean> {
  try {
    await readFile(join(at, '.initialized'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Distinguishes "directory absent" from "directory empty" — `listOrEmpty`
 * collapses both to `[]`, which makes `toEqual([])` unable to tell a refusal
 * that created nothing from one that created an empty tree.
 */
async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
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

  describe('argument parsing', () => {
    // A migration tool that silently operates on the wrong directory is the
    // failure family this script exists to prevent. `--cwd --apply` used to
    // swallow the flag as a path, resolve to <pwd>/--apply, find no legacy
    // state, and exit 0 having written a junk `.initialized`.
    test('--cwd followed by a flag exits 1 and writes nothing', async () => {
      const result = await runRaw('--cwd', '--apply');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--cwd requires a directory path');
      // `workspaces/` absent entirely — not merely empty.
      expect(await dirExists(join(archonHome, 'workspaces'))).toBe(false);
    });

    test('--cwd with no value at all exits 1 and writes nothing', async () => {
      const result = await runRaw('--cwd');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--cwd requires a directory path');
      expect(await dirExists(join(archonHome, 'workspaces'))).toBe(false);
    });

    test('an unknown flag exits 1 rather than being ignored, and writes nothing', async () => {
      // `--dry-run` looks plausible (dry run IS the default), so silently
      // accepting it would teach a wrong invocation that happens to work.
      const result = await runRaw('--dry-run');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown argument: '--dry-run'");
      expect(await dirExists(join(archonHome, 'workspaces'))).toBe(false);
    });

    test('a repeated --cwd exits 1 rather than silently using the last', async () => {
      const result = await runRaw('--cwd', repo, '--cwd', '/somewhere/else', '--apply');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--cwd was given more than once');
      expect(await dirExists(join(archonHome, 'workspaces'))).toBe(false);
    });

    test('a nonexistent --cwd exits 1 instead of a confident no-op success', async () => {
      // Previously this resolved to the _cwd fallback, found no legacy state,
      // and reported success while marking a directory nobody asked for.
      const result = await runRaw('--cwd', join(sandbox, 'no-such-dir'), '--apply');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Directory does not exist');
      expect(await dirExists(join(archonHome, 'workspaces'))).toBe(false);
    });
  });

  describe('subdirectory invocation (C5)', () => {
    // `findCodebaseByPathPrefix` matches any SUBDIRECTORY of a registered
    // project, so the destination climbed to the project root while the source
    // stayed at the literal cwd. The script then found no legacy state *under
    // the subdirectory*, declared "nothing to migrate", and wrote `.initialized`
    // into the REAL project's state root — disarming `state-preflight` for a
    // project whose state had never been migrated.
    const PROJECT_NAME = 'acme/myrepo';
    let subdir: string;
    let projectStateRoot: string;

    /**
     * Registered in a SUBPROCESS: @archon/core's DB connection is a module-level
     * singleton, so registering in-process would cache a handle to the first
     * test's temp ARCHON_HOME and fail with SQLITE_IOERR_VNODE once that
     * directory is torn down.
     */
    async function registerProject(): Promise<void> {
      const src = [
        "const db = await import('@archon/core/db/codebases');",
        'await db.createCodebase({',
        `  name: ${JSON.stringify(PROJECT_NAME)},`,
        `  repository_url: ${JSON.stringify(`https://github.com/${PROJECT_NAME}`)},`,
        `  default_cwd: ${JSON.stringify(repo)},`,
        "  default_branch: 'main',",
        '});',
      ].join('\n');
      const proc = Bun.spawn(['bun', '-e', src], {
        cwd: REPO_ROOT,
        env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) throw new Error(`registerProject failed (${String(code)}): ${stderr}`);
    }

    beforeEach(async () => {
      subdir = join(repo, 'packages', 'foo');
      await mkdir(subdir, { recursive: true });
      projectStateRoot = join(archonHome, 'workspaces', 'acme', 'myrepo', 'state');
      await registerProject();
    });

    test('migrates the PROJECT root when invoked from a subdirectory', async () => {
      await seedLegacy({ 'triage-state.json': '{"real":"state"}' });

      const proc = Bun.spawn(['bun', 'run', SCRIPT, '--cwd', subdir, '--apply'], {
        env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);

      // It says out loud that it climbed, rather than silently retargeting.
      expect(stdout).toContain('resolved to the registered project root');
      // The state actually moved — the old behaviour left it behind.
      expect(await listOrEmpty(legacyDir)).toEqual([]);
      expect(await listOrEmpty(projectStateRoot)).toEqual(['.initialized', 'triage-state.json']);
    });

    test('refuses when BOTH the subdirectory and the project root hold legacy state', async () => {
      // Ambiguous: migrating only the project's while marking would leave the
      // subdirectory's unmigrated behind a satisfied marker — C5 one level down.
      await seedLegacy({ 'triage-state.json': '{"project":true}' });
      await mkdir(join(subdir, '.archon', 'state'), { recursive: true });
      await writeFile(join(subdir, '.archon', 'state', 'other.json'), '{"subdir":true}');

      const proc = Bun.spawn(['bun', 'run', SCRIPT, '--cwd', subdir, '--apply'], {
        env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(proc.stderr).text();

      expect(await proc.exited).toBe(2);
      expect(stderr).toContain('two candidate sources');
      // Nothing moved, and critically nothing marked.
      expect(await listOrEmpty(legacyDir)).toEqual(['triage-state.json']);
      expect(await isMarked(projectStateRoot)).toBe(false);
    });
  });

  test('progress lines are printed only for entries actually moved', async () => {
    // Printed before the copy loop, a mid-run failure would claim moves that
    // never happened.
    await seedLegacy({ 'a.json': '1', 'b.json': '2' });

    const dry = await runMigration();
    expect(dry.stdout).toContain('would move  a.json');
    expect(dry.stdout).not.toContain('moved  a.json');

    const applied = await runMigration('--apply');
    expect(applied.stdout).toContain('moved  a.json');
    expect(applied.stdout).toContain('moved  b.json');
    expect(applied.stdout).not.toContain('would move');
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
