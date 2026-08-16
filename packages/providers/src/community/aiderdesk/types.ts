/**
 * AiderDesk API type definitions.
 *
 * These types mirror the REST API shapes returned by AiderDesk's backend
 * (localhost:24337). They are hand-written from the reverse-engineered MCP
 * server bundle (@aiderdesk/mcp-server v0.2.0) — there is no public OpenAPI
 * spec from AiderDesk's backend.
 *
 * @archon/providers is the contract layer; these types are provider-internal
 * and NOT re-exported through @archon/providers/types.
 */

/** Task state as reported by AiderDesk. Terminal states are the completion signal. */
export type AiderDeskTaskState =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'MORE_INFO_NEEDED'
  | 'READY_FOR_REVIEW'
  | 'DONE'
  | 'INTERRUPTED'
  | 'DELEGATED'
  | 'READY_FOR_IMPLEMENTATION';

/** Run mode passed to the /api/run-prompt endpoint. */
export type AiderDeskRunMode = 'code' | 'ask' | 'architect' | 'context' | 'agent';

/** Terminal task states — when the task reaches one of these, polling stops. */
export const TERMINAL_TASK_STATES: ReadonlySet<AiderDeskTaskState> = new Set([
  'READY_FOR_REVIEW',
  'DONE',
  'INTERRUPTED',
  'DELEGATED',
  'READY_FOR_IMPLEMENTATION',
]);

/** A message in an AiderDesk task conversation. */
export interface AiderDeskMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  usageReport?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
  };
}

/** A context file attached to an AiderDesk task. */
export interface AiderDeskContextFile {
  path: string;
  readOnly: boolean;
}

/** A model reported by GET /api/models. */
export interface AiderDeskModel {
  id: string;
  providerId: string;
}

/** A provider reported by GET /api/providers. */
export interface AiderDeskProvider {
  id: string;
  name: string;
  disabled: boolean;
}

/** A task in AiderDesk — the unit of work that holds a conversation and context. */
export interface AiderDeskTask {
  id: string;
  name: string;
  state: AiderDeskTaskState;
  workingMode: 'local' | 'worktree';
  currentMode: string;
  mainModel: string | null;
  provider: string | null;
  model: string | null;
  agentProfileId: string | null;
  reasoningEffort: string | null;
  thinkingTokens: string | null;
  parentId: string | null;
  archived: boolean;
  baseDir: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  interruptedAt: string | null;
  aiderTotalCost: number;
  agentTotalCost: number;
  lastAgentProviderMetadata: unknown;
}

/** Full task with conversation data — returned by POST /api/project/tasks/load. */
export interface AiderDeskTaskFull extends AiderDeskTask {
  messages: AiderDeskMessage[];
  files: AiderDeskContextFile[];
  todoItems: unknown[];
  question: string | null;
}

/** Health check response from GET /api/health. */
export interface AiderDeskHealth {
  status: string;
}

/** Response from GET /api/models. */
export interface AiderDeskModelsResponse {
  models: AiderDeskModel[];
}

/** Model info for Archon's model catalog surface. */
export interface AiderDeskModelInfo {
  /** Model id (e.g. 'qwen3-coder:30b'). */
  id: string;
  /** Provider id (e.g. 'ollama'). */
  providerId: string;
  /** Combined ref in 'provider/model' format (e.g. 'ollama/qwen3-coder:30b'). */
  ref: string;
}

/**
 * An AiderDesk agent profile returned by GET /api/agent-profiles.
 *
 * Minimal shape — only fields the dual-bind resolver needs to pick an
 * agent given a `(providerId, modelId)` pair. The full AiderDesk profile
 * surface includes systemPrompt, toolApprovals, enabledMcpServers, etc.;
 * we do not type those here because the resolver only reads `id`, `name`,
 * `provider`, `model`, and `ruleFiles`.
 */
export interface AiderDeskProfile {
  /** AiderDesk agent UUID (the field bound into `AiderDeskTaskUpdate.agentProfileId`). */
  id: string;
  /** Human-readable agent name (e.g. 'Poe', 'Inspector', 'Codenomicron'). */
  name: string;
  /** Provider the agent invokes (e.g. 'poe', 'ollama'). */
  provider: string;
  /** Model id within that provider (e.g. 'minimax-m3'). */
  model: string;
  /**
   * Rules files attached to the agent. Empty array on agents without a
   * `rules/` directory; non-empty on agents like Poe/Inspector that load
   * Archon-specific rules. The resolver uses presence (`length > 0`) as
   * the deterministic tiebreaker when discriminating agents that share
   * the same `provider+model`.
   */
  ruleFiles?: string[];
}

// ─── SSE event shapes — POST /api/run-prompt with Accept: text/event-stream ────────
//
// Per the docs at aiderdesk.hotovo.com/docs/features/rest-api, run-prompt supports
// Server-Sent Events when negotiated via Accept: text/event-stream. The stream
// starts once and ends with a `stream-end` event.
//
// Verified against live AiderDesk on /home/lfontanez/dev/archon-v2 (host :24337):
// the actual stream emits events in approximately this order:
//   user-message → log (optional) → task-updated (0..n) → response-chunk(*)
//   → response-completed → stream-end.
// Tool events can interleave between response-chunks when AiderDesk's agent
// uses bash/read/edit. ask-question is rare but emitted when the agent requires
// explicit human input.

/**
 * A single SSE event parsed from /api/run-prompt.
 */
export type AiderDeskSseEvent =
  | { kind: 'user-message'; taskId: string; baseDir: string; content: string }
  | {
      kind: 'log';
      taskId: string;
      baseDir: string;
      level: string;
      message?: string;
      finished: boolean;
    }
  | { kind: 'task-updated'; task: AiderDeskTask }
  | {
      kind: 'response-chunk';
      taskId: string;
      messageId: string;
      chunk: string;
      reasoning?: string;
    }
  | {
      kind: 'response-completed';
      taskId: string;
      messageId: string;
      content: string;
      reasoning?: string;
    }
  | {
      kind: 'tool';
      taskId: string;
      messageId?: string;
      toolName: string;
      finished: boolean;
      result?: string;
    }
  | { kind: 'ask-question'; taskId: string; question: string; options?: string[] }
  | { kind: 'stream-end' }
  | { kind: 'unknown'; eventName: string; payload: unknown };

/**
 * Payload accepted by POST /api/project/tasks. The endpoint accepts a partial
 * TaskData object as `updates`, plus the projectDir + id of the task to mutate.
 * Documented as the supported way to bind `mainModel`, `currentMode`,
 * `workingMode`, `agentProfileId`, and other task-level fields.
 *
 * Critically: this is required to bind a model to a fresh task before
 * run-prompt, because `/api/project/tasks/new` returns a task that resolves
 * its agent from project defaults (which may not match the requested model
 * — claude 401 fallback observed on the live host).
 */
export interface AiderDeskTaskUpdate {
  /** Model ref to bind to the task (e.g. 'poe/minimax-m3'). */
  mainModel?: string;
  /** Aider mode (e.g. 'agent', 'code', 'ask'). */
  currentMode?: string;
  /** local | worktree. */
  workingMode?: 'local' | 'worktree';
  /** AiderDesk agent profile UUID. Optional — AiderDesk auto-binds by mainModel. */
  agentProfileId?: string | null;
  /** When true, activate the task so other APIs resolve it as the active one. */
  activate?: boolean;
  /** Display name shown in AiderDesk UI. */
  name?: string;
}
