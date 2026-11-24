/**
 * How long a Factory read may take, on its first attempt, before the page says so and tries
 * again. A healthy read answers in a fraction of a second and a cold one in a few, so this
 * mostly fires on a read that is stuck: queued behind a full connection pool, say (#39).
 */
export const FACTORY_READ_DEADLINE_MS = 8_000;
/** The longest a retry waits. A read slower than this on every attempt is not a healthy one. */
export const FACTORY_READ_DEADLINE_MAX_MS = 30_000;

/** A read that did not answer by its deadline and was cancelled; the page retries it. */
export class SlowReadError extends Error {
  private retryClaimed = false;

  constructor(readonly ms: number) {
    super(`No answer after ${(ms / 1000).toString()} s`);
    this.name = 'SlowReadError';
  }

  /**
   * True for the first caller only. Several parts of a page show the same read (the Overview's
   * numbers, map and list all wait on the items), and one failure is retried once, not once
   * per part.
   */
  claimRetry(): boolean {
    if (this.retryClaimed) return false;
    this.retryClaimed = true;
    return true;
  }
}

/**
 * Run `read` with a signal that aborts after `ms`, and reject with `SlowReadError` then. The
 * abort cancels the request, so a retry does not queue behind the read it gave up on. A
 * read that settles in time settles the result and clears the timer.
 */
export function withDeadline<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SlowReadError(ms));
      controller.abort();
    }, ms);
    // After the deadline the read rejects with the abort; the promise has settled by then,
    // so that rejection is handled here and goes nowhere.
    read(controller.signal).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** One attempt's deadline applied to a request: what a Factory read runs each request through. */
export type WithinDeadline = <T>(read: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * The deadline for a read's next attempt: the first, or twice the one it last missed, up to
 * the cap. A fixed deadline would cancel a healthy read slower than it on every attempt, and
 * the page would say "trying again" forever.
 */
export function nextDeadlineMs(previous: Error | undefined): number {
  return previous instanceof SlowReadError
    ? Math.min(previous.ms * 2, FACTORY_READ_DEADLINE_MAX_MS)
    : FACTORY_READ_DEADLINE_MS;
}

/** Each request `within` runs gets `ms` to answer. */
export function deadlineOf(ms: number): WithinDeadline {
  return read => withDeadline(ms, read);
}

/**
 * The failure a page shows for a read: its error, unless the read only missed its deadline,
 * which `useFactoryRead` retries and `FactoryLoading` says so.
 */
export function readFailed(error: Error | undefined): Error | undefined {
  return error instanceof SlowReadError ? undefined : error;
}
