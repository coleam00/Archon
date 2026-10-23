import type { SETTING_SOURCES } from '@archon/paths/skills';
import type { ResolvedWorkflowPolicy } from './schemas/run-config';
/**
 * Workflow dependency injection types.
 *
 * Defines narrow interfaces for what the workflow engine needs from external systems.
 * Callers in @archon/core satisfy these structurally — no adapter wrappers needed.
 *
 * Provider types are imported directly from @archon/provider-contract.
 */
import type {
  CredentialStatus,
  ProviderRegistry,
  StoredCredentialKind,
} from '@archon/provider-contract';
import type { IWorkflowStore, WorkflowStoreKind } from './store';
import type { ModelReasoningEffort, WebSearchMode } from './schemas';
import type { AttentionOption } from './schemas/wait-node';
import { legacyOccurrenceStep, type RunAttention, type WorkflowRun } from './schemas/workflow-run';
import type { WorktreeDisposition } from './schemas/terminal-record';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderChunk,
  ProviderEvent,
  TokenUsage,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaultsMap,
  ProviderCapabilities,
} from '@archon/provider-contract';
import type { RawAliasesConfig, RawTiersConfig } from './model-validation';
import type {
  WorkflowRunConfigLayer,
  WorkflowRunConfigMetadata,
  WorkflowRunConfigSource,
} from './schemas/run-config';

// Older builds delivered a ChatGPT subscription here; resume still removes it.
const LEGACY_CODEX_AUTH_JSON_RELATIVE_PATH = 'codex-home/auth.json';
export const PI_AUTH_JSON_RELATIVE_PATH = 'pi-home/auth.json';
export const MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS = [
  LEGACY_CODEX_AUTH_JSON_RELATIVE_PATH,
  PI_AUTH_JSON_RELATIVE_PATH,
] as const;

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

// Backwards compat alias — deprecated, prefer direct import from @archon/provider-contract
export type WorkflowTokenUsage = TokenUsage;

// ---------------------------------------------------------------------------
// Platform message metadata
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

/**
 * What an adapter can render as a structured event: a provider's tool call or its
 * update, a turn's result (for its session id), a status line, or a workflow dispatch.
 */
export type PlatformStructuredEvent =
  | Extract<ProviderEvent, { type: 'tool_call' | 'tool_call_update' }>
  | Extract<ProviderChunk, { type: 'result' }>
  | { type: 'system_status'; content: string }
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string };

export interface IWorkflowPlatform {
  sendMessage(
    conversationId: string,
    message: string,
    metadata?: WorkflowMessageMetadata
  ): Promise<void>;
  getStreamingMode(): 'stream' | 'batch';
  getPlatformType(): string;
  /**
   * Optional: how an operator types a workflow command on this surface, given the
   * command after the verb prefix (`cancel <id>`). Absent means the chat grammar the
   * core command handler parses, `/workflow <command>`.
   */
  formatWorkflowCommand?(command: string): string;
  sendStructuredEvent?(conversationId: string, event: PlatformStructuredEvent): Promise<void>;
  emitRetract?(conversationId: string): Promise<void>;
}

/** The part of a surface that decides how an operator types a workflow command there. */
export type WorkflowCommandSurface = Pick<IWorkflowPlatform, 'formatWorkflowCommand'>;

/**
 * Spell a workflow command (`cancel <id>`) the way the surface rendering the message
 * accepts it. A surface without its own spelling gets `/workflow <command>`, the chat
 * grammar the core command handler parses; this is the one place that fallback lives.
 */
export function spellWorkflowCommand(surface: WorkflowCommandSurface, command: string): string {
  return surface.formatWorkflowCommand?.(command) ?? `/workflow ${command}`;
}

/**
 * The notice for a run released because this host could not read its source (#4209).
 * Continuation never selects a released container run, so that one is resumed by hand.
 */
export function sourceReleaseNotice(
  surface: WorkflowCommandSurface,
  runId: string,
  release: { path?: string; nodeId?: string; container: boolean }
): string {
  return (
    `⏸️ Run paused, not failed: this host could not read its frozen source${
      release.path !== undefined ? ` at ${release.path}` : ''
    }${release.nodeId !== undefined ? ` for node '${release.nodeId}'` : ''}. ${
      release.container
        ? 'A container run is not continued automatically; resume it by hand.'
        : 'A host that can read it continues the run on its next continuation scan.'
    }\n` +
    `Resume: \`${spellWorkflowCommand(surface, `resume ${runId}`)}\` | ` +
    `Abandon: \`${spellWorkflowCommand(surface, `abandon ${runId}`)}\``
  );
}

