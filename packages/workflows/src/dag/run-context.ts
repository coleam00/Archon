import type { ContainerPauseBoundary } from './pause';
import type { InteractionAdmission } from '../interaction-admission';
import { newNodeInvocation, startNodeExecution } from '../node-execution';
import { observeCheckout } from '../checkout-observation';
import { buildAiNodeEnvironment } from '../exec-environment';
import type { NodeExecutionResult } from '../node-record-serialization';
import type { NodeExecutionRecord, NodeInvocation } from '../schemas/node-execution';
import type { CheckoutObservation } from '../schemas/checkout-observation';
import type { createRunToolCallAttention } from '../tool-call-attention';
import type { WorkflowSourceRoots } from '../workflow-source';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '../deps';
import type {
  DagNode,
  EffortLevel,
  GraphPlan,
  NodeArtifactLoopFrame,
  NodeOutput,
  SandboxSettings,
  SessionCursor,
  WebSearchMode,
  WorkflowNodeSession,
  WorkflowRun,
} from '../schemas';
import { isNodeContextResume, type NodeContext } from '../schemas';
import type { DagResumeSnapshot, PersistedNodeOutput, PriorFailedNode } from '../store';
import type { RunBudgetLedger } from '../run-budget';
import type { ModelAliasPreset, ResolvedAiProfile, TierName } from '../model-validation';
import type { ExecutionContext, ProviderCapabilities, TokenUsage } from '@archon/provider-contract';
import type { LoopBodyScope } from './loop-scope';
import type { RunChildWorkflowFn } from './child-run';

/** Workflow-level provider options. The provider options have node-level
 *  counterparts and are resolved as `node.X ?? workflowLevelOptions.X`. Two do
 *  not: `webSearchMode`, absent from `dagNodeSchema` so a workflow-level value
 *  is the only value, and `workflowTier`, which is not an author-facing field at
 *  all — it carries the workflow's resolved tier keyword for annotation. */
export interface WorkflowLevelOptions {
  effort?: EffortLevel;
  fallbackModel?: string;
  betas?: string[];
  sandbox?: SandboxSettings;
  /** Codex-only: web-search mode, consumed as `assistantConfig.webSearchMode`.
   *  Permanently workflow-level-only — decided in #2556, and the ONLY
   *  workflow-level field with no per-node counterpart. */
  webSearchMode?: WebSearchMode;
  /** Workflow-level tier keyword (when `workflow.model` is small/medium/large), so
   *  nodes that inherit the workflow model can still surface the `← tier` annotation. */
  workflowTier?: TierName;
}

export type SequentialSessionCursor = SessionCursor;
export type SessionResumeIntent = 'ordinary' | 'source-fork' | 'owner-continuation';

/** Makes a provider session durable before its node becomes authoritatively complete. */
export type SessionCheckpoint = (sessionId: string) => Promise<void>;

/** Per-node result surfaced by a runLayers layer closure. `sessionProvider` tags which
 *  resolved provider created `output.sessionId` (session-producing paths only). */
export interface LayerNodeResult {
  nodeId: string;
  output: NodeExecutionResult;
  sessionProvider?: string;
}

/**
 * A run's cross-run session scope. Concurrent runs of one workflow share a scope, so
 * `sessionsAtStart` is read once when the run starts and every persisted node continues
 * from that copy, never from a row a sibling run wrote afterwards. The read is issued
 * before any node runs; a persisted node awaits it, so a failed read surfaces at the
 * node that needed it.
 */
export interface PersistScope {
  key: string;
  sessionsAtStart: Promise<readonly WorkflowNodeSession[]>;
}

export type ClaimedWorkPausePolicy = 'finish_through_parent_pause';

