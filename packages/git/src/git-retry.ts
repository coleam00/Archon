/**
 * Retry helpers for transient git errors.
 *
 * Background — issue #640: when `pr_autopilot` dispatches several
 * `archon-fix-pr-review` runs in the same tick, each runs `WorktreeProvider.create()`
 * against the same canonical checkout. All linked worktrees share one `.git/config`,
 * and concurrent `git worktree add -b …` / upstream-config writes collide on the
 * transient `config.lock` file. Today those failures are FATAL — the losing
 * process exits with code 1 before the DAG can run, and expensive LLM fix work is
 * discarded. This module centralizes retry logic for these transient errors.
 */

/** Substrings that identify a transient `.git/config.lock` collision. */
export const GIT_CONFIG_LOCK_PATTERNS = [
  'could not lock config file',
  'unable to write upstream branch configuration',
] as const;

/**
 * Return true if `err` looks like a transient `.git/config.lock` collision.
 *
 * We scan both `err.message` and `err.stderr` (git often reports the lock failure
 * on stderr while still throwing with a generic `code: 1`). The check is
 * case-insensitive to be defensive about git's own wording (e.g. `fatal: Could
 * not lock config file …` on some git versions).
 */
export function isGitConfigLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const stderr =
    err !== null &&
    typeof err === 'object' &&
    'stderr' in err &&
    typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr
      : '';
  const combined = `${message}\n${stderr}`.toLowerCase();
  return GIT_CONFIG_LOCK_PATTERNS.some(pattern => combined.includes(pattern));
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

function jitteredDelayMs(attempt: number, baseDelayMs: number): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_DELAY_MS);
  return exponential + Math.floor(Math.random() * Math.min(500, baseDelayMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface ExecGitOptions {
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExecGitRetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms (default 1000). */
  baseDelayMs?: number;
}

/**
 * Sign-compatible with `execFileAsync` from `@archon/git` (the child_process
 * promisified wrapper exposed via `packages/git/src/exec.ts`). Kept as an inline
 * type so this module does not require a circular import into `@archon/git`.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  options?: ExecGitOptions
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Run `execFn(cmd, args, options)` and retry ONLY on transient
 * `.git/config.lock` collisions. All other errors propagate immediately.
 *
 * The retry budget caps at `maxAttempts` (default 3). Between attempts we sleep
 * `jitteredDelayMs` — same shape as `providers/community/omp/retry.ts` — to
 * stagger across concurrent workers and avoid synchronized retries.
 *
 * We never auto-delete `config.lock`. A stale lock (from a crashed git process)
 * is an operator-visible problem; retry alone resolves transient contention, and
 * after `maxAttempts` the original error is re-thrown so the caller can surface
 * it for diagnosis (see investigation artefact, "Edge Cases & Risks").
 */
export async function execGitWithRetry(
  execFn: ExecFn,
  cmd: string,
  args: string[],
  options?: ExecGitOptions,
  retryOpts?: ExecGitRetryOptions
): Promise<{ stdout: string; stderr: string }> {
  const maxAttempts = retryOpts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = retryOpts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  if (maxAttempts < 1) {
    throw new Error(`execGitWithRetry: maxAttempts must be >= 1 (got ${maxAttempts})`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await execFn(cmd, args, options);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (!isGitConfigLockError(err) || isLastAttempt) {
        throw err;
      }
      const delayMs = jitteredDelayMs(attempt, baseDelayMs);
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt, but
  // TypeScript can't see that. Re-throw the last captured error verbatim.
  throw lastError;
}
