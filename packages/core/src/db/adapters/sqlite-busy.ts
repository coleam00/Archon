import { SQLiteError } from 'bun:sqlite';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.sqlite');
  return cachedLog;
}

/**
 * SQLITE_BUSY and its extended codes (BUSY_SNAPSHOT, BUSY_RECOVERY, BUSY_TIMEOUT):
 * another connection holds the lock. SQLITE_LOCKED (6) is a same-connection conflict
 * that waiting cannot clear, so it is not included.
 */
export function isSqliteBusy(error: unknown): error is SQLiteError {
  return error instanceof SQLiteError && (error.errno & 0xff) === 5;
}

const BUSY_RETRY_MAX_DELAY_MS = 2000;
const BUSY_WARN_INTERVAL_MS = 30_000;

/**
 * Run `attempt` until it stops failing with SQLITE_BUSY. Each attempt already waits
 * up to busy_timeout inside SQLite; between attempts this backs off without blocking
 * the event loop. There is deliberately no deadline: the lock belongs to another live
 * process, and a timer that gives up would end a run whose work is not lost, only
 * waiting. A lock that never clears shows up as a repeating warning, not a failure.
 */
export async function retryWhileBusy<T>(
  operation: 'statement' | 'transaction',
  attempt: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  let delayMs = 50;
  let nextWarnAtMs = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= nextWarnAtMs) {
        getLog().warn({ operation, code: error.code, waitedMs }, 'db.sqlite_busy_waiting');
        nextWarnAtMs = waitedMs + BUSY_WARN_INTERVAL_MS;
      }
      await Bun.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, BUSY_RETRY_MAX_DELAY_MS);
    }
  }
}

/**
 * `retryWhileBusy` for synchronous WAL initialization and schema convergence.
 * Switching a fresh file to WAL takes
 * a lock that SQLite does not wait for through busy_timeout, so a process opening the
 * same new database as another one gets SQLITE_BUSY there instead of waiting.
 */
export function retryWhileBusySync(attempt: () => void): void {
  const startedAt = Date.now();
  let delayMs = 10;
  let nextWarnAtMs = 0;
  for (;;) {
    try {
      attempt();
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= nextWarnAtMs) {
        getLog().warn({ operation: 'open', code: error.code, waitedMs }, 'db.sqlite_busy_waiting');
        nextWarnAtMs = waitedMs + BUSY_WARN_INTERVAL_MS;
      }
      Bun.sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, BUSY_RETRY_MAX_DELAY_MS);
    }
  }
}
