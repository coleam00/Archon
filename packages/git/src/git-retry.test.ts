/**
 * Unit tests for transient `.git/config.lock` retry helpers.
 *
 * Background — issue #640: concurrent `WorktreeProvider.create()` calls on the
 * same canonical repo collide on git's transient `config.lock`. These tests
 * pin the contract of `isGitConfigLockError` and `execGitWithRetry` so future
 * changes can't silently regress the recovery path.
 */

import { describe, test, expect } from 'bun:test';

import {
  execGitWithRetry,
  GIT_CONFIG_LOCK_PATTERNS,
  isGitConfigLockError,
  type ExecFn,
} from './git-retry';

const LOCK_ERR_STDERR =
  'error: could not lock config file .git/config: File exists\n' +
  'error: unable to write upstream branch configuration\n' +
  'hint: git branch --set-upstream-to=origin/refs/heads/main';

function makeLockError(): Error & { stderr: string; code?: number } {
  const err = new Error('Command failed: git fetch origin main') as Error & {
    stderr: string;
    code?: number;
  };
  err.stderr = LOCK_ERR_STDERR;
  err.code = 1;
  return err;
}

function makeOtherError(): Error & { stderr: string; code?: number } {
  const err = new Error('Command failed: git fetch origin main') as Error & {
    stderr: string;
    code?: number;
  };
  err.stderr = 'fatal: unable to access repository';
  err.code = 128;
  return err;
}

describe('isGitConfigLockError', () => {
  test('detects canonical lock error from message', () => {
    const err = new Error('fatal: could not lock config file .git/config: File exists');
    expect(isGitConfigLockError(err)).toBe(true);
  });

  test('detects upstream-tracking hint from stderr', () => {
    expect(isGitConfigLockError(makeLockError())).toBe(true);
  });

  test('matches case-insensitively', () => {
    const err = new Error('Fatal: Could Not Lock Config File');
    expect(isGitConfigLockError(err)).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    expect(isGitConfigLockError(makeOtherError())).toBe(false);
    expect(isGitConfigLockError(new Error('network unreachable'))).toBe(false);
  });

  test('returns false for non-Error, non-matching throws', () => {
    // Strings that don't contain lock patterns → false
    expect(isGitConfigLockError('network unreachable')).toBe(false);
    // null/undefined → String() yields "null"/"undefined", no match → false
    expect(isGitConfigLockError(null)).toBe(false);
    expect(isGitConfigLockError(undefined)).toBe(false);
    // Plain object with no matching message → false
    expect(isGitConfigLockError({})).toBe(false);
  });

  test('returns true for string-shaped throws containing lock pattern', () => {
    // A plain string thrown (unusual but possible) is detected via String() fallback.
    expect(isGitConfigLockError('could not lock config file')).toBe(true);
  });

  test('plain objects without matching stderr are not detected', () => {
    // String({message: '...'}) yields "[object Object]", not the message.
    // The implementation only reads .message from Error instances.
    const plainObj = { message: 'could not lock config file', stderr: '' };
    expect(isGitConfigLockError(plainObj)).toBe(false);
    // But if stderr contains the pattern, it is detected.
    const withStderr = { stderr: 'error: could not lock config file .git/config' };
    expect(isGitConfigLockError(withStderr)).toBe(true);
  });

  test('exports the canonical pattern list (does not mutate)', () => {
    expect(GIT_CONFIG_LOCK_PATTERNS).toEqual([
      'could not lock config file',
      'unable to write upstream branch configuration',
    ]);
  });
});

describe('execGitWithRetry — success path', () => {
  test('returns the result on first attempt without retrying', async () => {
    const calls: unknown[] = [];
    const exec: ExecFn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return Promise.resolve({ stdout: 'ok', stderr: '' });
    };

    const result = await execGitWithRetry(exec, 'git', ['fetch', 'origin', 'main'], {
      timeout: 1000,
    });

    expect(result).toEqual({ stdout: 'ok', stderr: '' });
    expect(calls).toHaveLength(1);
  });
});

