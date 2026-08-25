import type { MessageChunk, SendQueryOptions } from '../types';

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Provider attempt aborted before upstream work started');
  error.name = 'AbortError';
  throw error;
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
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, lease.signal])
    : lease.signal;
  try {
    throwIfAborted(signal);
    yield* run(signal);
  } finally {
    await lease.release();
  }
}
