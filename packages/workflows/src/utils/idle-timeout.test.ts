import { describe, test, expect, mock } from 'bun:test';
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

  // These two tests exercise the optional shouldResetTimer parameter.
  // dag-executor omits it (all messages reset the timer by default).
  test('shouldResetTimer predicate: does not reset timer on filtered events', async () => {
    type Msg = { type: string };
    const onTimeout = mock(() => {});
    const result: Msg[] = [];

    // Generator yields an assistant event, then a tool event, then hangs
    async function* toolThenHang(): AsyncGenerator<Msg> {
      yield { type: 'assistant' };
      yield { type: 'tool' };
      // Hang — simulates a tool call that never completes
      await new Promise<void>(() => {});
    }

    // Timeout is 100ms; shouldResetTimer returns false for 'tool'
    // After 'assistant', timer resets (100ms). After 'tool', timer does NOT reset.
    // So total elapsed from 'assistant' reset = time-for-tool-yield + hang.
    // Timer fires within ~100ms of the 'assistant' event.
    for await (const v of withIdleTimeout(
      toolThenHang(),
      100,
      onTimeout,
      msg => msg.type !== 'tool'
    )) {
      result.push(v);
    }

    expect(result).toEqual([{ type: 'assistant' }, { type: 'tool' }]);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test('shouldResetTimer predicate: resets timer on non-filtered events', async () => {
    type Msg = { type: string };
    const onTimeout = mock(() => {});
    const result: Msg[] = [];

    // Generator: assistant (resets timer), tool (no reset), assistant (resets timer),
    // then hangs longer than timeout
    async function* toolThenRecover(): AsyncGenerator<Msg> {
      yield { type: 'assistant' };
      yield { type: 'tool' };
      // Simulate quick tool result (comes as next assistant)
      await new Promise(r => setTimeout(r, 20));
      yield { type: 'assistant' };
      // Now hang — but timer should have been reset by second assistant
      await new Promise<void>(() => {});
    }

    for await (const v of withIdleTimeout(
      toolThenRecover(),
      150,
      onTimeout,
      msg => msg.type !== 'tool'
    )) {
      result.push(v);
    }

    expect(result).toEqual([{ type: 'assistant' }, { type: 'tool' }, { type: 'assistant' }]);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test('without shouldResetTimer, tool events reset timer (original behavior)', async () => {
    type Msg = { type: string };
    const onTimeout = mock(() => {});
    const result: Msg[] = [];

    // Without shouldResetTimer, tool events reset the timer — hang after tool
    // does NOT fire within the original window (it fires in a fresh window)
    async function* toolThenHang(): AsyncGenerator<Msg> {
      yield { type: 'assistant' };
      yield { type: 'tool' };
      await new Promise<void>(() => {});
    }

    // With no shouldResetTimer, timer resets on 'tool' → 100ms fresh window
    // Hang fires after 100ms from the 'tool' event
    for await (const v of withIdleTimeout(toolThenHang(), 100, onTimeout)) {
      result.push(v);
    }

    expect(result).toEqual([{ type: 'assistant' }, { type: 'tool' }]);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
