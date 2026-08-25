import type { MessageChunk, SendQueryOptions } from '../types';

/** The provider could not prove the remote attempt stopped, so capacity must expire naturally. */
export class ProviderAttemptStopUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderAttemptStopUnconfirmedError';
  }
}

export const PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS = 5_000;

/** Bound provider shutdown so an unresponsive SDK cannot renew capacity forever. */
export async function confirmProviderAttemptStopped(
  stop: () => Promise<void>,
  message: string
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new ProviderAttemptStopUnconfirmedError(
          `${message} within ${PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS}ms`
        )
      );
    }, PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.resolve()
        .then(stop)
        .catch(error => {
          if (error instanceof ProviderAttemptStopUnconfirmedError) throw error;
          throw new ProviderAttemptStopUnconfirmedError(message, { cause: error });
        }),
      timedOut,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    signal.throwIfAborted();
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      if (signal.reason instanceof Error) {
        reject(signal.reason);
        return;
      }
      const error = new Error('Provider operation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
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
