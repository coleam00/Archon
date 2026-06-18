/**
 * Single-producer / single-consumer async queue. Bridges callback-based provider
 * event subscriptions into async generators.
 *
 * Design:
 *  - producers call `push(item)` from any synchronous context
 *  - the consumer awaits `for await (const item of queue)` ONCE
 *  - sentinel items are pushed by callers; the queue itself does not know about them
 *
 * Single-consumer is a hard invariant — a second iterator would race with the
 * first over both the buffer and the waiters list, silently dropping items. The
 * constructor enforces this so the mistake surfaces loudly during development.
 */
const UNDEFINED_ITEM_ERROR =
  'AsyncQueue cannot enqueue undefined; use null or a caller-owned sentinel object';

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private consumed = false;
  private closed = false;

  push(item: T): void {
    if (item === undefined) throw new TypeError(UNDEFINED_ITEM_ERROR);
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  /**
   * Terminate iteration cleanly. Drains pending waiters with `{ done: true }` so
   * the consumer exits the `for await` loop instead of hanging forever.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error(
        'AsyncQueue: a single queue can only be iterated once (single-consumer invariant). Create a new queue for each consumer.'
      );
    }
    this.consumed = true;

    let finished = false;
    const done = (): IteratorResult<T> => ({ value: undefined as T, done: true });

    return {
      next: (): Promise<IteratorResult<T>> => {
        if (finished) return Promise.resolve(done());
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          finished = true;
          return Promise.resolve(done());
        }

        return new Promise<IteratorResult<T>>(resolve => {
          this.waiters.push(result => {
            if (result.done) finished = true;
            resolve(result);
          });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        finished = true;
        this.close();
        return Promise.resolve(done());
      },
    };
  }
}
