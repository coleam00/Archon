import { describe, expect, test } from 'bun:test';
import { waitOutGitLocks } from './lock-wait';

const context = { event: 'test_step', path: '/workspace/repo' };
const heldLock = (): NodeJS.ErrnoException =>
  Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });

describe('waitOutGitLocks', () => {
  test('a lock that is never released fails after the bound, keeping the last error', async () => {
    let calls = 0;
    const last = heldLock();
    const failure = await waitOutGitLocks(
      () => {
        calls++;
        return Promise.reject(last);
      },
      context,
      500
    ).catch((error: unknown) => error);

    expect(calls).toBeGreaterThan(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `EEXIST: file already exists (after ${String(calls)} attempts)`
    );
    expect((failure as Error).cause).toBe(last);
  });

  test('a failure that is not a git exit or a held lock is not retried', async () => {
    let calls = 0;
    const missingGit = new Error('spawn git ENOENT');
    await expect(
      waitOutGitLocks(() => {
        calls++;
        return Promise.reject(missingGit);
      }, context)
    ).rejects.toBe(missingGit);
    expect(calls).toBe(1);
  });
});
