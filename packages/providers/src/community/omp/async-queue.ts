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
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private consumed = false;
  private closed = false;

  push(item: T): void {
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
      if (waiter) waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error(
        'AsyncQueue: a single queue can only be iterated once (single-consumer invariant). Create a new queue for each consumer.'
      );
    }
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<T> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>(resolve => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
