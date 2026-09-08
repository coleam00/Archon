/**
 * Real-pipe regression tests for #2400 (piped human-readable `console.log`
 * silently truncates against a slow reader).
 *
 * ## Why these tests spawn a shell pipeline
 *
 * The bug only exists when fd 1 is a **non-blocking pipe**, which is what a
 * shell creates for `archon … | less`. The causal chain is identical to
 * `--json` truncation in #2384:
 *
 *  1. Importing `@archon/paths` builds the pino root logger, whose default
 *     destination opens fd 1 in non-blocking mode.
 *  2. On a non-blocking pipe a `console.log` call that exceeds the pipe's
 *     buffer can return a short count, and the stream drops the unwritten tail
 *     without error.
 *
 * That is why `> out.txt` always looked fine: a regular-file fd stays
 * blocking. PR #2389 routed every `--json` payload through `writeStdout`
 * (`utils/stdout.ts`) and closed that gap. #2400 is the symmetrical gap for
 * human-readable `console.log` calls, fixed by monkey-patching `console.log`
 * to delegate through the same `writeStdout` primitive (see
 * `utils/safe-console.ts`).
 *
 * `Bun.spawn` with `stdout: 'pipe'` does NOT reproduce the truncation, and
 * neither does mocking `process.stdout.write` — both replace the exact thing
 * that was broken. These tests therefore drive a genuine
 * `bun … workflow list | { sleep 0.5; cat; } > file` shell pipeline.
 *
 * ## Calibration (measured on macOS/arm64, bun 1.3.11)
 *
 * The payload size and consumer pattern below are not arbitrary. Against the
 * pre-fix code, a ~1.07 MB `workflow list --full` payload piped to
 * `{ sleep 0.5; cat; }` truncated in 5/5 runs (delivery 89–96%). The same
 * harness against the patched code delivered 10/10 byte-identical to the
 * file redirect. The slow consumer (`sleep 0.5` before reading) is what makes
 * the truncation deterministic — a plain `cat` only truncates ~1% of runs at
 * this payload size because cat drains the pipe faster than the writer fills
 * it. Do not "simplify" the consumer back to plain `cat` without re-measuring
 * against a pre-fix build; the test would silently stop catching regressions.
 *
 * POSIX-only: Windows has no equivalent non-blocking-pipe path and no bash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeWriteError, installPipeSafeConsole, restoreConsole } from './safe-console';
import { exitWithDrain } from './exit-with-drain';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const BUN = process.execPath;

/** Tuned so the human-readable payload lands in the proven truncation window. */
const WORKFLOW_COUNT = 150;
const DESCRIPTION_CHARS = 7000;
/** Piped runs per assertion. Pre-fix truncates 5/5; post-fix passes 10/10. */
const PIPED_RUNS = 5;

let repoDir: string;
let archonHome: string;
let scratch: string;

