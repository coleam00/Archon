/**
 * Port allocation utilities for Hono server
 * Separated from index.ts to allow testing without triggering app startup
 */
import { createHash } from 'crypto';
import { createServer } from 'node:net';
import { isWorktreePath } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('port-allocation');
  return cachedLog;
}

/** Base port for the Hono server; also the Vite dev proxy's fallback target. */
const BASE_PORT = 3090;
/** Lowest worktree offset. Ports below this stay clear of the base port. */
const MIN_OFFSET = 100;
/** Number of distinct worktree offsets (100–999 → ports 3190–4089). */
const OFFSET_SPAN = 900;

/**
 * Calculate hash-based port offset for worktree paths.
 * Exported for testing.
 *
 * @param path - The worktree path to hash
 * @returns Offset in range 100-999 (ports 3190-4089 when added to base 3090)
 */
export function calculatePortOffset(path: string): number {
  const hash = createHash('md5').update(path).digest();
  // 100-999 range: offset starts at 100; produces ports 3190-4089 when added to basePort (3090)
  return (hash.readUInt16BE(0) % OFFSET_SPAN) + MIN_OFFSET;
}

/**
 * Report whether `port` can be bound on `hostname`.
 *
 * Binds and immediately closes rather than scanning a port list, so the answer
 * reflects what `Bun.serve` will actually be allowed to do — a port held by
 * another user, or blocked by a local policy, reads as unavailable here for the
 * same reason it would fail at startup. `hostname` mirrors the server's own
 * `process.env.HOST || '0.0.0.0'`, because availability is per-interface: a
 * process bound to 127.0.0.1 does not block 0.0.0.0 on every platform.
 *
 * Exported for testing.
 */
export function isPortAvailable(port: number, hostname: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    // Both listeners settle the same promise; `once` plus the immediate close
    // below means whichever fires first wins and the other never runs.
    probe.once('error', () => {
      resolve(false);
    });
    probe.once('listening', () => {
      probe.close(() => {
        resolve(true);
      });
    });
    probe.listen(port, hostname);
  });
}

/**
 * Get the port for the Hono server
 * - If PORT env var is set: use it (explicit override, validated, never probed)
 * - If running in worktree: deterministic port from the path hash, advanced to the
 *   next free port in the range when that one is taken
 * - Otherwise: use default 3090 (matches the Vite proxy fallback in packages/web/vite.config.ts)
 *
 * Note: Exits process with code 1 if PORT env var is set but invalid (not 1-65535)
 */
export async function getPort(): Promise<number> {
  const envPort = process.env.PORT;

  if (envPort) {
    const parsedPort = Number(envPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      getLog().fatal({ envPort }, 'invalid_port_env_var');
      process.exit(1);
    }
    // Deliberately unprobed: an explicit PORT is an instruction, not a preference.
    // Moving the operator off the port they named would break whatever they pointed
    // at it; a bind failure here is the honest outcome.
    return parsedPort;
  }

  const cwd = process.cwd();
  const hostname = process.env.HOST || '0.0.0.0';

  if (await isWorktreePath(cwd)) {
    return resolveWorktreePort(calculatePortOffset(cwd), hostname, cwd);
  }

  // The base port is NOT probed. Unlike a worktree port, 3090 is a value other
  // things resolve independently — vite.config.ts falls back to it verbatim when
  // PORT is unset — so silently serving from somewhere else would leave the dev
  // proxy pointing at nothing. A collision here is the operator's to resolve, with
  // PORT or by freeing the socket, and Bun.serve reports it.
  getLog().info({ port: BASE_PORT }, 'default_port_selected');
  return BASE_PORT;
}

/**
 * Resolve a worktree's port: the hashed offset when it is free, otherwise the next
 * free offset in the range.
 *
 * Exported for testing: reaching this through `getPort()` requires the suite itself to
 * be running inside a worktree, so a collision test written against `getPort()` passes
 * by skipping in the main repo — including in CI, where it would never once exercise
 * the fallback it claims to cover.
 *
 * The hash is a convenience — "this worktree, this port, every time" — not a value
 * anything else recomputes, so yielding it to a live listener costs nothing a caller
 * can observe. 900 offsets is a small space: collisions between worktrees reach
 * roughly even odds around 35 of them, and any unrelated local process holding a port
 * in 3190–4089 collides too. Scanning forward from the hashed offset keeps the result
 * stable for a given occupancy rather than reshuffling every worktree.
 *
 * Racy by construction: another process can take the port between this probe and
 * `Bun.serve`. Closing that window means holding the socket from here to the server,
 * which this function does not own. The probe removes the common case — a port
 * already held when the server starts — and leaves the narrow one to the bind error.
 */
export async function resolveWorktreePort(
  offset: number,
  hostname: string,
  cwd: string
): Promise<number> {
  for (let attempt = 0; attempt < OFFSET_SPAN; attempt += 1) {
    const candidate = MIN_OFFSET + ((offset - MIN_OFFSET + attempt) % OFFSET_SPAN);
    const port = BASE_PORT + candidate;
    if (!(await isPortAvailable(port, hostname))) continue;

    if (attempt === 0) {
      getLog().info({ cwd, port, basePort: BASE_PORT, offset }, 'worktree_port_allocated');
    } else {
      getLog().info(
        { cwd, port, basePort: BASE_PORT, offset: candidate, preferredOffset: offset, attempt },
        'worktree_port_reallocated'
      );
    }
    return port;
  }

  getLog().fatal(
    {
      cwd,
      rangeStart: BASE_PORT + MIN_OFFSET,
      rangeEnd: BASE_PORT + MIN_OFFSET + OFFSET_SPAN - 1,
      hint: 'Free a port in the range, or set PORT to choose one explicitly.',
    },
    'worktree_port_range_exhausted'
  );
  throw new Error(
    `No free port for this worktree in ${String(BASE_PORT + MIN_OFFSET)}-${String(
      BASE_PORT + MIN_OFFSET + OFFSET_SPAN - 1
    )}. Free one, or set PORT explicitly.`
  );
}
