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
