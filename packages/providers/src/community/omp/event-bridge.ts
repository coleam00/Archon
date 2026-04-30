import { createLogger } from '@archon/paths';
import type { OmpSession } from './sdk-loader';

import type { MessageChunk, TokenUsage } from '../../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp.event-bridge');
  return cachedLog;
}

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
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error('AsyncQueue: a single queue can only be iterated once.');
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

export function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function readUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as {
    input?: unknown;
    output?: unknown;
    totalTokens?: unknown;
    cost?: { total?: unknown };
  };
  if (typeof u.input !== 'number' || typeof u.output !== 'number') return undefined;
  return {
    input: u.input,
    output: u.output,
    ...(typeof u.totalTokens === 'number' ? { total: u.totalTokens } : {}),
    ...(typeof u.cost?.total === 'number' ? { cost: u.cost.total } : {}),
  };
}

function isAssistantMessage(
  message: unknown
): message is { role: 'assistant'; usage?: unknown; stopReason?: string } {
  return (
    !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant'
  );
}

export function buildResultChunk(messages: readonly unknown[]): MessageChunk {
  const last = [...messages].reverse().find(isAssistantMessage);
  if (!last) {
    getLog().warn('omp.event-bridge.result_missing_assistant_message');
    return { type: 'result', isError: true, errorSubtype: 'missing_assistant_message' };
  }

  const tokens = readUsage(last.usage);
  const isError = last.stopReason === 'error' || last.stopReason === 'aborted';
  return {
    type: 'result',
    ...(tokens ? { tokens } : {}),
    ...(tokens?.cost !== undefined ? { cost: tokens.cost } : {}),
    ...(last.stopReason ? { stopReason: last.stopReason } : {}),
    ...(isError ? { isError: true, errorSubtype: last.stopReason } : {}),
  };
}

export function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }

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

export function mapOmpEvent(event: { type?: string } & Record<string, unknown>): MessageChunk[] {
  switch (event.type) {
    case 'message_update': {
      const update = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
        .assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        return [{ type: 'assistant', content: update.delta }];
      }
      if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
        return [{ type: 'thinking', content: update.delta }];
      }
      return [];
    }
    case 'tool_execution_start': {
      const toolEvent = event as {
        toolName: string;
        args?: unknown;
        toolCallId?: string;
      };
      return [
        {
          type: 'tool',
          toolName: toolEvent.toolName,
          toolInput:
            typeof toolEvent.args === 'object' && toolEvent.args !== null
              ? (toolEvent.args as Record<string, unknown>)
              : {},
          ...(toolEvent.toolCallId ? { toolCallId: toolEvent.toolCallId } : {}),
        },
      ];
    }
    case 'tool_execution_end': {
      const toolEvent = event as {
        toolName: string;
        result?: unknown;
        isError?: boolean;
        toolCallId?: string;
      };
      const chunks: MessageChunk[] = [];
      if (toolEvent.isError) {
        chunks.push({ type: 'system', content: `⚠️ Tool ${toolEvent.toolName} failed` });
      }
      chunks.push({
        type: 'tool_result',
        toolName: toolEvent.toolName,
        toolOutput: serializeToolResult(toolEvent.result),
        ...(toolEvent.toolCallId ? { toolCallId: toolEvent.toolCallId } : {}),
      });
      return chunks;
    }
    case 'agent_end':
      return [buildResultChunk((event as { messages?: unknown[] }).messages ?? [])];
    case 'auto_retry_start': {
      const retry = event as { attempt?: number; maxAttempts?: number; errorMessage?: string };
      return [
        {
          type: 'system',
          content: `⚠️ retry ${retry.attempt ?? '?'}${retry.maxAttempts ? `/${retry.maxAttempts}` : ''}: ${retry.errorMessage ?? 'request failed'}`,
        },
      ];
    }
    default:
      return [];
  }
}

export interface BridgeNotifier {
  setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void;
}

export type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

export async function* bridgeSession(
  session: OmpSession,
  prompt: string,
  abortSignal?: AbortSignal,
  jsonSchema?: Record<string, unknown>,
  uiBridge?: BridgeNotifier
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();
  const wantsStructured = jsonSchema !== undefined;
  let assistantBuffer = '';

  uiBridge?.setEmitter(chunk => {
    queue.push({ kind: 'chunk', chunk });
  });

  const unsubscribe = session.subscribe((event: unknown) => {
    try {
      for (const chunk of mapOmpEvent(event as { type?: string } & Record<string, unknown>)) {
        if (wantsStructured && chunk.type === 'assistant') assistantBuffer += chunk.content;
        queue.push({ kind: 'chunk', chunk });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  const onAbort = (): void => {
    void session.abort().catch((err: unknown) => {
      getLog().debug({ err }, 'omp.event-bridge.abort_failed');
    });
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
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
      if (item.chunk.type === 'result') {
        let terminal: MessageChunk = item.chunk;
        const sessionId = session.sessionId;
        if (sessionId) terminal = { ...terminal, sessionId };
        if (wantsStructured) {
          const parsed = tryParseStructuredOutput(assistantBuffer);
          if (parsed !== undefined) terminal = { ...terminal, structuredOutput: parsed };
          else
            getLog().warn({ bufferLength: assistantBuffer.length }, 'omp.structured_parse_failed');
        }
        yield terminal;
      } else {
        yield item.chunk;
      }
    }
  } finally {
    queue.close();
    uiBridge?.setEmitter(undefined);
    unsubscribe();
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    session.dispose();
    await promptPromise.catch(() => undefined);
  }
}
