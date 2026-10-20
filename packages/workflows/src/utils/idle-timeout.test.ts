import { afterEach, expect, jest, mock, test } from 'bun:test';
import { withStreamPolling } from './idle-timeout';

afterEach(() => jest.useRealTimers());

test('streams every value, records progress, and closes on a consumer break', async () => {
  let closed = false;
  async function* source(): AsyncGenerator<number> {
    try {
      yield 1;
      yield 2;
      yield 3;
    } finally {
      closed = true;
    }
  }
  const progress = mock((_value: number, _at: number) => {});
  const stop = mock(async () => false);
  const values: number[] = [];
  for await (const value of withStreamPolling(source(), progress, stop)) {
    values.push(value);
    if (value === 2) break;
  }
  expect(values).toEqual([1, 2]);
  expect(progress.mock.calls.map(([value]) => value)).toEqual([1, 2]);
  expect(closed).toBe(true);
  expect(stop).not.toHaveBeenCalled();
});

test('silence polls without ending the turn until explicitly stopped, without awaiting pending next', async () => {
  jest.useFakeTimers();
  let stop = false;
  let finished = false;
  let rejectNext: (error: Error) => void = () => {};
  async function* silent(): AsyncGenerator<number> {
    await new Promise<void>((_resolve, reject) => {
      rejectNext = reject;
    });
  }
  const check = mock(async () => stop);
  const execution = (async () => {
    for await (const _value of withStreamPolling(silent(), () => {}, check)) {
      /* consume */
    }
    finished = true;
  })();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  await settle();
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(1000);
    await settle();
  }
  expect(check).toHaveBeenCalledTimes(3);
  expect(finished).toBe(false);
  stop = true;
  jest.advanceTimersByTime(1000);
  await execution;
  expect(finished).toBe(true);
  rejectNext(new Error('producer aborted'));
  await settle();
});

test('producer failure preserves the original error', async () => {
  const error = new Error('provider failed');
  async function* source(): AsyncGenerator<number> {
    throw error;
  }
  const consume = async (): Promise<void> => {
    for await (const _value of withStreamPolling(
      source(),
      () => {},
      async () => false
    )) {
      /* consume */
    }
  };
  await expect(consume()).rejects.toBe(error);
});
