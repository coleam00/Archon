import type { AgentSession } from '@oh-my-pi/pi-coding-agent';
import type { Usage } from '@oh-my-pi/pi-ai';

import type { MessageChunk, TokenUsage } from '../../types';
import { createLogger } from '@archon/paths';
import {
  createOmpDiagnosticsContext,
  enrichOmpError,
  summarizeUnknown,
  type OmpDiagnosticsContext,
} from './diagnostics';

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

/** Output of a single ThinkingTagStripper write/flush call. */
export interface ThinkingTagOutput {
  /** User-visible text (outside thinking blocks). */
  visible: string;
  /** Text rerouted from inside `<think>`/`<thinking>` blocks. */
  thinking: string;
}

export interface ThinkingTagFlushOutput extends ThinkingTagOutput {
  /** True when the stream ended inside an unclosed thinking block. */
  unclosedBlock: boolean;
  /** Chars rerouted to `thinking` for the current (unclosed) block. */
  suppressedChars: number;
}

/**
 * Streaming-safe rerouter for model-emitted thinking markup.
 *
 * OMP normally emits reasoning as `thinking_delta`, which Archon maps to
 * `thinking` chunks. Some OpenAI-compatible/custom models still stream raw
 * `<think>` / `<thinking>` blocks as `text_delta`; reroute that content to
 * `thinking` so it never reaches Archon's command parser or platform
 * adapters as visible text — but is also never silently discarded.
 */
export class ThinkingTagStripper {
  private pending = '';
  private inThinkingBlock = false;
  /** Chars rerouted to thinking since the current block opened. */
  private currentBlockChars = 0;

  write(input: string): ThinkingTagOutput {
    if (input.length === 0) return { visible: '', thinking: '' };
    const text = this.pending + input;
    this.pending = '';
    return this.process(text);
  }

  flush(): ThinkingTagFlushOutput {
    if (this.inThinkingBlock) {
      // Stream ended inside a thinking block — surface the held content as
      // thinking and report the unclosed block loudly instead of silently
      // producing an empty turn.
      const thinking = this.pending;
      const suppressedChars = this.currentBlockChars + this.pending.length;
      this.pending = '';
      this.inThinkingBlock = false;
      this.currentBlockChars = 0;
      return { visible: '', thinking, unclosedBlock: true, suppressedChars };
    }
    const visible = this.pending;
    this.pending = '';
    return { visible, thinking: '', unclosedBlock: false, suppressedChars: 0 };
  }

