import type { ProviderDiagnostics, ProviderModelList } from './information';
import { z } from 'zod';
import type { CredentialStatus } from './credential-status';
import type { ProviderCapabilities } from './capabilities';
import type { ProviderChunk } from './events';
import type { EffortRung } from './effort';

/**
 * Claude Agent SDK AgentDefinition — inline sub-agent available via the Task tool.
 * Mirrors the SDK's AgentDefinition type (sdk.d.ts), minus mcpServers and the
 * experimental critical-reminder field.
 */
export const agentDefinitionSchema = z.object({
  description: z.string().min(1, "'description' is required"),
  prompt: z.string().min(1, "'prompt' is required"),
  model: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export interface PiExtensionPosture {
  /** Load Pi's native user and project extensions. Enabled by default; extension
   * tools and MCP clients remain the user's responsibility. */
  enableExtensions?: boolean;
  /** Bind Pi's extension UI context and forward notifications into the stream.
   * Enabled by default when extensions are enabled. */
  interactive?: boolean;
  /** ExtensionRunner flags applied before session_start, equivalent to Pi CLI
   * flags. Unknown keys are ignored; requires extensions to be enabled. */
  extensionFlags?: Record<string, boolean | string>;
}

/**
 * Everything a provider's stream yields, owned by `@archon/provider-contract`: its events,
 * then `result`, then `settled`.
 */
export type MessageChunk = ProviderChunk;

/**
 * The terminal `result` chunk. Providers build it by assignment on a value of this type
 * rather than from conditional spreads, so a misspelled key fails to compile.
 */
export type ResultChunk = Extract<MessageChunk, { type: 'result' }>;

/**
 * System prompt input accepted by all providers. Mirrors the Claude Agent SDK
 * preset-with-append shape so callers can opt into cacheable prefix behavior.
 * Kept SDK-free so external providers need no Claude SDK dependency.
 */
export const systemPromptPresetSchema = z.object({
  type: z.literal('preset'),
  preset: z.literal('claude_code'),
  append: z.string().optional(),
  excludeDynamicSections: z.boolean().optional(),
});
export type SystemPromptPreset = z.infer<typeof systemPromptPresetSchema>;
export const systemPromptInputSchema = z.union([
  z.string(),
  z.array(z.string()),
  systemPromptPresetSchema,
]);
export type SystemPromptInput = z.infer<typeof systemPromptInputSchema>;

/**
 * Where a provider turn (or a deterministic bash/script subprocess) runs.
 *  - `host`      — directly on the Archon host process, inheriting its environment.
 *    This is today's behavior and the default everywhere.
 *  - `container` — inside a prepared isolation container (the folder-project
 *    container backend). The provider spawns its CLI via `docker exec` and
 *    receives only the Archon-managed env bag; `containerId` identifies the
 *    running container and `execUser` optionally pins the in-container uid/user.
 *
 * Isolation produces this context; workflows threads it through to providers.
 * The engine checks the provider's container capability before dispatch, so
 * providers must not silently downgrade a container turn to the host.
 */
export const executionContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }),
  z.object({
    kind: z.literal('container'),
    containerId: z.string(),
    execUser: z.string().optional(),
  }),
]);
export type ExecutionContext = z.infer<typeof executionContextSchema>;

/**
 * Env keys NEVER forwarded into a container via `docker exec -e` — the runner
 * image sets these correctly and a host/project value would break in-container
 * resolution (PATH must point at the in-container binaries; HOME must be the
 * container user's home). Shared by BOTH container exec paths (the Claude spawn
 * hook and the bash/script deterministic exec) so their env policy can't drift.
 */
export const CONTAINER_ENV_DENYLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHLVL',
]);

/**
 * Universal request options accepted by all providers.
 * Provider-specific fields go through `nodeConfig` and `assistantConfig` in SendQueryOptions.
 */
export interface AgentRequestOptions {
  model?: string;
  abortSignal?: AbortSignal;
  systemPrompt?: SystemPromptInput;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  env?: Record<string, string>;
  /**
   * Names in `env` whose values Archon injected as credentials rather than
   * loading from project configuration. Custom provider configuration must not
   * be allowed to select them.
   */
  protectedEnvKeys?: readonly string[];
  maxBudgetUsd?: number;
  fallbackModel?: string;
  /**
   * Request an immutable fork of `resumeSessionId`. Exact-fork callers such as
   * named workflow resume must first verify `sessionFork === true`. Legacy session
   * reuse may still send this flag to resume-only providers, where behavior is
   * provider-specific and immutability is not guaranteed.
   */
  forkSession?: boolean;
  /**
   * In-process tools the model may call this turn. Defined once by the caller
   * (e.g. core's manage_run) and adapted per provider — Claude wraps each via
   * `createSdkMcpServer`/`tool()`, Pi via `customTools`. Providers without an
   * in-process tool path (Codex/OpenCode) ignore them. Gated on the
   * `nativeTools` capability.
   */
  nativeTools?: NativeTool[];
}

/**
 * One property on a native tool's input object. `kind` is the discriminant the
 * provider converters switch on; each variant maps to exactly one SDK schema
 * form. `values` is a non-empty tuple, so an enum with no options is a compile
 * error rather than a provider-side runtime throw.
 */
export type NativeToolProperty =
  | { kind: 'string'; description?: string }
  | { kind: 'enum'; values: readonly [string, ...string[]]; description?: string }
  | { kind: 'boolean'; description?: string };

/**
 * The closed input shape a native tool may declare: a flat object of string /
 * string-enum / boolean properties, plus the names of the required ones. Every
 * provider maps this to its SDK's schema form, so the supported subset lives
 * here once instead of being re-derived by each converter.
 */
