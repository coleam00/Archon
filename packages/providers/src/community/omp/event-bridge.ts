import type { AgentSession } from '@oh-my-pi/pi-coding-agent';
import type { Usage } from '@oh-my-pi/pi-ai';

import type { MessageChunk, TokenUsage } from '../../types';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp.event-bridge');
  return cachedLog;
}

// ─── AsyncQueue ────────────────────────────────────────────────────────────────

/**
 * Single-producer / single-consumer async queue. Bridges OMP's callback-based
 * `subscribe()` into an async generator.
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error(
        'AsyncQueue: a single queue can only be iterated once (single-consumer invariant).'
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

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Serialize a tool-execution `result` payload to a stable string.
 * OMP tools return arbitrary JS — strings pass through, everything else is JSON-serialized.
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
 * Extract Archon TokenUsage from OMP's Usage struct.
 */
export function usageToTokens(usage: Usage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
    cost: usage.cost.total,
  };
}

const THINKING_OPEN_TAGS = ['<think>', '<thinking>'] as const;
const THINKING_CLOSE_TAGS = ['</think>', '</thinking>'] as const;
const THINKING_TAGS = [...THINKING_OPEN_TAGS, ...THINKING_CLOSE_TAGS] as const;

interface ThinkingTagMatch {
  kind: 'open' | 'close';
  end: number;
}

function matchThinkingTagAt(lowerText: string, index: number): ThinkingTagMatch | undefined {
  for (const tag of THINKING_OPEN_TAGS) {
    if (lowerText.startsWith(tag, index)) return { kind: 'open', end: index + tag.length };
  }
  for (const tag of THINKING_CLOSE_TAGS) {
    if (lowerText.startsWith(tag, index)) return { kind: 'close', end: index + tag.length };
  }
  return undefined;
}

function isThinkingTagPrefix(lowerText: string, tags: readonly string[]): boolean {
  if (lowerText.length === 0) return false;
  return tags.some(tag => tag.startsWith(lowerText));
}

function trailingThinkingTagPrefixLength(lowerText: string, tags: readonly string[]): number {
  const maxLength = Math.min(lowerText.length, Math.max(...tags.map(tag => tag.length - 1)));
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = lowerText.slice(lowerText.length - length);
    if (isThinkingTagPrefix(suffix, tags)) return length;
  }
  return 0;
}

/**
 * Streaming-safe remover for model-emitted thinking markup.
 *
 * OMP normally emits reasoning as `thinking_delta`, which Archon keeps out of
 * user-visible text. Some OpenAI-compatible/custom models still stream raw
 * `<think>` / `<thinking>` blocks as `text_delta`; strip those blocks before
 * they reach Archon's command parser or platform adapters.
 */
export class ThinkingTagStripper {
  private pending = '';
  private inThinkingBlock = false;

  write(input: string): string {
    if (input.length === 0) return '';
    const text = this.pending + input;
    this.pending = '';
    return this.process(text);
  }

  flush(): string {
    if (this.inThinkingBlock) {
      this.pending = '';
      return '';
    }
    const out = this.pending;
    this.pending = '';
    return out;
  }

  private process(text: string): string {
    const lowerText = text.toLowerCase();
    let out = '';
    let index = 0;

    while (index < text.length) {
      if (this.inThinkingBlock) {
        const closeIndex = lowerText.indexOf('<', index);
        if (closeIndex === -1) {
          this.pending = '';
          return out;
        }

        const tag = matchThinkingTagAt(lowerText, closeIndex);
        if (tag?.kind === 'close') {
          this.inThinkingBlock = false;
          index = tag.end;
          continue;
        }

        const suffix = lowerText.slice(closeIndex);
        if (isThinkingTagPrefix(suffix, THINKING_CLOSE_TAGS)) {
          this.pending = text.slice(closeIndex);
          return out;
        }

        index = closeIndex + 1;
        continue;
      }

      const tagIndex = lowerText.indexOf('<', index);
      if (tagIndex === -1) {
        const remaining = lowerText.slice(index);
        const pendingLength = trailingThinkingTagPrefixLength(remaining, THINKING_TAGS);
        const emitEnd = text.length - pendingLength;
        out += text.slice(index, emitEnd);
        this.pending = pendingLength > 0 ? text.slice(emitEnd) : '';
        return out;
      }

      out += text.slice(index, tagIndex);
      const tag = matchThinkingTagAt(lowerText, tagIndex);
      if (tag) {
        this.inThinkingBlock = tag.kind === 'open';
        index = tag.end;
        continue;
      }

      const suffix = lowerText.slice(tagIndex);
      if (isThinkingTagPrefix(suffix, THINKING_TAGS)) {
        this.pending = text.slice(tagIndex);
        return out;
      }

      out += text[tagIndex];
      index = tagIndex + 1;
    }

    return out;
  }
}

// ─── Event mapping ─────────────────────────────────────────────────────────

type OmpEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'message_update'; assistantMessageEvent: { type: 'thinking_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolName: string; args: unknown; toolCallId: string }
  | {
      type: 'tool_execution_end';
      toolName: string;
      result: unknown;
      isError: boolean;
      toolCallId: string;
    }
  | { type: 'agent_end'; messages: readonly unknown[]; stopReason?: string }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; errorMessage: string }
  | { type: 'turn_start' }
  | { type: 'turn_end' };

