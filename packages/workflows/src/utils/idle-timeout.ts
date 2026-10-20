import { createLogger } from '@archon/paths';

/** Default silence threshold for provider-turn attention. */
export const STEP_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const TICK = Symbol('STREAM_TICK');

/** Poll run control while a provider is silent; only an explicit action ends a turn. */
export async function* withStreamPolling<T>(
  generator: AsyncGenerator<T>,
  onProgress: (value: T, at: number) => void,
  shouldStop: () => Promise<boolean>
): AsyncGenerator<T> {
  let pending: Promise<IteratorResult<T>> | undefined;
  try {
    while (true) {
      pending ??= generator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<typeof TICK>(resolve => {
        timer = setTimeout(() => resolve(TICK), 1000);
      });
      let result: IteratorResult<T> | typeof TICK;
      try {
        result = await Promise.race([pending, tick]);
      } finally {
        clearTimeout(timer);
      }
      if (result === TICK) {
        if (await shouldStop()) return;
        continue;
      }
      pending = undefined;
      if (result.done) return;
      onProgress(result.value, Date.now());
      yield result.value;
    }
  } finally {
    if (pending) {
      // return() queues behind next(): an interrupted producer must be aborted by the caller.
      pending.catch(() => undefined);
    } else {
      try {
        await generator.return(undefined as never);
      } catch (err) {
        createLogger('workflow.stream').warn({ err }, 'stream.generator_cleanup_failed');
      }
    }
  }
}
