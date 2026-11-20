/**
 * A buffered, closable source of `turnMessages` texts. The engine writes the texts it
 * sends a live session; the plugin server writes the texts it receives over the wire.
 * Iteration ends once the queue is closed and its buffer is drained.
 */
export interface TurnMessageQueue extends AsyncIterable<string> {
  /** False once the queue is closed: the text was not taken. */
  push(text: string): boolean;
  close(): void;
}

export function createTurnMessageQueue(): TurnMessageQueue {
  const buffered: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const signal = (): void => {
    wake?.();
    wake = undefined;
  };
  return {
    push(text): boolean {
      if (closed) return false;
      buffered.push(text);
      signal();
      return true;
    },
    close(): void {
      closed = true;
      signal();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      while (true) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
  };
}