  private process(text: string): ThinkingTagOutput {
    const lowerText = text.toLowerCase();
    let visible = '';
    let thinking = '';
    let index = 0;

    const emitThinking = (chunk: string): void => {
      thinking += chunk;
      this.currentBlockChars += chunk.length;
    };

    while (index < text.length) {
      if (this.inThinkingBlock) {
        const closeIndex = lowerText.indexOf('<', index);
        if (closeIndex === -1) {
          emitThinking(text.slice(index));
          this.pending = '';
          return { visible, thinking };
        }

        const tag = matchThinkingTagAt(lowerText, closeIndex);
        if (tag?.kind === 'close') {
          emitThinking(text.slice(index, closeIndex));
          this.inThinkingBlock = false;
          this.currentBlockChars = 0;
          index = tag.end;
          continue;
        }

        const suffix = lowerText.slice(closeIndex);
        if (isThinkingTagPrefix(suffix, THINKING_CLOSE_TAGS)) {
          emitThinking(text.slice(index, closeIndex));
          this.pending = text.slice(closeIndex);
          return { visible, thinking };
        }

        emitThinking(text.slice(index, closeIndex + 1));
        index = closeIndex + 1;
        continue;
      }

      const tagIndex = lowerText.indexOf('<', index);
      if (tagIndex === -1) {
        const remaining = lowerText.slice(index);
        const pendingLength = trailingThinkingTagPrefixLength(remaining, THINKING_TAGS);
        const emitEnd = text.length - pendingLength;
        visible += text.slice(index, emitEnd);
        this.pending = pendingLength > 0 ? text.slice(emitEnd) : '';
        return { visible, thinking };
      }

      visible += text.slice(index, tagIndex);
      const tag = matchThinkingTagAt(lowerText, tagIndex);
      if (tag) {
        this.inThinkingBlock = tag.kind === 'open';
        if (tag.kind === 'open') this.currentBlockChars = 0;
        index = tag.end;
        continue;
      }

      const suffix = lowerText.slice(tagIndex);
      if (isThinkingTagPrefix(suffix, THINKING_TAGS)) {
        this.pending = text.slice(tagIndex);
        return { visible, thinking };
      }

      visible += text[tagIndex];
      index = tagIndex + 1;
    }

    return { visible, thinking };
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
 * Known-bad terminal stop reasons (OMP `StopReason` union:
 * `'stop' | 'length' | 'toolUse' | 'error' | 'aborted'`).
 *
 * - `error` / `aborted`: explicit failure / cancellation.
 * - `length`: the turn was truncated at the output token limit — the
 *   assistant message is incomplete.
 * - `toolUse`: the agent loop terminated while still requesting a tool —
 *   the turn never completed.
 *
 * Unknown reasons are NOT marked as errors (preserved visibly on the result
 * chunk); only known-bad reasons flip `isError`.
 */
export function isOmpStopReasonError(stopReason: string | undefined): boolean {
  return (
    stopReason === 'error' ||
    stopReason === 'aborted' ||
    stopReason === 'length' ||
    stopReason === 'toolUse'
  );
}

/**
 * Build the terminal `result` chunk from the final `agent_end` event.
 */
export function buildResultChunk(
  messages: readonly unknown[],
  diagnostics?: OmpDiagnosticsContext
): MessageChunk {
  const last = [...messages].reverse().find(isAssistantMessage);
  if (!last) {
    getLog().warn(
      diagnostics?.toLogSummary() ?? {},
      'omp.event-bridge.result_missing_assistant_message'
    );
    return {
      type: 'result',
      isError: true,
      errorSubtype: 'missing_assistant_message',
      errors: [
        'OMP session ended without an assistant message. ' +
          (diagnostics?.formatForErrorMessage() ?? '[omp diagnostics unavailable]'),
      ],
    };
  }

  if (last.stopReason !== undefined) diagnostics?.recordStopReason(last.stopReason);

  const tokens = usageToTokens(last.usage);
  const isError = isOmpStopReasonError(last.stopReason);

  return {
    type: 'result',
    tokens,
    ...(tokens.cost !== undefined ? { cost: tokens.cost } : {}),
    ...(last.stopReason ? { stopReason: last.stopReason } : {}),
    ...(isError
      ? {
          isError: true,
          errorSubtype: last.stopReason,
          errors: [
            `OMP session ended with stop reason '${last.stopReason ?? 'unknown'}'.` +
              (diagnostics ? ` ${diagnostics.formatForErrorMessage()}` : ''),
          ],
        }
      : {}),
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

/** Max chars of serialized tool error detail included in failure chunks. */
const TOOL_FAILURE_DETAIL_MAX_LEN = 600;

/**
 * Build the bounded failure detail string for a failed tool execution.
 * Includes tool name, call id, phase, args summary, and serialized
 * result/error summary — never the full output.
 */
function buildToolFailureDetail(
  event: Extract<OmpEvent, { type: 'tool_execution_end' }>,
  diagnostics?: OmpDiagnosticsContext
): string {
  const attempt = diagnostics?.findAttempt(event.toolCallId);
  const parts = [
    `Tool '${event.toolName}' failed`,
    `callId=${event.toolCallId}`,
    `phase=${attempt?.phase ?? 'failed'}${attempt?.synthesized ? ' (end-without-start)' : ''}`,
  ];
  if (attempt?.argsSummary !== undefined) parts.push(`args=${attempt.argsSummary}`);
  parts.push(
    `error=${summarizeUnknown(serializeToolResult(event.result), TOOL_FAILURE_DETAIL_MAX_LEN)}`
  );
  return parts.join(' | ');
}

/**
 * Map OMP's `AgentSessionEvent` → zero-or-more Archon `MessageChunk`s.
 *
 * `diagnostics`, when provided, enriches tool-failure chunks with ledger
 * context (phase, args summary) and lets the terminal result chunk carry a
 * bounded failure summary.
 */
export function mapOmpEvent(event: OmpEvent, diagnostics?: OmpDiagnosticsContext): MessageChunk[] {
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
        const detail = buildToolFailureDetail(event, diagnostics);
        chunks.push({ type: 'system', content: `⚠️ ${detail}` });
        // Keep the tool_result chunk shape; encode the bounded failure detail
        // in toolOutput so downstream consumers see why the tool failed.
        chunks.push({
          type: 'tool_result',
          toolName: event.toolName,
          toolOutput: detail,
          toolCallId: event.toolCallId,
        });
        return chunks;
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
      return [buildResultChunk(event.messages, diagnostics)];
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

export interface BridgeSessionOptions {
  /** Shared per-query diagnostics ledger. A local one is created if omitted. */
  diagnostics?: OmpDiagnosticsContext;
}

// ─── Timeouts ───────────────────────────────────────────────────────────────

function getTimeoutMsFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackMs;
}

/** No events at all within this window → assume the session never started. */
export function getOmpFirstEventTimeoutMs(): number {
  return getTimeoutMsFromEnv('ARCHON_OMP_FIRST_EVENT_TIMEOUT_MS', 60_000);
}

/** Silence between events (no tool in flight) → assume the stream died. */
export function getOmpStreamDeathTimeoutMs(): number {
  return getTimeoutMsFromEnv('ARCHON_OMP_STREAM_DEATH_TIMEOUT_MS', 180_000);
}

/** Ceiling for a single in-flight tool execution (catches truly hung tools). */
export function getOmpToolExecutionTimeoutMs(): number {
  return getTimeoutMsFromEnv('ARCHON_OMP_TOOL_EXECUTION_TIMEOUT_MS', 30 * 60_000);
}

type OmpTimeoutKind = 'first_event' | 'stream_death' | 'tool_execution';

class OmpTimeoutSignal extends Error {
  constructor(readonly kind: OmpTimeoutKind) {
    super(`omp timeout: ${kind}`);
    this.name = 'OmpTimeoutSignal';
  }
}

function buildTimeoutErrorMessage(
  kind: OmpTimeoutKind,
  timeoutMs: number,
  diagnostics: OmpDiagnosticsContext
): string {
  switch (kind) {
    case 'first_event':
      return (
        `OMP first-event timeout: session produced no events within ${String(timeoutMs)}ms. ` +
        'The model/provider endpoint may be unreachable or hanging before the first token.'
      );
    case 'stream_death': {
      return (
        `OMP stream-death timeout: no session events for ${String(timeoutMs)}ms with no tool in flight. ` +
        'The event stream appears to have died mid-turn.'
      );
    }
    case 'tool_execution': {
      const inFlight = diagnostics
        .getInFlightAttempts()
        .map(a => `${a.toolName}#${a.toolCallId}`)
        .join(', ');
      return (
        `OMP tool-execution timeout: tool${inFlight ? ` [${inFlight}]` : ''} still running after ` +
        `${String(timeoutMs)}ms (ARCHON_OMP_TOOL_EXECUTION_TIMEOUT_MS ceiling).`
      );
    }
  }
}

/**
 * Bridge an OMP `AgentSession` into Archon's `AsyncGenerator<MessageChunk>` contract.
 *
 * - subscribe before calling prompt, unsubscribe in finally
 * - record every event in the diagnostics ledger BEFORE mapping
 * - yield mapped events in order
 * - reroute raw `<think>`/`<thinking>` text to `thinking` chunks
 * - first-event / tool-aware stream-death / tool-ceiling timeouts abort the
 *   session and throw an enriched OMP-specific error
 * - complete on successful `session.prompt()` resolution
 * - throw (enriched) on `session.prompt()` rejection
 * - forward `abortSignal` to `session.abort()` fire-and-forget
 * - always `dispose()` the session
 */
export async function* bridgeSession(
  session: AgentSession,
  prompt: string,
  abortSignal?: AbortSignal,
  outputSchema?: Record<string, unknown>,
  _uiBridge?: BridgeNotifier,
  options?: BridgeSessionOptions
): AsyncGenerator<MessageChunk> {
  const diagnostics =
    options?.diagnostics ??
    createOmpDiagnosticsContext({ provider: 'omp', modelId: 'unknown', cwd: '', resumed: false });

  const firstEventTimeoutMs = getOmpFirstEventTimeoutMs();
  const streamDeathTimeoutMs = getOmpStreamDeathTimeoutMs();
  const toolExecutionTimeoutMs = getOmpToolExecutionTimeoutMs();

  // Captured BEFORE subscribing/prompting: events emitted synchronously
  // during session.prompt() must count as belonging to this bridge.
  // (The diagnostics ledger is shared across retry attempts, so timestamps
  // older than this mark are treated as previous-attempt residue.)
  const bridgeStartedAt = Date.now();

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

    const { visible, thinking } = thinkingTagStripper.write(chunk.content);
    if (thinking.length > 0) {
      queue.push({ kind: 'chunk', chunk: { type: 'thinking', content: thinking } });
    }
    if (visible.length > 0) {
      queue.push({ kind: 'chunk', chunk: { ...chunk, content: visible } });
    }
  };

  const enqueueFlushedAssistantText = (): void => {
    const flushed = thinkingTagStripper.flush();
    if (flushed.thinking.length > 0) {
      queue.push({ kind: 'chunk', chunk: { type: 'thinking', content: flushed.thinking } });
    }
    if (flushed.unclosedBlock) {
      getLog().warn(
        { ...diagnostics.toLogSummary(), suppressedChars: flushed.suppressedChars },
        'omp.event-bridge.unclosed_thinking_block'
      );
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'system',
          content:
            '⚠️ OMP turn ended inside an unclosed <think> block — ' +
            `${String(flushed.suppressedChars)} chars rerouted to thinking instead of visible output.`,
        },
      });
    }
    if (flushed.visible.length > 0) {
      queue.push({ kind: 'chunk', chunk: { type: 'assistant', content: flushed.visible } });
    }
  };

