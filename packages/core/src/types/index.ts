/**
 * Core type definitions for the Remote Coding Agent platform
 */
import type { TransitionTrigger } from '../state/session-transitions';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { McpServerConfig, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Custom error for when a conversation is not found during update operations
 * Allows callers to programmatically handle this specific error case
 */
export class ConversationNotFoundError extends Error {
  constructor(public conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  isolation_env_id: string | null; // UUID FK to isolation_environments
  ai_assistant_type: string;
  title: string | null;
  hidden: boolean;
  deleted_at: Date | null;
  last_activity_at: Date | null; // For staleness detection
  created_at: Date;
  updated_at: Date;
}

import type { IsolationHints } from '@archon/isolation';

export interface AttachedFile {
  /** Absolute path on disk where the file was saved by the server */
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface HandleMessageContext {
  readonly issueContext?: string;
  readonly threadContext?: string;
  readonly parentConversationId?: string;
  readonly isolationHints?: IsolationHints;
  readonly attachedFiles?: AttachedFile[];
}

export interface Codebase {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
  ai_assistant_type: string;
  allow_env_keys: boolean;
  commands: Record<string, { path: string; description: string }>;
  created_at: Date;
  updated_at: Date;
}

export const sessionMetadataSchema = z
  .object({
    lastCommand: z.string().optional(),
  })
  .passthrough();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export interface Session {
  id: string;
  conversation_id: string;
  codebase_id: string | null;
  ai_assistant_type: string;
  assistant_session_id: string | null;
  active: boolean;
  metadata: SessionMetadata;
  started_at: Date;
  ended_at: Date | null;
  // Audit trail fields (added in migration 010)
  parent_session_id: string | null;
  transition_reason: TransitionTrigger | null;
  ended_reason: TransitionTrigger | null;
}

export interface CommandResult {
  success: boolean;
  message: string;
  modified?: boolean; // Indicates if conversation state was modified
  workflow?: {
    // If set, orchestrator should execute this workflow
    definition: WorkflowDefinition;
    args: string;
  };
}

/**
 * Generic platform adapter interface
 * Allows supporting multiple platforms (Telegram, Slack, GitHub, etc.)
 */
export interface MessageMetadata {
  category?:
    | 'tool_call_formatted'
    | 'workflow_status'
    | 'workflow_dispatch_status'
    | 'isolation_context'
    | 'workflow_result';
  segment?: 'new' | 'auto';
  workflowDispatch?: { workerConversationId: string; workflowName: string };
  workflowResult?: { workflowName: string; runId: string };
}

export interface IPlatformAdapter {
  /**
   * Send a message to the platform
   */
  sendMessage(conversationId: string, message: string, metadata?: MessageMetadata): Promise<void>;

  /**
   * Ensure responses go to a thread, creating one if needed.
   * Returns the thread's conversation ID to use for subsequent messages.
   *
   * @param originalConversationId - The conversation ID from the triggering message
   * @param messageContext - Platform-specific context (e.g., Discord Message, Slack event)
   * @returns Thread conversation ID (may be same as original if already in thread)
   */
  ensureThread(originalConversationId: string, messageContext?: unknown): Promise<string>;

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch';

  /**
   * Get the platform type identifier (e.g., 'telegram', 'github', 'slack')
   */
  getPlatformType(): string;

  /**
   * Start the platform adapter (e.g., begin polling, start webhook server)
   */
  start(): Promise<void>;

  /**
   * Stop the platform adapter gracefully
   */
  stop(): void;

  /**
   * Optional: Send a structured event (MessageChunk) to the platform.
   * Only implemented by adapters that can display rich structured data (e.g., Web UI).
   * Other adapters (Telegram, Slack) continue using sendMessage() for formatted text.
   */
  sendStructuredEvent?(conversationId: string, event: MessageChunk): Promise<void>;

  /** Retract previously streamed text (used when workflow routing intercepts) */
  emitRetract?(conversationId: string): Promise<void>;
}

/**
 * Extended platform adapter for the Web UI.
 * Adds methods for SSE event bridging, message persistence, and lock events
 * that are only meaningful in the web context.
 */
export interface IWebPlatformAdapter extends IPlatformAdapter {
  sendStructuredEvent(conversationId: string, event: MessageChunk): Promise<void>;
  setConversationDbId(platformConversationId: string, dbId: string): void;
  setupEventBridge(workerConversationId: string, parentConversationId: string): () => void;
  emitLockEvent(conversationId: string, locked: boolean, queuePosition?: number): Promise<void>;
  registerOutputCallback(conversationId: string, callback: (text: string) => void): void;
  removeOutputCallback(conversationId: string): void;
}

/**
 * Type guard for web platform adapter.
 */
export function isWebAdapter(adapter: IPlatformAdapter): adapter is IWebPlatformAdapter {
  return adapter.getPlatformType() === 'web';
}

/**
 * Message chunk from AI assistant.
 * Discriminated union with per-type required fields for type safety.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
  cost?: number;
}

export type MessageChunk =
  | { type: 'assistant'; content: string }
  | { type: 'system'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'result';
      sessionId?: string;
      tokens?: TokenUsage;
      structuredOutput?: unknown;
      isError?: boolean;
      errorSubtype?: string;
      cost?: number;
      stopReason?: string;
      numTurns?: number;
      modelUsage?: Record<string, unknown>;
    }
  | { type: 'rate_limit'; rateLimitInfo: Record<string, unknown> }
  | {
      type: 'tool';
      toolName: string;
      toolInput?: Record<string, unknown>;
      /** Stable per-call ID from the underlying SDK (e.g. Claude `tool_use_id`).
       *  When present, the platform adapter uses it directly instead of generating
       *  one — guarantees `tool_call`/`tool_result` pair correctly even when
       *  multiple tools with the same name run concurrently. */
      toolCallId?: string;
    }
  | {
      type: 'tool_result';
      toolName: string;
      toolOutput: string;
      /** Matching ID for the originating `tool` chunk. See `tool` variant above. */
      toolCallId?: string;
    }
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string };

import type { ModelReasoningEffort, WebSearchMode } from '@archon/workflows/schemas/workflow';
export type { ModelReasoningEffort, WebSearchMode };
import type {
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
} from '@archon/workflows/schemas/dag-node';
export type { EffortLevel, ThinkingConfig, SandboxSettings };

export interface AssistantRequestOptions {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  additionalDirectories?: string[];
  /**
   * Restrict the set of built-in tools available to the assistant.
   * - `[]` — disable all built-in tools (Claude SDK only; Codex ignores this field)
   * - `string[]` — restrict to the named tools
   * Omit entirely to use the assistant's default tool set.
   * Note: `undefined` (omitted) and `[]` have different semantics — do not confuse them.
   */
  tools?: string[];
  /**
   * Remove specific tools from the assistant's available set.
   * Applied after `tools` whitelist (if both are set, denied tools are removed from the whitelist result).
   * Claude SDK only — Codex ignores this field.
   */
  disallowedTools?: string[];
  /**
   * Structured output schema.
   * Claude: passed as outputFormat option to Claude Agent SDK.
   * Codex: passed as outputSchema in TurnOptions to Codex SDK (v0.116.0+).
   * Shape: { type: 'json_schema', schema: <JSON Schema object> }
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** SDK hooks configuration. Passed directly to Claude Agent SDK Options.hooks. Claude only — ignored for Codex. */
  hooks?: Partial<
    Record<
      string,
      {
        matcher?: string;
        hooks: ((
          input: unknown,
          toolUseID: string | undefined,
          options: { signal: AbortSignal }
        ) => Promise<unknown>)[];
        timeout?: number;
      }[]
    >
  >;
  /**
   * MCP server configuration passed to Claude Agent SDK Options.mcpServers.
   * Uses SDK type directly — @archon/core already depends on the SDK.
   * Claude only — Codex ignores this.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tools to auto-allow without permission prompts (e.g., MCP tool wildcards).
   *  Passed to Claude Agent SDK Options.allowedTools. Claude only. */
  allowedTools?: string[];
  /** Custom subagent definitions passed to Claude Agent SDK Options.agents.
   *  Used for per-node skill scoping via AgentDefinition wrapping. Claude only. */
  agents?: Record<string, AgentDefinition>;
  /** Name of agent definition for the main thread. References a key in `agents`. Claude only. */
  agent?: string;
  /**
   * Abort signal for cancelling in-flight AI requests.
   * When aborted, the AI client should terminate the subprocess/query gracefully.
   */
  abortSignal?: AbortSignal;
  /**
   * When false (default), skips writing session transcript to ~/.claude/projects/.
   * Claude Agent SDK v0.2.74+. The SDK default is true, but Archon overrides it to false
   * to avoid disk pollution. Set to true only when session persistence is explicitly needed.
   */
  persistSession?: boolean;
  /**
   * When true, the SDK copies the prior session's history into a new session file
   * before appending, leaving the original untouched. Use with `resume` to safely
   * preserve conversation context without risk of corrupting the source session.
   * Claude only — ignored for Codex.
   */
  forkSession?: boolean;
  /**
   * Claude Code settingSources — controls which CLAUDE.md files are loaded.
   * Passed directly to Claude Agent SDK Options.settingSources.
   * Claude only — ignored for Codex.
   * @default ['project']
   */
  settingSources?: ('project' | 'user')[];
  /**
   * Additional env vars merged into Claude subprocess environment after buildSubprocessEnv().
   * Final env: { ...buildSubprocessEnv(), ...env } (auth tokens conditionally filtered).
   * Claude only — Codex SDK does not support env injection.
   */
  env?: Record<string, string>;
  /**
   * Controls reasoning depth for Claude. Claude only — ignored for Codex.
   */
  effort?: EffortLevel;
  /**
   * Controls Claude's thinking/reasoning behavior. Claude only — ignored for Codex.
   */
  thinking?: ThinkingConfig;
  /**
   * Maximum USD cost budget. SDK returns error_max_budget_usd result if exceeded.
   * Claude only — ignored for Codex.
   */
  maxBudgetUsd?: number;
  /**
   * Per-node system prompt string. Overrides the default claude_code preset.
   * Claude only — ignored for Codex.
   */
  systemPrompt?: string;
  /**
   * Fallback model if primary fails. Claude only — ignored for Codex.
   */
  fallbackModel?: string;
  /**
   * SDK beta feature flags. Claude only — ignored for Codex.
   */
  betas?: string[];
  /**
   * OS-level sandbox settings passed to Claude subprocess.
   * Claude only — ignored for Codex.
   */
  sandbox?: SandboxSettings;
  /**
   * Base URL for the Ollama REST API.
   * Overrides OLLAMA_BASE_URL env var and the compiled-in default.
   * Ollama only — ignored for Claude and Codex.
   */
  baseUrl?: string;
}

/**
 * Generic AI assistant client interface
 * Allows supporting multiple AI assistants (Claude, Codex, etc.)
 */
export interface IAssistantClient {
  /**
   * Send a message and get streaming response
   * @param prompt - User message or prompt
   * @param cwd - Working directory for the assistant
   * @param resumeSessionId - Optional session ID to resume
   * @param options - Optional request options (model, provider-specific settings)
   */
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk>;

  /**
   * Get the assistant type identifier
   */
  getType(): string;
}
