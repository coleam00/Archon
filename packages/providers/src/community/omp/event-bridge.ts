import { createLogger } from '@archon/paths';
import type { OmpSession } from './sdk-loader';

import { AsyncQueue } from '../async-queue';
import type { MessageChunk, TokenUsage } from '../../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp.event-bridge');
  return cachedLog;
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    const json = JSON.stringify(result);
    return json === undefined ? String(result) : json;
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

interface ToolCallIdField {
  toolCallId?: string;
}

function toolCallIdField(toolCallId: unknown): ToolCallIdField {
  return typeof toolCallId === 'string' ? { toolCallId } : {};
}

function parseToolInput(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function mapMessageUpdate(event: Record<string, unknown>): MessageChunk[] {
  const update = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
  if (update?.type === 'text_delta' && typeof update.delta === 'string') {
    return [{ type: 'assistant', content: update.delta }];
  }
  if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
    return [{ type: 'thinking', content: update.delta }];
  }
  return [];
}

function mapToolExecutionStart(event: Record<string, unknown>): MessageChunk[] {
  return [
    {
      type: 'tool',
      toolName: String(event.toolName),
      toolInput: parseToolInput(event.args),
      ...toolCallIdField(event.toolCallId),
    },
  ];
}

function mapToolExecutionEnd(event: Record<string, unknown>): MessageChunk[] {
  const toolName = String(event.toolName);
  const chunks: MessageChunk[] = [];
  if (event.isError === true) {
    chunks.push({ type: 'system', content: `⚠️ Tool ${toolName} failed` });
  }
  chunks.push({
    type: 'tool_result',
    toolName,
    toolOutput: serializeToolResult(event.result),
    ...toolCallIdField(event.toolCallId),
  });
  return chunks;
}

function retryAttemptLabel(attempt: unknown, maxAttempts?: unknown): string {
  const current = typeof attempt === 'number' ? String(attempt) : '?';
  return typeof maxAttempts === 'number' ? `${current}/${maxAttempts}` : current;
}

function mapAutoRetryStart(event: Record<string, unknown>): MessageChunk[] {
  return [
    {
      type: 'system',
      content: `⚠️ retry ${retryAttemptLabel(event.attempt, event.maxAttempts)}: ${typeof event.errorMessage === 'string' ? event.errorMessage : 'request failed'}`,
    },
  ];
}

function mapAutoRetryEnd(event: Record<string, unknown>): MessageChunk[] {
  const attempt = retryAttemptLabel(event.attempt);
  return [
    {
      type: 'system',
      content:
        event.success === true
          ? `✓ retry ${attempt} succeeded`
          : `⚠️ retry ${attempt} failed: ${typeof event.finalError === 'string' ? event.finalError : 'request failed'}`,
    },
  ];
}

function mapRetryFallbackApplied(event: Record<string, unknown>): MessageChunk[] {
  const role = typeof event.role === 'string' ? ` for ${event.role}` : '';
  const from = typeof event.from === 'string' ? event.from : 'unknown';
  const to = typeof event.to === 'string' ? event.to : 'unknown';
  return [{ type: 'system', content: `⚠️ OMP retry fallback applied${role}: ${from} → ${to}` }];
}

function mapRetryFallbackSucceeded(event: Record<string, unknown>): MessageChunk[] {
  const role = typeof event.role === 'string' ? ` for ${event.role}` : '';
  const model = typeof event.model === 'string' ? event.model : 'unknown';
  return [{ type: 'system', content: `✓ OMP retry fallback succeeded${role}: ${model}` }];
}

function mapAutoCompactionStart(event: Record<string, unknown>): MessageChunk[] {
  const reason = typeof event.reason === 'string' ? event.reason : 'unknown';
  const action = typeof event.action === 'string' ? event.action : 'unknown';
  return [{ type: 'system', content: `⚠️ OMP auto-compaction started (${reason}, ${action}).` }];
}

function mapAutoCompactionEnd(event: Record<string, unknown>): MessageChunk[] {
  if (event.skipped === true) return [];
  if (event.aborted === true) {
    const suffix = typeof event.errorMessage === 'string' ? `: ${event.errorMessage}` : '';
    return [{ type: 'system', content: `⚠️ OMP auto-compaction aborted${suffix}` }];
  }

  const action = typeof event.action === 'string' ? event.action : 'unknown';
  return [{ type: 'system', content: `✓ OMP auto-compaction completed (${action}).` }];
}

export function mapOmpEvent(event: { type?: string } & Record<string, unknown>): MessageChunk[] {
  switch (event.type) {
    case 'message_update':
      return mapMessageUpdate(event);
    case 'tool_execution_start':
      return mapToolExecutionStart(event);
    case 'tool_execution_end':
      return mapToolExecutionEnd(event);
    case 'agent_end':
      return [buildResultChunk((event.messages as unknown[] | undefined) ?? [])];
    case 'auto_retry_start':
      return mapAutoRetryStart(event);
    case 'auto_retry_end':
      return mapAutoRetryEnd(event);
    case 'retry_fallback_applied':
      return mapRetryFallbackApplied(event);
    case 'retry_fallback_succeeded':
      return mapRetryFallbackSucceeded(event);
    case 'auto_compaction_start':
      return mapAutoCompactionStart(event);
    case 'auto_compaction_end':
      return mapAutoCompactionEnd(event);
    default:
      return [];
  }
}

export interface BridgeNotifier {
  setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void;
}

type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: Error };

type ResultChunk = Extract<MessageChunk, { type: 'result' }>;

function attachResultMetadata(
  chunk: ResultChunk,
  session: OmpSession,
  wantsStructured: boolean,
  assistantBuffer: string
): ResultChunk {
  let terminal = chunk;

  const sessionId = session.sessionId;
  if (sessionId) terminal = { ...terminal, sessionId };

  if (!wantsStructured) return terminal;

  const parsed = tryParseStructuredOutput(assistantBuffer);
  if (parsed !== undefined) return { ...terminal, structuredOutput: parsed };

  getLog().warn({ bufferLength: assistantBuffer.length }, 'omp.structured_parse_failed');
  return terminal;
}

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
        yield attachResultMetadata(item.chunk, session, wantsStructured, assistantBuffer);
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
