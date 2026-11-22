import { createLogger } from '@archon/paths';
import { GitFailure } from './errors';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/** How long a step waits out another writer before it reports the failure. */
export const LOCK_WAIT_MS = 30_000;

/**
 * Whether a failure may be another writer holding a lock this step needs: a git process
 * that ran and exited nonzero, or an exclusive create of a lock file that already exists.
 * Git has no distinct exit status for a held `index.lock` or `config.lock`, and its message
 * is prose, so any exited git failure counts. A git that could not start or was killed by
 * its timeout does not.
 */
function mayBeHeldLock(error: unknown): boolean {
  if (error instanceof GitFailure) {
    return error.kind === 'unclassified' && typeof error.code === 'number' && error.code > 0;
  }
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Run a repeatable git step, waiting out another process that holds one of git's locks.
 *
 * Two runs that start together on one project sync the same base checkout and write the
 * same global config, and git refuses the second writer while the first holds its lock.
 * Git releases a lock when its process exits, so this waits for that and tries again. It
 * never removes a lock. Only a step that converges when run again belongs here: a
 * failure that is not contention is retried too, so it is reported up to `budgetMs`
 * later, with the attempt count and the original error as its cause.
 */
export async function waitOutGitLocks<T>(
  step: () => Promise<T>,
  context: { event: string; path: string },
  budgetMs = LOCK_WAIT_MS
): Promise<T> {
  let firstFailureAt: number | undefined;
  let delay = 200;
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (!mayBeHeldLock(error)) throw error;
      firstFailureAt ??= Date.now();
      if (Date.now() - firstFailureAt + delay > budgetMs) {
        if (attempt === 1) throw error;
        getLog().warn({ err: error, ...context, attempts: attempt }, `${context.event}_gave_up`);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (after ${String(attempt)} attempts)`, { cause: error });
      }
      getLog().debug({ err: error, ...context, attempt }, `${context.event}_retry`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2_000);
    }
  }
}
