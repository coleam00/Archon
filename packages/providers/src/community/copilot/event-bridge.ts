/**
 * Event bridge between @github/copilot-sdk's callback-based session.on() API
 * and Archon's async-generator MessageChunk contract.
 *
 * Three concerns in this file:
 *  1. `AsyncQueue<T>` — single-producer / single-consumer queue; copied
 *     verbatim from `community/pi/event-bridge.ts`. Peer community providers
 *     stay decoupled (no cross-imports).
 *  2. `mapCopilotEvent(event, toolCallIdToName, captureUsage)` — pure fn
 *     translating one SDK event into zero or more MessageChunks. Testable
 *     in isolation.
 *  3. `bridgeSession(session, prompt, abortSignal?)` — wired integration
 *     wrapper; lives here rather than in provider.ts so the queue/listener/
 *     cleanup lifecycle stays readable. Implemented in step 6 of the plan.
 *
 * Module-scope invariant: type-only imports from @github/copilot-sdk. Value
 * imports go inside `provider.ts` via dynamic `await import(...)`. See the
 * PI lazy-load test for rationale.
 */
import { createLogger } from '@archon/paths';
import type { AssistantMessageEvent, CopilotSession, SessionEvent } from '@github/copilot-sdk';

import type { MessageChunk, TokenUsage } from '../../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot.event-bridge');
  return cachedLog;
}

// ─── AsyncQueue — copy of PI's (single-producer / single-consumer) ───────

/**
 * Single-producer / single-consumer async queue. Bridges the SDK's
 * callback-based `session.on()` into an async generator.
 *
 * Design:
 *  - producers call `push(item)` from any synchronous context
 *  - the consumer awaits `for await (const item of queue)` ONCE
 *  - sentinel items (in this bridge: `done` / `error`) are pushed by the
 *    caller; the queue itself does not know about them
 *
 * Single-consumer is a hard invariant — a second iterator would race with
 * the first over both the buffer and the waiters list, silently dropping
 * items. Constructor enforces: first `Symbol.asyncIterator` sets
 * `consumed=true`; subsequent calls throw loudly during development.
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
   * `{ done: true }` so the consumer exits the `for await` loop instead of
   * hanging when the producer's finally block fires before a new item
   * arrives (e.g. consumer abort mid-iteration).
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

// ─── Usage + event → chunk translation ────────────────────────────────────

/**
 * Coerce the SDK's `assistant.usage.data` shape into Archon's TokenUsage.
 * Returns undefined if neither input nor output token count is a number,
 * so callers don't emit a meaningless result chunk with {0, 0}.
 */
export function normalizeCopilotUsage(raw?: {
  inputTokens?: number;
  outputTokens?: number;
}): TokenUsage | undefined {
  if (!raw) return undefined;
  const input = raw.inputTokens;
  const output = raw.outputTokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  const usage: TokenUsage = {
    input: typeof input === 'number' ? input : 0,
    output: typeof output === 'number' ? output : 0,
  };
  return usage;
}

/**
 * Pure mapper: one SDK event → zero or more MessageChunks, plus side-effect
 * callbacks into closure state (toolCallId → toolName map, usage capture).
 *
 * Splitting side-effects from pure return value lets the test table drive
 * the MessageChunk output while spies verify the closure interactions.
 *
 * Events intentionally NOT mapped:
 *   - `user.message` — echo of our own prompt
 *   - `assistant.message` / `assistant.reasoning` — boundary events;
 *     streaming is covered by `*_delta` events. If deltas were somehow
 *     absent, `bridgeSession` has a safety-net using sendAndWait's return.
 *   - `session.idle` — internal signal; sendAndWait resolves on it
 *   - turn_start/turn_end, streaming_delta, intent, compaction_complete,
 *     task_complete, context_changed, title_changed, etc. — internal
 *     housekeeping, no user-facing chunk
 */
export interface EventMapperContext {
  /** Populated by tool.execution_start, read by tool.execution_complete. */
  toolCallIdToName: Map<string, string>;
  /** Called when assistant.usage arrives; undefined for non-usage events. */
  captureUsage: (usage: TokenUsage) => void;
  /** Flagged on session.error; consumer decides whether to promote to isError on the terminal result. */
  markErrored: (errorMsg: string) => void;
}