  const unsubscribe = session.subscribe(event => {
    const ompEvent = event as OmpEvent;
    // Record in the ledger BEFORE mapping so failure paths always have context.
    diagnostics.recordEvent(ompEvent.type);
    if (ompEvent.type === 'tool_execution_start') {
      diagnostics.recordToolStart(ompEvent.toolName, ompEvent.toolCallId, ompEvent.args);
    } else if (ompEvent.type === 'tool_execution_end') {
      diagnostics.recordToolEnd(
        ompEvent.toolName,
        ompEvent.toolCallId,
        ompEvent.result,
        ompEvent.isError
      );
    }
    if (done) return;
    if (ompEvent.type === 'agent_end') {
      enqueueFlushedAssistantText();
    }
    const chunks = mapOmpEvent(ompEvent, diagnostics);
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

  // Terminal result chunk from `agent_end` — held back and yielded exactly
  // once after stream completion so structuredOutput can be merged into it
  // (mirrors the Pi bridge: one terminal result with tokens + structuredOutput).
  // The chunk arrives already enriched: buildResultChunk applies stop-reason
  // classification and ledger diagnostics when mapping `agent_end`.
  let terminalResult: Extract<MessageChunk, { type: 'result' }> | undefined;

  /**
   * Await the next queue item, racing against the applicable timeout:
   * - no activity yet → first-event timeout
   * - tool in flight → tool-execution ceiling (stream-death suspended)
   * - otherwise → stream-death timeout (reset on every event)
   * A timeout that loses to ledger activity (events that map to no chunks)
   * re-arms instead of firing.
   */
  const iterator = queue[Symbol.asyncIterator]();
  let sawActivity = false;
  const nextQueueItem = async (): Promise<IteratorResult<BridgeQueueItem>> => {
    while (true) {
      if (!sawActivity) {
        // Only events recorded since THIS bridge started count as activity
        // (the diagnostics ledger is shared across retry attempts).
        const lastEventAt = diagnostics.getLastEventAt();
        if (lastEventAt !== undefined && lastEventAt >= bridgeStartedAt) sawActivity = true;
      }

      let kind: OmpTimeoutKind;
      let waitMs: number;
      // Ignore in-flight tools from a previous retry attempt (shared ledger):
      // only tools started by THIS bridge suspend the stream-death timer.
      const rawInFlightStart = diagnostics.getEarliestInFlightStart();
      const inFlightStart =
        rawInFlightStart !== undefined && rawInFlightStart >= bridgeStartedAt
          ? rawInFlightStart
          : undefined;
      if (!sawActivity) {
        kind = 'first_event';
        waitMs = firstEventTimeoutMs;
      } else if (inFlightStart !== undefined) {
        kind = 'tool_execution';
        waitMs = Math.max(0, inFlightStart + toolExecutionTimeoutMs - Date.now());
      } else {
        kind = 'stream_death';
        waitMs = streamDeathTimeoutMs;
      }

      const waitStart = Date.now();
      let timerId: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => {
              reject(new OmpTimeoutSignal(kind));
            }, waitMs);
          }),
        ]);
        sawActivity = true;
        return result;
      } catch (raceErr: unknown) {
        if (!(raceErr instanceof OmpTimeoutSignal)) throw raceErr;
        // Ledger activity since the wait started (events that produced no
        // chunks, or a tool state change) → re-arm rather than fire.
        const lastEventAt = diagnostics.getLastEventAt();
        if (lastEventAt !== undefined && lastEventAt >= waitStart) {
          sawActivity = true;
          continue;
        }
        const timeoutMs = kind === 'tool_execution' ? toolExecutionTimeoutMs : waitMs;
        getLog().error(
          { ...diagnostics.toLogSummary(), timeoutKind: kind, timeoutMs },
          'omp.event-bridge.timeout'
        );
        onAbort();
        throw enrichOmpError(
          new Error(buildTimeoutErrorMessage(kind, timeoutMs, diagnostics)),
          diagnostics
        );
      } finally {
        clearTimeout(timerId);
      }
    }
  };

  try {
    while (true) {
      const next = await nextQueueItem();
      if (next.done) break;
      const item = next.value;
      if (item.kind === 'done') {
        const flushed = thinkingTagStripper.flush();
        if (flushed.thinking.length > 0) {
          const chunk: MessageChunk = { type: 'thinking', content: flushed.thinking };
          pendingChunks.push(chunk);
          yield chunk;
        }
        if (flushed.unclosedBlock) {
          getLog().warn(
            { ...diagnostics.toLogSummary(), suppressedChars: flushed.suppressedChars },
            'omp.event-bridge.unclosed_thinking_block'
          );
          yield {
            type: 'system',
            content:
              '⚠️ OMP turn ended inside an unclosed <think> block — ' +
              `${String(flushed.suppressedChars)} chars rerouted to thinking instead of visible output.`,
          };
        }
        if (flushed.visible.length > 0) {
          const chunk: MessageChunk = { type: 'assistant', content: flushed.visible };
          pendingChunks.push(chunk);
          yield chunk;
        }
        done = true;
        break;
      }
      if (item.kind === 'error') {
        done = true;
        diagnostics.recordError(item.error);
        error = enrichOmpError(item.error, diagnostics);
        break;
      }
      if (item.chunk.type === 'result') {
        terminalResult = item.chunk;
        continue;
      }
      pendingChunks.push(item.chunk);
      yield item.chunk;
    }
    if (done) await promptPromise;
  } finally {
    done = true;
    unsubscribe();
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    await session.dispose();
  }

  if (error) throw error;

  // Attempt structured output parse if schema was requested, then merge into
  // the single terminal result chunk (preserves missing_assistant_message
  // semantics — that error result is still the one terminal chunk).
  if (outputSchema) {
    const transcript = pendingChunks
      .filter(c => c.type === 'assistant')
      .map(c => (c as { type: 'assistant'; content: string }).content)
      .join('');
    const parsed = tryParseStructuredOutput(transcript);
    if (parsed !== undefined) {
      terminalResult = terminalResult
        ? { ...terminalResult, structuredOutput: parsed }
        : { type: 'result', structuredOutput: parsed };
    }
  }

  if (terminalResult) {
    yield terminalResult;
  }
}
