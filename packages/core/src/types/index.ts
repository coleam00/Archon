/**
 * Core type definitions for the Remote Coding Agent platform
 */
import type { TransitionTrigger } from '../state/session-transitions';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { z } from 'zod';

// MessageChunk imported for use in IPlatformAdapter/IWebPlatformAdapter below
import type { MessageChunk } from '@archon/providers/types';

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

// Re-export workflow schema types for config-types.ts compatibility
import type { ModelReasoningEffort, WebSearchMode } from '@archon/workflows/schemas/workflow';
export type { ModelReasoningEffort, WebSearchMode };
import type {
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
} from '@archon/workflows/schemas/dag-node';
export type { EffortLevel, ThinkingConfig, SandboxSettings };
