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
 * timeout reads as a timeout. What that rules out is REASSIGNMENT, not sharing:
 * the C5 group below shares one read-only registry built in `beforeAll`, and
 * keeps the property by giving each case its own paths, derived from its name.
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
 *
 * It did recur, for the two C5 cases only (#2575). Coverage instrumentation was
 * measured on windows-latest and ruled out. What was left was accidental cost:
 * their fixture spawned a SECOND cold `bun` process purely to write one registry
 * row, which is now an in-process write. The budget still has not moved.
 *
 * It recurred a third time (#2882), and the reading recorded here then — that the
 * pair sit ~15% above a one-spawn floor, so a contended runner is the whole story
 * and there is nothing left to spend less of — was WRONG. #2982 falsified it and
 * #2575 carries the correction. Two facts kill it. Ten of ten Windows failures
 * are Bun's body-timeout message, out to 12296 ms; a test finishing 2.5x past its
 * budget is not a 15% margin. And in those same runs, on the same runner, the
 * other 17 tests in this file — which spawn the same script — never left
 * 171-515 ms. A contended runner cannot slow one test in a file 30x and leave the
 * next one untouched. The subprocess was never the cost.
 *
 * The registry fixture was. It read as 8-11% of the body because it was measured
 * on the wrong platform: on macOS the whole fixture is ~6 ms of a ~60 ms body, on
 * windows-latest it is ~230 ms of a ~400 ms floor, and it carries the file's only
 * tail. `new SqliteAdapter` on a fresh path applies the entire product schema —
 * 20 tables, 28 indexes, ~300 KB through a WAL and checkpointed back on close —
 * synchronously, so it blocks the test's own event loop, which is why Bun's 5 s
 * timer reported as late as 12296 ms. Building it once for the group instead of
 * once per case is what this file can spend less of, and now does. Ubuntu, for
 * scale, runs these at 120-130 ms and has never failed them.
 *
 * The Windows primitive behind the tail is NOT proven — do not write it down as
 * though it were. Three candidates are already ruled out and should not be
 * re-run: Defender (the runner image excludes C:\ and D:\ recursively, PR #2943),
 * fsync-per-commit (bun:sqlite opens WAL at synchronous=NORMAL, so commits do not
 * fsync — 19 us per autocommit write, measured), and a parent handle outliving
 * `close()` (lsof shows every handle released before the child starts). If this
 * recurs, the failure now discriminates on its own: a HOOK timeout means creating
 * the database is itself the pathological operation, while a BODY timeout means a
 * body that does exactly what the other 17 do has stopped fitting, which is the
 * whole file's floor and not a C5 question. Still do not reach for the timeout.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { getLogLevel, setLogLevel } from '@archon/paths';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, 'migrate-state-dir.ts');

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
  return collect(
    Bun.spawn(['bun', 'run', SCRIPT, '--cwd', cwd, ...args], {
      env: childEnv(ctx, extraEnv),
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
        stateRoot: join(archonHome, 'workspaces', '_cwd', name, 'state'),
        subdir: join(repo, 'packages', 'foo'),
        projectStateRoot: join(archonHome, 'workspaces', 'acme', name, 'state'),
      };
    }

    /**
     * Build the registry ONCE for the whole group.
     *
     * Registering also CREATES the registry, which is what makes these cases the
     * guard that #2306's "skip the lookup when there is no database" cannot
     * silently disable project resolution: here a database exists, so the lookup
     * must still run and still climb.
     *
     * Creating it is also the entire reason these two tests were the file's only
     * Windows flake (#2575, re-attributed in #2982). `new SqliteAdapter` on a fresh
     * path applies the whole product schema — 20 tables and 28 indexes, ~300 KB,
     * written to a WAL and checkpointed back on close — and bun:sqlite is
     * synchronous, so all of it blocks the test's own event loop. The other 17
     * tests in this file spawn the same script and never reach 515 ms on the same
     * runner in the same run; only these two carried a tail, out to 12296 ms. The
     * subprocess is not the cost and never was. Building the registry per test was.
     *
     * So it is built once, in a hook, and the test bodies now do exactly what the
     * other 17 do: seed files, spawn the script, assert. One creation for the group
     * instead of one per case is also the smallest possible amount of this work —
     * a per-case template copy still creates a database per case.
     *
     * The rows go in through the SAME adapter the script's lookup opens, so the
     * fixture cannot drift from the real schema — but through a dedicated instance
     * rather than `@archon/core/db/codebases`, whose `pool` resolves the
     * module-level connection singleton from `ARCHON_HOME`. That singleton would
     * pin this temp home and then fail with SQLITE_IOERR_VNODE once the directory
     * is torn down; an instance takes an explicit path and is closed before the
     * tests run. `name` and `default_cwd` are the only columns the destination
     * resolution reads (`resolveRepoProjectIdentity`).
     *
     * Nothing writes this database again, so the cases share it read-only.
     */
    beforeAll(async () => {
      registryRoot = await mkdtemp(join(tmpdir(), 'archon-migrate-c5-'));
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
      expect(await listOrEmpty(ctx.projectStateRoot)).toEqual([
        '.initialized',
        'triage-state.json',
      ]);
    });

    test('refuses when BOTH the subdirectory and the project root hold legacy state', async () => {
      const ctx = sandboxFor('ambiguous');
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
      expect(await isMarked(ctx.stateRoot)).toBe(true);
    }));
});
