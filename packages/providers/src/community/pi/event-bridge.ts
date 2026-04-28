import { createLogger } from '@archon/paths';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage, Usage } from '@mariozechner/pi-ai';

import type { MessageChunk, TokenUsage } from '../../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi.event-bridge');
  return cachedLog;
}

/**
 * Single-producer / single-consumer async queue. Bridges Pi's callback-based
 * `subscribe()` into an async generator.
 *
 * Design:
 *  - producers call `push(item)` from any synchronous context
 *  - the consumer awaits `for await (const item of queue)` ONCE
 *  - sentinel items (in this bridge: `__done` / `__error`) are pushed by the
 *    caller; the queue itself does not know about them
 *
 * Single-consumer is a hard invariant — a second iterator would race with
 * the first over both the buffer and the waiters list, silently dropping
 * items. The constructor enforces this: the first `Symbol.asyncIterator`
 * call sets `consumed=true`; subsequent calls throw so the mistake surfaces
 * loudly during development rather than being debugged after the fact.
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
   * hanging forever when the producer's finally block fires before a new
   * item arrives (e.g. consumer abort mid-iteration).
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
      // Throw synchronously at the call site (not lazily on first .next())
      // so the stack trace points at the offending second-consumer caller.
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

/**
 * Serialize a tool-execution `result` payload to a stable string.
 * Pi tools return arbitrary JS — strings pass through, everything else is
 * JSON-serialized (with String() fallback for non-serializable objects).
 */
export function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Extract Archon TokenUsage from Pi's Usage struct.
 * Pi reports input/output/cacheRead/cacheWrite + cost breakdown.
 */
export function usageToTokens(usage: Usage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    cost: usage.cost.total,
  };
}

/**
 * Narrow a single transcript message to AssistantMessage by inspecting
 * `role` and `usage` structurally. Pi's AgentMessage union includes user,
 * toolResult, and custom extension messages; we only care about assistant
 * messages for result-chunk assembly.
 */
function isAssistantMessage(m: unknown): m is AssistantMessage {
  if (m === null || typeof m !== 'object') return false;
  const obj = m as { role?: unknown; usage?: unknown };
  return obj.role === 'assistant' && typeof obj.usage === 'object' && obj.usage !== null;
}

/**
 * Build the terminal `result` chunk from the final `agent_end` event. Pulls
 * usage/stopReason/error from the last assistant message in the returned
 * transcript. When the agent ended in error, surfaces it as `isError: true`.
 */
export function buildResultChunk(messages: readonly unknown[]): MessageChunk {
  const last = [...messages].reverse().find(isAssistantMessage);
  if (!last) {
    // agent_end fired with no assistant message in the transcript. This
    // shouldn't happen in healthy Pi runs — surface it as a loud error
    // rather than a silent success so orchestrators don't treat a broken
    // session as a clean completion.
    getLog().warn('pi.event-bridge.result_missing_assistant_message');
    return { type: 'result', isError: true, errorSubtype: 'missing_assistant_message' };
  }

  const tokens = usageToTokens(last.usage);
  const isError = last.stopReason === 'error' || last.stopReason === 'aborted';

  const chunk: MessageChunk = {
    type: 'result',
    tokens,
    ...(tokens.cost !== undefined ? { cost: tokens.cost } : {}),
    ...(last.stopReason ? { stopReason: last.stopReason } : {}),
    ...(isError ? { isError: true, errorSubtype: last.stopReason } : {}),
  };
  return chunk;
}

/**
 * Attempt to parse a Pi assistant transcript as the structured-output JSON
 * requested via `outputFormat`. Handles three common model failure modes:
 *  - trailing/leading whitespace (always stripped)
 *  - markdown code fences (```json ... ``` or bare ``` ... ```) that models
 *    emit despite the "no code fences" instruction in the prompt
 *  - prose preamble followed by a single trailing JSON object — pattern
 *    observed on Minimax M2.7 ("Now I have all the inputs. Let me evaluate
 *    the three gates: ... {...}"). Reasoning models tend to "think out loud"
 *    before emitting structured output despite explicit JSON-only prompts.
 *
 * Returns the parsed value on success, `undefined` on any failure. Callers
 * treat `undefined` as "structured output unavailable" and degrade via the
 * dag-executor's existing missing-structured-output warning.
 */
export function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Strip ```json / ``` fences if present. Match only at boundaries so we
  // don't mangle JSON strings that legitimately contain backticks.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  // Tier 1: clean parse — fast path for fully compliant outputs.
  try {
    const parsed: unknown = JSON.parse(cleaned);
    // Schema augmentation always asks for an object — bare `null`, numbers,
    // and strings are valid JSON but not "structured output". Treat them as
    // missing so the dag-executor's structured_output_missing path engages.
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    // fall through
  }

  // Tier 2: scan forward to the FIRST `{` and parse from there. Recovers the
  // preamble-then-JSON pattern reasoning models emit. A backward scan from
  // the last `{` was considered but rejected: it silently returns the wrong
  // object when the prose contains a brace-bearing example after the real
  // payload (e.g. `{"actual":1}\nFor example: {"x":2}` would yield `{x:2}`),
  // breaking the conservative-failure contract callers rely on.
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) {
    try {
      return JSON.parse(cleaned.slice(firstBrace));
    } catch {
      // fall through
    }
  }

  return undefined;
}

