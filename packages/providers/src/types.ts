// CONTRACT LAYER — no SDK imports, no runtime deps.
// @archon/workflows and @archon/core import from this subpath (@archon/providers/types).
// HARD RULE: This file must never import SDK packages or other @archon/* packages.

// ─── Provider Config Defaults ──────────────────────────────────────────────
// Canonical definitions — @archon/core/config/config-types.ts imports from here.
// Single source of truth for provider-specific config shapes.

export interface ClaudeProviderDefaults {
  [key: string]: unknown;
  model?: string;
  /** Claude Code settingSources — controls which CLAUDE.md files are loaded.
   *  @default ['project']
   */
  settingSources?: ('project' | 'user')[];
  /** Absolute path to the Claude Code SDK's `cli.js`. Required in compiled
   *  Archon builds when `CLAUDE_BIN_PATH` is not set; optional in dev mode
   *  (SDK resolves from node_modules). */
  claudeBinaryPath?: string;
}

export interface CodexProviderDefaults {
  [key: string]: unknown;
  model?: string;
  /** Structurally matches @archon/workflows ModelReasoningEffort */
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Structurally matches @archon/workflows WebSearchMode */
  webSearchMode?: 'disabled' | 'cached' | 'live';
  additionalDirectories?: string[];
  /** Path to the Codex CLI binary. Overrides auto-detection in compiled Archon builds. */
  codexBinaryPath?: string;
}

/**
 * Community provider defaults for Pi (@mariozechner/pi-coding-agent).
 * v1 minimal shape; extend as capabilities are wired in.
 */
export interface PiProviderDefaults {
  [key: string]: unknown;
  /** Default model ref in '<pi-provider-id>/<model-id>' format, e.g. 'google/gemini-2.5-pro' */
  model?: string;
  /**
   * Opt-in to Pi's extension discovery (tools + lifecycle hooks from community
   * packages — see https://shittycodingagent.ai/packages). When true, Pi loads
   * extensions from `~/.pi/agent/extensions/`, `~/.pi/agent/settings.json`
   * packages, AND the workflow's cwd (`<cwd>/.pi/extensions/`,
   * `<cwd>/.pi/settings.json`). The cwd scope is the risky one — a workflow
   * running against an untrusted repo can auto-load whatever extension code
   * that repo ships. Disabled by default to preserve the "Archon is source of
   * truth" trust boundary. Flip to true only on hosts whose workflows run
   * against repos you trust.
   * @default false
   */
  enableExtensions?: boolean;
}

/** Generic per-provider defaults bag used by config surfaces and UI. */
export type ProviderDefaults = Record<string, unknown>;

/** Provider-keyed defaults map. Built-ins may refine individual entries. */
export type ProviderDefaultsMap = Record<string, ProviderDefaults>;

/**
 * Token usage statistics from AI provider responses.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
  cost?: number;
}

/**
 * Message chunk from AI assistant.
 * Discriminated union with per-type required fields for type safety.
 */
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
      /** SDK-provided error detail strings. Populated when isError is true. */
      errors?: string[];
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
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string }
  // ── SDK lifecycle events (task/hook observability) ──────────────────────
  | { type: 'task_started'; taskId: string; description: string; taskType?: string }
  | { type: 'task_progress'; taskId: string; description: string; summary?: string }
  | {
      type: 'task_notification';
      taskId: string;
      status: 'completed' | 'failed' | 'stopped';
      summary: string;
    }
  | { type: 'hook_started'; hookId: string; hookName: string; hookEvent: string }
  | {
      type: 'hook_response';
      hookId: string;
      hookName: string;
      hookEvent: string;
      outcome: 'success' | 'error' | 'cancelled';
      exitCode?: number;
    };

/**
 * Universal request options accepted by all providers.
 * Provider-specific fields go through `nodeConfig` and `assistantConfig` in SendQueryOptions.
 */
export interface AgentRequestOptions {
  model?: string;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  env?: Record<string, string>;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  /** Session fork flag — when true, copies prior session history before appending. */
  forkSession?: boolean;
  /** When false, skip writing session transcript to disk. */
  persistSession?: boolean;
}

/**
 * Raw node configuration from workflow YAML.
 * Providers translate fields they understand; unknown fields are ignored.
 */
