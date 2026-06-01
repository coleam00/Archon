/**
 * Workflow dependency injection types.
 *
 * Defines narrow interfaces for what the workflow engine needs from external systems.
 * Callers in @archon/core satisfy these structurally — no adapter wrappers needed.
 *
 * Provider types are imported directly from @archon/providers/types (contract layer).
 * No more mirror copies — single source of truth for IAgentProvider, MessageChunk, etc.
 */
import type { IWorkflowStore } from './store';
import type { ModelReasoningEffort, WebSearchMode } from './schemas';
import type {
  IAgentProvider,
  MessageChunk,
  TokenUsage,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaultsMap,
  ProviderCapabilities,
} from '@archon/providers/types';

// Re-export provider types so existing workflow engine consumers don't break
export type {
  IAgentProvider,
  MessageChunk,
  TokenUsage,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaultsMap,
  ProviderCapabilities,
};

// Backwards compat alias — deprecated, prefer direct import from @archon/providers/types
export type WorkflowTokenUsage = TokenUsage;

// ---------------------------------------------------------------------------
// Platform-specific types (NOT mirrors — unique to workflow engine)
// ---------------------------------------------------------------------------

export interface WorkflowMessageMetadata {
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

// ---------------------------------------------------------------------------
// Narrow platform interface (subset of IPlatformAdapter)
// ---------------------------------------------------------------------------

export interface IWorkflowPlatform {
  sendMessage(
    conversationId: string,
    message: string,
    metadata?: WorkflowMessageMetadata
  ): Promise<void>;
  getStreamingMode(): 'stream' | 'batch';
  getPlatformType(): string;
  sendStructuredEvent?(conversationId: string, event: MessageChunk): Promise<void>;
  emitRetract?(conversationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Narrow config interface (subset of MergedConfig)
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  /** Default assistant provider (validated against provider registry at runtime) */
  assistant: string;
  baseBranch?: string;
  docsPath?: string;
  envVars?: Record<string, string>;
  commands: { folder?: string };
  defaults?: {
    loadDefaultWorkflows?: boolean;
    loadDefaultCommands?: boolean;
  };
  // Intersection: generic map for community providers + typed built-in entries.
  // Built-ins are typed so executor/dag-executor get type-safe config access for
  // Claude settingSources, Codex reasoningEffort, etc. without casts.
  // Community providers use the generic [string] index signature.
  assistants: ProviderDefaultsMap & {
    claude: {
      model?: string;
      settingSources?: ('project' | 'user')[];
    };
    codex: {
      model?: string;
      modelReasoningEffort?: ModelReasoningEffort;
      webSearchMode?: WebSearchMode;
      additionalDirectories?: string[];
    };
  };
}

// ---------------------------------------------------------------------------
// Agent provider factory type
// ---------------------------------------------------------------------------

export type AgentProviderFactory = (provider: string) => IAgentProvider;

// ---------------------------------------------------------------------------
// WorkflowDeps — the single injection point
// ---------------------------------------------------------------------------

export interface WorkflowDeps {
  store: IWorkflowStore;
  getAgentProvider: AgentProviderFactory;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  /**
   * Optional: resolve a fresh GitHub bot token for the given (owner, repo).
   * Used to inject GH_TOKEN/GITHUB_TOKEN into bash/script subprocess env so
   * AI-driven `gh` and `git push` operations inside worktrees authenticate
   * correctly.
   *
   *  - App mode (server bootstrap registered a provider): returns a fresh
   *    installation access token, refreshed transparently from the cache.
   *  - PAT mode / not configured: returns undefined. The subprocess inherits
   *    whatever GITHUB_TOKEN already lives on `process.env` (the legacy
   *    behaviour), so solo installs see zero functional change.
   *
   * Implementations must not throw — return undefined on any failure so the
   * workflow execution falls back to env inheritance rather than aborting.
   */
  resolveBotGitHubToken?: (owner: string, repo: string) => Promise<string | undefined>;
  /**
   * Optional: resolve the originating user's personal GitHub token (decrypted,
   * refreshed on read). Used by the per-user token policy to route a run's
   * `gh`/`git push` through the human who triggered it rather than the shared
   * org/bot token. Returns undefined when the user hasn't connected. Must not
   * throw — return undefined on any failure.
   */
  getUserGithubToken?: (userId: string) => Promise<string | undefined>;
  /**
   * Optional: whether per-user GitHub attribution is active for this install
   * (GitHub App configured + TOKEN_ENCRYPTION_KEY set). When false/absent, the
   * token policy is a no-op and subprocesses keep inheriting `process.env`.
   */
  isPerUserGitHubEnabled?: () => boolean;
}
