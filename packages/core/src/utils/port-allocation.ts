/**
 * Port allocation utilities for Hono server
 * Separated from index.ts to allow testing without triggering app startup
 */
import { createHash } from 'crypto';
import { isWorktreePath } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('port-allocation');
  return cachedLog;
}

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
  return (hash.readUInt16BE(0) % 900) + 100;
}

/**
 * Get the port for the Hono server
 * - If PORT env var is set: use it (explicit override, validated)
 * - If running in worktree: auto-allocate deterministic port based on path hash
 * - Otherwise: use default 3000
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
    return parsedPort;
  }

  const basePort = 3090;
  const cwd = process.cwd();

  if (await isWorktreePath(cwd)) {
    const offset = calculatePortOffset(cwd);
    const port = basePort + offset;
    getLog().info({ cwd, port, basePort, offset }, 'worktree_port_allocated');
    return port;
  }

  getLog().info({ port: basePort }, 'default_port_selected');
  return basePort;
}
