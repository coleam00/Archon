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

/**
 * Framework-emitted messages carry a `category` in their metadata identifying
 * what they are (e.g. `workflow_dispatch_status` for the rocket-emoji
 * dispatch line, `workflow_status` for "starting workflow" prose). These
 * read as system chatter — the SDK / orchestrator narrating, not the agent
 * itself — and are hidden by default, surfaced as compact rows under the
 * System toggle.
 */
const SYSTEM_CATEGORY_PREFIXES = ['workflow_', 'system_'] as const;

export function isSystemCategory(category: string | null): boolean {
  if (category === null) return false;
  return SYSTEM_CATEGORY_PREFIXES.some(p => category.startsWith(p));
}

/**
 * An attachment recorded on a message. The server persists name, MIME type and
 * size when the upload is saved, deliberately omitting the on-disk path — the
 * file is deleted once the agent has read it, so there is nothing to link to.
 */
export interface MessageFile {
  name: string;
  mimeType: string;
  size: number;
}

export interface WorkflowDispatchMeta {
  workflowName: string;
  workerConversationId?: string;
}

/** Completion metadata on a `workflow_result` message — identifies the finished run. */
export interface WorkflowResultMeta {
  workflowName: string;
  runId: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  toolCalls: InlineToolCall[];
  error: InlineError | null;
  /** Framework category from metadata (e.g. workflow_dispatch_status, workflow_result). */
  category: string | null;
  /** Parsed workflowDispatch payload, if present on this message. */
  dispatch: WorkflowDispatchMeta | null;
  /** Parsed workflowResult payload — present on `workflow_result` messages. */
  workflowResult: WorkflowResultMeta | null;
  /** Attachments sent with this message. Empty when there were none. */
  files: MessageFile[];
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
  category?: string;
  workflowDispatch?: {
    workflowName: string;
    workerConversationId?: string;
  };
  // Untrusted/raw shape straight from JSON.parse — stays inline (rather than
  // reusing WorkflowResultMeta) because toMessage validates it before producing
  // the domain value. Runtime may hand us null or wrong-typed fields regardless
  // of this annotation; the guard in toMessage is what enforces the contract.
  workflowResult?: {
    workflowName: string;
    runId: string;
  };
  // Written by the server when an upload is saved. Same untrusted-shape caveat
  // as workflowResult: toMessage validates before producing domain values.
  files?: { name: string; mimeType: string; size: number }[];
}

function parseMetadata(raw: string): ParsedMetadata {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as ParsedMetadata;
  } catch (e) {
    // Corrupt metadata degrades to "no metadata" (the message still renders as
    // plain prose) — but never silently: a malformed blob here is the kind of
    // thing that would otherwise hide a real workflow_result with no trace.
    console.warn('[console] failed to parse message metadata; treating as empty', {
      error: e,
      raw: raw.slice(0, 200),
    });
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
  const dispatch: WorkflowDispatchMeta | null =
    meta.workflowDispatch !== undefined
      ? {
          workflowName: meta.workflowDispatch.workflowName,
          workerConversationId: meta.workflowDispatch.workerConversationId,
        }
      : null;
  // Only a fully-formed payload yields a result (the hard-failure orchestrator path
  // can omit it) — guard both fields so a partial object never half-renders a card.
  // `!= null` (not `!== undefined`) so an explicit JSON `null` doesn't slip past and
  // make the `typeof wr.workflowName` access throw.
  const wr = meta.workflowResult;
  const workflowResult: WorkflowResultMeta | null =
    wr != null && typeof wr.workflowName === 'string' && typeof wr.runId === 'string'
      ? { workflowName: wr.workflowName, runId: wr.runId }
      : null;
  // Drop entries missing a usable name or size rather than rendering a chip
  // labelled `undefined`. A non-numeric size degrades to 0, which formatBytes
  // renders as `0 B` — a wrong size is better than losing the attachment.
  // Array.isArray, not `?? []`: parseMetadata casts JSON.parse output without
  // validating it, so a metadata blob carrying a non-array `files` would reach
  // .filter and throw — taking the whole message history's render down with it.
  const files: MessageFile[] = (Array.isArray(meta.files) ? meta.files : [])
    .filter(
      (f): f is { name: string; mimeType: string; size: number } =>
        f != null && typeof f.name === 'string' && f.name.length > 0
    )
    .map(f => ({
      name: f.name,
      mimeType: typeof f.mimeType === 'string' ? f.mimeType : '',
      size: typeof f.size === 'number' ? f.size : 0,
    }));
  return {
    id: raw.id,
    role: toMessageRole(raw.role),
    content: raw.content,
    timestamp: raw.created_at,
    toolCalls,
    error,
    category: meta.category ?? null,
    dispatch,
    workflowResult,
    files,
  };
}
