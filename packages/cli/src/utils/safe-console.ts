/**
 * Pipe-safe `console.log` for CLI human-readable output.
 *
 * ## Why this exists (#2400)
 *
 * Pino's default destination opens fd 1 in non-blocking mode as a side effect
 * of `@archon/paths` being imported — every CLI command inherits that fd
 * state. On a non-blocking pipe (`archon … | less`, `archon … | head`,
 * `archon … | grep`), `console.log` calls that exceed the pipe's buffer can
 * silently drop the unwritten tail and exit 0 (see the file-redirect vs pipe
 * asymmetry in `utils/stdout.ts`). PR #2389 fixed the machine-readable
 * `--json` paths by routing every JSON emitter through `writeStdout` /
 * `writeJsonLine`. This patch is the symmetrical fix for human-readable
 * `console.log` calls — 226 of them across `packages/cli/src/commands/*.ts`,
 * every one a piped-failure site against a slow reader.
 *
 * The patch delegates through the same `writeStdout` primitive that
 * `--json` already uses, so short writes and `EAGAIN` are retried by the
 * stream rather than lost. The `void` return shape preserves the original
 * `console.log` signature so existing callers (and `spyOn(console, 'log')`
 * mocks in `workflow.test.ts` / `cli-adapter.test.ts`) keep working unchanged.
 *
 * Delivery itself is fire-and-forget: the patched `console.log` returns
 * synchronously and bytes reach the OS in the background via the underlying
 * `process.stdout.write` stream callback. `cli.ts` therefore awaits
 * `flushPendingWrites()` between `main()` resolving and `process.exit()` —
 * `process.exit()` does not drain the stream's pending writes, so without
 * that flush a very-slow reader (e.g. `archon … | { sleep 1; cat; }`) would
 * re-introduce the same silent-exit-0 truncation the patch is meant to
 * eliminate.
 *
 * If a write fails (e.g. EPIPE because a piped reader hung up after `head -c
 * 100`), the underlying rejection is recorded in `writeError` (see below).
 * The deterministic exit-code path lives in `consumeWriteError()`, which
 * `exitWithDrain()` calls after draining the in-flight writes: any captured
 * error forces a non-zero exit regardless of which platform's runtime
 * observed the rejection first. We deliberately do NOT re-throw the error
 * asynchronously — a re-thrown async error still races `process.exit()` on
 * Linux and would re-introduce the very flakiness the `consumeWriteError()`
 * path was added to remove.
 *
 * ## Scope (deliberate)
 *
 * - `console.log` and `console.info` are patched; `console.warn` /
 *   `console.error` are NOT. They write to stderr, which carries short
 *   diagnostics rather than command output, and `console.warn` is also used
 *   by CLI commands as the deliberate "non-pino diagnostic" channel (e.g.
 *   `workflow.ts`); routing it through `writeStdout` would change where it
 *   lands, which is a separate decision.
 * - `console.info` shares fd 1 with `console.log` in Bun (it is an alias, not
 *   a stderr method), so it would be vulnerable to the same truncation and
 *   is patched to the same delegate.
 * - Color is hard-disabled: Bun's built-in would colorize on TTY, but human
 *   CLI text (`console.log(\`some text\`)`) does not depend on ANSI. Pino
 *   pretty-printing (used when the log destination is a TTY, see
 *   `paths/src/logger.ts`) still colorizes its own output.
 * - Idempotent: a second call is a no-op so re-imports don't double-wrap.
 *
 * ## Maintainer warning
 *
 * The CLI now sends pino to stderr (`setLogDestination` in `cli.ts`), except
 * for `archon serve`. That does not retire this patch: a non-blocking flag
 * belongs to the open file description, which fd 1 and fd 2 share whenever
 * they point at the same pipe or terminal (`2>&1`, a pty), Bun's own pipe
 * handling can drop the tail (#2384), and `serve` still logs to stdout. Keep
 * the patch unless a slow-reader pipe test proves stdout cannot truncate.
 */

import { formatWithOptions } from 'node:util';
import { writeStdout } from './stdout';

const ORIGINAL_LOG = console.log.bind(console);
const ORIGINAL_INFO = console.info.bind(console);

let installed = false;

/**
 * In-flight `writeStdout` promises. `process.exit()` does NOT drain
 * `process.stdout`'s pending writes, so the CLI entry must await this set
 * to guarantee every byte has reached the OS before it terminates — see
 * R1 in `artifacts/runs/ae71ab1e-…/review/report.md`.
 */
const pendingWrites = new Set<Promise<void>>();

