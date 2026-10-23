/**
 * Telemetry event building: the categorical property vocabulary and the pure functions
 * that turn capture inputs into wire properties. Nothing here sends; README.md owns the
 * event/property inventory.
 */
import { createHash } from 'crypto';
import { isDocker } from './home-paths';
import { BUNDLED_GIT_COMMIT, BUNDLED_IS_BINARY, BUNDLED_VERSION } from './bundled-build';
import { readSourceCommit } from './source-commit';
import { getTelemetryId } from './telemetry-consent';
import type { WORKFLOW_SOURCES } from './workflow-source';

/**
 * Bumped when the captured property set changes (documented in README). 7 is
 * skipped: a fork shipping this embedded key already sends it.
 */
export const TELEMETRY_SCHEMA_VERSION = 12;

/**
 * Privacy invariants attached to EVERY telemetry event by the transport, not
 * registered as super-properties, so a super-property regression can never
 * silently leak the source IP or create a person profile.
 */
export const PRIVACY_INVARIANTS = {
  $process_person_profile: false,
  // Strip source IP at ingest. `disableGeoip: true` only prevents geo
  // enrichment; `$ip: ''` drops the IP from the event entirely.
  $ip: '',
} as const;

/** How this Archon was installed, from build constants and the Docker env marker. */
export type InstallChannel = 'binary' | 'docker' | 'source';

/**
 * `binary` wins because a compiled build can also run inside a container;
 * `docker` means the source tree running in Archon's image (`ARCHON_DOCKER`).
 * Never derived from a filesystem path.
 * @internal exported for tests
 */
export function resolveInstallChannel(env: NodeJS.ProcessEnv = process.env): InstallChannel {
  if (BUNDLED_IS_BINARY) return 'binary';
  return isDocker(env) ? 'docker' : 'source';
}

/**
 * Short commit of the running build: stamped into binaries at build time, read
 * from the source checkout's git metadata otherwise. Public source identity,
 * not user data; omitted when unknown (e.g. a Docker image built without .git).
 */
function resolveGitCommit(): string | undefined {
  if (BUNDLED_IS_BINARY) return BUNDLED_GIT_COMMIT === 'unknown' ? undefined : BUNDLED_GIT_COMMIT;
  return readSourceCommit(import.meta.dir);
}

/**
 * Stable machine/runtime context registered once as PostHog super-properties
 * (attached to every event from this client). Categorical only — no
 * identifiers, no paths.
 */
export function collectMachineProperties(): Record<string, string | boolean> {
  const bunVersion = typeof Bun !== 'undefined' ? Bun.version : undefined;
  const gitCommit = resolveGitCommit();
  return {
    os: process.platform,
    arch: process.arch,
    archon_version: BUNDLED_VERSION,
    is_binary: BUNDLED_IS_BINARY,
    install_channel: resolveInstallChannel(),
    ...(gitCommit ? { git_commit: gitCommit } : {}),
    runtime_version: bunVersion ? `bun-${bunVersion}` : process.version,
    // Mirrors the CI auto-disable check; when telemetry is enabled this is
    // effectively always false, but it's cheap and future-proof.
    is_ci: process.env.CI?.toLowerCase() === 'true',
    // `process.stderr.isTTY` is `undefined` at runtime when stderr is not a TTY
    // (servers, pipes, CI), so without coercion the field is silently omitted on
    // the primary server path. bun-types incorrectly narrows it to `boolean`, so
    // the coercion looks redundant — it is not.
    is_tty: Boolean(process.stderr.isTTY),
  };
}

export type WorkflowTelemetrySource = (typeof WORKFLOW_SOURCES)[number];

/**
 * Apply the workflow-name privacy rule: bundled (Archon-authored) workflows
 * report their real name so maintainers can see which defaults are popular;
 * user-authored (global/project) and installed-pack workflows report `"custom"` so private names
 * (e.g. "deploy-acme-prod") never leave the machine. `workflow_source` is
 * always reported for the custom-vs-default split.
 */
export function classifyWorkflowForTelemetry(
  name: string,
  source: WorkflowTelemetrySource | undefined
): { workflow_name: string; workflow_source: WorkflowTelemetrySource } {
  return {
    workflow_name: source === 'bundled' ? name : 'custom',
    workflow_source: source ?? 'project',
  };
}

/**
 * Model ids are user-supplied (forwarded verbatim from workflow/`config.yaml`
 * YAML), so unlike `provider` they're not structurally categorical. Forward a
 * value only when it looks like a real model ref (alphanumerics plus `/._:-`,
 * bounded length, and an optional short bracketed variant — covers `sonnet`,
 * `gpt-5.6-sol`, `anthropic/claude-haiku-4-5`, `openrouter/qwen/qwen3-coder`,
 * `opus[1m]`). Anything else is dropped so a stray free-text value can't slip
 * through the "categorical only" telemetry contract.
 *
 * Exported for direct testing of the privacy guard. @internal
 */
