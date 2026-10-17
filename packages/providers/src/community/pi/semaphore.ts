function abortedError(signal: AbortSignal): Error {
  return new Error('Aborted while waiting for a semaphore slot', { cause: signal.reason });
}

/**
 * Counting semaphore: `acquire()` waits for a free slot, `release()` hands it to the next waiter.
 * A waiter whose signal aborts leaves the queue and rejects, so a caller that gave up never
 * takes a slot later.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(count: number) {
    this.available = count;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortedError(signal));
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index !== -1) this.waiters.splice(index, 1);
        if (signal) reject(abortedError(signal));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}