/** Run-level values the caller supplies verbatim to the DAG boundary. */
export interface RunInputs {
  deps: WorkflowDeps;
  platform: IWorkflowPlatform;
  conversationId: string;
  /** The workspace nodes ACT on: provider turns, subprocesses, git, output files. */
  cwd: string;
  /**
   * Injected closure that starts a child sub-run for a `workflow:` node (#2121
   * Phase 2). Undefined when the caller (e.g. a unit test) doesn't wire it — a
   * `workflow:` node then fails fast rather than silently no-op'ing. Forwarded
   * into loop_group body contexts too, though a `workflow:` node inside a
   * loop_group body is rejected at load time.
   */
  runChildWorkflow?: RunChildWorkflowFn;
  workflowRun: WorkflowRun;
  config: WorkflowConfig;
  workflowProvider: string | undefined;
  workflowModel: string | undefined;
  aiProfile?: ResolvedAiProfile;
  workflowPreset?: ModelAliasPreset;
  artifactsDir: string;
  /**
   * `$STATE_DIR` — the per-PROJECT cross-run state directory (#2200), shared by
   * every workflow in the project and pre-created by the executor. A run-level
   * invariant like `artifactsDir`; forwarded unchanged into loop_group bodies.
   */
  stateDir: string;
  logDir: string;
  baseBranch: string;
  docsDir: string;
  configuredCommandFolder?: string;
  issueContext?: string;
}

/** Run-level values derived exactly once at the DAG boundary, never supplied by callers. */
export interface RunDerived {
  containerPause?: ContainerPauseBoundary;
  toolAttention: ReturnType<typeof createRunToolCallAttention>;
  /**
   * The roots nodes READ executable source from — command files and named scripts.
   *
   * REQUIRED and concrete: normalized once at the DAG boundary so no leaf lookup can be
   * reached without them. They were optional at first, and an omitted argument at any one
   * of six call sites silently recreated the original source/target bug — the resolver
   * would fall back to `cwd` and look for the workflow's own files inside the workspace it
   * was executing against. Public discovery helpers keep their live-source defaults; this
   * internal path does not.
   */
  workflowSourceRoots: WorkflowSourceRoots;
  /** Where nodes in these layers execute (host, or the container in Phase B). Threaded
   *  into every AI turn's SendQueryOptions and every deterministic subprocess. */
  execContext: ExecutionContext;
  /** Workflow name — used for persist_session keying + telemetry. */
  workflowName: string;
  workflowLevelOptions: WorkflowLevelOptions;
  /** Cross-run session persistence for this run, or undefined to skip. */
  persistScope: PersistScope | undefined;
  /** Workflow-level default for per-node `persist_session` (opt-in). */
  workflowPersistSessions: boolean;
  /**
   * Stable cross-invocation artifact scope dir (`scopes/<workflow>/<scope>/`), or
   * undefined when the run cannot use session persistence (`runMayPersistSessions`,
   * which also counts composed fan-out bodies). When set,
   * persistence-participating nodes with `output_type` mirror their typed sidecars
   * here, and a cold session resume points the user at the prior invocation's
   * artifacts by reference (#1846). Always undefined for loop_group bodies
   * (which also run with `persistScope: undefined`).
   */
  scopeArtifactsDir: string | undefined;
}

/**
 * Shared context for {@link runLayers}. Bundles the run-level invariants (deps, platform,
 * run record, resolved provider/model/options, paths, config) together with the per-subgraph
 * mutable state (the node set + its pre-computed topological layers, the shared output map,
 * session threading, usage accumulators, and resume cache).
 *
 * The top-level DAG and each `loop_group` body iteration construct their own context: the
 * top-level call uses `workflow.nodes` / a fresh `nodeOutputs`; a loop-group body uses the
 * group's `nodes` / a per-iteration scoped `nodeOutputs` (reset each iteration) and a
 * `stepNamePrefix` of `'{groupId}.'` that namespaces the persisted `step_name` of EVERY
 * body event — runLayers' own control events (skip/trigger_rule/when) AND the lifecycle
 * events emitted inside executeAgentNode / executeBashNode / executeScriptNode /
 * executeLoopNode / executeApprovalNode. Body lifecycle rows additionally carry `iteration`
 * in `data`. The in-process emitter payloads stay raw (unprefixed) — see #2090.
 */
