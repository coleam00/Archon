/**
 * The migration uses real files and a scratch SQLite registry. Refusals must move
 * nothing; successful migrations must leave state at the engine's resolved path.
 * Each case owns its paths so a timed-out assertion cannot read another case's tree.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { getLogLevel, setLogLevel } from '@archon/paths';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { main } from './migrate-state-dir';
import { closeDatabase } from '@archon/core/db/connection';
import { createHash } from 'node:crypto';
import { format } from 'node:util';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, 'migrate-state-dir.ts');

/** `$STATE_DIR` of an unregistered directory: `@cwd/<basename>-<sha256 of its path>`. */
function unregisteredStateRoot(archonHome: string, dir: string): string {
  const digest = createHash('sha256').update(dir).digest('hex');
  return join(archonHome, 'workspaces', '@cwd', `${basename(dir)}-${digest}`, 'state');
}

/** Per-test paths. Immutable, and never shared between tests. */
interface Sandbox {
  readonly root: string;
  readonly archonHome: string;
  readonly repo: string;
  readonly legacyDir: string;
  readonly stateRoot: string;
}

/**
 * Create a sandbox, run `body`, and always tear down.
 *
 * Teardown has to survive the Windows case where a just-exited child still holds a
 * handle inside the sandbox: on PR #2513 an unretried `rm` threw
 * `EBUSY … archon-migrate-dhOLl3` and failed the check. `removeTempTree` owns that
 * retry — and owns it explicitly, because passing `maxRetries` to `rm` does nothing
 * under Bun (#2306). This docblock used to claim that option was the fix.
 */