/**
 * First `process.stdout.write` error observed by the patched `console.log`,
 * if any. Cleared by `consumeWriteError()` so the exit code only flips once.
 * EPIPE is the common case (a piped reader like `head -c 100` hangs up after
 * its slice, then the next write to fd 1 fails with `EPIPE: broken pipe`).
 *
 * The shim attaches a `.catch()` to the per-write promise that records the
 * error here. `exitWithDrain()` reads it back via `consumeWriteError()` and
 * forces a non-zero exit when it is set — that is what makes the exit code
 * deterministic across platforms, including the Linux CI runner where Bun
 * schedules its unhandled-rejection handler after `process.exit()` has
 * already taken effect and the rejection would otherwise be swallowed.
 *
 * The `.catch()` here marks the per-write rejection as handled (so the test
 * runner does not see it as an unhandled error), but we do NOT re-throw it
 * elsewhere: a re-thrown async error would still race `process.exit()` on
 * Linux and re-introduce the very flakiness the `consumeWriteError()` path
 * was added to remove.
 */
let writeError: NodeJS.ErrnoException | null = null;

/**
 * Resolve once every write queued so far has been handed to the OS in full.
 * `cli.ts` calls this between `main()` resolving and `process.exit()` so the
 * fire-and-forget patched `console.log` cannot race the exit and drop the
 * tail of the output.
 */
export function flushPendingWrites(): Promise<void> {
  return Promise.allSettled([...pendingWrites]).then(() => undefined);
}

/**
 * Pop the first write error observed by the patched `console.log`, if any.
 * `exitWithDrain()` calls this between draining and `process.exit()` so a
 * failed write (typically `EPIPE`) deterministically forces a non-zero exit
 * code, independent of the runtime's unhandled-rejection ordering. Returns
 * `null` when every write succeeded.
 */
export function consumeWriteError(): NodeJS.ErrnoException | null {
  const err = writeError;
  writeError = null;
  return err;
}

/**
 * Replace `console.log` and `console.info` with a pipe-safe delegate that
 * routes every call through `writeStdout`. Safe to call multiple times —
 * only the first call has any effect.
 *
 * The patched functions keep `console.log`'s void-return signature. Callers
 * that don't await them (the entire existing call surface) keep working;
 * the underlying `process.stdout.write` stream callback fires once the bytes
 * have reached the OS, retrying short writes and `EAGAIN` through the event
 * loop (no busy-wait). See `utils/stdout.ts` for the underlying primitive.
 * Callers that DO need delivery confirmation before the process exits must
 * await `flushPendingWrites()` — see `utils/exit-with-drain.ts` (the
 * `withDrainedExit` helper that owns this) and the `withDrainedExit(main)`
 * call at the end of `cli.ts`.
 */
export function installPipeSafeConsole(): void {
  if (installed) return;
  installed = true;

  // `function` (not arrow) so `console.log.toString()` reports the name
  // and stack traces point at the wrapped symbol, which helps when a test
  // asserts on `console.log` identity.
  function pipeSafeLog(...args: unknown[]): void {
    // `colors: false` — Bun's built-in would colorize on TTY; CLI human
    // output (template strings, status lines) does not depend on ANSI.
    // `depth: 4` matches Bun's default for objects so a single-line diff in
    // CI is meaningful.
    const text = formatWithOptions({ colors: false, depth: 4 }, ...args) + '\n';
    // Fire-and-forget: keep `void` return so callers don't have to await,
    // and so tests that mock `console.log` with `() => {}` still pass.
    // Errors from `writeStdout` are recorded in `writeError` and consumed by
    // `exitWithDrain()` to force a non-zero exit (see the `writeError`
    // comment). The Linux CI runner schedules Bun's unhandled-rejection
    // handler after `process.exit()` has taken effect; without the explicit
    // `writeError` flag the exit code would silently drop to 0 — see the
    // R5 regression test in `safe-console.test.ts`.
    // The promise is tracked in `pendingWrites` so `flushPendingWrites()`
    // can drain it before `process.exit()`.
    const p = writeStdout(text).finally(() => {
      pendingWrites.delete(p);
    });
    pendingWrites.add(p);
    p.catch((err: unknown) => {
      const e = err as NodeJS.ErrnoException;
      if (writeError === null) writeError = e;
    });
  }

  // Preserve the original symbol name so logs / stack traces still read
  // "log" rather than "pipeSafeLog". (Both console.log and console.info
  // delegate to the same function and therefore share this name — there is
  // no separate "info" frame name to preserve.)
  Object.defineProperty(pipeSafeLog, 'name', { value: 'log', configurable: true });

  const consoleAny = console as {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  consoleAny.log = pipeSafeLog;
  consoleAny.info = pipeSafeLog;
}

/** For tests / rollback: restore the original `console.log` / `console.info`. */
export function restoreConsole(): void {
  if (!installed) return;
  installed = false;
  // Reset alongside `installed` so a caller that restores without consuming
  // a pending write error (via `consumeWriteError()`) doesn't leave it to be
  // read by a later, unrelated `exitWithDrain()` call after reinstalling.
  writeError = null;
  const consoleAny = console as {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  consoleAny.log = ORIGINAL_LOG;
  // Best-effort: if console.info was never read it may not be writable in
  // every runtime. The patched write is the only reason we touch it.
  try {
    consoleAny.info = ORIGINAL_INFO;
  } catch {
    // ignore — test-only fallback path
  }
}
