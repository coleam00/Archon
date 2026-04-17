import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage, Usage } from '@mariozechner/pi-ai';

import type { MessageChunk, TokenUsage } from '../../types';

/**
 * Single-producer / single-consumer async queue. Bridges Pi's callback-based
 * `subscribe()` into an async generator.
 *
 * Design:
 *  - producers call `push(item)` from any synchronous context
 *  - the consumer awaits `for await (const item of queue)`
 *  - sentinel items (in this bridge: `__done` / `__error`) are pushed by the
 *    caller; the queue itself does not know about them
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.buffer.push(item);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      const item = await new Promise<T>(resolve => {
        this.waiters.push(resolve);
      });
      yield item;
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
    return { type: 'result' };
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
export async function* bridgeSession(
  session: AgentSession,
  prompt: string,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  type QueueItem =
    | { kind: 'chunk'; chunk: MessageChunk }
    | { kind: 'done' }
    | { kind: 'error'; error: Error };

  const queue = new AsyncQueue<QueueItem>();

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    try {
      for (const chunk of mapPiEvent(event)) {
        queue.push({ kind: 'chunk', chunk });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  const onAbort = (): void => {
    void session.abort().catch(() => {
      /* abort is best-effort — failures are recoverable via dispose */
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
      if (item.chunk.type === 'result' && session.sessionId) {
        yield { ...item.chunk, sessionId: session.sessionId };
      } else {
        yield item.chunk;
      }
    }
  } finally {
    unsubscribe();
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    try {
      session.dispose();
    } catch {
      /* dispose is defensive — session may already be torn down */
    }
    // Ensure the prompt promise settles so callers see no dangling work.
    await promptPromise.catch(() => {
      /* errors already surfaced through the queue */
    });
  }
}
