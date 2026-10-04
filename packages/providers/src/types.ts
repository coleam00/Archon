import type {
  EffortRung,
  PiExtensionPosture,
  ProviderCapabilities,
} from '@archon/provider-contract';

export type {
  MessageChunk,
  ResultChunk,
  SystemPromptPreset,
  SystemPromptInput,
  ExecutionContext,
  AgentRequestOptions,
  NativeToolProperty,
  NativeToolInputSchema,
  NativeTool,
  NodeConfig,
  ProviderAdmissionEvent,
  SendQueryOptions,
  IAgentProvider,
  ProviderDefaults,
  ProviderConfigScope,
  ProviderConfigParser,
  ProviderDefaultsMap,
  CredentialKind,
  CredentialSpec,
  ProviderCredentialCatalog,
  ProviderRegistration,
  PiExtensionPosture,
  ProviderCapabilities,
  ProviderChunk,
  ProviderEvent,
  ProviderResult,
  ProviderWarning,
  ResolvedModel,
  TokenUsage,
} from '@archon/provider-contract';
export {
  CONTAINER_ENV_DENYLIST,
  defineNativeToolInputSchema,
  CREDENTIAL_KINDS,
  mergeTokenUsage,
} from '@archon/provider-contract';

// ─── Provider Config Defaults ──────────────────────────────────────────────
// Canonical definitions — @archon/core/config/config-types.ts imports from here.
// Single source of truth for provider-specific config shapes.

export interface ClaudeProviderDefaults {
  [key: string]: unknown;
  model?: string;
  /** Claude Code settingSources — controls which sources the SDK loads:
   *  CLAUDE.md, skills, commands, agents, and hooks. Both project-level
   *  (`<cwd>/.claude/`) and user-level (`~/.claude/`) are loaded by default.
   *  Set explicitly to `['project']` to scope a workflow to project-only
   *  resources (e.g. CI, shared environments).
   *  @default ['project', 'user']
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
  modelReasoningEffort?: EffortRung;
  /** Structurally matches @archon/workflows WebSearchMode */
  webSearchMode?: 'disabled' | 'cached' | 'live';
  additionalDirectories?: string[];
  /** Path to the Codex CLI binary. Overrides auto-detection in compiled Archon builds. */
  codexBinaryPath?: string;
}

/**
 * Community provider defaults for GitHub Copilot (@github/copilot-sdk).
 */
export interface CopilotProviderDefaults {
  [key: string]: unknown;
  /** Default model ref, e.g. 'gpt-5', 'gpt-5-mini', 'claude-sonnet-4.5'. */
  model?: string;
  /**
   * Reasoning effort passed to the SDK as `reasoningEffort`. Field name
   * mirrors `CodexProviderDefaults.modelReasoningEffort` so users get one
   * consistent key across cross-provider configs.
   */
  modelReasoningEffort?: EffortRung;
  /**
   * Absolute path to the Copilot CLI binary. Required in compiled Archon
   * builds when `COPILOT_BIN_PATH` env var is not set. Dev-mode builds let
   * the SDK resolve from `$PATH`.
   */
  copilotCliPath?: string;
  /**
   * Override Copilot's config directory. When unset the SDK uses its own
   * default (typically `~/.copilot`).
   */
  configDir?: string;
  /**
   * Opt in to Copilot's config discovery from the repo (MCP servers, skills,
   * etc. declared in the repo's `.copilot/` directory). Disabled by default
   * so arbitrary repos do not implicitly load MCP servers or skills.
   * @default false
   */
  enableConfigDiscovery?: boolean;
  /**
   * Reuse the CLI's logged-in user credentials (from `copilot login`) when
   * no explicit token is provided via env vars. Defaults to true.
   * @default true
   */
  useLoggedInUser?: boolean;
  /**
   * Copilot CLI log level. When unset the SDK picks its own default.
   */
  logLevel?: 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all';
}

/**
 * Community provider defaults for Pi (@earendil-works/pi-coding-agent).
 * v1 minimal shape; extend as capabilities are wired in.
 */
export interface PiProviderDefaults extends PiExtensionPosture {
  [key: string]: unknown;
  /** Default model ref in '<pi-provider-id>/<model-id>' format, e.g. 'google/gemini-2.5-pro' */
  model?: string;
  /**
   * Environment variables injected into `process.env` at session start so
   * in-process extensions (which read `process.env` directly) pick them up.
   * Existing `process.env` entries are NOT overridden — shell env wins over
   * config. Use for extension-config vars like `PLANNOTATOR_REMOTE=1` that
   * must be present before the extension's `session_start` hook runs.
   *
   * Note: this differs from `requestOptions.env` (codebase-scoped env vars),
   * which is per-request and only injected into bash subprocesses. Use
   * codebase env vars for secrets that vary per project; use `assistants.pi.env`
   * for extension wiring that's global to the Pi provider.
   * @default undefined
   */
  env?: Record<string, string>;
  /**
   * Maximum number of concurrent Pi `session.prompt()` calls allowed.
   * When this limit is reached, additional calls queue and wait rather than
   * fail. Pi/Minimax does not throttle concurrent requests at the SDK layer
   * (unlike the Claude SDK), so this prevents cascading 429/rate-limit failures
   * when many parallel workflow nodes invoke Pi simultaneously.
   *
   * Set to a positive integer matching your Pi API tier's concurrency limit.
   * Omit for unlimited (not recommended for production batches).
   * @default undefined (unlimited)
   */
  maxConcurrent?: number;
}

/**
 * Community provider defaults for OpenCode (opencode-ai).
 * Minimal shape — extend as capabilities are wired in.
 */
export interface OpencodeProviderDefaults {
  [key: string]: unknown;
  /** Default model ref in '<provider>/<model>' format, e.g. 'anthropic/claude-3-5-sonnet' */
  model?: string;
  /** Base URL of an existing OpenCode server to connect to. */
  baseUrl?: string;
  /** Default agent name from opencode.json config to use. */
  agent?: string;
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
  /** The shared ladder when this provider accepts `effort:`; absent otherwise. */
  effortLevels?: readonly EffortRung[];
}