/**
 * Pure mapper from Pi's `AgentSessionEvent` → zero-or-more Archon `MessageChunk`s.
 *
 * Most Pi events map 1:1 or are skipped. Tool execution is split across
 * `tool_execution_start` / `tool_execution_end`; the start yields `tool` with
 * `toolCallId`, the end yields `tool_result` matched by the same id.
 *
 * Events deliberately skipped in v1:
 *  - turn_start / turn_end, message_start / message_end (redundant with deltas)
 *  - text_start / text_end / thinking_start / thinking_end (boundaries only)
 *  - compaction_start / compaction_end (auto-compaction opaque to Archon)
 *  - queue_update (single-prompt sessions only)
 *  - auto_retry_end (retry_start communicates the retry sufficiently)
 */
export function mapPiEvent(event: AgentSessionEvent): MessageChunk[] {
  switch (event.type) {
    case 'message_update': {
      const amEvent = event.assistantMessageEvent;
      if (amEvent.type === 'text_delta') {
        return [{ type: 'assistant', content: amEvent.delta }];
      }
      if (amEvent.type === 'thinking_delta') {
        return [{ type: 'thinking', content: amEvent.delta }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool',
          toolName: event.toolName,
          toolInput:
            typeof event.args === 'object' && event.args !== null
              ? (event.args as Record<string, unknown>)
              : {},
          toolCallId: event.toolCallId,
        },
      ];
    case 'tool_execution_end': {
      const chunks: MessageChunk[] = [];
      if (event.isError) {
        chunks.push({
          type: 'system',
          content: `⚠️ Tool ${event.toolName} failed`,
        });
      }
      chunks.push({
        type: 'tool_result',
        toolName: event.toolName,
        toolOutput: serializeToolResult(event.result),
        toolCallId: event.toolCallId,
      });
      return chunks;
    }
    case 'agent_end':
      return [buildResultChunk(event.messages)];
    case 'auto_retry_start':
      return [
        {
          type: 'system',
          content: `⚠️ retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
        },
      ];
    default:
      return [];
  }
}

/**
 * Bridge a Pi `AgentSession` into Archon's `AsyncGenerator<MessageChunk>` contract.
 *
 * Behavior:
 *  - subscribe before calling prompt, unsubscribe in finally
 *  - yield mapped events in order
 *  - complete on successful `session.prompt()` resolution
 *  - throw on `session.prompt()` rejection or listener-raised errors
 *  - forward `abortSignal` to `session.abort()` fire-and-forget
 *  - always `dispose()` the session to avoid listener accumulation
 */
/**
 * Internal queue payload for `bridgeSession`. Exported at module scope
 * (not inside the generator) so unit tests can exercise each variant
 * independently without reaching into the generator's closure.
 */
export type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

/** Lets the UI stub push notifications into the session's chunk queue. */
export interface BridgeNotifier {
  setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void;
}

export async function* bridgeSession(
  session: AgentSession,
  prompt: string,
  abortSignal?: AbortSignal,
  jsonSchema?: Record<string, unknown>,
  uiBridge?: BridgeNotifier
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();
  uiBridge?.setEmitter(chunk => {
    queue.push({ kind: 'chunk', chunk });
  });
  // Best-effort structured-output buffer. Only accumulates when the caller
  // requested a JSON schema; otherwise stays empty and the terminal chunk
  // passes through untouched.
  const wantsStructured = jsonSchema !== undefined;
  let assistantBuffer = '';

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    try {
      for (const chunk of mapPiEvent(event)) {
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
    void session.abort().catch((err: unknown) => {
      // Abort is best-effort — failures are recoverable via the dispose()
      // call in the `finally` below. But log at debug so a regression in
      // Pi's abort path doesn't silently disappear.
      getLog().debug({ err }, 'pi.event-bridge.abort_failed');
    });
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const promptPromise = session.prompt(prompt).then(
    () => {
      queue.push({ kind: 'done' });
    },
    (err: unknown) => {
      queue.push({ kind: 'error', error: err as Error });
    }
  );

  try {
    for await (const item of queue) {
      if (item.kind === 'done') return;
      if (item.kind === 'error') throw item.error;
      // Annotate the terminal result chunk with Pi's session UUID so Archon's
      // orchestrator can pass it back as `resumeSessionId` on the next call.
      // Pi's session.sessionId is always a UUID (even for in-memory); we emit
      // it unconditionally and let the caller decide whether resume is
      // meaningful (capability-gated at the registry level).
      if (item.chunk.type === 'result') {
        let terminal: MessageChunk = item.chunk;
        if (session.sessionId) {
          terminal = { ...terminal, sessionId: session.sessionId };
        }
        // Best-effort structured output: parse the accumulated assistant
        // transcript as JSON and attach. On parse failure, leave it off —
        // the dag-executor's existing dag.structured_output_missing path
        // warns and downstream $node.output.field refs degrade to '' instead
        // of propagating bogus data.
        if (wantsStructured) {
          const parsed = tryParseStructuredOutput(assistantBuffer);
          if (parsed !== undefined) {
            terminal = { ...terminal, structuredOutput: parsed };
          } else {
            getLog().warn(
              { bufferLength: assistantBuffer.length },
              'pi.event-bridge.structured_output_parse_failed'
            );
          }
        }
        yield terminal;
      } else {
        yield item.chunk;
      }
    }
  } finally {
    // Close the queue first so any producer push() still in flight becomes
    // a no-op and pending iterate() waiters resolve — otherwise a consumer
    // abort mid-iteration would leak this generator on the promise forever.
    queue.close();
    uiBridge?.setEmitter(undefined);
    unsubscribe();
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    try {
      session.dispose();
    } catch (err: unknown) {
      // Dispose is defensive — session may already be torn down. Log at
      // debug so SDK regressions surface without polluting normal output.
      getLog().debug({ err }, 'pi.event-bridge.dispose_failed');
    }
    // Ensure the prompt promise settles so callers see no dangling work.
    await promptPromise.catch(() => {
      /* errors already surfaced through the queue */
    });
  }
}