export function sanitizeModelForTelemetry(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  return /^[a-zA-Z0-9/._:-]{1,64}(\[[a-zA-Z0-9]{1,8}\])?$/.test(model) ? model : undefined;
}

/**
 * Anonymous per-run reference: the same for every segment of one run on one
 * install, unlinkable to the run's database id without that install's id.
 * @internal exported for tests
 */
export function runRefForTelemetry(runId: string): string {
  return createHash('sha256').update(`${getTelemetryId()}:${runId}`).digest('hex').slice(0, 16);
}

export interface WorkflowInvokedProperties {
  /** Run row id, hashed into `run_ref` here; never sent raw. */
  runId: string;
  /** True for a run started by a parent run's `workflow:` node. */
  isChild: boolean;
  workflowName: string;
  /** Discovery source — drives the custom-vs-default split and name redaction. */
  workflowSource?: WorkflowTelemetrySource;
  platform?: string;
  provider?: string;
  model?: string;
  nodeCount?: number;
  usesLoop?: boolean;
  usesLoopGroup?: boolean;
  usesApproval?: boolean;
  usesScript?: boolean;
  usesBash?: boolean;
  // Advanced-feature adoption flags (presence on any node, categorical only) —
  // these tell maintainers which features earn their maintenance cost.
  usesOutputFormat?: boolean;
  usesOutputType?: boolean;
  usesPersistSession?: boolean;
  usesMcp?: boolean;
  usesSkills?: boolean;
  usesFreshContext?: boolean;
  usedIsolation?: boolean;
  isResume?: boolean;
  shape?: WorkflowShapeProperties;
  /** Only for a non-bundled workflow copied from a bundled one. */
  ancestry?: WorkflowAncestryProperties;
}

export type PromptCharsBucket = 'none' | 'lt_1k' | '1k_5k' | '5k_20k' | 'gte_20k';

/**
 * Categorical shape of a workflow: counts and buckets only, never ids, names or text.
 * Two scopes on purpose: the counts measure everything the workflow contains, loop_group
 * bodies included; depth and fan-out measure the run-level graph the engine schedules.
 */
export interface WorkflowShapeProperties {
  /** Nodes of each type, loop_group bodies included; a type with no nodes is absent. */
  nodeCounts: Partial<Record<WorkflowNodeType, number>>;
  /** Number of dependency layers in the top-level graph (loop_group bodies excluded). */
  graphDepth: number;
  /** Most direct dependents of any one top-level node (loop_group bodies excluded). */
  maxFanOut: number;
  /** Distinct command names referenced by agent and loop nodes. */
  commandRefs: number;
  /** Total inline prompt characters, bucketed. Command bodies are not read. */
  promptCharsBucket: PromptCharsBucket;
}

export interface WorkflowAncestryProperties {
  /** The bundled workflow's name. Bundled names are public; a custom name never is. */
  derivedFrom: string;
  derivedSimilarity: 'identical' | 'modified';
}

/**
 * Deployment-shape context for server installs. Categorical only — booleans
 * and fixed enums derived from which integrations are configured, never the
 * configuration values themselves. Distinguishes solo-laptop installs from
 * team server deployments.
 */
export interface DeploymentShapeProperties {
  dbKind?: 'sqlite' | 'postgresql';
  webAuthEnabled?: boolean;
  /** Per-user credentials mode (TOKEN_ENCRYPTION_KEY configured). */
  multiUser?: boolean;
  githubAuthMode?: 'app' | 'pat' | 'none' | 'conflict';
  /** Hosted chat plugin ids, sent only as a count and `adapter_slack`; ids never leave. */
  chatPluginIds?: readonly string[];
  adapterTelegram?: boolean;
  adapterDiscord?: boolean;
  adapterGitea?: boolean;
  adapterGitlab?: boolean;
}

/** Once-per-process startup event — the basis for active-install counting. */
export interface ArchonStartedProperties extends DeploymentShapeProperties {
  surface: 'cli' | 'server';
}

/**
 * One completed direct-chat AI turn (NOT workflow execution — workflows emit
 * `workflow_invoked` instead). Carries only platform + provider; never
 * message content, conversation ids, or prompt/response data.
 *
 * `platform`/`provider` are open strings because this leaf package cannot
 * import the adapter/provider unions without inverting the dependency graph.
 * Callers MUST pass only registry identifiers (`platform.getPlatformType()`,
 * `aiClient.getType()`) — both are structurally categorical (fixed literals
 * per adapter/provider implementation), never user input.
 */