export function mapCopilotEvent(event: SessionEvent, ctx: EventMapperContext): MessageChunk[] {
  switch (event.type) {
    case 'assistant.message_delta': {
      const content = event.data.deltaContent;
      if (!content) return [];
      return [{ type: 'assistant', content }];
    }
    case 'assistant.reasoning_delta': {
      const content = event.data.deltaContent;
      if (!content) return [];
      return [{ type: 'thinking', content }];
    }
    case 'assistant.usage': {
      const usage = normalizeCopilotUsage(event.data);
      if (usage) ctx.captureUsage(usage);
      return [];
    }
    case 'tool.execution_start': {
      const { toolCallId, toolName, arguments: args } = event.data;
      ctx.toolCallIdToName.set(toolCallId, toolName);
      return [
        {
          type: 'tool',
          toolName,
          toolInput: args ?? {},
          toolCallId,
        },
      ];
    }
    case 'tool.execution_complete': {
      const { toolCallId, success, result } = event.data;
      const toolName = ctx.toolCallIdToName.get(toolCallId) ?? 'unknown';
      // Prefer detailedContent (full output) over content (truncated for LLM).
      const rawOutput = result?.detailedContent ?? result?.content ?? '';
      const chunks: MessageChunk[] = [];
      if (!success) {
        chunks.push({
          type: 'system',
          content: `⚠️ Tool ${toolName} failed`,
        });
      }
      chunks.push({
        type: 'tool_result',
        toolName,
        toolOutput: success ? rawOutput : `❌ ${rawOutput}`,
        toolCallId,
      });
      return chunks;
    }
    case 'session.error': {
      const msg = event.data.message || 'Copilot session error';
      ctx.markErrored(msg);
      return [{ type: 'system', content: `⚠️ ${msg}` }];
    }
    case 'session.compaction_start': {
      return [{ type: 'system', content: '⚙️ Compacting context…' }];
    }
    default: {
      getLog().debug({ eventType: event.type }, 'copilot.unhandled_event_type');
      return [];
    }
  }
}

// ─── bridgeSession integration wrapper ────────────────────────────────────

export type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

/**
 * Bridge a CopilotSession into an async generator of MessageChunks.
 *
 * Lifecycle:
 *  1. Subscribe to the session's event stream. Each event is translated via
 *     `mapCopilotEvent` and pushed into an `AsyncQueue`. Listener-thrown
 *     errors are captured and pushed as `{ kind: 'error' }` so the consumer
 *     surfaces them instead of swallowing.
 *  2. Wire `abortSignal` to `session.abort()`. Fire-and-forget — the SDK
 *     will surface the resulting rejection through `sendAndWait`, which
 *     feeds the queue.
 *  3. Call `session.sendAndWait({ prompt })` in parallel. Resolution pushes
 *     `{ kind: 'done' }`; rejection pushes `{ kind: 'error' }`. Its return
 *     value is stashed as a safety net for the no-streaming-deltas case.
 *  4. Consume the queue, yielding chunks. On `done`, emit a terminal
 *     `{ type: 'result', sessionId, tokens?, isError? }` chunk. Tokens are
 *     captured via the `assistant.usage` event earlier in the stream.
 *  5. Finally: close the queue, unsubscribe, remove abort listener, call
 *     `session.disconnect()` (best-effort), and await the sendAndWait
 *     promise to let the SDK settle (errors already surfaced via queue).
 */
export async function* bridgeSession(
  session: CopilotSession,
  prompt: string,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const log = getLog();
  const queue = new AsyncQueue<BridgeQueueItem>();
  const toolCallIdToName = new Map<string, string>();
  let capturedTokens: TokenUsage | undefined;
  let errorMessage: string | undefined;

  const ctx: EventMapperContext = {
    toolCallIdToName,
    captureUsage: (u: TokenUsage): void => {
      capturedTokens = u;
    },
    markErrored: (msg: string): void => {
      errorMessage = msg;
    },
  };

  const unsubscribe = session.on((event: SessionEvent) => {
    try {
      const chunks = mapCopilotEvent(event, ctx);
      for (const chunk of chunks) {
        queue.push({ kind: 'chunk', chunk });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  const onAbort = (): void => {
    void session.abort().catch(err => {
      log.debug({ err, sessionId: session.sessionId }, 'copilot.abort_failed');
    });
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // Kick off sendAndWait; it resolves on `session.idle`.
  let sendResult: AssistantMessageEvent | undefined;
  const sendPromise = session.sendAndWait({ prompt }).then(
    (r: AssistantMessageEvent | undefined) => {
      sendResult = r;
      queue.push({ kind: 'done' });
    },
    (err: unknown) => {
      queue.push({ kind: 'error', error: err as Error });
    }
  );

  let sawAssistantContent = false;
  try {
    for await (const item of queue) {
      if (item.kind === 'done') break;
      if (item.kind === 'error') throw item.error;
      if (item.chunk.type === 'assistant') sawAssistantContent = true;
      yield item.chunk;
    }

    // Safety net: if `streaming: true` didn't produce deltas for some reason
    // (older SDK, model quirks, BYOK provider), emit the accumulated final
    // content from sendAndWait's return value so the user doesn't lose output.
    if (!sawAssistantContent && sendResult?.data?.content) {
      yield { type: 'assistant', content: sendResult.data.content };
    }

    // Terminal result chunk — always emit, even on error, so the executor
    // gets a session ID back (useful for resume).
    const result: MessageChunk = {
      type: 'result',
      sessionId: session.sessionId,
    };
    if (capturedTokens) result.tokens = capturedTokens;
    if (errorMessage) {
      result.isError = true;
      result.errors = [errorMessage];
    }
    yield result;
  } finally {
    queue.close();
    try {
      unsubscribe();
    } catch (err) {
      log.debug({ err }, 'copilot.unsubscribe_failed');
    }
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    try {
      await session.disconnect();
    } catch (err) {
      log.debug({ err, sessionId: session.sessionId }, 'copilot.disconnect_failed');
    }
    // Let the SDK's sendPromise settle so we don't leave a dangling promise.
    // Any error was already pushed to the queue.
    await sendPromise.catch(() => {
      /* already surfaced via queue */
    });
  }
}