/**
 * How to answer an attention wait, one line per way, spelled for `surface`. The verbs are
 * the `approve`, `reject` and `respond` sugar every surface parses. A `multi_select`
 * answer carries several options at once, which only the CLI's `answer` verb (and its
 * HTTP route) takes, so that line is spelled for the CLI. A wait paused before answers
 * existed (a legacy occurrence) takes no answer; it resumes.
 */
export function attentionAnswerLines(
  surface: WorkflowCommandSurface,
  attention: Pick<
    Extract<RunAttention, { kind: 'attention' }>,
    'runId' | 'form' | 'options' | 'occurrence'
  >
): string[] {
  const { runId, options } = attention;
  const command = (text: string): string => `\`${spellWorkflowCommand(surface, text)}\``;
  if (legacyOccurrenceStep(attention.occurrence) !== undefined)
    return [`When it is done, resume: ${command(`resume ${runId}`)}`];
  const choice = (option: AttentionOption): string =>
    option.label === undefined ? option.id : `${option.label} (${option.id})`;
  switch (attention.form) {
    case 'message':
      return [`Answer: ${command(`approve ${runId} <your answer>`)}`];
    case 'approval':
      return [
        `Approve: ${command(`approve ${runId} [text]`)}`,
        `Reject: ${command(`reject ${runId} [text]`)}`,
      ];
    case 'select':
      return options.map(
        option => `${choice(option)}: ${command(`respond ${runId} ${option.id} [text]`)}`
      );
    case 'multi_select':
      return [
        `Choose one or more of: ${options.map(choice).join(', ')}`,
        `Answer: \`archon workflow answer ${runId} --occurrence ${attention.occurrence} --choose <id> [--choose <id>]… [--text <text>]\``,
      ];
  }
}

// ---------------------------------------------------------------------------
// Narrow config interface (subset of MergedConfig)
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  /** Default assistant provider (validated against provider registry at runtime) */
  assistant: string | undefined;
  baseBranch?: string;
  remote?: string;
  docsPath?: string;
  envVars?: Record<string, string>;
  /** Archon-managed env entries that nodes cannot override. */
  protectedEnvKeys?: readonly string[];
  userCredentialEnvKeys?: SendQueryOptions['userCredentialEnvKeys'];
  /** Exact injected credential values, including credentials delivered through files. */
  protectedCredentialValues?: readonly string[];
  aliases?: RawAliasesConfig;
  tiers?: RawTiersConfig;
  commands: { folder?: string };
  workflows?: ResolvedWorkflowPolicy;
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
      settingSources?: (typeof SETTING_SOURCES)[number][];
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

export type WorkflowEnvironment = Pick<
  WorkflowConfig,
  'envVars' | 'protectedEnvKeys' | 'protectedCredentialValues' | 'userCredentialEnvKeys'
>;

export type AgentProviderFactory = (provider: string) => IAgentProvider;

// ---------------------------------------------------------------------------
// WorkflowDeps — the single injection point
// ---------------------------------------------------------------------------

/** Stored metadata is safe to inspect before resolving health, which may decrypt or refresh. */
export interface StoredProviderCredential {
  kind: StoredCredentialKind;
  getStatus: () => Promise<CredentialStatus>;
}