export interface ChatTurnProperties {
  platform?: string;
  provider?: string;
  /** Resolved model ref — passed through {@link sanitizeModelForTelemetry}. */
  model?: string;
  outcome: 'completed' | 'failed';
  durationMs?: number;
  /** Provider-reported aggregate usage for the turn. Numbers only. */
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Why a failed run ended — a fixed enum, never raw error text. Mirrored from the
 * engine's terminal-reason type in `@archon/workflows` (conformance-tested there).
 */
export type WorkflowExitReason =
  | 'no_nodes_completed'
  | 'node_error'
  | 'unhandled_error'
  // File-presence gate (#2230): all nodes succeeded but `evidence_policy.required`
  // found no conventional `$ARTIFACTS_DIR/evidence.json` marker, so the run failed.
  | 'evidence_missing'
  // The run budget refused new work, or its spend could not be measured (#2814).
  | 'budget_refused'
  | 'source_unavailable'
  | 'not_finalized'
  | 'process_terminated'
  | 'launch_failed'
  | 'run_not_created';

/** Why a run was cancelled — a fixed enum. Mirrored from `@archon/workflows`. */
export type WorkflowCancelReason =
  | 'approval_rejected'
  | 'operator'
  | 'halt_node'
  | 'precondition_failed'
  | 'conversation_reset'
  | 'fan_out';

/**
 * Why the first failed node failed, as recorded where the failure happened.
 * `fatal`/`transient`/`rate_limited`/`unknown` classify a provider error; the rest are
 * engine-detected causes. Mirrored from `NodeFailureKind` in `@archon/workflows`.
 * A fixed enum — raw error text never leaves the machine.
 */
export type WorkflowErrorClass =
  | 'fatal'
  | 'transient'
  | 'unknown'
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'exec_failed'
  | 'output_contract'
  | 'max_iterations'
  | 'child_failed'
  | 'cancelled'
  | 'config';

/** Closed set of DAG node types, mirrored from `@archon/workflows` schemas. */
export type WorkflowNodeType =
  | 'command'
  | 'prompt'
  | 'bash'
  | 'script'
  | 'loop'
  | 'loop_group'
  | 'approval'
  | 'wait'
  | 'workflow'
  | 'cancel'
  | 'compose_fan_out';

/**
 * One terminal workflow-run event: `workflow_completed`, `workflow_failed`, or
 * `workflow_cancelled`. Sent once per committed terminal transition by the run
 * store (see `buildRunTerminalTelemetry` in `@archon/workflows`), so every path
 * that ends a run reports it — plus `run_not_created` from the executor when no
 * run row could be written.
 */
export interface WorkflowTerminalProperties {
  outcome: 'completed' | 'failed' | 'cancelled';
  /** Run row id, hashed into `run_ref` here; never sent raw. Absent without a row. */
  runId?: string;
  isChild?: boolean;
  workflowName: string;
  workflowSource?: WorkflowTelemetrySource;
  provider?: string;
  /** Model ref — passed through {@link sanitizeModelForTelemetry}. */
  model?: string;
  /** Surface the run started on (a child reports `workflow`). */
  platform?: string;
  /** Wall-clock from the run's first start to the terminal transition, waits included. */
  durationMs?: number;
  nodesCompleted?: number;
  nodesFailed?: number;
  nodesSkipped?: number;
  nodesTotal?: number;
  exitReason?: WorkflowExitReason;
  cancelReason?: WorkflowCancelReason;
  /** Failure class of the first failed node: fixed enum, never error text. */
  errorClass?: WorkflowErrorClass;
  /** Type of the first failed node. */
  failedNodeType?: WorkflowNodeType;
  /** Provider-reported cost (USD) across every segment, a child's spend included. */
  costUsd?: number;
  /** Provider-reported gross input tokens across every segment. */
  tokensIn?: number;
  tokensOut?: number;
  /** Cache-read input tokens; absent when no contribution reported the axis. */
  cacheReadTokens?: number;
  /** Cache-write input tokens; absent when no contribution reported the axis. */
  cacheWriteTokens?: number;
  /**
   * True when the two cache totals above are a FLOOR because at least one contributing
   * node did not report that axis. Without it a narrowed total would be indistinguishable
   * from a complete one and would bias aggregate cache figures low (#2662).
   */
  cachePartialTokens?: true;
  /** Completed loop iterations across every segment. */
  loopIterations?: number;
}

export const WORKFLOW_TERMINAL_EVENT_TYPE = {
  completed: 'workflow_completed',
  failed: 'workflow_failed',
  cancelled: 'workflow_cancelled',
} as const satisfies Record<WorkflowTerminalProperties['outcome'], string>;

/** Wire properties for one event, before the transport adds the privacy invariants. */
export type EventProperties = Record<string, unknown>;

/** Drop absent fields so they are left off the wire rather than sent as undefined. */
function withoutUndefined(properties: EventProperties): EventProperties {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function workflowShapeWireProps(shape: WorkflowShapeProperties): Record<string, string | number> {
  const counts: Record<string, number> = {};
  for (const [type, count] of Object.entries(shape.nodeCounts))
    if (count) counts[`nodes_${type}`] = count;
  return {
    ...counts,
    graph_depth: shape.graphDepth,
    max_fan_out: shape.maxFanOut,
    command_refs: shape.commandRefs,
    prompt_chars_bucket: shape.promptCharsBucket,
  };
}

export function workflowInvokedEventProperties(props: WorkflowInvokedProperties): EventProperties {
  const model = sanitizeModelForTelemetry(props.model);
  return {
    ...classifyWorkflowForTelemetry(props.workflowName, props.workflowSource),
    schema_version: TELEMETRY_SCHEMA_VERSION,
    run_ref: runRefForTelemetry(props.runId),
    is_child: props.isChild,
    ...(props.platform ? { platform: props.platform } : {}),
    ...(props.provider ? { provider: props.provider } : {}),
    ...(model ? { model } : {}),
    ...(props.nodeCount !== undefined ? { node_count: props.nodeCount } : {}),
    uses_loop: Boolean(props.usesLoop),
    uses_loop_group: Boolean(props.usesLoopGroup),
    uses_approval: Boolean(props.usesApproval),
    uses_script: Boolean(props.usesScript),
    uses_bash: Boolean(props.usesBash),
    uses_output_format: Boolean(props.usesOutputFormat),
    uses_output_type: Boolean(props.usesOutputType),
    uses_persist_session: Boolean(props.usesPersistSession),
    uses_mcp: Boolean(props.usesMcp),
    uses_skills: Boolean(props.usesSkills),
    uses_fresh_context: Boolean(props.usesFreshContext),
    used_isolation: Boolean(props.usedIsolation),
    is_resume: Boolean(props.isResume),
    ...(props.shape ? workflowShapeWireProps(props.shape) : {}),
    ...(props.ancestry
      ? {
          derived_from: props.ancestry.derivedFrom,
          derived_similarity: props.ancestry.derivedSimilarity,
        }
      : {}),
  };
}

/**
 * Serialize deployment-shape fields to wire properties, omitting absent ones
 * (the CLI surface passes none; the server surface passes all). `archon_started`
 * and `archon_active` both build from this, so they can never drift apart.
 */
export function archonSurfaceEventProperties(props: ArchonStartedProperties): EventProperties {
  return {
    surface: props.surface,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    ...withoutUndefined({
      db_kind: props.dbKind,
      web_auth_enabled: props.webAuthEnabled,
      multi_user: props.multiUser,
      github_auth_mode: props.githubAuthMode,
      chat_plugins: props.chatPluginIds?.length,
      adapter_slack: props.chatPluginIds?.includes('slack'),
      adapter_telegram: props.adapterTelegram,
      adapter_discord: props.adapterDiscord,
      adapter_gitea: props.adapterGitea,
      adapter_gitlab: props.adapterGitlab,
    }),
  };
}

export function chatTurnEventProperties(props: ChatTurnProperties): EventProperties {
  return {
    outcome: props.outcome,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    ...withoutUndefined({
      platform: props.platform || undefined,
      provider: props.provider || undefined,
      model: sanitizeModelForTelemetry(props.model),
      duration_ms: props.durationMs,
      cost_usd: props.costUsd,
      tokens_in: props.tokensIn,
      tokens_out: props.tokensOut,
    }),
  };
}

export function workflowTerminalEventProperties(
  props: WorkflowTerminalProperties
): EventProperties {
  return {
    ...classifyWorkflowForTelemetry(props.workflowName, props.workflowSource),
    schema_version: TELEMETRY_SCHEMA_VERSION,
    ...withoutUndefined({
      run_ref: props.runId === undefined ? undefined : runRefForTelemetry(props.runId),
      is_child: props.isChild,
      provider: props.provider || undefined,
      model: sanitizeModelForTelemetry(props.model),
      platform: props.platform || undefined,
      duration_ms: props.durationMs,
      nodes_completed: props.nodesCompleted,
      nodes_failed: props.nodesFailed,
      nodes_skipped: props.nodesSkipped,
      nodes_total: props.nodesTotal,
      exit_reason: props.exitReason || undefined,
      cancel_reason: props.cancelReason || undefined,
      error_class: props.errorClass || undefined,
      failed_node_type: props.failedNodeType || undefined,
      cost_usd: props.costUsd,
      tokens_in: props.tokensIn,
      tokens_out: props.tokensOut,
      cache_read_tokens: props.cacheReadTokens,
      cache_write_tokens: props.cacheWriteTokens,
      cache_partial: props.cachePartialTokens ? true : undefined,
      loop_iterations: props.loopIterations,
    }),
  };
}
