import type { MessageChunk, SendQueryOptions } from '../types';

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    if (!signal) continue;
    const abort = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listeners.set(signal, abort);
  }
  return {
    signal: controller.signal,
    cleanup: (): void => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

/** Run exactly one upstream provider attempt under the optional core admission gate. */
export async function* withProviderAttempt(
  options: SendQueryOptions | undefined,
  run: (signal: AbortSignal | undefined) => AsyncGenerator<MessageChunk>
): AsyncGenerator<MessageChunk> {
  const gate = options?.providerAttemptGate;
  if (!gate) {
    yield* run(options?.abortSignal);
    return;
  }

  const lease = await gate.acquire();
  const combined = combineAbortSignals([options.abortSignal, lease.signal]);
  try {
    yield* run(combined.signal);
  } finally {
    combined.cleanup();
    await lease.release();
  }
}
