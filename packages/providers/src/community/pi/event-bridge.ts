import { createLogger } from '@archon/paths';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, StopReason, Usage } from '@earendil-works/pi-ai';
import { truncateToolOutput, type ProviderStopReason } from '@archon/provider-contract';

import type { MessageChunk, ResultChunk, TokenUsage } from '../../types';
import { unknownFailureResult } from '../../shared/failure';
import type { PiExtensionTurn } from './extension-error-broker';

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
  } catch (err) {
    getLog().warn({ err }, 'pi.event-bridge.tool_result_serialize_failed');
    return String(result);
  }
}

/**
 * Extract Archon TokenUsage from Pi's Usage struct.
 * Pi reports input/output/cacheRead/cacheWrite + cost breakdown.
 */
export function usageToTokens(usage: Usage): TokenUsage {
  return {
    input: usage.input + usage.cacheRead + usage.cacheWrite,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
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
 * Extract the concatenated text content of the last assistant message from a
 * Pi session transcript (the fully-assembled version from agent_end.messages).
 * Used by bridgeSession to detect streaming truncation: if the assembled text
 * is longer than what was delivered via text_delta events, the gap is emitted
 * as a corrective assistant chunk before the result chunk.
 * Returns undefined when no assistant message is present.
 */
function extractLastAssistantText(messages: readonly unknown[]): string | undefined {
  const last = [...messages].reverse().find(isAssistantMessage);
  if (!last) return undefined;
  // AssistantMessage.content is (TextContent | ThinkingContent | ToolCall)[].
  // Filter to text blocks only; thinking and tool-call blocks are not streamed
  // as assistant chunks so they are excluded from the gap calculation.
  const blocks = last.content as { type: string; text?: string }[];
  return blocks
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');
}

/**
 * Sum usage over every model call of one prompt.
 *
 * Pi reports usage per assistant message, and each assistant message is one model
 * call. Claude and Codex hand Archon the prompt-wide total instead, and the executor
 * treats a result chunk's usage as the whole pass, so the sum happens here (#2800).
 * Pi also calls the model mid-prompt without producing an assistant message, to
 * keep the prompt cache warm or to compact the context. The bridge passes the usage
 * of those calls in as `sideCalls` so the total still covers every billed call.
 *
 * Pi's `Usage` cannot say "not reported": a provider without streamed usage leaves
 * every field 0. A completed call always consumes input, so an all-zero completed
 * call means its usage is unknown, and the prompt's usage is then undefined rather
 * than a sum that silently omits it (#2314). An errored or aborted call with zero
 * usage was rejected before a response and adds nothing.
 */
function sumPromptUsage(
  assistants: readonly AssistantMessage[],
  sideCalls: readonly Usage[]
): TokenUsage | undefined {
  const isZero = (u: Usage): boolean => u.input + u.output + u.cacheRead + u.cacheWrite === 0;
  // Pi records a side call only once it completed, so the completed-call rule applies.
  const unreported =
    assistants.filter(
      m => m.stopReason !== 'error' && m.stopReason !== 'aborted' && isZero(m.usage)
    ).length + sideCalls.filter(isZero).length;
  const calls = [...assistants.map(m => m.usage), ...sideCalls];
  if (unreported > 0) {
    getLog().warn(
      { unreportedCalls: unreported, calls: calls.length },
      'pi.event-bridge.usage_unreported'
    );
    return undefined;
  }
  const sum = (pick: (u: Usage) => number): number =>
    calls.reduce((total, u) => total + pick(u), 0);
  return usageToTokens({
    input: sum(u => u.input),
    output: sum(u => u.output),
    cacheRead: sum(u => u.cacheRead),
    cacheWrite: sum(u => u.cacheWrite),
    totalTokens: sum(u => u.totalTokens),
    cost: {
      input: sum(u => u.cost.input),
      output: sum(u => u.cost.output),
      cacheRead: sum(u => u.cost.cacheRead),
      cacheWrite: sum(u => u.cost.cacheWrite),
      total: sum(u => u.cost.total),
    },
  });
}

/** Pi's stop reason in ACP's names; `undefined` for one ACP has no name for. */
function piStopReason(reason: StopReason): ProviderStopReason | undefined {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'aborted':
      return 'cancelled';
    default:
      // ACP has no name for it (e.g. `toolUse`); the native value stays in the log.
      getLog().debug({ stopReason: reason }, 'pi.stop_reason_unmapped');
      return undefined;
  }
}

/**
 * Build the terminal `result` chunk from every message the prompt produced.
 * Usage and cost are summed over all assistant messages plus `sideCalls`, the usage of
 * model calls that added no message (see sumPromptUsage); stopReason, model and error
 * come from the last assistant message. When the agent ended in error, the chunk
 * carries a typed `failure`.
 */
export function buildResultChunk(
  messages: readonly unknown[],
  sideCalls: readonly Usage[] = []
): ResultChunk {
  const assistants = messages.filter(isAssistantMessage);
  const last = assistants.at(-1);
  if (!last) {
    // agent_end fired with no assistant message in the transcript. This
    // shouldn't happen in healthy Pi runs — surface it as a loud error
    // rather than a silent success so orchestrators don't treat a broken
    // session as a clean completion.
    getLog().warn('pi.event-bridge.result_missing_assistant_message');
    return unknownFailureResult(
      'missing_assistant_message',
      'Pi ended the turn without an assistant message'
    );
  }

  const tokens = sumPromptUsage(assistants, sideCalls);
  const isError = last.stopReason === 'error' || last.stopReason === 'aborted';

  // Built by assignment on a typed value so a misspelled key fails to compile.
  // Unclassified: Pi folds a setup `ModelsError` into this message's text, so its
  // `code` never reaches Archon.
  const chunk: ResultChunk = isError
    ? unknownFailureResult(last.stopReason, last.errorMessage)
    : { type: 'result' };
  if (tokens) chunk.tokens = tokens;
  if (tokens?.cost !== undefined) chunk.cost = tokens.cost;
  const stopReason = piStopReason(last.stopReason);
  if (stopReason !== undefined) chunk.stopReason = stopReason;
  if (typeof last.responseModel === 'string' && last.responseModel.length > 0) {
    chunk.resolvedModel = { id: last.responseModel };
  }
  if (isError) {
    // Error chunks are yielded, not thrown: the failure and the turn's usage travel on
    // the same chunk.
    getLog().error(
      { stopReason: last.stopReason, errorMessage: last.errorMessage },
      'pi.result_chunk_error'
    );
  }
  return chunk;
}

// Structured-output parsing is shared across providers. Import once for local
// use and re-export so existing callers and tests keep their import path
// stable; new providers should import from `../../shared/structured-output`.
import { tryParseStructuredOutput } from '../../shared/structured-output';
export { tryParseStructuredOutput };

/**
 * Pure mapper from Pi's `AgentSessionEvent` → zero-or-more Archon `MessageChunk`s.
 *
 * Most Pi events map 1:1 or are skipped. Text and thinking deltas map to one chunk per
 * delta; `bridgeSession` coalesces them into whole blocks before yielding. Tool
 * execution is split across `tool_execution_start` / `tool_execution_end`, matched by
 * Pi's `toolCallId`.
 *
 * `agent_end` is not mapped here: its result chunk needs every message of the
 * prompt, which only `bridgeSession` holds.
 *
 * Events deliberately skipped:
 *  - turn_start / turn_end, message_start / message_end (redundant with deltas)
 *  - text_start / text_end / thinking_start / thinking_end (boundaries only)
 *  - queue_update (single-prompt sessions only)
 *  - auto_retry_end (retry_start communicates the retry sufficiently)
 */
export function mapPiEvent(event: AgentSessionEvent): MessageChunk[] {
  switch (event.type) {
    case 'message_update': {
      const amEvent = event.assistantMessageEvent;
      if (amEvent.type === 'text_delta' && amEvent.delta) {
        return [{ type: 'agent_message_chunk', text: amEvent.delta }];
      }
      if (amEvent.type === 'thinking_delta' && amEvent.delta) {
        return [{ type: 'agent_thought_chunk', text: amEvent.delta }];
      }
      return [];
    }
    case 'tool_execution_start': {
      const call: MessageChunk = {
        type: 'tool_call',
        toolCallId: event.toolCallId,
        name: event.toolName,
      };
      if (typeof event.args === 'object' && event.args !== null) {
        call.rawInput = event.args as Record<string, unknown>;
      }
      return [call];
    }
    case 'tool_execution_end':
      return [
        {
          type: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: event.isError ? 'failed' : 'completed',
          ...truncateToolOutput(serializeToolResult(event.result)),
        },
      ];
    case 'auto_retry_start':
      return [
        {
          type: 'warning',
          code: 'pi.auto_retry',
          message: `retry ${String(event.attempt)}/${String(event.maxAttempts)}: ${event.errorMessage}`,
        },
      ];
    case 'compaction_start':
      return [
        {
          type: 'compaction',
          phase: 'started',
          trigger: event.reason === 'manual' ? 'manual' : 'auto',
        },
      ];
    case 'compaction_end':
      // An aborted or failed compaction has no result; the session goes on uncompacted.
      return event.result
        ? [
            {
              type: 'compaction',
              phase: 'completed',
              trigger: event.reason === 'manual' ? 'manual' : 'auto',
              tokensBefore: event.result.tokensBefore,
            },
          ]
        : [];
    default:
      return [];
  }
}

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

/**
 * Bridge a Pi `AgentSession` into Archon's `AsyncGenerator<MessageChunk>` contract.
 *
 * Behavior:
 *  - subscribe before calling prompt, unsubscribe in finally
 *  - yield mapped events in order
 *  - complete on successful `session.prompt()` resolution
 *  - throw on `session.prompt()` rejection, listener errors, or attributed extension errors
 *  - forward `abortSignal` to `session.abort()` fire-and-forget
 *  - always `dispose()` the session to avoid listener accumulation
 */
export async function* bridgeSession(
  session: AgentSession,
  prompt: string,
  abortSignal?: AbortSignal,
  jsonSchema?: Record<string, unknown>,
  uiBridge?: BridgeNotifier,
  extensionTurn?: PiExtensionTurn
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();

  // ── Text-block coalescing (#1814) ──────────────────────────────────────
  // Pi streams text and thinking as many tiny deltas (often a few characters
  // each). The contract's text events carry a whole block, so consecutive deltas
  // of one kind are coalesced and flushed only at natural boundaries (turn start,
  // block end, a switch between text and thinking, before any other chunk, and at
  // end-of-stream/error). `currentTurnText`/`assistantBuffer` still accumulate
  // every text delta, so streaming-tail detection and structured-output buffering
  // are unaffected.
  let pending: { type: 'agent_message_chunk' | 'agent_thought_chunk'; text: string } | undefined;
  const takePending = (): MessageChunk | undefined => {
    const block = pending;
    pending = undefined;
    return block;
  };
  const flushPending = (): void => {
    const block = takePending();
    if (block) queue.push({ kind: 'chunk', chunk: block });
  };
  const appendPending = (
    type: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string
  ): void => {
    if (pending?.type !== type) flushPending();
    if (pending) pending.text += text;
    else pending = { type, text };
  };

  uiBridge?.setEmitter(chunk => {
    // A notify() warning must surface immediately and in order, so drain any
    // buffered text ahead of it.
    flushPending();
    queue.push({ kind: 'chunk', chunk });
  });
  // Best-effort structured-output buffer. Only accumulates when the caller
  // requested a JSON schema; otherwise stays empty and the terminal chunk
  // passes through untouched.
  const wantsStructured = jsonSchema !== undefined;
  let assistantBuffer = '';
  // Track text streamed via text_delta for the current assistant turn.
  // Reset at each turn_start so only a run's final turn is compared against
  // the assembled text on its agent_end (see streaming-tail completion below).
  let currentTurnText = '';
  // Every message this prompt produced. One prompt() can run Pi's agent loop more
  // than once (auto-retry after a retryable error, compact-and-continue after a
  // recoverable `length` stop or context overflow, queued follow-ups), and each run
  // ends with its own agent_end carrying only that run's new messages. The single
  // result chunk is emitted when prompt() resolves: a turn reports its outcome once,
  // so a result per agent_end would report an intermediate run as the outcome and
  // split the prompt's usage across several results.
  const promptMessages: unknown[] = [];
  // Usage of model calls that add no message, such as Pi's cache-warming refreshes.
  const promptSideCalls: Usage[] = [];
  let sawAgentEnd = false;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    try {
      if (event.type === 'turn_start') {
        // A new turn begins: the previous turn's text block is complete.
        flushPending();
        currentTurnText = '';
      }
      // Billed model calls that add no assistant message. Pi announces each one exactly
      // once: cache warming and hook-driven compaction as an appended entry (the SDK's
      // `SessionEntry` type decides which entries carry `usage`), its own auto and
      // manual compaction through `compaction_end`, whose entry is appended silently.
      if (event.type === 'entry_appended') {
        if ('usage' in event.entry && event.entry.usage) promptSideCalls.push(event.entry.usage);
        return;
      }
      if (event.type === 'compaction_end' && event.result?.usage) {
        promptSideCalls.push(event.result.usage);
      }
      if (event.type === 'agent_end') {
        // Streaming tail completion: Pi occasionally fails to flush the last
        // characters of an assistant turn as text_delta events, leaving them
        // present only in agent_end.messages. Detect the gap and emit the
        // missing suffix as a corrective assistant chunk so the orchestrator's
        // allMessages accumulator receives the full command text. Checked on
        // every agent_end: each loop run's final turn can have its own gap.
        // Condition: assembled text is strictly longer and starts with what was
        // streamed (an extension, not a replacement); no assistant message in
        // the transcript is treated as clean.
        // The tail joins the buffered prefix so the executor sees one text block,
        // not the prefix and the tail joined as two blocks.
        const assembled = extractLastAssistantText(event.messages);
        if (
          assembled !== undefined &&
          assembled.length > currentTurnText.length &&
          assembled.startsWith(currentTurnText)
        ) {
          const tail = assembled.slice(currentTurnText.length);
          appendPending('agent_message_chunk', tail);
          if (wantsStructured) assistantBuffer += tail;
          getLog().warn(
            {
              streamedLen: currentTurnText.length,
              assembledLen: assembled.length,
              tailLen: tail.length,
            },
            'pi.event-bridge.streaming_tail_completed'
          );
        }
        flushPending();
        currentTurnText = '';
        promptMessages.push(...event.messages);
        sawAgentEnd = true;
        return;
      }
      for (const chunk of mapPiEvent(event)) {
        if (chunk.type === 'agent_message_chunk') {
          // Coalesce char-level deltas; hold them until a boundary flush so the
          // executor receives one block-level chunk instead of dozens of tiny
          // ones. The accumulators below still observe every delta.
          currentTurnText += chunk.text;
          if (wantsStructured) assistantBuffer += chunk.text;
          appendPending(chunk.type, chunk.text);
        } else if (chunk.type === 'agent_thought_chunk') {
          appendPending(chunk.type, chunk.text);
        } else {
          // Any other chunk is a boundary: drain buffered text first so ordering
          // is preserved.
          flushPending();
          queue.push({ kind: 'chunk', chunk });
        }
      }
      // A completed block flushes promptly so stream-mode consumers see each
      // block as it finishes rather than waiting for the terminal result.
      if (
        event.type === 'message_update' &&
        (event.assistantMessageEvent.type === 'text_end' ||
          event.assistantMessageEvent.type === 'thinking_end')
      ) {
        flushPending();
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

  let extensionFailed = false;
  const unsubscribeExtensionError = extensionTurn?.onError(error => {
    extensionFailed = true;
    flushPending();
    queue.push({ kind: 'error', error });
    onAbort();
  });

  const promptPromise =
    extensionFailed || abortSignal?.aborted
      ? Promise.resolve()
      : session.prompt(prompt).then(
          () => {
            if (sawAgentEnd) {
              flushPending();
              queue.push({
                kind: 'chunk',
                chunk: buildResultChunk(promptMessages, promptSideCalls),
              });
            }
            queue.push({ kind: 'done' });
          },
          (err: unknown) => {
            queue.push({ kind: 'error', error: err as Error });
          }
        );

  try {
    // An aborted caller may have walked away with a next() still pending. Yielding to
    // it would park this generator for good and skip the cleanup below, so end by throwing.
    if (abortSignal?.aborted) throw new Error('Query aborted');
    for await (const item of queue) {
      if (abortSignal?.aborted) throw new Error('Query aborted');
      if (item.kind === 'done') {
        extensionTurn?.throwIfFailed();
        extensionTurn?.stopAccepting();
        // Buffered text is flushed ahead of the result chunk when an agent_end
        // was seen; a prompt that resolved without one can still strand text.
        const stranded = takePending();
        if (stranded) yield stranded;
        return;
      }
      if (item.kind === 'error') {
        // Preserve partial output: emit whatever text was buffered before the
        // failure so it still reaches the user instead of being discarded.
        const stranded = takePending();
        if (stranded) yield stranded;
        throw item.error;
      }
      // Annotate the terminal result chunk with Pi's session UUID so Archon's
      // orchestrator can pass it back as `resumeSessionId` on the next call.
      // Pi's session.sessionId is always a UUID (even for in-memory); we emit
      // it unconditionally and let the caller decide whether resume is
      // meaningful (capability-gated at the registry level).
      if (item.chunk.type === 'result') {
        extensionTurn?.throwIfFailed();
        extensionTurn?.stopAccepting();
        // The chunk was built for this turn by buildResultChunk; annotate it in place.
        const terminal = item.chunk;
        if (session.sessionId) terminal.sessionId = session.sessionId;
        // Best-effort structured output: parse the accumulated assistant
        // transcript as JSON and attach. On parse failure, leave it off —
        // the dag-executor's existing dag.structured_output_missing path
        // warns and downstream $node.output.field refs degrade to '' instead
        // of propagating bogus data.
        if (wantsStructured) {
          const parsed = tryParseStructuredOutput(assistantBuffer);
          if (parsed !== undefined) {
            terminal.structuredOutput = parsed;
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
    unsubscribeExtensionError?.();
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
    // Don't await promptPromise. The queue is closed above (line 392), and the
    // .then() handlers attached at construction (line 344) only push to that
    // queue — closed pushes are no-ops. There's nothing the caller is waiting
    // for; whether prompt() resolves in 1ms or never, no observable behavior
    // changes. Awaiting it is what caused #1561: Pi's session.prompt() can
    // hang indefinitely after dispose(), keeping generator.return() suspended,
    // draining Bun's event loop, and exiting with code 0 mid-workflow.
    //
    // Attach .catch() defensively so a stray async rejection (the .then()
    // handlers should preclude this, but belt-and-suspenders) doesn't bubble
    // up as an unhandled-rejection process exit.
    promptPromise.catch((err: unknown) => {
      getLog().debug({ err }, 'pi.event-bridge.prompt_rejected_after_close');
    });
  }
}
