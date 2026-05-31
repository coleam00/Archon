/**
 * Event bridge between @cursor/sdk stream events and Archon's MessageChunk contract.
 *
 * Module-scope invariant: type-only imports from @cursor/sdk. Value imports happen
 * inside `CursorProvider.sendQuery()` via dynamic import.
 */
import { createLogger } from '@archon/paths';
import type { Run, SDKMessage } from '@cursor/sdk';

import type { MessageChunk, TokenUsage } from '../../types';
import { tryParseStructuredOutput } from '../../shared/structured-output';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.cursor.event-bridge');
  return cachedLog;
}

function serializeToolPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Pure translation: one SDKMessage → zero or more MessageChunks.
 */
export function mapCursorMessage(event: SDKMessage): MessageChunk[] {
  switch (event.type) {
    case 'assistant': {
      const chunks: MessageChunk[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text.length > 0) {
          chunks.push({ type: 'assistant', content: block.text });
        } else if (block.type === 'tool_use') {
          chunks.push({
            type: 'tool',
            toolName: block.name,
            toolInput: toolInputRecord(block.input),
            toolCallId: block.id,
          });
        }
      }
      return chunks;
    }
    case 'thinking':
      return event.text.length > 0 ? [{ type: 'thinking', content: event.text }] : [];
    case 'tool_call': {
      if (event.status === 'running') {
        return [
          {
            type: 'tool',
            toolName: event.name,
            toolInput: toolInputRecord(event.args),
            toolCallId: event.call_id,
          },
        ];
      }
      if (event.status === 'completed' || event.status === 'error') {
        const output = serializeToolPayload(event.result);
        return [
          {
            type: 'tool_result',
            toolName: event.name,
            toolOutput: event.status === 'error' ? `❌ ${output}` : output,
            toolCallId: event.call_id,
          },
        ];
      }
      return [];
    }
    case 'system':
      return [{ type: 'system', content: 'Cursor agent session initialized' }];
    case 'status': {
      const suffix = event.message ? `: ${event.message}` : '';
      return [{ type: 'system', content: `Cursor status ${event.status}${suffix}` }];
    }
    case 'task':
      return event.text ? [{ type: 'system', content: event.text }] : [];
    default:
      getLog().debug(
        { eventType: (event as { type?: string }).type },
        'cursor.unhandled_event_type'
      );
      return [];
  }
}

function toStreamError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error('Cursor stream failed');
}

/**
 * Bridge a Cursor SDK Run into Archon MessageChunks.
 * Consumes `run.stream()`, then `run.wait()` for the terminal result.
 */
export async function* bridgeRun(
  run: Run,
  agentId: string,
  abortSignal?: AbortSignal,
  jsonSchema?: Record<string, unknown>
): AsyncGenerator<MessageChunk> {
  const log = getLog();
  const wantsStructured = jsonSchema !== undefined;
  let assistantBuffer = '';

  const onAbort = (): void => {
    if (run.supports('cancel')) {
      void run.cancel().catch(err => {
        log.debug({ err, runId: run.id }, 'cursor.cancel_failed');
      });
    }
  };

  if (abortSignal?.aborted) {
    throw new DOMException('Cursor sendQuery aborted before start', 'AbortError');
  }
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    let streamError: unknown;
    try {
      for await (const event of run.stream()) {
        for (const chunk of mapCursorMessage(event)) {
          if (wantsStructured && chunk.type === 'assistant') {
            assistantBuffer += chunk.content;
          }
          yield chunk;
        }
      }
    } catch (err) {
      streamError = err;
      log.warn({ err, runId: run.id, agentId }, 'cursor.stream_error');
    }

    const runResult = await run.wait();
    const resultChunk: MessageChunk = {
      type: 'result',
      sessionId: agentId,
    };

    if (runResult.status === 'error' || runResult.status === 'cancelled') {
      resultChunk.isError = true;
      resultChunk.errorSubtype = runResult.status;
      if (runResult.result) {
        resultChunk.errors = [runResult.result];
      }
    }

    if (wantsStructured) {
      const text = assistantBuffer || runResult.result || '';
      const parsed = tryParseStructuredOutput(text);
      if (parsed !== undefined) {
        resultChunk.structuredOutput = parsed;
      } else if (text.length > 0) {
        log.warn({ bufferLength: text.length, agentId }, 'cursor.structured_output_parse_failed');
      }
    }

    if (
      streamError !== undefined &&
      runResult.status !== 'finished' &&
      assistantBuffer.length === 0
    ) {
      throw toStreamError(streamError);
    }

    yield resultChunk;
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

/** @internal Test helper — normalize token usage from stream deltas when wired. */
export function usageFromTurnEnded(usage?: {
  inputTokens: number;
  outputTokens: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.inputTokens + usage.outputTokens,
  };
}