function runShell(script: string): { status: number | null; stdout: string } {
  // LOG_LEVEL=silent silences pino's diagnostic lines so two CLI invocations
  // produce byte-identical stdout (each invocation carries a unique timestamp
  // + pid in the first JSON line; the human-readable payload underneath is
  // stable, but pino's preamble is not). Without this the test would diff on
  // the pino preamble and pass trivially even when the real payload truncates.
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

/** `archon workflow list --full` redirected to a regular file (blocking fd). */
function listToFile(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null > "${target}"`
  ).status;
}

/**
 * The same command with stdout attached to a real pipe. The consumer sleeps
 * for 500 ms before draining so the writer fills the pipe buffer before the
 * reader pulls anything — that is what makes the pre-fix truncation
 * deterministic. `cat` alone truncates too rarely to be a useful test.
 */
function listThroughPipe(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null | { sleep 0.5; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
  ).status;
}

/**
 * Very-slow consumer (1 s before reading). The CLI finishes in ~620 ms; with
 * the fire-and-forget shim and no exit-path flush, `process.exit()` would
 * fire while bytes are still queued in the stream buffer and the truncation
 * described in R1 (review report) returns. `flushPendingWrites()` in
 * `cli.ts` is what closes that window — do not delete it without re-running
 * this test.
 */
function listThroughVerySlowPipe(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null | { sleep 1; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
  ).status;
}

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('CLI human-readable console.log over a real pipe (#2400)', () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'archon-pipe-test-'));
    archonHome = join(scratch, 'home');
    repoDir = join(scratch, 'repo');
    mkdirSync(archonHome, { recursive: true });
    const workflowsDir = join(repoDir, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    spawnSync('git', ['init', '-q', '.'], { cwd: repoDir });

    const padding = 'x'.repeat(DESCRIPTION_CHARS);
    for (let i = 0; i < WORKFLOW_COUNT; i++) {
      const name = `probe-${String(i).padStart(3, '0')}`;
      writeFileSync(
        join(workflowsDir, `${name}.yaml`),
        `name: ${name}\ndescription: ${padding}${i}\nnodes:\n  - id: only\n    prompt: hello\n`
      );
    }
  });

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('delivers the whole document, byte-identical to a file redirect, against a slow consumer', () => {
    const referencePath = join(scratch, 'reference.txt');
    expect(listToFile(referencePath)).toBe(0);
    const reference = readFileSync(referencePath);

    // Guard the calibration: below the pipe capacity the bug cannot occur, so a
    // shrinking payload would silently turn this into a no-op test.
    expect(reference.byteLength).toBeGreaterThan(65_536);

    for (let run = 0; run < PIPED_RUNS; run++) {
      const pipedPath = join(scratch, `piped-${run}.txt`);
      const status = listThroughPipe(pipedPath);
      const piped = readFileSync(pipedPath);

      expect({ run, status }).toEqual({ run, status: 0 });
      // Report the byte count on failure — a bare buffer diff is unreadable.
      expect({ run, bytes: piped.byteLength }).toEqual({ run, bytes: reference.byteLength });
      expect(piped.equals(reference)).toBe(true);
    }
  }, 180_000);

  /**
   * Regression guard for the EPIPE propagation contract
   * (`safe-console.ts` file comment + `exit-with-drain.ts`'s
   * `consumeWriteError()` branch). A defensive
   * `writeStdout(text).catch(() => {})` regression in the shim that
   * failed to record the error in `writeError` would turn
   * `archon … | head -c 100` into a silent exit 0 on the Linux CI runner
   * — the only test above uses `cat` and would not catch it.
   *
   * `head -c 100` closes the read end of the pipe after the first 100
   * bytes, so the writer's next `process.stdout.write` fails with EPIPE.
   * The shim records that error in `writeError`, `exitWithDrain()` reads
   * it back via `consumeWriteError()` after the drain, and the writer
   * exits non-zero regardless of whether Bun's unhandled-rejection trap
   * fires before or after `process.exit()` (macOS fires it before, Linux
   * CI schedules it after — see `safe-console.ts` file comment for the
   * full ordering analysis). We capture `${PIPESTATUS[0]}` (the writer's
   * status) so the surrounding pipeline cannot mask a non-zero exit with
   * a clean `head`.
   */
  it('propagates EPIPE as a non-zero exit when the consumer hangs up early', () => {
    const result = runShell(
      `"${BUN}" "${CLI_ENTRY}" workflow list --full --cwd "${repoDir}" 2>/dev/null | head -c 100 > /dev/null; exit \${PIPESTATUS[0]}`
    );
    expect(result.status).not.toBe(0);
  }, 60_000);

  /**
   * Regression guard for R1 (review report): the fire-and-forget shim
   * discards the per-write completion promise, so `process.exit()` would
   * race the stream drain and re-introduce the silent-exit-0 truncation
   * the patch is meant to eliminate. The fix is `flushPendingWrites()` in
   * `cli.ts` (awaited between `main()` and `process.exit()`); this test
   * sleeps 1 s on the consumer side — longer than the CLI's own runtime —
   * so without the flush the queued bytes are lost. With the flush in
   * place the output is byte-identical to the file redirect.
   */
  it('delivers the whole document to a very-slow consumer (sleep >= 1 s) without truncating', () => {
    const referencePath = join(scratch, 'reference.txt');
    const pipedPath = join(scratch, 'very-slow.txt');
    const status = listThroughVerySlowPipe(pipedPath);
    const reference = readFileSync(referencePath);
    const piped = readFileSync(pipedPath);

    expect(status).toBe(0);
    expect({ bytes: piped.byteLength }).toEqual({ bytes: reference.byteLength });
    expect(piped.equals(reference)).toBe(true);
  }, 120_000);

  /**
   * Regression guard for R9 (review report): the `.catch()` arm of cli.ts's
   * top-level promise chain must also drain `pendingWrites` before calling
   * `process.exit(1)` — otherwise a fatal `main()` rejection against a slow
   * reader drops queued stdout bytes the same way the success arm used to
   * pre-R1. The success-arm R1 test above would not catch a regression here
   * (it drives `workflow list`, which returns 0); this test drives a small
   * fixture that throws after emitting a known marker through the patched
   * `console.log`. With the drain shared across both arms the marker is
   * delivered to a slow pipe; without it the bytes are truncated.
   *
   * The fixture is a self-contained TS script under `scratch/`. It imports
   * the shim from the source tree (not from a published package) so a
   * regression in `flushPendingWrites()` itself is also caught here. It
   * also imports `withDrainedExit` from the same module cli.ts imports it
   * from (`./utils/exit-with-drain.ts`), so a regression inside
   * `withDrainedExit`/`exitWithDrain` itself (e.g. dropping the
   * `flushPendingWrites()` await) is caught here too. A regression that
   * instead bypasses `withDrainedExit` at the cli.ts call site — swapping
   * it for a direct `process.exit` — is NOT caught by this fixture, since
   * the fixture never imports cli.ts; that case is caught by the separate
   * static-contract test below.
   */
  it('drains queued console.log writes before process.exit(1) on the catch arm (R9)', () => {
    const marker = `R9-MARKER-${Date.now()}`;
    // Mirror the cli.ts exit chain via the shared helper: success and
    // fatal both route through `exitWithDrain`, which awaits
    // `flushPendingWrites()` before `process.exit()`. The chain wiring
    // lives in `withDrainedExit` (`./utils/exit-with-drain.ts`), imported
    // from the same module cli.ts imports it from, so a regression inside
    // that shared module is caught here too. A bypass of `withDrainedExit`
    // specifically at the cli.ts call site is NOT caught by this fixture
    // (see the static-contract test below).
    const fixturePath = join(scratch, 'r9-fixture.ts');
    const shimEntry = join(import.meta.dir, 'safe-console.ts');
    const exitWithDrainEntry = join(import.meta.dir, 'exit-with-drain.ts');
    writeFileSync(
      fixturePath,
      [
        `import { installPipeSafeConsole } from ${JSON.stringify(shimEntry)};`,
        `import { withDrainedExit } from ${JSON.stringify(exitWithDrainEntry)};`,
        `installPipeSafeConsole();`,
        `// Emit a large payload FIRST so the pipe buffer (64 KiB on macOS)`,
        `// fills and the marker cannot reach the OS before the catch arm`,
        `// exits the process. The marker is written LAST so it sits behind`,
        `// the pipe-full payload; without the drain the marker is dropped`,
        `// when process.exit fires.`,
        `for (let i = 0; i < 4000; i++) console.log('x'.repeat(200));`,
        `console.log(${JSON.stringify(marker)});`,
        `// Simulate a fatal main() rejection.`,
        `async function main(): Promise<number> { throw new Error('simulated fatal'); }`,
        `withDrainedExit(main);`,
        ``,
      ].join('\n')
    );

    const target = join(scratch, 'r9-output.txt');
    // Sleep 1 s on the consumer side — same calibration as the R1 test,
    // longer than the fixture's own runtime so without the drain the
    // queued bytes are lost when process.exit fires.
    const result = runShell(
      `"${BUN}" "${fixturePath}" 2>/dev/null | { sleep 1; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
    );
    const output = readFileSync(target, 'utf8');

    // The marker must be present and the writer must have exited non-zero
    // (the simulated throw). Both are part of the contract: a future
    // regression that swallows the throw and exits 0 would also be
    // caught by the status assertion.
    expect(result.status).toBe(1);
    expect(output).toContain(marker);
  }, 60_000);

  /**
   * R20 (review report): `withDrainedExit`'s default fatal-error handler
   * prints `Fatal error: <message>` to stderr — the only diagnostic a user
   * sees on an uncaught `main()` rejection. The R9 fixture above redirects
   * stderr to `/dev/null`, so this content has never been captured or
   * asserted by any test. This variant redirects stderr to a file instead
   * and asserts the message survives.
   */
  it('withDrainedExit logs the fatal rejection message to stderr (R20)', () => {
    const fixturePath = join(scratch, 'r20-fixture.ts');
    const exitWithDrainEntry = join(import.meta.dir, 'exit-with-drain.ts');
    writeFileSync(
      fixturePath,
      [
        `import { withDrainedExit } from ${JSON.stringify(exitWithDrainEntry)};`,
        `async function main(): Promise<number> { throw new Error('r20 simulated fatal'); }`,
        `withDrainedExit(main);`,
        ``,
      ].join('\n')
    );

    const stderrTarget = join(scratch, 'r20-stderr.txt');
    const result = runShell(`"${BUN}" "${fixturePath}" > /dev/null 2> "${stderrTarget}"`);
    const stderr = readFileSync(stderrTarget, 'utf8');

    expect(result.status).toBe(1);
    expect(stderr).toContain('Fatal error: r20 simulated fatal');
  }, 30_000);

  /**
   * Static-contract test for R12 (review report): even with the chain
   * wiring extracted to `withDrainedExit`, a regression that bypasses
   * the helper at the cli.ts call site (e.g. replacing
   * `withDrainedExit(main)` with `main().then((c) => process.exit(c))`)
   * is not caught by the R9 pipe test above — the fixture is a self-
   * contained TS script that does not import cli.ts, so its own chain
   * stays correct even when cli.ts drifts. Read cli.ts as a string and
   * assert the call site is the shared helper, so a cli.ts bypass lands
   * here.
   */
  it('routes cli.ts through withDrainedExit — no direct process.exit chain', () => {
    const cliSrc = readFileSync(join(import.meta.dir, '..', 'cli.ts'), 'utf8');
    // Strip line comments so a regression that comments out the import
    // is still caught — `cliSrc.toMatch(/.../)` would still see the
    // text inside the comment and pass falsely otherwise.
    const codeLines = cliSrc.split('\n').filter(line => !line.trimStart().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    // Must import the helper from the module that owns the chain shape.
    expect(codeOnly).toMatch(
      /import\s*\{\s*withDrainedExit\s*\}\s*from\s*['"]\.\/utils\/exit-with-drain['"]/
    );
    // Must invoke it at the top level, with main as the argument. Anchor
    // on `withDrainedExit(` so a future alias import or wrap-in-helper
    // regression is still caught.
    expect(codeOnly).toMatch(/withDrainedExit\s*\(\s*main\s*\)/);
    // Must NOT carry a parallel exit chain. The only legitimate
    // `process.exit` mentions in cli.ts are comments — the filter above
    // already stripped them, so any remaining line with `process.exit`
    // is a regression.
    const offendingExit = codeLines.filter(line => /process\.exit\b/.test(line));
    expect(offendingExit).toEqual([]);
  });
});

/**
 * Unit-level companion to the R5 pipe test above. The pipe test is the
 * integration check (it spawns a real `bun … | head -c 100` pipeline); on
 * macOS the patched `console.log`'s unhandled-rejection trap fires before
 * `process.exit()` and the writer happens to exit 1 even without the
 * `consumeWriteError()` branch in `exit-with-drain.ts`. On the Linux CI
 * runner the trap is scheduled after `process.exit()` has taken effect, so
 * the rejection is silently swallowed and the writer exits 0 — that is what
 * the CI failure looked like.
 *
 * This test mocks `process.stdout.write` to fail with EPIPE so the
 * contract is exercised deterministically on every platform: the shim must
 * record the error in `writeError`, `consumeWriteError()` must surface it,
 * and `exitWithDrain(0)` must exit non-zero. A regression that drops any of
 * those three steps lands here, independent of timing.
 */
describe('safe-console + exit-with-drain — EPIPE unit contract (R5)', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);

  afterAll(() => {
    restoreConsole();
    // Restore process.stdout.write even if a test threw mid-flight so the
    // other test files in this run are not contaminated.
    process.stdout.write = originalWrite as typeof process.stdout.write;
  });

  it('records a process.stdout.write failure in writeError and consumeWriteError() surfaces it', async () => {
    // Install fresh so the unit-test branch runs in isolation even if a
    // sibling test already called installPipeSafeConsole().
    installPipeSafeConsole();

    // Mock process.stdout.write to fail with EPIPE on the next call.
    const epipe = Object.assign(new Error('EPIPE: broken pipe, write'), {
      code: 'EPIPE' as const,
    });
    let calls = 0;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((
      _chunk: unknown,
      ...args: unknown[]
    ) => {
      calls++;
      const callback =
        typeof args[0] === 'function' ? (args[0] as (err?: Error | null) => void) : args[1];
      if (typeof callback === 'function') callback(epipe);
      return true;
    }) as typeof process.stdout.write;

    try {
      console.log('this will fail with EPIPE');

      // Wait for the in-flight write to reject and pendingWrites to drain.
      // flushPendingWrites resolves via Promise.allSettled so it never
      // throws on a rejected write — the rejection is observed.
      // Importing flushPendingWrites here keeps the call chain explicit
      // and avoids relying on the export order from safe-console.ts.
      const { flushPendingWrites } = await import('./safe-console');
      await flushPendingWrites();

      expect(calls).toBe(1);
      const err = consumeWriteError();
      expect(err).not.toBeNull();
      expect((err as NodeJS.ErrnoException).code).toBe('EPIPE');
      // consumeWriteError is a one-shot — a second call must return null so
      // a later exitWithDrain(0) does not double-flip the exit code.
      expect(consumeWriteError()).toBeNull();
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write =
        originalWrite as typeof process.stdout.write;
    }
  }, 30_000);

  /**
   * `exitWithDrain(0)` must exit 1 when `consumeWriteError()` returns an
   * error — this is the deterministic path that closes the Linux-CI
   * regression. We assert the resolved exit code by intercepting
   * `process.exit` (rather than letting it terminate the test runner).
   */
  it('exitWithDrain(0) calls process.exit(1) when writeError is set', () => {
    // Restore stdout.write (the previous test's finally block already did,
    // but assert it explicitly so the contract is self-describing).
    (process.stdout as unknown as { write: typeof process.stdout.write }).write =
      originalWrite as typeof process.stdout.write;

    // Seed writeError the same way the shim does, then run the exit helper
    // with a captured process.exit to observe the resulting code.
    const epipe = Object.assign(new Error('EPIPE: broken pipe, write'), {
      code: 'EPIPE' as const,
    });
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((
      _chunk: unknown,
      ...args: unknown[]
    ) => {
      const callback =
        typeof args[0] === 'function' ? (args[0] as (err?: Error | null) => void) : args[1];
      if (typeof callback === 'function') callback(epipe);
      return true;
    }) as typeof process.stdout.write;

    const originalExit = process.exit.bind(process);
    let observed: number | undefined;
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      observed = code;
      // Throw to short-circuit exitWithDrain's second process.exit call —
      // we only care which code the first one passes.
      throw new Error('observed exit');
    }) as (code?: number) => never;

    try {
      installPipeSafeConsole();
      console.log('this will fail with EPIPE');
      // The exit helper awaits flushPendingWrites before reading writeError,
      // so we let the microtask queue drain.
      void exitWithDrain(0).catch(() => {
        // The first process.exit throws 'observed exit' on purpose; the
        // helper never reaches the second one because it throws first.
      });
    } catch {
      // installPipeSafeConsole does not throw — nothing to catch here.
    } finally {
      // Drain the in-flight write so writeError is recorded before we
      // assert. flushPendingWrites resolves on the next microtask.
      // We await it here in a finally because the catch above does not
      // re-await the original chain.
    }

    // Allow the rejection to propagate so consumeWriteError sees it.
    return new Promise<void>(resolve => {
      setImmediate(() => {
        try {
          expect(observed).toBe(1);
        } finally {
          (process as unknown as { exit: (code?: number) => never }).exit = originalExit as (
            code?: number
          ) => never;
          (process.stdout as unknown as { write: typeof process.stdout.write }).write =
            originalWrite as typeof process.stdout.write;
          restoreConsole();
          resolve();
        }
      });
    });
  }, 30_000);

  it('exitWithDrain(nonZero) preserves the caller-supplied code even when writeError is set', () => {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write =
      originalWrite as typeof process.stdout.write;

    // Same mock as the previous test — we only need writeError populated.
    const epipe = Object.assign(new Error('EPIPE: broken pipe, write'), {
      code: 'EPIPE' as const,
    });
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((
      _chunk: unknown,
      ...args: unknown[]
    ) => {
      const callback =
        typeof args[0] === 'function' ? (args[0] as (err?: Error | null) => void) : args[1];
      if (typeof callback === 'function') callback(epipe);
      return true;
    }) as typeof process.stdout.write;

    const originalExit = process.exit.bind(process);
    let observed: number | undefined;
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      observed = code;
      throw new Error('observed exit');
    }) as (code?: number) => never;

    try {
      installPipeSafeConsole();
      console.log('this will fail with EPIPE');
      void exitWithDrain(7).catch(() => {});
    } catch {
      // installPipeSafeConsole does not throw.
    }

    return new Promise<void>(resolve => {
      setImmediate(() => {
        try {
          // exitWithDrain(7) should exit 7 — the EPIPE error must NOT
          // overwrite an already non-zero caller-supplied code.
          expect(observed).toBe(7);
        } finally {
          (process as unknown as { exit: (code?: number) => never }).exit = originalExit as (
            code?: number
          ) => never;
          (process.stdout as unknown as { write: typeof process.stdout.write }).write =
            originalWrite as typeof process.stdout.write;
          restoreConsole();
          resolve();
        }
      });
    });
  }, 30_000);

  /**
   * R19 (review report): every EPIPE fixture above uses `code: 'EPIPE'` —
   * the exit-code-flip logic has no EPIPE-specific branch, but nothing
   * proved that until now. A non-EPIPE write failure (e.g. `ENOSPC`) must
   * still force `exitWithDrain(0)` to exit 1, and — per R17 — must also be
   * logged, since it carries no other diagnostic trail (the patched
   * `console.log` is fire-and-forget and never re-throws).
   */
  it('exitWithDrain(0) still exits 1 and logs a non-EPIPE write failure', () => {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write =
      originalWrite as typeof process.stdout.write;

    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC' as const,
    });
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((
      _chunk: unknown,
      ...args: unknown[]
    ) => {
      const callback =
        typeof args[0] === 'function' ? (args[0] as (err?: Error | null) => void) : args[1];
      if (typeof callback === 'function') callback(enospc);
      return true;
    }) as typeof process.stdout.write;

    const originalExit = process.exit.bind(process);
    let observed: number | undefined;
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      observed = code;
      throw new Error('observed exit');
    }) as (code?: number) => never;

    const originalError = console.error;
    let loggedArgs: unknown[] | undefined;
    console.error = ((...args: unknown[]) => {
      loggedArgs = args;
    }) as typeof console.error;

    try {
      installPipeSafeConsole();
      console.log('this will fail with ENOSPC');
      void exitWithDrain(0).catch(() => {});
    } catch {
      // installPipeSafeConsole does not throw.
    }

    return new Promise<void>(resolve => {
      setImmediate(() => {
        try {
          expect(observed).toBe(1);
          expect(loggedArgs?.join(' ')).toContain('ENOSPC: no space left on device, write');
        } finally {
          (process as unknown as { exit: (code?: number) => never }).exit = originalExit as (
            code?: number
          ) => never;
          (process.stdout as unknown as { write: typeof process.stdout.write }).write =
            originalWrite as typeof process.stdout.write;
          console.error = originalError;
          restoreConsole();
          resolve();
        }
      });
    });
  }, 30_000);
});