export interface NativeToolInputSchema {
  properties: Record<string, NativeToolProperty>;
  required: readonly string[];
}

/**
 * Build a NativeToolInputSchema while tying `required` to the property keys: a
 * name that is not a declared property is a compile error, where the erased
 * interface alone would accept any string. Returns the erased shape so
 * `NativeTool` stays non-generic — a `keyof P` constraint on the interface
 * itself would make the schema invariant in `P` and break assignment to
 * `SendQueryOptions.nativeTools`.
 */
export function defineNativeToolInputSchema<P extends Record<string, NativeToolProperty>>(input: {
  properties: P;
  required: readonly (keyof P & string)[];
}): NativeToolInputSchema {
  return input;
}

/**
 * A provider-neutral in-process tool. The handler runs in the host process and
 * closes over whatever live context it needs (DB, operations, conversation), so
 * `@archon/providers` never imports `@archon/core` — the tool crosses the
 * boundary as data + a function on the request options.
 *
 * `inputSchema` is the closed typed shape each provider maps to its SDK's
 * schema form. The handler is expected to return a text result rather than
 * throw — provider adapters add no safety net, so an uncaught throw would
 * surface into the agent loop. (core's `buildManageRunTool` guarantees this with
 * an outer try/catch around its dispatch.)
 */
export interface NativeTool {
  name: string;
  description: string;
  inputSchema: NativeToolInputSchema;
  handler: (input: Record<string, unknown>) => Promise<string>;
}

/**
 * Raw node configuration from workflow YAML.
 * Providers translate fields they understand; unknown fields are ignored.
 */
export interface NodeConfig {
  /** Node ID from the workflow DAG — used by providers for per-node isolation (e.g., session dirs). */
  nodeId?: string;
  mcp?: string;
  hooks?: unknown;
  skills?: string[];
  /** Exact provider plugin ids the node loads; every other user-installed plugin stays off. */
  plugins?: string[];
  /** Inline sub-agent definitions (keyed by kebab-case agent ID). */
  agents?: Record<string, AgentDefinition>;
  allowed_tools?: string[];
  denied_tools?: string[];
  /**
   * Per-node Pi extension posture, overriding provider defaults.
   */
  pi?: PiExtensionPosture;
  effort?: EffortRung;
  sandbox?: unknown;
  betas?: string[];
  output_format?: Record<string, unknown>;
  maxBudgetUsd?: number;
  systemPrompt?: SystemPromptInput;
  fallbackModel?: string;
  /**
   * Per-node override for Claude Code settingSources — which filesystem
   * setting sources the SDK loads (CLAUDE.md, skills, commands, agents).
   * Overrides the assistant-level default; falls back to ['project', 'user']
   * when neither is set. Claude-only; other providers ignore it (the
   * dag-executor warns via the settingSources capability axis).
   */
  settingSources?: ('project' | 'user')[];
  idle_timeout?: number;
  /**
   * Per-node override for Claude's `agentProgressSummaries` flag (Phase 4 of #975).
   * When unset, workflow nodes default to `true` (so the Web UI gets AI-generated
   * `summary` fields on running `subtask` events every ~30s). Authors can explicitly set
   * `false` to opt out for a specific node.
   */
  agentProgressSummaries?: boolean;
  [key: string]: unknown;
}

/** Typed admission transitions for one capped provider attempt. */
export interface ProviderAdmissionEvent {
  state: 'waiting' | 'admitted' | 'released';
  /** Provider registration ID. */
  provider: string;
  /** Slot holder ID; stable from `waiting` through `released` for one attempt. */
  attemptId: string;
  capacity: number;
}

/**
 * Extended options for sendQuery, adding workflow-specific context.
 * The orchestrator path uses base AgentRequestOptions fields only.
 * The workflow path additionally passes nodeConfig and assistantConfig.
 */
export interface SendQueryOptions extends AgentRequestOptions {
  /**
   * Codex titles use empty capability declarations and a read-only sandbox.
   * Pi titles without a resume id use in-memory sessions. Other providers may ignore it.
   */
  purpose?: 'title-generation';
  /** Observer for capped-provider admission transitions (queue visibility, #2817). */
  onAdmission?: (event: ProviderAdmissionEvent) => void;
  /** Raw YAML node config — provider translates internally to SDK-specific options. */
  nodeConfig?: NodeConfig;
  /** Per-provider defaults from .archon/config.yaml assistants section. */
  assistantConfig?: Record<string, unknown>;
  /**
   * Execution target for this turn. Absent or `host` runs on the host;
   * `container` requires the provider capability checked by the engine before dispatch.
   */
  execContext?: ExecutionContext;
}

/**
 * Generic agent provider interface.
 * Allows supporting multiple agent providers (Claude, Codex, etc.)
 */
export interface IAgentProvider {
  diagnose?(request: {
    assistantConfig?: SendQueryOptions['assistantConfig'];
  }): Promise<ProviderDiagnostics>;
  listModels?(): Promise<ProviderModelList>;

  resolveCredentialModel?(request: {
    model?: string;
    assistantConfig?: SendQueryOptions['assistantConfig'];
    cwd: string;
  }): Promise<string | undefined>;

  /** Check the credential this provider uses when Archon delivers none. */
  checkCredential(request: {
    assistantConfig?: SendQueryOptions['assistantConfig'];
    model?: string;
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<CredentialStatus>;

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

/** Host providers inherit native configuration; container children receive only the request bag. */
export function buildProviderSubprocessEnv(
  requestOptions?: Pick<SendQueryOptions, 'env' | 'execContext'>
): NodeJS.ProcessEnv {
  return {
    ...(requestOptions?.execContext?.kind === 'container' ? { TERM: 'dumb' } : process.env),
    ...requestOptions?.env,
  };
}
