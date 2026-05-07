import { createLogger } from '@archon/paths';
import type { CopilotClient, CopilotSession, SessionEvent } from '@github/copilot-sdk';

import type { MessageChunk, TokenUsage } from '../../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot.event-bridge');
  return cachedLog;
}

/**
 * Single-producer / single-consumer async queue. Bridges Copilot's callback-based
 * `session.on()` into an async generator.
 *
 * Single-consumer is a hard invariant — a second iterator would race with
 * the first over both the buffer and the waiters list, silently dropping
 * items. The constructor enforces this: the first `Symbol.asyncIterator`
 * call sets `consumed=true`; subsequent calls throw.
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
   * Terminate iteration cleanly. Drains any pending waiters with
   * `{ done: true }` so the consumer exits the `for await` loop.
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

export type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

/**
 * Pure mapper from Copilot's `SessionEvent` → zero-or-more Archon `MessageChunk`s.
 *
 * Stateless — callers pass in mutable accumulators (`tokens`, `pendingTools`).
 * `session.idle` and `session.error` are NOT handled here — they are sentinels
 * handled in `bridgeCopilotSession()` where queue control is available.
 */
export function mapCopilotEvent(
  event: SessionEvent,
  tokens: { input: number; output: number },
  pendingTools: Map<string, string>
): MessageChunk[] {
  switch (event.type) {
    case 'assistant.message_delta':
      return [{ type: 'assistant', content: event.data.deltaContent }];

    case 'assistant.reasoning_delta':
      return [{ type: 'thinking', content: event.data.deltaContent }];

    case 'assistant.reasoning':
      return [{ type: 'thinking', content: event.data.content }];

    case 'assistant.usage':
      tokens.input += event.data.inputTokens ?? 0;
      tokens.output += event.data.outputTokens ?? 0;
      return [];

    case 'tool.execution_start':
      pendingTools.set(event.data.toolCallId, event.data.toolName);
      return [
        {
          type: 'tool',
          toolName: event.data.toolName,
          toolInput: event.data.arguments ?? {},
          toolCallId: event.data.toolCallId,
        },
      ];

    case 'tool.execution_complete': {
      const toolName = pendingTools.get(event.data.toolCallId) ?? 'unknown';
      pendingTools.delete(event.data.toolCallId);
      const chunks: MessageChunk[] = [];
      if (!event.data.success) {
        chunks.push({ type: 'system', content: `⚠️ Tool ${toolName} failed` });
      }
      chunks.push({
        type: 'tool_result',
        toolName,
        toolOutput: event.data.result?.content ?? '',
        toolCallId: event.data.toolCallId,
      });
      return chunks;
    }

    default:
      return [];
  }
}

/**
 * Bridge a `CopilotSession` into Archon's `AsyncGenerator<MessageChunk>` contract.
 *
 * Behavior:
 *  - subscribe before calling session.send(), unsubscribe in finally
 *  - yield mapped events in order
 *  - complete on `session.idle` (session.send() is fire-and-forget, not a completion promise)
 *  - throw on `session.error` or send()-time errors
 *  - forward `abortSignal` to `session.abort()` fire-and-forget
 *  - always `session.disconnect()` and `client.stop()` in finally
 */
export async function* bridgeCopilotSession(
  session: CopilotSession,
  client: CopilotClient,
  prompt: string,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();
  const tokens = { input: 0, output: 0 };
  const pendingTools = new Map<string, string>();

  const unsubscribe = session.on((event: SessionEvent) => {
    try {
      for (const chunk of mapCopilotEvent(event, tokens, pendingTools)) {
        queue.push({ kind: 'chunk', chunk });
      }
      if (event.type === 'session.idle') {
        const resultChunk: MessageChunk = {
          type: 'result',
          sessionId: session.sessionId,
          tokens: {
            input: tokens.input,
            output: tokens.output,
            total: tokens.input + tokens.output,
          } satisfies TokenUsage,
        };
        queue.push({ kind: 'chunk', chunk: resultChunk });
        queue.push({ kind: 'done' });
      } else if (event.type === 'session.error') {
        queue.push({
          kind: 'error',
          error: new Error(`[${event.data.errorType}]: ${event.data.message}`),
        });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  const onAbort = (): void => {
    void session.abort().catch((err: unknown) => {
      getLog().debug({ err }, 'copilot.event-bridge.abort_failed');
    });
    // Signal the consumer to exit — the SDK may or may not emit session.idle
    // after abort(), so we close the queue explicitly to unblock the loop.
    queue.push({ kind: 'done' });
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // session.send() is fire-and-forget (returns messageId Promise, not completion).
  // Attach .catch() so send-time errors surface as queue errors instead of
  // unhandled rejections.
  session.send({ prompt }).catch((err: unknown) => {
    queue.push({ kind: 'error', error: err as Error });
  });

  try {
    for await (const item of queue) {
      if (item.kind === 'done') return;
      if (item.kind === 'error') throw item.error;
      yield item.chunk;
    }
  } finally {
    queue.close();
    unsubscribe();
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    try {
      await session.disconnect();
    } catch (err: unknown) {
      getLog().debug({ err }, 'copilot.event-bridge.disconnect_failed');
    }
    // Fire-and-forget — stop() tears down the CLI subprocess. If it hangs
    // (e.g. the SDK bug where stop() never settles), don't block the caller.
    void client.stop().catch((err: unknown) => {
      getLog().debug({ err }, 'copilot.event-bridge.stop_failed');
    });
  }
}