interface AssistantMessageWithUsage {
  role: 'assistant';
  usage: Usage;
  stopReason?: string;
}

function isAssistantMessage(m: unknown): m is AssistantMessageWithUsage {
  if (m === null || typeof m !== 'object') return false;
  const obj = m as { role?: unknown; usage?: unknown };
  return obj.role === 'assistant' && typeof obj.usage === 'object' && obj.usage !== null;
}

/**
 * Build the terminal `result` chunk from the final `agent_end` event.
 */
export function buildResultChunk(messages: readonly unknown[]): MessageChunk {
  const last = [...messages].reverse().find(isAssistantMessage);
  if (!last) {
    getLog().warn('omp.event-bridge.result_missing_assistant_message');
    return { type: 'result', isError: true, errorSubtype: 'missing_assistant_message' };
  }

  const tokens = usageToTokens(last.usage);
  const isError = last.stopReason === 'error' || last.stopReason === 'aborted';

  return {
    type: 'result',
    tokens,
    ...(tokens.cost !== undefined ? { cost: tokens.cost } : {}),
    ...(last.stopReason ? { stopReason: last.stopReason } : {}),
    ...(isError ? { isError: true, errorSubtype: last.stopReason } : {}),
  };
}

/**
 * Attempt to parse assistant transcript as structured-output JSON.
 * Handles: whitespace, fences, and prose-then-JSON patterns.
 */
export function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  // Strip fences
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  // Tier 1: direct parse
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }

  // Tier 2: scan to first `{`
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
 * Map OMP's `AgentSessionEvent` → zero-or-more Archon `MessageChunk`s.
 */
export function mapOmpEvent(event: OmpEvent): MessageChunk[] {
  switch (event.type) {
    case 'message_update': {
      const amEvent = event.assistantMessageEvent;
      if ('delta' in amEvent && amEvent.delta !== undefined) {
        if (amEvent.type === 'text_delta') {
          return [{ type: 'assistant', content: amEvent.delta }];
        }
        if (amEvent.type === 'thinking_delta') {
          return [{ type: 'thinking', content: amEvent.delta }];
        }
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
        chunks.push({ type: 'system', content: `⚠️ Tool ${event.toolName} failed` });
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

// ─── Bridge ─────────────────────────────────────────────────────────────────

export type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

export interface BridgeNotifier {
  emit(chunk: MessageChunk): void;
  setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void;
}

/**
 * Bridge an OMP `AgentSession` into Archon's `AsyncGenerator<MessageChunk>` contract.
 *
 * - subscribe before calling prompt, unsubscribe in finally
 * - yield mapped events in order
 * - complete on successful `session.prompt()` resolution
 * - throw on `session.prompt()` rejection
 * - forward `abortSignal` to `session.abort()` fire-and-forget
 * - always `dispose()` the session
 */
export async function* bridgeSession(
  session: AgentSession,
  prompt: string,
  abortSignal?: AbortSignal,
  outputSchema?: Record<string, unknown>,
  _uiBridge?: BridgeNotifier
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();
  const pendingChunks: MessageChunk[] = [];
  const thinkingTagStripper = new ThinkingTagStripper();
  let done = false;
  let error: Error | undefined;

  const enqueueSanitizedChunk = (chunk: MessageChunk): void => {
    if (chunk.type !== 'assistant') {
      queue.push({ kind: 'chunk', chunk });
      return;
    }

    const content = thinkingTagStripper.write(chunk.content);
    if (content.length > 0) {
      queue.push({ kind: 'chunk', chunk: { ...chunk, content } });
    }
  };

  const enqueuePendingAssistantText = (): void => {
    const content = thinkingTagStripper.flush();
    if (content.length > 0) {
      queue.push({ kind: 'chunk', chunk: { type: 'assistant', content } });
    }
  };

  const unsubscribe = session.subscribe(event => {
    if (done) return;
    const ompEvent = event as OmpEvent;
    if (ompEvent.type === 'agent_end') {
      enqueuePendingAssistantText();
    }
    const chunks = mapOmpEvent(ompEvent);
    for (const chunk of chunks) {
      enqueueSanitizedChunk(chunk);
    }
  });

  let aborted = false;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    session.abort();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort);
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
      if (item.kind === 'done') {
        const content = thinkingTagStripper.flush();
        if (content.length > 0) {
          const chunk: MessageChunk = { type: 'assistant', content };
          pendingChunks.push(chunk);
          yield chunk;
        }
        done = true;
        break;
      }
      if (item.kind === 'error') {
        done = true;
        error = item.error;
        break;
      }
      pendingChunks.push(item.chunk);
      yield item.chunk;
    }
    await promptPromise;
  } finally {
    done = true;
    unsubscribe();
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    await session.dispose();
  }

  if (error) throw error;

  // Attempt structured output parse if schema was requested
  if (outputSchema) {
    const transcript = pendingChunks
      .filter(c => c.type === 'assistant')
      .map(c => (c as { type: 'assistant'; content: string }).content)
      .join('');
    const parsed = tryParseStructuredOutput(transcript);
    if (parsed !== undefined) {
      yield { type: 'result', structuredOutput: parsed };
    }
  }
}