export interface RunLayersContext extends RunInputs, RunDerived {
  /** One node dispatch, shared by its inner retry attempts. Never mutate the parent context. */
  nodeInvocation?: NodeInvocation;
  /** Last captured attempt for this isolated dispatch; unexpected failures retain its attribution. */
  currentExecution?: NodeExecutionRecord;
  /**
   * Ids of the nodes in this concurrent layer that have taken their
   * `mutates_checkout: false` snapshot in this run, shared by the layer's nodes. A
   * violation names the others as nodes that also ran in the layer; add-only, so a
   * named node may have finished before the write. A node that was skipped or
   * reused from a prior run never snapshots and is never named. Undefined when the
   * layer runs sequentially. Set per layer; never inherited.
   */
  guardedLayerSnapshots?: Set<string>;
  bodyGateOwner?: { nodeId: string; bodyGateId: string; iteration: number };
  unfinishedInvocations?: DagResumeSnapshot['unfinishedInvocations'];
  /** Each workflow path dispatches once per segment; prior events are the fixed accounting baseline. */
  reportedChildUsage?: DagResumeSnapshot['reportedChildUsage'];
  unattributedChildUsagePaths?: DagResumeSnapshot['unattributedChildUsagePaths'];
  /** The run budget's live ledger; set only when the workflow declares `budget:`. */
  runBudget?: RunBudgetLedger;
  // --- per-subgraph mutable state (varies between top-level DAG and loop_group body) ---
  /** Pre-computed topological layers (caller builds once — body shape is static). runLayers walks ONLY these; there is deliberately no flat node list here. */
  layers: GraphPlan['layers'];
  /** A settled enclosing body failure prevents later interactions, including nested ones. */
  interactionAdmission?: InteractionAdmission;
  /** Shared node-output map (caller owns; runLayers writes node results here). */
  nodeOutputs: Map<string, NodeOutput>;
  /** Prior body outputs available to a loop-group iteration's `when:` conditions. */
  loopPrevOutputs?: ReadonlyMap<string, NodeOutput>;
  /**
   * Awaited after a complete layer has been aggregated and before lifecycle status is
   * observed. The top-level DAG uses this to durably capture authored run state at
   * the first point it exists; loop_group bodies have no run-level hook.
   */
  afterLayer?: () => Promise<void>;
  /**
   * Finish an already-claimed deterministic subgraph when a sibling pauses the parent.
   * Composed fan-out bodies set this after their durable start claim: load-time
   * validation proves they cannot create the pause themselves, and finishing the outer
   * node's claimed work avoids leaving an unresolved durable start. Cancellation and
   * deletion still stop between layers, and unclaimed instances still cannot start.
   */
  claimedWorkPausePolicy?: ClaimedWorkPausePolicy;
  /** Resume cache: node ids that completed in a prior run (top-level only; undefined for body). */
  priorCompletedNodes?: Map<string, PersistedNodeOutput>;
  /**
   * Failures a run continued after a pause had already moved past (top-level only):
   * those nodes replay their failure instead of running again. Undefined on a retry.
   */
  replayedFailures?: ReadonlyMap<string, PriorFailedNode>;
  nodeSessionHandles?: Map<string, SequentialSessionCursor>;
  namedResumeSourceIds?: ReadonlySet<string>;
  bodySessionCursors?: Map<string, SessionCursor>;
  bodySessionCursorAncestry?: Map<string, Map<string, SessionCursor>>;
  /** Sequential-session threading cursor (mutated by runLayers). Provider-tagged so the
   *  session is only threaded into nodes that resolve to the SAME provider (#1992). */
  lastSequentialSession: SequentialSessionCursor | undefined;
  /**
   * Provider/model conflicts already reported to the user this run, keyed
   * `declared|resolved|modelRef`. A conflict the author wrote once at workflow level is
   * collapsed onto every node (#1764), so without this one mistake produces one message
   * per node. Genuinely distinct per-node conflicts still each get their own. Shared by
   * reference with loop_group body contexts so an iteration cannot re-report.
   */
  warnedProviderConflicts: Set<string>;
  /** Run-level usage accumulators (mutated by runLayers; caller reads after). */
  totalCostUsd: number | undefined;
  totalTokens: TokenUsage | undefined;
  totalTokensUnknown?: boolean;
  /** Prefix prepended to every persisted `step_name` ('' for top-level, '{groupId}.' for a loop_group body). */
  stepNamePrefix: string;
  /** Complete runtime loop_group lineage for typed body artifacts; empty at top level. */
  loopGroupPath: NodeArtifactLoopFrame[];
  /**
   * One {@link LoopBodyScope} per enclosing loop_group iteration, outermost first; empty
   * outside a loop_group body. Every body node template resolves its `$LOOP_PREV.*` and
   * `$LOOP_USER_INPUT` references against these, in the same pass as its other references.
   */
  loopBodyScopes: readonly LoopBodyScope[];
  /**
   * Per-iteration `$LOOP_USER_INPUT` free-text for loop_group body `exec:` nodes, delivered
   * into the subprocess as an env var (#2115, #2725). `script:` nodes never splice this into
   * source (unsafe for TS/Python) and rely on this env var exclusively. `bash:` nodes get it
   * as a second channel alongside the loop scope's shell-quoted splice of the literal
   * `$LOOP_USER_INPUT` token — this env var is what covers an indirect
   * read (`${LOOP_USER_INPUT}`, `printenv`, `env`) that splice can't reach. Only non-empty on
   * the first resumed iteration of an interactive group; undefined for the top-level DAG
   * (top-level exec nodes have no loop user input).
   */
  bodyLoopUserInput?: string;
}

