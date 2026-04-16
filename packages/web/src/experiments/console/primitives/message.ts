/**
 * Conversation message primitive. Runs have both `workflow_events` (structured)
 * and chat `messages` (the AI's and user's text). The Run detail page merges
 * both into a single timeline keyed by timestamp.
 */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface InlineToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  durationMs?: number;
}

export interface InlineError {
  message: string;
  classification?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  toolCalls: InlineToolCall[];
  error: InlineError | null;
}

interface RawMessage {
  id: string;
  role: string;
  content: string;
  metadata: string;
  created_at: string;
}

interface ParsedMetadata {
  error?: { message: string; classification?: string };
  toolCalls?: {
    name: string;
    input?: Record<string, unknown>;
    output?: string;
    duration?: number;
  }[];
}

function parseMetadata(raw: string): ParsedMetadata {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as ParsedMetadata;
  } catch {
    return {};
  }
}

function toMessageRole(s: string): MessageRole {
  if (s === 'user' || s === 'assistant' || s === 'system') return s;
  return 'assistant';
}

export function toMessage(raw: RawMessage): Message {
  const meta = parseMetadata(raw.metadata);
  const toolCalls: InlineToolCall[] = (meta.toolCalls ?? []).map(tc => ({
    name: tc.name,
    input: tc.input ?? {},
    output: tc.output,
    durationMs: tc.duration,
  }));
  const error: InlineError | null =
    meta.error !== undefined
      ? {
          message: meta.error.message,
          classification: meta.error.classification,
        }
      : null;
  return {
    id: raw.id,
    role: toMessageRole(raw.role),
    content: raw.content,
    timestamp: raw.created_at,
    toolCalls,
    error,
  };
}