describe('execGitWithRetry — retry path (lock error)', () => {
  test('retries on transient lock error and succeeds on second attempt', async () => {
    let attempts = 0;
    const exec: ExecFn = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(makeLockError());
      }
      return Promise.resolve({ stdout: 'recovered', stderr: '' });
    };

    const result = await execGitWithRetry(
      exec,
      'git',
      ['worktree', 'add', '-b', 'feat', 'origin/main'],
      { timeout: 1000 },
      { baseDelayMs: 1, maxAttempts: 3 }
    );

    expect(result).toEqual({ stdout: 'recovered', stderr: '' });
    expect(attempts).toBe(2);
  });

  test('retries up to maxAttempts then re-throws the last lock error', async () => {
    let attempts = 0;
    const exec: ExecFn = () => {
      attempts++;
      return Promise.reject(makeLockError());
    };

    await expect(
      execGitWithRetry(exec, 'git', ['worktree', 'add', '-b', 'feat', 'origin/main'], undefined, {
        baseDelayMs: 1,
        maxAttempts: 3,
      })
    ).rejects.toBeInstanceOf(Error);

    expect(attempts).toBe(3);
  });

  test('does NOT retry on non-lock errors', async () => {
    let attempts = 0;
    const exec: ExecFn = () => {
      attempts++;
      return Promise.reject(makeOtherError());
    };

    await expect(
      execGitWithRetry(exec, 'git', ['fetch', 'origin', 'main'], undefined, {
        baseDelayMs: 1,
        maxAttempts: 3,
      })
    ).rejects.toBeInstanceOf(Error);

    expect(attempts).toBe(1);
  });

  test('rejects on maxAttempts < 1', async () => {
    const exec: ExecFn = () => Promise.resolve({ stdout: '', stderr: '' });
    await expect(
      execGitWithRetry(exec, 'git', ['status'], undefined, { maxAttempts: 0 })
    ).rejects.toThrow('maxAttempts must be >= 1');
  });

  test('succeeds when the LAST attempt would otherwise have retried', async () => {
    // Sanity check that the `isLastAttempt` short-circuit doesn't swallow a
    // lock error that arrives only on the final attempt.
    let attempts = 0;
    const exec: ExecFn = () => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(makeLockError());
      }
      return Promise.resolve({ stdout: 'finally', stderr: '' });
    };

    const result = await execGitWithRetry(exec, 'git', ['fetch'], undefined, {
      baseDelayMs: 1,
      maxAttempts: 3,
    });
    expect(result.stdout).toBe('finally');
    expect(attempts).toBe(3);
  });
});

describe('execGitWithRetry — backoff bounds', () => {
  test('backoff for attempt=0 is bounded above by baseDelay + min(500, baseDelay) jitter', async () => {
    // With baseDelayMs=10: exponential = min(10 * 2^0, 15000) = 10,
    // jitter = random(0, min(500, 10)) = random(0, 10), so delay ∈ [10, 20].
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = (cb: () => void, ms?: number): unknown => (
      delays.push(ms ?? 0),
      realSetTimeout(cb, 0)
    );
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

    try {
      const exec: ExecFn = () => Promise.reject(makeLockError());
      await expect(
        execGitWithRetry(exec, 'git', ['status'], undefined, {
          baseDelayMs: 10,
          maxAttempts: 3,
        })
      ).rejects.toBeInstanceOf(Error);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // Two delays scheduled (after attempt 0 and attempt 1; attempt 2 throws).
    expect(delays).toHaveLength(2);
    // Per-index bounds: attempt 0 → [10, 20], attempt 1 → [20, 30]
    expect(delays[0]).toBeGreaterThanOrEqual(10);
    expect(delays[0]).toBeLessThanOrEqual(20);
    expect(delays[1]).toBeGreaterThanOrEqual(20);
    expect(delays[1]).toBeLessThanOrEqual(30);
  });

  test('backoff for high attempt counts is capped at MAX_DELAY_MS (15_000) + jitter', async () => {
    // With baseDelayMs=1000 and maxAttempts=5, the delays are:
    // attempt 0: min(1000, 15000) + [0,500] → [1000, 1500]
    // attempt 1: min(2000, 15000) + [0,500] → [2000, 2500]
    // attempt 2: min(4000, 15000) + [0,500] → [4000, 4500]
    // attempt 3: min(8000, 15000) + [0,500] → [8000, 8500]
    // Max delay ≤ 8500.
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = (cb: () => void, ms?: number): unknown => (
      delays.push(ms ?? 0),
      realSetTimeout(cb, 0)
    );
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

    try {
      const exec: ExecFn = () => Promise.reject(makeLockError());
      await expect(
        execGitWithRetry(exec, 'git', ['status'], undefined, {
          baseDelayMs: 1000,
          maxAttempts: 5,
        })
      ).rejects.toBeInstanceOf(Error);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    const maxDelay = Math.max(...delays);
    expect(maxDelay).toBeLessThanOrEqual(8500);
    expect(delays).toHaveLength(4);
  });
});
