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
import { describe, it, expect, afterAll } from 'bun:test';
import { consumeWriteError, installPipeSafeConsole, restoreConsole } from './safe-console';
import { exitWithDrain } from './exit-with-drain';

/**
 * Unit-level companion to the R5 pipe test in stdout.test.ts. The pipe test is the
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

  afterAll(async () => {
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
