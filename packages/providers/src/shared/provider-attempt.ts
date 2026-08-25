import type { MessageChunk, SendQueryOptions } from '../types';

/** The provider could not prove the remote attempt stopped, so capacity must expire naturally. */
export class ProviderAttemptStopUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderAttemptStopUnconfirmedError';
  }
}

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
  let upstreamStopped = true;
  try {
    throwIfAborted(signal);
    yield* run(signal);
  } catch (error) {
    if (error instanceof ProviderAttemptStopUnconfirmedError) upstreamStopped = false;
    throw error;
  } finally {
    await lease.release({ upstreamStopped });
  }
}
