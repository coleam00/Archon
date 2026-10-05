/**
 * Async generator idle timeout utility.
 *
 * Wraps an async generator with an idle timeout — if no value is yielded
 * within `timeoutMs`, the wrapper returns normally, converting a hang
 * into a clean exit.
 *
 * This is the primary defense against subprocess hangs where the AI process
 * completes its work but fails to exit (stuck MCP connection, dangling child
 * process, etc.). Without this, the `for await` loop blocks indefinitely and
 * `node_completed` is never recorded.
 */

/**
 * Default idle timeout: 30 minutes.
 *
 * This is a deadlock detector, not a work limiter. The timer resets on every
 * message type, so it only fires when the subprocess goes completely silent.
 * 30 minutes is generous enough to never interrupt legitimate work while still
 * catching genuine hangs. Per-node `idle_timeout` overrides this default.
 */
export const STEP_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The watchdog counts silence one tick at a time. A tick is credited with at most its
 * scheduled delay, so a jump in the wall clock between ticks (the machine was
 * suspended) costs the idle window at most one tick. A single timer spanning the
 * whole window would fire on wake and fail a node that was never silent while awake.
 */
const WATCHDOG_TICK_MS = 1000;

const TICK = Symbol('WATCHDOG_TICK');

/**
 * Wraps an async generator with an idle timeout. If the generator yields no value for
 * `timeoutMs` of its own time, the wrapper returns normally, converting a hang into a
 * clean exit. Time the consumer spends handling a value does not count, and neither
 * does time the machine spends suspended.
 *
 * When timeout fires:
 * 1. `onTimeout` callback is invoked (use this to abort the subprocess and log)
 * 2. The pending `generator.next()` promise gets a `.catch()` to prevent unhandled rejection
 * 3. We do NOT call `generator.return()` — it would block on the pending `.next()`
 * 4. The subprocess is cleaned up asynchronously via the abort signal from `onTimeout`
 *
 * @param generator - The async generator to wrap
 * @param timeoutMs - Maximum idle time in milliseconds before terminating
 * @param onTimeout - Optional callback invoked when idle timeout fires (before return)
 * @param onTimerReset - Optional observer invoked with the value and exact reset timestamp
 * @param isWorkLive - Runtime-reported live work suspends the silence watchdog
 * @param shouldStop - Checks operator cancellation during silence and aborts the producer
 */
export async function* withIdleTimeout<T>(
  generator: AsyncGenerator<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  onTimerReset?: (value: T, resetAt: number) => void,
  isWorkLive?: () => boolean,
  shouldStop?: () => Promise<boolean>
): AsyncGenerator<T> {
  let nextAbandoned = false;
  let idleMs = 0;

  try {
    while (true) {
      const nextPromise = generator.next();

      let result: IteratorResult<T> | undefined;
      while (result === undefined) {
        const tickMs = Math.max(0, Math.min(WATCHDOG_TICK_MS, timeoutMs - idleMs));
        const tickStartedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<typeof TICK>(resolve => {
          timer = setTimeout(() => {
            resolve(TICK);
          }, tickMs);
        });

        const settled = await Promise.race([nextPromise, tick]);
        clearTimeout(timer);
        // Wall-clock time beyond the scheduled delay was spent suspended.
        if (isWorkLive?.()) idleMs = 0;
        else idleMs += Math.max(0, Math.min(Date.now() - tickStartedAt, tickMs));

        if (settled !== TICK) {
          result = settled;
        } else if (shouldStop && (await shouldStop())) {
          nextAbandoned = true;
          // The caller aborts the producer; do not await return behind its pending next.
          nextPromise.catch(() => undefined);
          return;
        } else if (idleMs >= timeoutMs) {
          nextAbandoned = true;
          // Prevent unhandled rejection when the subprocess is aborted via onTimeout
          nextPromise.catch((_err: unknown) => {
            // Intentional: swallow rejection from aborted subprocess
          });
          onTimeout?.();
          return;
        }
      }

      if (result.done) return;

      idleMs = 0;
      onTimerReset?.(result.value, Date.now());

      // Idle time accrues only while waiting on the generator, so the time the consumer
      // spends on the value (the engine records every provider event before it asks for
      // the next one) is not charged to it.
      yield result.value;
    }
  } finally {
    if (!nextAbandoned) {
      // Normal exit (generator exhausted or consumer broke out) — safe to clean up
      try {
        await generator.return(undefined as never);
      } catch (e) {
        // Generator cleanup errors are non-fatal but worth logging for diagnostics
        // Dynamic import to avoid circular deps — this module has zero @archon/* imports
        try {
          const { createLogger } = await import('@archon/paths');
          createLogger('idle-timeout').warn(
            { err: e as Error },
            'idle_timeout.generator_cleanup_failed'
          );
        } catch {
          // If logger is unavailable, swallow — cleanup is best-effort
        }
      }
    }
    // If timed out, don't call generator.return() — it would hang on the pending .next()
    // The onTimeout callback aborts the subprocess, which causes the pending .next()
    // to reject (caught by nextPromise.catch above) and the generator to finalize
  }
}