/**
 * Capture immutable attribution before one execution attempt starts.
 *
 * `checkoutStart` is this attempt's checkout sample. The first sample also becomes the
 * invocation's, and the dispatch context keeps that invocation, so a retry or a resumed
 * continuation is compared with where the invocation began rather than where it paused.
 */
export function beginExecution(
  ctx: RunLayersContext,
  node: DagNode,
  options: {
    provider?: string;
    model?: string;
    tier?: TierName;
    effort?: EffortLevel;
    sessionId?: string;
    capabilities?: ProviderCapabilities;
    checkoutStart?: CheckoutObservation;
  } = {}
): NodeExecutionRecord {
  let invocation = ctx.nodeInvocation ?? newNodeInvocation(ctx.loopGroupPath);
  if (options.checkoutStart !== undefined && invocation.checkoutStart === undefined) {
    invocation = { ...invocation, checkoutStart: options.checkoutStart };
  }
  ctx.nodeInvocation = invocation;
  const execution = startNodeExecution({
    runId: ctx.workflowRun.id,
    path: ctx.stepNamePrefix + node.id,
    node,
    invocation,
    ...options,
  });
  ctx.currentExecution = execution;
  return execution;
}

/**
 * Sample the checkout a node is about to execute against, through the run's execution
 * backend. Taken at every attempt start of a node that runs code or an agent there.
 */
export function observeNodeCheckout(ctx: RunLayersContext): Promise<CheckoutObservation> {
  return observeCheckout(ctx.cwd, ctx.execContext, {
    runId: ctx.workflowRun.id,
    artifactsDir: ctx.artifactsDir,
  });
}

export function aiNodeEnvironment(
  ctx: RunLayersContext,
  execution: NodeExecutionRecord
): Record<string, string> {
  return buildAiNodeEnvironment(
    execution,
    ctx.execContext.kind === 'host' ? process.env.ARCHON_CLI_COMMAND : undefined
  );
}

/**
 * The checkpoint through which a node another node names in `context: { resume }` records
 * its provider session as soon as the provider reports it. Undefined for every other node.
 */
export function sessionCheckpoint(
  ctx: RunLayersContext,
  node: DagNode,
  provider: string
): SessionCheckpoint | undefined {
  if (ctx.nodeSessionHandles === undefined || ctx.namedResumeSourceIds?.has(node.id) !== true) {
    return undefined;
  }
  return async (sessionId: string): Promise<void> => {
    await ctx.deps.store.upsertWorkflowRunNodeSession({
      workflow_run_id: ctx.workflowRun.id,
      node_id: ctx.stepNamePrefix + node.id,
      provider,
      provider_session_id: sessionId,
    });
  };
}

/**
 * A loop_group body node that resumes a source outside its own body owns a private
 * session cursor continued across iterations. A same-body source is forked afresh in
 * every iteration, so its consumer never owns a cursor.
 */
export function ownsBodySessionCursor(
  node: { context?: NodeContext },
  bodyNodeIds: ReadonlySet<string>
): boolean {
  return isNodeContextResume(node.context) && !bodyNodeIds.has(node.context.resume);
}
