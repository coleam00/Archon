import type { MessageChunk, TokenUsage } from '../../types';

/**
 * Map one Grok stdout line to Archon MessageChunk(s).
 *
 * Primary: `--output-format streaming-json` (`type`-tagged NDJSON).
 * Fallback: `--output-format json` (a single object with `text`/`sessionId`)
 * in case `--json-schema` wins the format race.
 * Unknown streaming types are ignored (Grok's event list is non-exhaustive).
 */
export function parseGrokOutput(line: string): MessageChunk[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('grok_stream_json_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('grok_stream_json_invalid');
  }
  const row = parsed as Record<string, unknown>;
  const streaming = parseStreamingRow(row);
  if (streaming) return [streaming];
  return parseJsonDocument(row);
}

/** @deprecated Prefer {@link parseGrokOutput}. Kept for tests that assert one chunk. */
export function parseGrokStreamingLine(line: string): MessageChunk | undefined {
  const chunks = parseGrokOutput(line);
  return chunks[0];
}

function parseStreamingRow(row: Record<string, unknown>): MessageChunk | undefined {
  const type = row.type;
  if (type === 'text' && typeof row.data === 'string') {
    return { type: 'assistant', content: row.data };
  }
  if (type === 'thought' && typeof row.data === 'string') {
    return { type: 'thinking', content: row.data };
  }
  if (type === 'tool_call') {
    return {
      type: 'tool',
      toolName: typeof row.toolName === 'string' ? row.toolName : 'unknown',
      ...(typeof row.toolCallId === 'string' ? { toolCallId: row.toolCallId } : {}),
      ...(isRecord(row.rawInput) ? { toolInput: row.rawInput } : {}),
    };
  }
  if (type === 'tool_call_update') {
    return {
      type: 'tool_result',
      toolName: typeof row.toolName === 'string' ? row.toolName : 'unknown',
      toolOutput: stringifyUnknown(row.rawOutput ?? row.content ?? ''),
      ...(typeof row.toolCallId === 'string' ? { toolCallId: row.toolCallId } : {}),
      toolOutcome:
        row.status === 'completed' ? 'success' : row.status === 'failed' ? 'error' : 'unknown',
    };
  }
  if (type === 'end') {
    return resultFrom(row);
  }
  if (type === 'error') {
    return {
      type: 'result',
      isError: true,
      errors: [typeof row.message === 'string' ? row.message : 'grok_stream_error'],
      ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}),
      ...(usageFrom(row.usage) ? { tokens: usageFrom(row.usage) } : {}),
    };
  }
  return undefined;
}

function parseJsonDocument(row: Record<string, unknown>): MessageChunk[] {
  if (row.type !== undefined) return [];
  const hasText = typeof row.text === 'string';
  const hasSession = typeof row.sessionId === 'string';
  if (!hasText && !hasSession) return [];
  const chunks: MessageChunk[] = [];
  if (hasText && row.text) {
    chunks.push({ type: 'assistant', content: row.text as string });
  }
  chunks.push(resultFrom(row));
  return chunks;
}

function resultFrom(row: Record<string, unknown>): Extract<MessageChunk, { type: 'result' }> {
  return {
    type: 'result',
    ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}),
    ...(typeof row.stopReason === 'string' ? { stopReason: row.stopReason } : {}),
    ...(typeof row.num_turns === 'number' ? { numTurns: row.num_turns } : {}),
    ...(usageFrom(row.usage) ? { tokens: usageFrom(row.usage) } : {}),
  };
}

function usageFrom(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const tokens: TokenUsage = { input, output };
  if (typeof value.cache_read_input_tokens === 'number') {
    tokens.cacheRead = value.cache_read_input_tokens;
  }
  if (typeof value.cache_creation_input_tokens === 'number') {
    tokens.cacheWrite = value.cache_creation_input_tokens;
  }
  return tokens;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
