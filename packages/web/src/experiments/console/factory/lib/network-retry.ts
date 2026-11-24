/** How long the retry waits: long enough for a restarting server to listen again. */
export const NETWORK_RETRY_MS = 1_000;

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Run `attempt`, and once more after `NETWORK_RETRY_MS` when it rejects because the request got
 * no answer at all: `fetch` rejects with a `TypeError` then (a server restarting, a dropped
 * connection). Classified by type, never by message text. An answer the server gave (an
 * `HttpError`), a missed deadline (`SlowReadError`, which `useFactoryRead` retries itself) and
 * a cancelled request (an `AbortError` `DOMException`) are not retried here.
 */
export async function retryOnceOnNetworkFailure<T>(
  attempt: () => Promise<T>,
  wait: (ms: number) => Promise<void> = pause
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await wait(NETWORK_RETRY_MS);
    return attempt();
  }
}
