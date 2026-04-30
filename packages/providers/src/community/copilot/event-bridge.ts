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
 *     cleanup lifecycle stays readable.
 *
 * Module-scope invariant: type-only imports from @github/copilot-sdk. Value
 * imports go inside `provider.ts` via dynamic `await import(...)`. See the
 * PI lazy-load test for rationale.
 */
import { createLogger } from '@archon/paths';
import type { AssistantMessageEvent, CopilotSession, SessionEvent } from '@github/copilot-sdk';

import type { MessageChunk, TokenUsage } from '../../types';
import { tryParseStructuredOutput } from '../../shared/structured-output';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot.event-bridge');
  return cachedLog;
}

// ─── AsyncQueue ──────────────────────────────────────────────────────────

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

/**
 * Translate one Copilot SDK `SessionEvent` into zero or more Archon
 * `MessageChunk`s, mutating the supplied context (tool-call id → name map,
 * captured usage, terminal error) as a side-effect. Keeping the side-effects
 * behind a closure lets unit tests drive pure inputs and assert on both the
 * returned chunks and the context mutations.
 */
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
      // Don't emit a system chunk here — defer until after sendAndWait
      // resolves. If the SDK delivers a fallback assistant message (transient
      // upstream errors are common on auto-retry paths), the user got what
      // they asked for and a "⚠️ ..." chunk is just noise. The bridgeSession
      // wrapper checks `sawAssistantContent` and emits the warning only when
      // no assistant content reached the consumer.
      const msg = event.data.message || 'Copilot session error';
      ctx.markErrored(msg);
      return [];
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

/**
 * Backstop timeout passed to `session.sendAndWait()`.
 *
 * The SDK defaults to 60s, which is far too short — any tool-heavy turn or
 * workflow node with a larger `idle_timeout` would trip the SDK timer before
 * Archon's own idle / abort machinery gets a say. The SDK docs also note
 * that this timeout *only* stops the wait; it does not abort in-flight agent
 * work — so a small value causes the session to keep running in the
 * background, orphaned. We therefore set a 60-minute ceiling (2× Archon's
 * `STEP_IDLE_TIMEOUT_MS`) and rely on `abortSignal → session.abort()` to be
 * the real cancel path.
 */
const SEND_AND_WAIT_TIMEOUT_MS = 60 * 60 * 1000;

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
  abortSignal?: AbortSignal,
  jsonSchema?: Record<string, unknown>
): AsyncGenerator<MessageChunk> {
  const log = getLog();
  const queue = new AsyncQueue<BridgeQueueItem>();
  const toolCallIdToName = new Map<string, string>();
  let capturedTokens: TokenUsage | undefined;
  let errorMessage: string | undefined;

  // Structured-output buffer. Populated only when the caller supplied a
  // schema; parsed into the terminal result chunk after the run completes.
  const wantsStructured = jsonSchema !== undefined;
  let assistantBuffer = '';

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
        if (wantsStructured && chunk.type === 'assistant') {
          assistantBuffer += chunk.content;
        }
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
  // `addEventListener('abort', ...)` is a no-op on an already-aborted signal,
  // so short-circuit before handing the 24-hour sendAndWait path a signal
  // that will never fire. Caller's caller (the executor) treats AbortError
  // as a clean cancellation. Clean up listeners + queue first so the throw
  // doesn't leak resources.
  if (abortSignal?.aborted) {
    onAbort();
    queue.close();
    try {
      unsubscribe();
    } catch (err) {
      log.debug({ err }, 'copilot.unsubscribe_failed');
    }
    try {
      await session.disconnect();
    } catch (err) {
      log.debug({ err, sessionId: session.sessionId }, 'copilot.disconnect_failed');
    }
    throw new DOMException('Copilot sendQuery aborted before start', 'AbortError');
  }
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Kick off sendAndWait; it resolves on `session.idle`. The explicit
  // timeout overrides the SDK's 60s default — see SEND_AND_WAIT_TIMEOUT_MS.
  let sendResult: AssistantMessageEvent | undefined;
  const sendPromise = session.sendAndWait({ prompt }, SEND_AND_WAIT_TIMEOUT_MS).then(
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
      if (wantsStructured) assistantBuffer += sendResult.data.content;
      yield { type: 'assistant', content: sendResult.data.content };
      sawAssistantContent = true;
    }

    // Emit the deferred session.error warning only if no assistant content
    // reached the consumer. When the SDK auto-recovers and still delivers a
    // fallback message (the common case for transient upstream errors), the
    // ⚠️ chunk is noise and gets suppressed.
    if (!sawAssistantContent && errorMessage) {
      yield { type: 'system', content: `⚠️ ${errorMessage}` };
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
    if (wantsStructured) {
      const parsed = tryParseStructuredOutput(assistantBuffer);
      if (parsed !== undefined) {
        result.structuredOutput = parsed;
      } else {
        log.warn(
          { bufferLength: assistantBuffer.length, sessionId: session.sessionId },
          'copilot.structured_output_parse_failed'
        );
      }
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
    // Abort before disconnect: if the consumer closed the generator early
    // (return() / break), sendAndWait is still running in the background.
    // Without an explicit abort, the finally would wait on sendPromise for up
    // to SEND_AND_WAIT_TIMEOUT_MS. abort() tells the SDK to cancel the run;
    // disconnect() tears down the connection.
    try {
      await session.abort();
    } catch (err) {
      log.debug({ err, sessionId: session.sessionId }, 'copilot.abort_cleanup_failed');
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