export interface NodeConfig {
  mcp?: string;
  hooks?: unknown;
  skills?: string[];
  /**
   * Inline sub-agent definitions (keyed by kebab-case agent ID).
   *
   * Intentional hand-written duplicate of `agentDefinitionSchema` (authoritative
   * source: `@archon/workflows/schemas/dag-node`). Normally we follow the
   * project rule "derive types from Zod via `z.infer`, never write parallel
   * interfaces" — broken here on purpose: `@archon/providers/types` is the
   * contract subpath consumed by `@archon/workflows`, so importing from
   * `@archon/workflows` would create a circular dependency.
   *
   * Drift risk: when the schema gains a field, this shape must be updated
   * by hand. Follow-up work: extract the agent-definition contract to a
   * lower-tier package so `z.infer` can be used end-to-end (#1276).
   */
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      model?: string;
      tools?: string[];
      disallowedTools?: string[];
      skills?: string[];
      maxTurns?: number;
    }
  >;
  allowed_tools?: string[];
  denied_tools?: string[];
  effort?: string;
  thinking?: unknown;
  sandbox?: unknown;
  betas?: string[];
  output_format?: Record<string, unknown>;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  fallbackModel?: string;
  idle_timeout?: number;
  [key: string]: unknown;
}

/**
 * Extended options for sendQuery, adding workflow-specific context.
 * The orchestrator path uses base AgentRequestOptions fields only.
 * The workflow path additionally passes nodeConfig and assistantConfig.
 */
export interface SendQueryOptions extends AgentRequestOptions {
  /** Raw YAML node config — provider translates internally to SDK-specific options. */
  nodeConfig?: NodeConfig;
  /** Per-provider defaults from .archon/config.yaml assistants section. */
  assistantConfig?: Record<string, unknown>;
}

/**
 * Provider capability flags. The dag-executor uses these for capability warnings
 * when a node specifies features the target provider doesn't support.
 */
export interface ProviderCapabilities {
  sessionResume: boolean;
  mcp: boolean;
  hooks: boolean;
  skills: boolean;
  /** Whether the provider supports inline sub-agent definitions (Claude SDK's options.agents). */
  agents: boolean;
  toolRestrictions: boolean;
  structuredOutput: boolean;
  envInjection: boolean;
  costControl: boolean;
  effortControl: boolean;
  thinkingControl: boolean;
  fallbackModel: boolean;
  sandbox: boolean;
}

/**
 * Registration entry for a provider in the provider registry.
 * Each entry carries metadata, a factory, and model-compatibility logic.
 * The registry is the source of truth for provider identity, capabilities, and display.
 */
export interface ProviderRegistration {
  /** Unique provider identifier — used in YAML, config, DB */
  id: string;

  /** Human-readable name for UI display */
  displayName: string;

  /** Instantiate a provider */
  factory: () => IAgentProvider;

  /** Static capability declaration — used for dag-executor warnings */
  capabilities: ProviderCapabilities;

  /**
   * Model compatibility check. Returns true if the model string
   * is valid for this provider. Used by workflow validation and
   * provider inference from model names.
   */
  isModelCompatible: (model: string) => boolean;

  /** Whether this is a built-in (maintained by core team) or community provider */
  builtIn: boolean;
}

/**
 * API-safe projection of ProviderRegistration (excludes non-serializable fields).
 * Used by GET /api/providers and consumed by the Web UI.
 */
export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  builtIn: boolean;
}

/**
 * Generic agent provider interface.
 * Allows supporting multiple agent providers (Claude, Codex, etc.)
 */
export interface IAgentProvider {
  /**
   * Send a message and get streaming response.
   * @param prompt - User message or prompt
   * @param cwd - Working directory for the provider
   * @param resumeSessionId - Optional session ID to resume
   * @param options - Optional request options (universal + nodeConfig + assistantConfig)
   */
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>;

  /**
   * Get the provider type identifier (e.g. 'claude', 'codex').
   */
  getType(): string;

  /**
   * Get the provider's capability flags.
   * Used by the dag-executor to warn when nodes specify unsupported features.
   */
  getCapabilities(): ProviderCapabilities;
}
