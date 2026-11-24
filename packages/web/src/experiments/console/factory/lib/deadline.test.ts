import { afterEach, expect, jest, test } from 'bun:test';
import {
  FACTORY_READ_DEADLINE_MAX_MS,
  FACTORY_READ_DEADLINE_MS,
  nextDeadlineMs,
  readFailed,
  SlowReadError,
  withDeadline,
} from './deadline';

afterEach(() => {
  jest.useRealTimers();
});

test('a read that answers in time resolves, and its timer is cleared', async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  const value = await withDeadline(1_000, async received => {
    signal = received;
    return 'answer';
  });
  expect(value).toBe('answer');
  expect(jest.getTimerCount()).toBe(0);
  expect(signal?.aborted).toBe(false);
});

test('a read past its deadline is aborted and rejects with SlowReadError', async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  const result = withDeadline(1_000, received => {
    signal = received;
    // As fetch does: the abort rejects the read.
    return new Promise<string>((_resolve, reject) => {
      received.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  });
  jest.advanceTimersByTime(1_000);
  const error = await result.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SlowReadError);
  expect(signal?.aborted).toBe(true);
});

test('one slow failure is claimed for a retry once; the page shows only other failures', () => {
  const slow = new SlowReadError(1_000);
  expect(slow.claimRetry()).toBe(true);
  expect(slow.claimRetry()).toBe(false);
  expect(readFailed(slow)).toBeUndefined();
  const failure = new Error('500');
  expect(readFailed(failure)).toBe(failure);
  expect(readFailed(undefined)).toBeUndefined();
});

test('each attempt after a miss gets twice the deadline it missed, up to the cap', () => {
  expect(nextDeadlineMs(undefined)).toBe(FACTORY_READ_DEADLINE_MS);
  expect(nextDeadlineMs(new SlowReadError(FACTORY_READ_DEADLINE_MS))).toBe(
    FACTORY_READ_DEADLINE_MS * 2
  );
  const capped = nextDeadlineMs(new SlowReadError(FACTORY_READ_DEADLINE_MAX_MS));
  expect(capped).toBe(FACTORY_READ_DEADLINE_MAX_MS);
});
