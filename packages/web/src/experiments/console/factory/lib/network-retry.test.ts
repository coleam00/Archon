import { describe, expect, test } from 'bun:test';
import { HttpError } from '../../lib/http';
import { SlowReadError } from './deadline';
import { NETWORK_RETRY_MS, retryOnceOnNetworkFailure } from './network-retry';

/** An attempt that answers each call from `outcomes` in turn, and counts the calls. */
function attempts(...outcomes: (string | Error)[]) {
  let calls = 0;
  const attempt = async (): Promise<string> => {
    const outcome = outcomes[calls++];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? 'none left';
  };
  return { attempt, calls: () => calls };
}

describe('retryOnceOnNetworkFailure', () => {
  test('a network failure is tried once more, after the wait', async () => {
    const waits: number[] = [];
    const read = attempts(new TypeError('Failed to fetch'), 'steps');
    expect(
      await retryOnceOnNetworkFailure(read.attempt, async ms => {
        waits.push(ms);
      })
    ).toBe('steps');
    expect(read.calls()).toBe(2);
    expect(waits).toEqual([NETWORK_RETRY_MS]);
  });

  test('a second network failure is the answer', async () => {
    const read = attempts(new TypeError('Failed to fetch'), new TypeError('Failed again'));
    await expect(retryOnceOnNetworkFailure(read.attempt, async () => {})).rejects.toThrow(
      'Failed again'
    );
    expect(read.calls()).toBe(2);
  });

  test('an answer from the server, a missed deadline and a cancel are not retried', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    for (const failure of [
      new HttpError(404, '/api/factory/workflow', ''),
      new SlowReadError(8_000),
      abort,
    ]) {
      const read = attempts(failure, 'steps');
      await expect(retryOnceOnNetworkFailure(read.attempt, async () => {})).rejects.toBe(failure);
      expect(read.calls()).toBe(1);
    }
  });
});
