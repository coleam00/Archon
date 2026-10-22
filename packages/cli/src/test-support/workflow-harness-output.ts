/** Helpers that capture what a workflow command wrote and drive its detached startup. */
import { expect, spyOn, mock, jest } from 'bun:test';

/**
 * Capture machine-readable (`--json`) payloads.
 *
 * They are emitted through `writeJsonLine()` (src/utils/stdout.ts) — i.e.
 * `process.stdout.write` with a completion callback — rather than `console.log`,
 * so a piped consumer can never receive a truncated document (#2384).
 *
 * This helper only CAPTURES what a command emitted. That the bytes actually
 * survive a real pipe is proven end-to-end in src/utils/stdout.test.ts, which
 * spawns the CLI through a genuine shell pipeline — deliberately not here,
 * because a test that mocks `process.stdout.write` cannot observe the truncation
 * this fix is about.
 */
export function spyOnJsonStdout(): ReturnType<typeof spyOn> {
  return spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
}

/** The same delivery-confirming shim for stderr, where progress lines go. */
export function spyOnStderr(): ReturnType<typeof spyOn> {
  return spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
}

/** The first `--json` document a command wrote, trailing newline stripped. */
export function firstJsonPayload(spy: ReturnType<typeof spyOn>): string {
  return ((spy.mock.calls[0]?.[0] as string) ?? '').trimEnd();
}

export async function captureError(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    cause => cause
  );
  if (!(error instanceof Error)) throw new Error('Expected command to reject with an Error');
  return error;
}

export type DetachedSpawnOptions = Bun.Spawn.SpawnOptions<'ignore', 'pipe', 'inherit'> & {
  cmd: string[];
};

export function firstDetachedSpawnOptions(
  spawnSpy: ReturnType<typeof spyOn>
): DetachedSpawnOptions {
  const value: unknown = spawnSpy.mock.calls[0]?.[0];
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected Bun.spawn to receive an options object');
  }

  if (
    !('cmd' in value) ||
    !Array.isArray(value.cmd) ||
    !value.cmd.every((arg: unknown): arg is string => typeof arg === 'string')
  ) {
    throw new Error('Expected Bun.spawn options to include a string command array');
  }
  return value as DetachedSpawnOptions;
}

/**
 * Stand-in for the child `spawnDetachedWorkflowRun` starts. `node:child_process`'s
 * spawn routes through `Bun.spawn` under Bun, so spying on `Bun.spawn` intercepts it
 * and Bun wraps this object into the ChildProcess whose events the startup window
 * listens on. Shared by both detach suites — `run` and the control verbs.
 */
export function createDetachedChildFixture(pid: number | null = 12345): {
  child: ReturnType<typeof Bun.spawn>;
  unref: ReturnType<typeof mock>;
} {
  const unref = mock(() => undefined);
  const child = {
    pid: pid ?? undefined,
    unref,
  };

  return {
    child: child as unknown as ReturnType<typeof Bun.spawn>,
    unref,
  };
}

/**
 * Drive a detach command past `waitForDetachedStartup` (#2279). The command awaits a
 * 500 ms window in which a dying child would reject, so a test that never advances
 * the fake timer hangs — and one that never awaits the command silently skips the
 * window altogether. Both suites go through here so neither can pass by accident.
 */
export async function finishStartupWindow(
  commandPromise: Promise<unknown>,
  spawnSpy: ReturnType<typeof spyOn>,
  expectedSpawnCount = 1
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 200 && spawnSpy.mock.calls.length < expectedSpawnCount;
    attempt++
  ) {
    await Promise.resolve();
  }
  expect(spawnSpy).toHaveBeenCalledTimes(expectedSpawnCount);
  jest.advanceTimersByTime(500);
  await commandPromise;
}