async function withSandbox(body: (ctx: Sandbox) => Promise<void>): Promise<void> {
  // Canonical, like the script's cwd: macOS tmpdir() is behind a /var symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-migrate-')));
  const archonHome = join(root, 'home');
  const repo = join(root, 'repo');
  const ctx: Sandbox = {
    root,
    archonHome,
    repo,
    legacyDir: join(repo, '.archon', 'state'),
    stateRoot: unregisteredStateRoot(archonHome, repo),
  };
  await mkdir(archonHome, { recursive: true });
  await mkdir(repo, { recursive: true });
  try {
    await body(ctx);
  } finally {
    await removeTempTree(root);
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function collect(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<RunResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Environment for every child, pinned to this sandbox.
 *
 * `DATABASE_URL` is forced EMPTY rather than deleted. A contributor running the
 * documented Postgres mode would otherwise have it reach the child, which flips
 * `getDatabaseType()` there: `registryIsKnownEmpty` goes false and `resolveTarget`
 * reads a Postgres registry, while the C5 fixture writes its row to this sandbox's
 * SQLite file. The two sides would disagree and both C5 tests would fail looking
 * like a climbing regression rather than an environment leak.
 *
 * Deleting the key does NOT achieve that: a spawned Bun child re-runs automatic
 * `.env` loading from its own cwd and fills in every key the passed environment
 * omits, so a repo-root `.env` — exactly how Postgres mode is configured — puts it
 * straight back. An empty string is a key that is present, which dotenv leaves
 * alone, and `getDatabaseType()` reads it as falsy. This is the same suppression
 * `packages/cli/src/cli.test.ts` uses for its own inherited keys.
 *
 * The one test that wants the Postgres branch passes a real DSN via `extraEnv`.
 */
function childEnv(
  ctx: Sandbox,
  extraEnv: Record<string, string> = {}
): Record<string, string | undefined> {
  return {
    ...process.env,
    ARCHON_HOME: ctx.archonHome,
    LOG_LEVEL: 'silent',
    DATABASE_URL: '',
    ...extraEnv,
  };
}

/** Run with raw argv — no implicit `--cwd`, for argument-parsing cases. */
async function runRaw(ctx: Sandbox, ...args: string[]): Promise<RunResult> {
  return collect(
    Bun.spawn(['bun', 'run', SCRIPT, ...args], {
      env: childEnv(ctx),
      cwd: ctx.repo,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  );
}

async function runMigration(ctx: Sandbox, ...args: string[]): Promise<RunResult> {
  return runIn(ctx, ctx.repo, ...args);
}

/** Same as `runMigration`, but targets an arbitrary directory via `--cwd`. */
async function runIn(ctx: Sandbox, cwd: string, ...args: string[]): Promise<RunResult> {
  return runWithEnv(ctx, {}, cwd, ...args);
}

/** `runIn` plus extra environment — for exercising the DATABASE_URL dialect branch. */
async function runWithEnv(
  ctx: Sandbox,
  extraEnv: Record<string, string>,
  cwd: string,
  ...args: string[]
): Promise<RunResult> {
  return captureMigration(ctx, extraEnv, ['--cwd', cwd, ...args]);
}

async function captureMigration(
  ctx: Sandbox,
  extraEnv: Record<string, string>,
  argv: string[]
): Promise<RunResult> {
  const saved = { ...process.env };
  const level = getLogLevel();
  let stdout = '';
  let stderr = '';
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout += `${format(...values)}\n`;
  });
  const error = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr += `${format(...values)}\n`;
  });
  Object.assign(process.env, childEnv(ctx, extraEnv));
  setLogLevel('silent');
  try {
    const exitCode = await main(argv);
    return { exitCode, stdout, stderr };
  } finally {
    try {
      await closeDatabase();
    } finally {
      log.mockRestore();
      error.mockRestore();
      setLogLevel(level);
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  }
}

async function seedLegacy(ctx: Sandbox, files: Record<string, string>): Promise<void> {
  await mkdir(ctx.legacyDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(ctx.legacyDir, name), content);
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

/** Names of the SQLite registry files a lazy connect would materialise. */
async function databaseFiles(archonHome: string): Promise<string[]> {
  return (await listOrEmpty(archonHome)).filter(name => name.startsWith('archon.db'));
}

describe('migrate-state-dir', () => {
  test('--apply moves every file and empties the source', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}', 'pr-state.json': '{"b":2}' });

      const result = await runRaw(ctx, '--cwd', ctx.repo, '--apply');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Migrated 2 entries');
      expect(await listOrEmpty(ctx.stateRoot)).toEqual(['pr-state.json', 'triage-state.json']);
      expect(await listOrEmpty(ctx.legacyDir)).toEqual([]);
      // Contents survive the copy — not just the filenames.
      expect(await readFile(join(ctx.stateRoot, 'triage-state.json'), 'utf-8')).toBe('{"a":1}');
    }));

  test('a symlinked --cwd migrates to the $STATE_DIR runs use for the real directory', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });
      const link = join(ctx.root, 'repo-link');
      await symlink(ctx.repo, link, 'junction');

      const result = await runRaw(ctx, '--cwd', link, '--apply');

      expect(result.exitCode).toBe(0);
      expect(await listOrEmpty(ctx.stateRoot)).toEqual(['triage-state.json']);
    }));

  test('dry run is the default and mutates nothing', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });

      const result = await runMigration(ctx);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('would move');
      expect(result.stdout).toContain('Dry run — nothing was moved');
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
      // The destination is not even created by a dry run.
      expect(await listOrEmpty(ctx.stateRoot)).toEqual([]);
    }));

  test('a destination collision exits 2 and moves nothing', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"new":true}' });
      await mkdir(ctx.stateRoot, { recursive: true });
      await writeFile(join(ctx.stateRoot, 'triage-state.json'), '{"existing":true}');

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Refusing to migrate');
      expect(result.stderr).toContain('Already present in $STATE_DIR');
      // Neither side was touched.
      expect(await readFile(join(ctx.stateRoot, 'triage-state.json'), 'utf-8')).toBe(
        '{"existing":true}'
      );
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
    }));

  test('a nested directory is a hard failure and nothing moves', async () =>
    withSandbox(async ctx => {
      // Regression guard: this used to `continue` past the directory and report
      // the PRE-SKIP count as migrated — a partial migration announced as
      // complete.
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });
      await mkdir(join(ctx.legacyDir, 'nested'), { recursive: true });
      await writeFile(join(ctx.legacyDir, 'nested', 'inner.json'), '{}');

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Nested directories');
      expect(result.stdout).not.toContain('Migrated');
      // The sibling file must NOT have been moved — the pre-flight decides the
      // whole migration before touching anything.
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['nested', 'triage-state.json']);
    }));

  test('no legacy directory is a success that writes nothing', async () =>
    withSandbox(async ctx => {
      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no legacy .archon/state/ directory');
      expect(await dirExists(ctx.stateRoot)).toBe(false);
    }));

  test('an empty legacy directory is a success', async () =>
    withSandbox(async ctx => {
      await mkdir(ctx.legacyDir, { recursive: true });

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('legacy .archon/state/ is empty');
    }));

  // A read-only lookup that CREATES the thing it reads is not read-only. The
  // SQLite adapter connects lazily and applies the full schema on first use, so
  // resolving the destination used to materialise archon.db plus a ~680 KB WAL —
  // from a command whose own output says "nothing was moved" (#2306).
  describe('the registry lookup does not materialise a database', () => {
    test('a dry run against a never-used ARCHON_HOME creates no database', async () =>
      withSandbox(async ctx => {
        await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });

        const result = await runMigration(ctx);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Dry run — nothing was moved');
        expect(await databaseFiles(ctx.archonHome)).toEqual([]);
      }));

    test('a Postgres registry is never inferred from the local filesystem', async () =>
      withSandbox(async ctx => {
        // The skip is sound only for SQLite: a remote registry's contents cannot
        // be deduced from the absence of a local file. Without the dialect clause
        // the whole suite still passes while every DATABASE_URL install silently
        // takes the @cwd fallback — a wrong destination for the moved files.
        //
        // The DSN points at a UNIX SOCKET path inside this test's own sandbox, so
        // the lookup fails with ENOENT at the filesystem layer — no TCP, no
        // listener anything could occupy, and nothing a firewall or network policy
        // can delay. An earlier revision used 127.0.0.1:1, which would have been a
        // unit test touching a real network resource in the very PR about tests
        // doing hidden real I/O (#2186, #2240).
        await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });

        const result = await runWithEnv(
          ctx,
          { DATABASE_URL: `postgresql://u@/db?host=${join(ctx.root, 'no-such-socket-dir')}` },
          ctx.repo,
          '--apply'
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Could not read the codebase registry');
        // It refused rather than guessing: nothing moved.
        expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
        expect(await dirExists(ctx.stateRoot)).toBe(false);
      }));

    test('--apply creates no database either, and still migrates', async () =>
      withSandbox(async ctx => {
        // Scoping the skip to dry runs would put the cold schema apply straight
        // back on the path every real migration takes.
        await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });

        const result = await runMigration(ctx, '--apply');

        expect(result.exitCode).toBe(0);
        expect(await databaseFiles(ctx.archonHome)).toEqual([]);
        expect(await listOrEmpty(ctx.stateRoot)).toEqual(['triage-state.json']);
      }));
  });

  describe('argument parsing', () => {
    // A migration tool that silently operates on the wrong directory is the
    // failure family this script exists to prevent. `--cwd --apply` used to
    // swallow the flag as a path, resolve to <pwd>/--apply, find no legacy
    // state, and exit 0.
    test('--cwd followed by a flag exits 1 and writes nothing', async () =>
      withSandbox(async ctx => {
        const result = await runRaw(ctx, '--cwd', '--apply');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--cwd requires a directory path');
        // `workspaces/` absent entirely — not merely empty.
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));

    test('--cwd with no value at all exits 1 and writes nothing', async () =>
      withSandbox(async ctx => {
        const result = await captureMigration(ctx, {}, ['--cwd']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--cwd requires a directory path');
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));

    test('an unknown flag exits 1 rather than being ignored, and writes nothing', async () =>
      withSandbox(async ctx => {
        // `--dry-run` looks plausible (dry run IS the default), so silently
        // accepting it would teach a wrong invocation that happens to work.
        const result = await runRaw(ctx, '--dry-run');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Unknown argument: '--dry-run'");
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));

    test('a repeated --cwd exits 1 rather than silently using the last', async () =>
      withSandbox(async ctx => {
        const result = await captureMigration(ctx, {}, [
          '--cwd',
          ctx.repo,
          '--cwd',
          '/somewhere/else',
          '--apply',
        ]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--cwd was given more than once');
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));

    test('a nonexistent --cwd exits 1 instead of a confident no-op success', async () =>
      withSandbox(async ctx => {
        // Previously this resolved to the _cwd fallback, found no legacy state,
        // and reported success for a directory nobody asked for.
        const result = await captureMigration(ctx, {}, [
          '--cwd',
          join(ctx.root, 'no-such-dir'),
          '--apply',
        ]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Directory does not exist');
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));
  });

  describe('subdirectory invocation (C5)', () => {
    // `findCodebaseByPathPrefix` matches any SUBDIRECTORY of a registered
    // project, so the destination climbed to the project root while the source
    // stayed at the literal cwd. The script then found no legacy state *under
    // the subdirectory* and declared "nothing to migrate" for a project whose
    // state had never been migrated.
    /** One registered project per case, so no two cases share a destination. */
    const CASE_NAMES = ['climbs', 'ambiguous'] as const;
    type CaseName = (typeof CASE_NAMES)[number];

    interface ProjectSandbox extends Sandbox {
      readonly subdir: string;
      readonly projectStateRoot: string;
    }

    /**
     * Root of the ONE registry these cases share. Assigned by `beforeAll`; every
     * other path is a pure function of it, so nothing is reassigned between tests.
     */
    let registryRoot = '';

    /**
     * Every path a case touches, derived from its name alone.
     *
     * The per-case name is the isolation: it is the repository directory, so each
     * case gets its own `legacyDir`, and it is the registered project name, so
     * each case gets its own `projectStateRoot` under the shared home. Two cases
     * therefore never read or write the same file, which keeps the property the
     * file docblock protects — an assertion still running after its test timed out
     * can only ever describe its own case.
     */
    function sandboxFor(name: CaseName): ProjectSandbox {
      const archonHome = join(registryRoot, 'home');
      const repo = join(registryRoot, name);
      return {
        root: registryRoot,
        archonHome,
        repo,
        legacyDir: join(repo, '.archon', 'state'),
        stateRoot: unregisteredStateRoot(archonHome, repo),
        subdir: join(repo, 'packages', 'foo'),
        projectStateRoot: join(archonHome, 'workspaces', 'acme', name, 'state'),
      };
    }

    // The two cases share a read-only registry, with separate source and destination trees.
    beforeAll(async () => {
      registryRoot = await realpath(await mkdtemp(join(tmpdir(), 'archon-migrate-c5-')));
      await mkdir(join(registryRoot, 'home'), { recursive: true });
      for (const name of CASE_NAMES) {
        await mkdir(sandboxFor(name).subdir, { recursive: true });
      }

      // Opening the adapter announces its schema init at info, which every
      // subprocess here already suppresses with LOG_LEVEL=silent. Scoped rather
      // than set once at module load: `setLogLevel` mutates the process-wide
      // root logger, and `bun test ./scripts/` runs all five files in one
      // process, so an unrestored level would silently follow the others.
      const priorLogLevel = getLogLevel();
      setLogLevel('silent');
      const registry = new SqliteAdapter(join(registryRoot, 'home', 'archon.db'));
      try {
        for (const name of CASE_NAMES) {
          await registry.query(
            'INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ($1, $2)',
            [`acme/${name}`, sandboxFor(name).repo]
          );
        }
      } finally {
        await registry.close();
        setLogLevel(priorLogLevel);
      }
    });

    afterAll(async () => {
      // Empty only when the hook above failed before mkdtemp returned.
      if (registryRoot) await removeTempTree(registryRoot);
    });

    test('migrates the PROJECT root when invoked from a subdirectory', async () => {
      const ctx = sandboxFor('climbs');
      await seedLegacy(ctx, { 'triage-state.json': '{"real":"state"}' });

      const result = await runIn(ctx, ctx.subdir, '--apply');
      expect(result.exitCode).toBe(0);

      // It says out loud that it climbed, rather than silently retargeting.
      expect(result.stdout).toContain('resolved to the registered project root');
      // The state actually moved — the old behaviour left it behind.
      expect(await listOrEmpty(ctx.legacyDir)).toEqual([]);
      expect(await listOrEmpty(ctx.projectStateRoot)).toEqual(['triage-state.json']);
    });

    test('refuses when BOTH the subdirectory and the project root hold legacy state', async () => {
      const ctx = sandboxFor('ambiguous');
      // Ambiguous: migrating only the project's would report success while
      // leaving the subdirectory's unmigrated — C5 one level down.
      await seedLegacy(ctx, { 'triage-state.json': '{"project":true}' });
      await mkdir(join(ctx.subdir, '.archon', 'state'), { recursive: true });
      await writeFile(join(ctx.subdir, '.archon', 'state', 'other.json'), '{"subdir":true}');

      const result = await runIn(ctx, ctx.subdir, '--apply');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('two candidate sources');
      // Nothing moved.
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
      expect(await dirExists(ctx.projectStateRoot)).toBe(false);
    });
  });

  test('progress lines are printed only for entries actually moved', async () =>
    withSandbox(async ctx => {
      // Printed before the copy loop, a mid-run failure would claim moves that
      // never happened.
      await seedLegacy(ctx, { 'a.json': '1', 'b.json': '2' });

      const dry = await runMigration(ctx);
      expect(dry.stdout).toContain('would move  a.json');
      expect(dry.stdout).not.toContain('moved  a.json');

      const applied = await runMigration(ctx, '--apply');
      expect(applied.stdout).toContain('moved  a.json');
      expect(applied.stdout).toContain('moved  b.json');
      expect(applied.stdout).not.toContain('would move');
    }));

  test('re-running after a successful migration is an idempotent no-op', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });
      expect((await runMigration(ctx, '--apply')).exitCode).toBe(0);

      const second = await runMigration(ctx, '--apply');

      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain('legacy .archon/state/ is empty');
      expect(await readFile(join(ctx.stateRoot, 'triage-state.json'), 'utf-8')).toBe('{"a":1}');
    }));
});
