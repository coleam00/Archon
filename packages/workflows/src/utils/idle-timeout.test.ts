import { describe, test, expect, mock, jest, afterEach } from 'bun:test';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from './idle-timeout';

/** Helper: create an async generator from an array of values with optional delays */
async function* fromValues<T>(values: T[], delayMs = 0): AsyncGenerator<T> {
  for (const value of values) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    yield value;
  }
}

/** Helper: create an async generator that hangs after yielding N values */
async function* hangAfter<T>(values: T[], _hangForever = true): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
  // Hang indefinitely — simulates a subprocess that completed work but won't exit
  await new Promise<void>(() => {});
}

describe('withIdleTimeout', () => {
  test('exports a default timeout constant', () => {
    expect(STEP_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  test('passes through all values from a normal generator', async () => {
    const values = [1, 2, 3, 4, 5];
    const result: number[] = [];

    for await (const v of withIdleTimeout(fromValues(values), 1000)) {
      result.push(v);
    }

    expect(result).toEqual(values);
  });

  test('handles empty generator', async () => {
    const result: number[] = [];

    for await (const v of withIdleTimeout(fromValues<number>([]), 1000)) {
      result.push(v);
    }

    expect(result).toEqual([]);
  });

  test("the consumer's own processing time is not charged to the generator's idle window", async () => {
    // The generator is never silent for more than 30ms, but the consumer spends 60ms on
    // each value (the engine records every provider event before asking for the next).
    // Only the generator's silence is idleness.
    const onTimeout = mock(() => {});
    const result: number[] = [];

    for await (const v of withIdleTimeout(fromValues([1, 2, 3], 30), 70, onTimeout)) {
      result.push(v);
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    expect(onTimeout).not.toHaveBeenCalled();
    expect(result).toEqual([1, 2, 3]);
  });

  test('fires onTimeout and exits when generator hangs', async () => {
    const onTimeout = mock(() => {});
    const result: string[] = [];

    // Use a very short timeout (50ms) for testing
    for await (const v of withIdleTimeout(hangAfter(['a', 'b', 'c']), 50, onTimeout)) {
      result.push(v);
    }

    // Should have received all values yielded before the hang
    expect(result).toEqual(['a', 'b', 'c']);
    // onTimeout should have been called exactly once
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test('exits without onTimeout callback when generator hangs', async () => {
    const result: string[] = [];

    // No onTimeout callback — should still exit cleanly
    for await (const v of withIdleTimeout(hangAfter(['x', 'y']), 50)) {
      result.push(v);
    }

    expect(result).toEqual(['x', 'y']);
  });

  test('does not fire onTimeout for a slow but completing generator', async () => {
    const onTimeout = mock(() => {});
    const result: number[] = [];

    // Each value takes 20ms, timeout is 200ms — should never fire
    for await (const v of withIdleTimeout(fromValues([1, 2, 3], 20), 200, onTimeout)) {
      result.push(v);
    }

    expect(result).toEqual([1, 2, 3]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('resets timeout between values', async () => {
    const onTimeout = mock(() => {});

    // Create a generator where each value takes 30ms but timeout is 50ms
    // Without resetting, the 3rd value would trigger timeout at 90ms > 50ms
    // With resetting, each gap is 30ms < 50ms — no timeout
    const result: number[] = [];
    for await (const v of withIdleTimeout(fromValues([1, 2, 3, 4], 30), 50, onTimeout)) {
      result.push(v);
    }

    expect(result).toEqual([1, 2, 3, 4]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('works with generator that yields objects', async () => {
    type Msg = { type: string; content?: string };
    const messages: Msg[] = [
      { type: 'assistant', content: 'hello' },
      { type: 'tool', content: 'running' },
      { type: 'result' },
    ];
    const result: Msg[] = [];

    for await (const v of withIdleTimeout(fromValues(messages), 1000)) {
      result.push(v);
    }

    expect(result).toEqual(messages);
  });

  test('consumer breaking out cleans up normally', async () => {
    const result: number[] = [];

    // Consumer breaks after 2 values — generator should be cleaned up
    for await (const v of withIdleTimeout(fromValues([1, 2, 3, 4, 5]), 1000)) {
      result.push(v);
      if (v === 2) break;
    }

    expect(result).toEqual([1, 2]);
  });

  test('times out after tool events stop', async () => {
    type Msg = { type: string };
    const onTimeout = mock(() => {});
    const result: Msg[] = [];

    async function* toolThenHang(): AsyncGenerator<Msg> {
      yield { type: 'assistant' };
      yield { type: 'tool' };
      await new Promise<void>(() => {});
    }

    for await (const v of withIdleTimeout(toolThenHang(), 100, onTimeout)) {
      result.push(v);
    }

    expect(result).toEqual([{ type: 'assistant' }, { type: 'tool' }]);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test('every value resets the timer and reports its value and timestamp once', async () => {
    type Msg = { type: 'assistant' | 'tool' | 'thinking' };
    const resets: Array<{ type: Msg['type']; resetAt: number }> = [];
    const before = Date.now();
    const messages: Msg[] = [{ type: 'assistant' }, { type: 'tool' }, { type: 'thinking' }];
    const onTimeout = mock(() => {});

    const values: Msg[] = [];
    for await (const value of withIdleTimeout(
      fromValues(messages, 30),
      50,
      onTimeout,
      (msg, resetAt) => resets.push({ type: msg.type, resetAt })
    )) {
      values.push(value);
    }

    const after = Date.now();
    expect(values).toEqual(messages);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(resets.map(reset => reset.type)).toEqual(messages.map(msg => msg.type));
    for (const reset of resets) {
      expect(reset.resetAt).toBeGreaterThanOrEqual(before);
      expect(reset.resetAt).toBeLessThanOrEqual(after);
    }
  });

  describe('on a fake clock', () => {
    const TIMEOUT_MS = 10_000;

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Let the wrapper react to a fired timer and arm its next one. */
    async function settle(): Promise<void> {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    /** Advance the clock while awake: every timer due in the span fires in order. */
    async function stayAwake(ms: number): Promise<void> {
      for (let step = 0; step < ms; step += 100) {
        jest.advanceTimersByTime(Math.min(100, ms - step));
        await settle();
      }
    }

    /** Start consuming a generator that yields once and then goes silent. */
    async function consumeSilentAfterOneValue(onTimeout: () => void): Promise<{ done: boolean }> {
      const state = { done: false };
      void (async (): Promise<void> => {
        for await (const _ of withIdleTimeout(hangAfter(['a']), TIMEOUT_MS, onTimeout)) {
          // consume
        }
        state.done = true;
      })();
      await settle();
      return state;
    }

    test('a steady silence fails at the timeout', async () => {
      jest.useFakeTimers();
      const onTimeout = mock(() => {});
      const state = await consumeSilentAfterOneValue(onTimeout);

      await stayAwake(TIMEOUT_MS - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      await stayAwake(1);
      await settle();
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(state.done).toBe(true);
    });

    test('time suspended does not count, and a later silence while awake still fails', async () => {
      jest.useFakeTimers();
      const onTimeout = mock(() => {});
      const state = await consumeSilentAfterOneValue(onTimeout);

      await stayAwake(2_000);
      // Suspension: the wall clock jumps far past the timeout without any timer running,
      // then the pending timer fires once on wake.
      jest.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      jest.advanceTimersToNextTimer();
      await settle();
      expect(onTimeout).not.toHaveBeenCalled();

      // At most one tick of the suspension is charged, so the window still closes
      // within a tick of the awake silence reaching the timeout.
      await stayAwake(TIMEOUT_MS - 2_000 - 1_000 - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      await stayAwake(1_000);
      await settle();
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(state.done).toBe(true);
    });
  });
});

test('quiet live work suspends the watchdog, then silence times out after it ends', async () => {
  let live = false;
  const timedOut = mock(() => {});
  async function* work(): AsyncGenerator<string> {
    yield 'started';
    await new Promise(resolve => setTimeout(resolve, 100));
    yield 'completed';
    await new Promise<void>(() => {});
  }
  const values: string[] = [];
  for await (const value of withIdleTimeout(work(), 30, timedOut, undefined, () => live)) {
    values.push(value);
    live = value === 'started';
  }
  expect(values).toEqual(['started', 'completed']);
  expect(timedOut).toHaveBeenCalledTimes(1);
});
