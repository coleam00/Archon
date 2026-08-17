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
 *
 * Every test owns its sandbox through `withSandbox` instead of sharing
 * module-level bindings via `beforeEach` (#2306). Those bindings used to be
 * reassigned between tests, so when a test timed out its still-running
 * assertions read the NEXT test's paths and reported a mutation that never
 * happened — on PR #2513 that surfaced as a dry run appearing to move a file.
 * Locals make an orphaned assertion able to describe only its own sandbox, so a
 * timeout reads as a timeout.
 *
 * BUDGET: deliberately left at Bun's 5000 ms default, even though these tests
 * time out on windows-latest at ~5015 ms (#2306). Raising it was considered and
 * rejected: every spawn that got as far as resolving a destination used to create
 * a 704 KB SQLite database — including a `PRAGMA busy_timeout = 5000` carrier, the
 * exact bound that turned out to be #2473's real cause — and that creation is now
 * gone. (The five argument-parsing cases never did: four exit from `parseArgs` at
 * module load, and the nonexistent-`--cwd` one exits from `main()` — all of them
 * before `resolveTarget` is reached.) Whether it was also the cause here is
 * testable only by leaving the alarm armed and seeing whether the timeouts stop.
 * A larger budget would answer the question by silencing it.
 * If it does recur, find the specific colliding bound the way #2473 did; do not
 * reach for the timeout.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, 'migrate-state-dir.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

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
 * `maxRetries` covers the Windows case where a just-exited child still holds a
 * handle inside the sandbox: node's `rm` retries on EBUSY, EMFILE, ENFILE,
 * ENOTEMPTY and EPERM, which covers what this hits. On PR #2513 an unretried `rm`
 * threw `EBUSY … archon-migrate-dhOLl3` from teardown and failed the check. A leaked
 * temp directory is not a test failure, so a final failure warns instead of
 * throwing — but it does warn, so a genuine leak stays visible.
 */
async function withSandbox(body: (ctx: Sandbox) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'archon-migrate-'));
  const archonHome = join(root, 'home');
  const repo = join(root, 'repo');
  const ctx: Sandbox = {
    root,
    archonHome,
    repo,
    legacyDir: join(repo, '.archon', 'state'),
    // basename('<root>/repo') === 'repo' → the _cwd pseudo-project segment.
    stateRoot: join(archonHome, 'workspaces', '_cwd', 'repo', 'state'),
  };
  await mkdir(archonHome, { recursive: true });
  await mkdir(repo, { recursive: true });
  try {
    await body(ctx);
  } finally {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn(`sandbox cleanup failed for ${root}: ${(error as Error).message}`);
    }
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

/** Run with raw argv — no implicit `--cwd`, for argument-parsing cases. */
async function runRaw(ctx: Sandbox, ...args: string[]): Promise<RunResult> {
  return collect(
    Bun.spawn(['bun', 'run', SCRIPT, ...args], {
      env: { ...process.env, ARCHON_HOME: ctx.archonHome, LOG_LEVEL: 'silent' },
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
  return collect(
    Bun.spawn(['bun', 'run', SCRIPT, '--cwd', cwd, ...args], {
      env: { ...process.env, ARCHON_HOME: ctx.archonHome, LOG_LEVEL: 'silent', ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  );
}

async function seedLegacy(ctx: Sandbox, files: Record<string, string>): Promise<void> {
  await mkdir(ctx.legacyDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(ctx.legacyDir, name), content);
  }
}

async function isMarked(at: string): Promise<boolean> {
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

/** Names of the SQLite registry files a lazy connect would materialise. */
async function databaseFiles(archonHome: string): Promise<string[]> {
  return (await listOrEmpty(archonHome)).filter(name => name.startsWith('archon.db'));
}

describe('migrate-state-dir', () => {
  test('--apply moves every file, marks the destination, and empties the source', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}', 'pr-state.json': '{"b":2}' });

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Migrated 2 entries');
      expect(await listOrEmpty(ctx.stateRoot)).toEqual([
        '.initialized',
        'pr-state.json',
        'triage-state.json',
      ]);
      expect(await listOrEmpty(ctx.legacyDir)).toEqual([]);
      // Contents survive the copy — not just the filenames.
      expect(await readFile(join(ctx.stateRoot, 'triage-state.json'), 'utf-8')).toBe('{"a":1}');
    }));

  test('dry run is the default and mutates nothing — no move, no marker', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });

      const result = await runMigration(ctx);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('would move');
      expect(result.stdout).toContain('Dry run — nothing was moved');
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
      expect(await isMarked(ctx.stateRoot)).toBe(false);
      // The destination is not even created by a dry run.
      expect(await listOrEmpty(ctx.stateRoot)).toEqual([]);
    }));

  test('a destination collision exits 2, moves nothing, and does NOT mark', async () =>
    withSandbox(async ctx => {
      await seedLegacy(ctx, { 'triage-state.json': '{"new":true}' });
      await mkdir(ctx.stateRoot, { recursive: true });
      await writeFile(join(ctx.stateRoot, 'triage-state.json'), '{"existing":true}');

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Refusing to migrate');
      expect(result.stderr).toContain('Already present in $STATE_DIR');
      expect(result.stderr).toContain('NOT marked initialized');
      // Neither side was touched.
      expect(await readFile(join(ctx.stateRoot, 'triage-state.json'), 'utf-8')).toBe(
        '{"existing":true}'
      );
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
      expect(await isMarked(ctx.stateRoot)).toBe(false);
    }));

  test('a nested directory is a hard failure — nothing moves and nothing is marked', async () =>
    withSandbox(async ctx => {
      // Regression guard: this used to `continue` past the directory, then write
      // the marker anyway and report the PRE-SKIP count as migrated — a partial
      // migration announced as complete.
      await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });
      await mkdir(join(ctx.legacyDir, 'nested'), { recursive: true });
      await writeFile(join(ctx.legacyDir, 'nested', 'inner.json'), '{}');

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Nested directories');
      expect(result.stderr).toContain('NOT marked initialized');
      expect(result.stdout).not.toContain('Migrated');
      // The sibling file must NOT have been moved — the pre-flight decides the
      // whole migration before touching anything.
      expect(await listOrEmpty(ctx.legacyDir)).toEqual(['nested', 'triage-state.json']);
      expect(await isMarked(ctx.stateRoot)).toBe(false);
    }));

  test('no legacy directory is a success that still marks the destination', async () =>
    withSandbox(async ctx => {
      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no legacy .archon/state/ directory');
      // Without this, an operator who correctly runs the migration on a project
      // that has nothing to migrate would be left with an unmarked $STATE_DIR.
      expect(await isMarked(ctx.stateRoot)).toBe(true);
    }));

  test('an empty legacy directory is a success that still marks the destination', async () =>
    withSandbox(async ctx => {
      await mkdir(ctx.legacyDir, { recursive: true });

      const result = await runMigration(ctx, '--apply');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('legacy .archon/state/ is empty');
      expect(await isMarked(ctx.stateRoot)).toBe(true);
    }));

  test('a no-op dry run reports without marking', async () =>
    withSandbox(async ctx => {
      const result = await runMigration(ctx);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('re-run with --apply');
      expect(await isMarked(ctx.stateRoot)).toBe(false);
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
        // takes the _cwd fallback — a wrong destination in a script that writes
        // `.initialized`.
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
        // It refused rather than guessing: nothing moved, nothing marked.
        expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
        expect(await isMarked(ctx.stateRoot)).toBe(false);
      }));

    test('--apply creates no database either, and still migrates and marks', async () =>
      withSandbox(async ctx => {
        // Scoping the skip to dry runs would put the cold schema apply straight
        // back on the path every real migration takes.
        await seedLegacy(ctx, { 'triage-state.json': '{"a":1}' });

        const result = await runMigration(ctx, '--apply');

        expect(result.exitCode).toBe(0);
        expect(await databaseFiles(ctx.archonHome)).toEqual([]);
        expect(await listOrEmpty(ctx.stateRoot)).toEqual(['.initialized', 'triage-state.json']);
      }));
  });

  describe('argument parsing', () => {
    // A migration tool that silently operates on the wrong directory is the
    // failure family this script exists to prevent. `--cwd --apply` used to
    // swallow the flag as a path, resolve to <pwd>/--apply, find no legacy
    // state, and exit 0 having written a junk `.initialized`.
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
        const result = await runRaw(ctx, '--cwd');

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
        const result = await runRaw(ctx, '--cwd', ctx.repo, '--cwd', '/somewhere/else', '--apply');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--cwd was given more than once');
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));

    test('a nonexistent --cwd exits 1 instead of a confident no-op success', async () =>
      withSandbox(async ctx => {
        // Previously this resolved to the _cwd fallback, found no legacy state,
        // and reported success while marking a directory nobody asked for.
        const result = await runRaw(ctx, '--cwd', join(ctx.root, 'no-such-dir'), '--apply');

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Directory does not exist');
        expect(await dirExists(join(ctx.archonHome, 'workspaces'))).toBe(false);
      }));
  });

  describe('subdirectory invocation (C5)', () => {
    // `findCodebaseByPathPrefix` matches any SUBDIRECTORY of a registered
    // project, so the destination climbed to the project root while the source
    // stayed at the literal cwd. The script then found no legacy state *under
    // the subdirectory*, declared "nothing to migrate", and wrote `.initialized`
    // into the REAL project's state root — disarming `state-preflight` for a
    // project whose state had never been migrated.
    const PROJECT_NAME = 'acme/myrepo';

    interface ProjectSandbox extends Sandbox {
      readonly subdir: string;
      readonly projectStateRoot: string;
    }

    /**
     * Registering also CREATES the registry, which is what makes these two tests
     * the guard that #2306's "skip the lookup when there is no database" cannot
     * silently disable project resolution: here a database exists, so the lookup
     * must still run and still climb.
     *
     * Registered in a SUBPROCESS: @archon/core's DB connection is a module-level
     * singleton, so registering in-process would cache a handle to the first
     * test's temp ARCHON_HOME and fail with SQLITE_IOERR_VNODE once that
     * directory is torn down.
     */
    async function withProjectSandbox(body: (ctx: ProjectSandbox) => Promise<void>): Promise<void> {
      return withSandbox(async base => {
        const ctx: ProjectSandbox = {
          ...base,
          subdir: join(base.repo, 'packages', 'foo'),
          projectStateRoot: join(base.archonHome, 'workspaces', 'acme', 'myrepo', 'state'),
        };
        await mkdir(ctx.subdir, { recursive: true });

        const src = [
          "const db = await import('@archon/core/db/codebases');",
          'await db.createCodebase({',
          `  name: ${JSON.stringify(PROJECT_NAME)},`,
          `  repository_url: ${JSON.stringify(`https://github.com/${PROJECT_NAME}`)},`,
          `  default_cwd: ${JSON.stringify(ctx.repo)},`,
          "  default_branch: 'main',",
          '});',
        ].join('\n');
        const proc = Bun.spawn(['bun', '-e', src], {
          cwd: REPO_ROOT,
          env: { ...process.env, ARCHON_HOME: ctx.archonHome, LOG_LEVEL: 'silent' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const { exitCode, stderr } = await collect(proc);
        if (exitCode !== 0) {
          throw new Error(`registerProject failed (${String(exitCode)}): ${stderr}`);
        }

        await body(ctx);
      });
    }

    test('migrates the PROJECT root when invoked from a subdirectory', async () =>
      withProjectSandbox(async ctx => {
        await seedLegacy(ctx, { 'triage-state.json': '{"real":"state"}' });

        const result = await runIn(ctx, ctx.subdir, '--apply');
        expect(result.exitCode).toBe(0);

        // It says out loud that it climbed, rather than silently retargeting.
        expect(result.stdout).toContain('resolved to the registered project root');
        // The state actually moved — the old behaviour left it behind.
        expect(await listOrEmpty(ctx.legacyDir)).toEqual([]);
        expect(await listOrEmpty(ctx.projectStateRoot)).toEqual([
          '.initialized',
          'triage-state.json',
        ]);
      }));

    test('refuses when BOTH the subdirectory and the project root hold legacy state', async () =>
      withProjectSandbox(async ctx => {
        // Ambiguous: migrating only the project's while marking would leave the
        // subdirectory's unmigrated behind a satisfied marker — C5 one level down.
        await seedLegacy(ctx, { 'triage-state.json': '{"project":true}' });
        await mkdir(join(ctx.subdir, '.archon', 'state'), { recursive: true });
        await writeFile(join(ctx.subdir, '.archon', 'state', 'other.json'), '{"subdir":true}');

        const result = await runIn(ctx, ctx.subdir, '--apply');

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('two candidate sources');
        // Nothing moved, and critically nothing marked.
        expect(await listOrEmpty(ctx.legacyDir)).toEqual(['triage-state.json']);
        expect(await isMarked(ctx.projectStateRoot)).toBe(false);
      }));
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
      expect(await isMarked(ctx.stateRoot)).toBe(true);
    }));
});
