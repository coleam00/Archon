/**
 * Filesystem and logging helpers shared by tests across packages.
 *
 * This module is test-only. Nothing in `src/` imports it; it lives here because
 * `@archon/paths` is the one package every consumer of these helpers already depends on.
 */
import { afterEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import pino from 'pino';
import { rootLogger } from './logger';

/** Attempts before a stuck tree is reported as a leak rather than retried again. */
const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 50;

/**
 * Codes meaning "something still holds this tree", not "this can never be removed".
 *
 * The first five are the set Node documents for `rm`'s own `maxRetries`. `EFAULT` is the
 * odd one, and it is not defensive padding — under Bun it is the only entry that does any
 * work. Bun's `rm` maps any underlying OS error it cannot classify onto `EFAULT`, so an
 * ordinary lock arrives wearing a code that reads as a bad pointer. Measured against the
 * probe described below, which induces a genuine `EPERM` with the macOS `uchg` flag and
 * releases it after 300 ms: with `EFAULT` listed the tree is removed after ~310 ms of
 * retrying; with it dropped the same call gives up in 0 ms and leaves the tree on disk,
 * because the `EPERM` never arrives under that name. This is the signature these cleanups
 * fail with on Windows CI (#2306).
 *
 * Because Bun collapses unmapped errors onto `EFAULT`, this set cannot be exhaustive in
 * either direction; a permanently unremovable tree may also arrive as `EFAULT` and simply
 * costs the full retry budget before it is reported. That is acceptable because both
 * paths end the same way — see `removeTempTree`.
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM', 'EFAULT']);

/**
 * Remove a test temp tree, retrying while the OS still holds a handle inside it.
 *
 * A just-exited child process, or the test's own preceding async writes, can leave a
 * handle open for a short window after the work that created it finished. Windows is
 * where this actually bites: an unretried cleanup there fails the test that just passed
 * (#2306).
 *
 * The retry is written out rather than delegated to `rm`'s own `maxRetries`/`retryDelay`
 * because **Bun accepts those options and ignores them**. Measured on Bun 1.3.11: against
 * a tree holding one file locked with the macOS `uchg` flag (unlink returns EPERM, which
 * is in the retry set Node documents), `rm(..., { maxRetries: 10, retryDelay: 50 })`
 * rejects in 0 ms, while the same call on node v25.6.1 retries for ~300 ms and succeeds
 * once the flag clears. `rmSync` behaves the same way. Bun also reports errors it cannot
 * map as `EFAULT` — that same locked-file probe surfaces EPERM as
 * `EFAULT: bad address in system call argument`, which is why cleanup failures on Windows
 * CI carry a code that looks nothing like a lock. Switching back to the built-in options
 * is safe only once Bun actually honors them.
 *
 * Failing to delete a scratch directory is not a test failure, so a tree that never comes
 * free warns instead of throwing — but it does warn, so a genuine leak stays visible. An
 * error outside `TRANSIENT_CODES` takes that same exit immediately rather than retrying
 * against a condition that will not clear. (`force: true` already absorbs "already gone".)
 */
export async function removeTempTree(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_ATTEMPTS || code === undefined || !TRANSIENT_CODES.has(code)) {
        console.warn(`temp cleanup failed for ${path}: ${String(error)}`);
        return;
      }
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Track temp roots for teardown, and register the `afterEach` that removes them.
 *
 * Call once at module scope and pass every root through the returned function as it is
 * created:
 *
 * ```ts
 * const trackTempRoot = trackTempRoots();
 * const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'fixture-')));
 * ```
 *
 * Registering at creation rather than removing at the end of the test body is the point:
 * a trailing removal runs only when every assertion above it passed, so the tests most
 * worth diagnosing are exactly the ones that leak their fixture. It also keeps the
 * removal off the test's own time budget.
 *
 * The invariant is "every root this file created gets torn down", and it holds only while
 * roots are created through one helper that tracks them. A test that calls `mkdtemp`
 * inline instead leaks silently, so give each file a single creation helper and route
 * every fixture through it.
 *
 * Not for a teardown that has to do something else first — stopping a child process,
 * closing a database — before the tree can be removed. Splitting that into two hooks
 * makes correctness depend on their registration order, which nothing states and a later
 * edit can invert. Keep those files on one explicit `afterEach` that calls
 * `removeTempTree` in the right sequence.
 */
export function trackTempRoots(): (root: string) => string {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await removeTempTree(root);
  });
  return root => {
    roots.push(root);
    return root;
  };
}

/**
 * Record the structured lines every child logger writes, through the root logger's
 * stream, while still forwarding them. Pino's stream symbol is a plain `Symbol`, so it
 * must come from the pino instance that built `rootLogger`, which is this package's.
 */
export function captureLogLines(): { lines: Record<string, unknown>[]; restore(): void } {
  const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => unknown }>)[
    pino.symbols.streamSym
  ];
  const write = stream.write;
  const lines: Record<string, unknown>[] = [];
  stream.write = (chunk: string): unknown => {
    lines.push(JSON.parse(chunk) as Record<string, unknown>);
    return write.call(stream, chunk);
  };
  return {
    lines,
    restore: (): void => {
      stream.write = write;
    },
  };
}