export interface WorkflowDeps {
  providers: ProviderRegistry;
  store: IWorkflowStore;
  /**
   * Optional: release the worktree a completed run created. `assess` runs before the
   * completion write and its result goes into the terminal record; it returns null when
   * the run has no proof it created its checkout, and reports a failed check as a
   * `check_failed` retention instead of throwing. `release` runs only after the
   * completion write commits and only for a `release` disposition; it re-checks under
   * the worktree lock and throws when it refuses, which the engine logs and ignores.
   */
  completedRunWorktree?: {
    assess(run: WorkflowRun): Promise<WorktreeDisposition | null>;
    release(run: WorkflowRun): Promise<void>;
  };
  getAgentProvider: AgentProviderFactory;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  /** Seal a run-owned config layer before it is persisted in public run metadata. */
  sealRunConfig?: (
    layer: WorkflowRunConfigLayer,
    source: WorkflowRunConfigSource
  ) => WorkflowRunConfigMetadata;
  /** Restore a previously sealed run-owned config layer during continuation. */
  unsealRunConfig?: (metadata: WorkflowRunConfigMetadata) => WorkflowRunConfigLayer;
  /**
   * Optional: GitHub App mode. Absent in PAT mode / when not configured: the
   * subprocess inherits whatever GITHUB_TOKEN already lives on `process.env`
   * (the legacy behaviour), so solo installs see zero functional change.
   */
  githubApp?: {
    /**
     * Resolve an installation token for (owner, repo), refreshed transparently
     * from the cache. Injected as GH_TOKEN/GITHUB_TOKEN so `gh` and `git push`
     * inside worktrees authenticate. Must throw on resolution failure so
     * execution fails before a node can use another credential.
     */
    resolveInstallationToken: (owner: string, repo: string) => Promise<string>;
    /**
     * Install the `gh` shim that fetches a current installation token per call
     * from the server's loopback endpoint; returns the directory to put first
     * on PATH. Throws when installation fails.
     */
    installCliShim: () => string;
  };
  /**
   * Optional: resolve the originating user's personal GitHub token (decrypted,
   * refreshed on read). Used by the per-user token policy to route a run's
   * `gh`/`git push` through the human who triggered it rather than the shared
   * org/bot token. Returns undefined when the user hasn't connected. Must not
   * throw — return undefined on any failure.
   */
  getUserGithubToken?: (userId: string) => Promise<string | undefined>;
  /** Connected commit author; undefined when this user has no GitHub connection. */
  getUserGithubAuthor?: (userId: string) => Promise<{ name: string; email: string } | undefined>;
  /**
   * Optional: whether per-user GitHub attribution is active for this install
   * (GitHub App configured + TOKEN_ENCRYPTION_KEY set). When false/absent, the
   * token policy is a no-op and subprocesses keep inheriting `process.env`.
   */
  isPerUserGitHubEnabled?: () => boolean;
  /**
   * Optional: whether per-user AI-provider credentials are active for this
   * install (TOKEN_ENCRYPTION_KEY set; independent of the GitHub App). When
   * false/absent, no per-user provider env is injected and chats/runs keep
   * the shared process-global keys.
   */
  isPerUserProviderKeysEnabled?: () => boolean;
  /** Where stored per-user credentials live; `files` uses only native provider authentication. */
  credentialStore?: WorkflowStoreKind;
  /** The user's stored credential for `vendor`, or `undefined` when none is stored. */
  getUserProviderCredential?: (
    userId: string,
    vendor: string
  ) => Promise<StoredProviderCredential | undefined>;
  /**
   * Optional: resolve the required connected provider credentials into a
   * delivery bag (env vars + files to write under `artifactsDir`) plus the
   * decrypted values that must be scrubbed from subprocess failures. Called
   * once per run from `executeWorkflow`. Implementations own the delivery
   * map — the engine just merges `env` into `config.envVars` and writes the
   * `files` before any provider invocation.
   *
   * Vendors selected as connected during preflight must remain connected at
   * delivery. Failures must throw to prevent fallback to another account.
   */
  getUserProviderEnv?: (
    userId: string,
    artifactsDir: string,
    vendors: readonly string[],
    connectedVendors: readonly string[]
  ) => Promise<{
    env: Record<string, string>;
    files: { path: string; contents: string }[];
    protectedValues: string[];
  }>;
  /**
   * Optional: resolve the originating user's personal AI preferences (model
   * tiers, `@custom` aliases, default assistant) from the DB. Folded into
   * `buildAiProfile` as the highest-precedence layer at the userId-aware
   * seams (executor + chat orchestrator) — the deep execution path only ever
   * sees the resolved profile.
   *
   * Must never throw — return `{}` on any failure so model resolution falls
   * back to install-wide config exactly as before.
   */
  getUserAiPrefs?: (userId: string) => Promise<{
    tiers?: RawTiersConfig;
    aliases?: RawAliasesConfig;
    defaultProvider?: string;
  }>;
}
