/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { existsSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'path';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { discoverScriptsForCwd } from './script-discovery';
import type {
  IWorkflowPlatform,
  WorkflowMessageMetadata,
  WorkflowConfig,
  WorkflowDeps,
} from './deps';
import type {
  SendQueryOptions,
  NodeConfig,
  ProviderCapabilities,
  TokenUsage,
  ExecutionContext,
  OverlayChangeSummary,
} from '@archon/providers/types';
import { CONTAINER_ENV_DENYLIST, remapContainerPath } from '@archon/providers/types';
import type { ContainerRunContext } from './container-context';
import { WRITEBACK_GATE_NODE_ID } from './container-context';
import {
  getProviderCapabilities,
  getRegisteredProviders,
  isRegisteredProvider,
  validateStructuredOutput,
} from '@archon/providers';
import type {
  DagNode,
  ApprovalNode,
  BashNode,
  CommandNode,
  PromptNode,
  LoopNode,
  LoopGroupNode,
  ScriptNode,
  WorkflowNode,
  NodeOutput,
  TriggerRule,
  WorkflowRun,
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
  WorkflowSource,
  LoopGateRunMetadata,
  ApprovalContext,
  WorkflowEvidencePolicy,
} from './schemas';
import {
  isBashNode,
  isLoopNode,
  isLoopGroupNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isIncludeNode,
  isWorkflowNode,
  isPersistableNode,
  isApprovalContext,
} from './schemas';
import { formatToolCall } from './utils/tool-formatter';
import { createLogger, captureWorkflowCompleted } from '@archon/paths';
import type { WorkflowErrorClass, WorkflowNodeType } from '@archon/paths';
import { getWorkflowEventEmitter } from './event-emitter';
import { evaluateCondition } from './condition-evaluator';
import {
  declaredFieldsFromSchema,
  resolveNodeOutputField,
  OutputRefError,
  similarNodeIds,
} from './output-ref';
import { writeNodeArtifact, readNodeArtifacts } from './artifacts-index';
import {
  logNodeStart,
  logNodeComplete,
  logNodeSkip,
  logNodeError,
  logAssistant,
  logTool,
  logWorkflowComplete,
  logWorkflowError,
} from './logger';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from './utils/idle-timeout';
import {
  classifyError,
  toTelemetryErrorClass,
  detectCreditExhaustion,
  loadCommandPrompt,
  substituteWorkflowVariables,
  buildPromptWithContext,
  detectCompletionSignal,
  stripCompletionTags,
  isInlineScript,
  formatSubprocessFailure,
  safeSendMessage,
  type SendMessageContext,
} from './executor-shared';
import {
  isLiteralSpec,
  isTierName,
  resolveModelSpec,
  routePresetEffort,
  type ModelAliasPreset,
  type ResolvedAiProfile,
  type TierName,
} from './model-validation';

/**
 * Closed-set node type for telemetry — mirrors the DagNode discriminators.
 * The final `'prompt'` arm is the fallthrough: a future node type added to
 * the schema without a guard here would be reported as `'prompt'` (a metrics
 * misclassification, not a privacy issue) — extend this when adding node types.
 */
function dagNodeTelemetryType(node: DagNode): WorkflowNodeType {
  if (isBashNode(node)) return 'bash';
  if (isScriptNode(node)) return 'script';
  if (isLoopNode(node)) return 'loop';
  if (isLoopGroupNode(node)) return 'loop_group';
  if (isApprovalNode(node)) return 'approval';
  if (isCancelNode(node)) return 'cancel';
  if ('command' in node) return 'command';
  return 'prompt';
}

/**
 * Usage totals for the terminal telemetry event. Fields are omitted (not sent
 * as zero) when nothing was reported, so absence in PostHog means "providers
 * reported no usage", never "zero spend".
 */
function buildRunUsageProps(totals: {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  loopIterations: number;
}): { costUsd?: number; tokensIn?: number; tokensOut?: number; loopIterations?: number } {
  return {
    ...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
    ...(totals.tokensIn > 0 || totals.tokensOut > 0
      ? { tokensIn: totals.tokensIn, tokensOut: totals.tokensOut }
      : {}),
    ...(totals.loopIterations > 0 ? { loopIterations: totals.loopIterations } : {}),
  };
}

/**
 * Failure taxonomy for the terminal telemetry event: the first failed node's
 * type and a fixed-enum error class derived from its stored error message.
 * Returns {} when nothing failed. Categorical only — the error text itself
 * is classified locally and never transmitted.
 */
function firstFailedNodeTaxonomy(
  nodeOutputs: Map<string, NodeOutput>,
  nodes: readonly DagNode[]
): { errorClass?: WorkflowErrorClass; failedNodeType?: WorkflowNodeType } {
  for (const [nodeId, output] of nodeOutputs) {
    if (output.state !== 'failed') continue;
    const node = nodes.find(n => n.id === nodeId);
    const taxonomy: { errorClass: WorkflowErrorClass; failedNodeType?: WorkflowNodeType } = {
      errorClass: toTelemetryErrorClass(classifyError(new Error(output.error))),
    };
    if (node) {
      taxonomy.failedNodeType = dagNodeTelemetryType(node);
    }
    return taxonomy;
  }
  return {};
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.dag-executor');
  return cachedLog;
}

const MCP_FAILURE_PREFIX = 'MCP server connection failed: ';

/** A failed MCP server entry parsed from the SDK message. `segment` is the
 *  original substring (e.g. `"telegram (disconnected)"`) so callers can
 *  reconstruct a filtered message without losing the status detail. */
export interface McpFailureEntry {
  name: string;
  segment: string;
}

function applyPresetOptions(
  provider: string,
  preset: ModelAliasPreset | undefined,
  node: DagNode,
  workflowLevelOptions: WorkflowLevelOptions,
  nodeConfig: NodeConfig,
  assistantConfig: Record<string, unknown>
): void {
  if (!preset) return;

  if (
    preset.thinking !== undefined &&
    node.thinking === undefined &&
    workflowLevelOptions.thinking === undefined
  ) {
    nodeConfig.thinking = preset.thinking;
  }

  if (
    preset.effort === undefined ||
    node.effort !== undefined ||
    workflowLevelOptions.effort !== undefined
  ) {
    return;
  }

  const routed = routePresetEffort(provider, preset.effort);
  if (!routed) {
    // Cross-provider effort mismatch (e.g. a `tiers:` entry sets `effort: max`
    // on a Codex tier). Warn rather than silently drop it — fail-loud per the
    // project's fail-fast guideline.
    getLog().warn(
      { provider, effort: preset.effort, nodeId: node.id },
      'dag.preset_effort_unsupported'
    );
    return;
  }
  if (routed.field === 'effort') {
    nodeConfig.effort = routed.value;
  } else {
    assistantConfig.modelReasoningEffort = routed.value;
  }
}

/**
 * Parse the SDK's "MCP server connection failed: a (status), b (status)"
 * message. Best-effort — malformed or prefix-free messages return `[]`.
 * Entries are ordered and deduped by name; the segment of the first
 * occurrence wins.
 */
export function parseMcpFailureServerNames(message: string): McpFailureEntry[] {
  if (!message.startsWith(MCP_FAILURE_PREFIX)) return [];
  const seen = new Set<string>();
  const entries: McpFailureEntry[] = [];
  for (const raw of message.slice(MCP_FAILURE_PREFIX.length).split(', ')) {
    const segment = raw.trim();
    const name = segment.split(' (')[0]?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      entries.push({ name, segment });
    }
  }
  return entries;
}

/**
 * Load the set of MCP server names that a node's `mcp:` config file declares.
 *
 * Returns an empty set when no `mcp:` is configured or when the file can't be
 * read/parsed. Used to distinguish workflow-configured failures (surface to
 * user) from user-plugin failures (silent debug log). We intentionally do not
 * validate or env-expand here — the provider owns full loading and will
 * surface its own parse errors via the warning channel if the file is broken.
 *
 * Read failures are debug-logged so a transient I/O error (EMFILE/EBUSY) that
 * leaves us with an empty set — and silently reclassifies a real workflow-MCP
 * failure as plugin noise — is at least observable.
 */
export async function loadConfiguredMcpServerNames(
  nodeMcpPath: string | undefined,
  cwd: string
): Promise<Set<string>> {
  if (!nodeMcpPath) return new Set();
  const fullPath = isAbsolute(nodeMcpPath) ? nodeMcpPath : resolvePath(cwd, nodeMcpPath);
  try {
    const raw = await readFile(fullPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(Object.keys(parsed as Record<string, unknown>));
  } catch (err) {
    getLog().debug({ err, nodeMcpPath, fullPath }, 'dag.mcp_filter_config_read_failed');
    return new Set();
  }
}

/** Workflow-level Claude SDK options — per-node overrides take precedence via ?? */
interface WorkflowLevelOptions {
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  fallbackModel?: string;
  betas?: string[];
  sandbox?: SandboxSettings;
  /** Workflow-level tier keyword (when `workflow.model` is small/medium/large), so
   *  nodes that inherit the workflow model can still surface the `← tier` annotation. */
  workflowTier?: 'small' | 'medium' | 'large';
}

/** Internal node execution result — extends NodeOutput with cost data for aggregation. */
type NodeExecutionResult = NodeOutput & {
  costUsd?: number;
  /** Provider-reported token usage for the node (loop nodes: summed across iterations). */
  tokens?: TokenUsage;
  /** Loop nodes only: number of iterations executed. */
  loopIterations?: number;
};

// ---------------------------------------------------------------------------
// workflow: (sub-run) node — cross-run composition (#2121 Phase 2)
// ---------------------------------------------------------------------------

/** Terminal (or paused) outcome of a child sub-run, as consumed by a `workflow:` node. */
export interface ChildWorkflowOutcome {
  childRunId: string;
  status: 'completed' | 'paused' | 'failed' | 'cancelled';
  /** Child's terminal output (its first sink node's output), threaded as `$<id>.output`. */
  output?: string;
  /** Child run's total cost, rolled up into the parent node's costUsd (D8). */
  costUsd?: number;
  tokens?: TokenUsage;
  error?: string;
}

/** Arguments for starting (or resuming a failed) child sub-run. */
export interface RunChildWorkflowArgs {
  parentRun: WorkflowRun;
  nodeId: string;
  childWorkflowName: string;
  /** Data string forwarded as the child's user_message (substituted upstream). */
  input: string;
  cwd: string;
  /** Platform conversation id (shared with the parent). */
  conversationId: string;
  /** DB conversation UUID (shared with the parent — satisfies the child's NOT-NULL FK). */
  conversationDbId: string;
  userId?: string;
  /** Codebase id inherited from the parent (env vars + attribution). */
  codebaseId?: string;
  /** Present only when re-driving a FAILED child on parent resume (D5 recovery path). */
  resumeFailedChild?: WorkflowRun;
}

/**
 * Injected closure that starts a child workflow run in-process (#2121 Phase 2).
 * Defined in executor.ts — it captures `executeWorkflow` from the SAME module, so
 * there is no static import cycle — and threaded through executeDagWorkflow →
 * RunLayersContext so a `workflow:` node can spawn its child without dag-executor
 * importing executor.
 */
export type RunChildWorkflowFn = (args: RunChildWorkflowArgs) => Promise<ChildWorkflowOutcome>;

/**
 * Derive a child's node-facing outcome from its persisted run row. Cost, tokens,
 * and the terminal `summary` are written into the child run's metadata at
 * completion (see executeDagWorkflow completion + Task 12), so both the
 * synchronous path (runChildWorkflow reads the row back) and the re-entry path
 * (executeWorkflowNode finds an already-terminal child) read the same source.
 */
export function childOutcomeFromRun(run: WorkflowRun): ChildWorkflowOutcome {
  if (run.status === 'running' || run.status === 'pending') {
    // Fail fast instead of a blind narrowing cast: every caller must hand this a
    // settled (terminal or paused) run. A non-settled status slipping through
    // would fall out of interpret()'s switch and corrupt the node result with
    // `undefined` — throwing turns that into a loud, attributable node failure.
    throw new Error(
      `Sub-run ${run.id} is still '${run.status}' — cannot derive a node outcome from an unsettled run.`
    );
  }
  const md: Record<string, unknown> = run.metadata ?? {};
  const input = typeof md.total_tokens_in === 'number' ? md.total_tokens_in : undefined;
  const output = typeof md.total_tokens_out === 'number' ? md.total_tokens_out : undefined;
  const tokens =
    input !== undefined || output !== undefined
      ? { input: input ?? 0, output: output ?? 0 }
      : undefined;
  return {
    childRunId: run.id,
    status: run.status,
    output: typeof md.summary === 'string' ? md.summary : undefined,
    costUsd: typeof md.total_cost_usd === 'number' ? md.total_cost_usd : undefined,
    tokens,
    error: typeof md.error === 'string' ? md.error : undefined,
  };
}

/**
 * Sequential-session threading cursor. Tagged with the resolved provider that produced
 * the session so a downstream sequential node on a DIFFERENT provider starts fresh
 * instead of attempting an impossible cross-provider resume (#1992) — a foreign session
 * id hard-fails Claude ("No conversation found with session ID") and cold-falls-back
 * on Codex.
 */
interface SequentialSessionCursor {
  sessionId: string;
  provider: string;
}

/** Per-node result surfaced by a runLayers layer closure. `sessionProvider` tags which
 *  resolved provider created `output.sessionId` (session-producing paths only). */
interface LayerNodeResult {
  nodeId: string;
  output: NodeExecutionResult;
  sessionProvider?: string;
}

/** Throttle state for cancel checks (reads — no write contention in WAL mode) */
const lastNodeCancelCheck = new Map<string, number>();
const CANCEL_CHECK_INTERVAL_MS = 10_000;

/**
 * Policy for the during-streaming cancel check: should the currently-streaming
 * node be allowed to continue for a given observed run status?
 *
 * - `running`: the normal case → continue.
 * - `paused`: a concurrent approval node in the same topological layer has
 *   transitioned the run to paused. The streaming node should finish its own
 *   output; workflow progression is gated by the approval node, not by tearing
 *   down unrelated in-flight streams.
 * - `null` (run deleted), `cancelled`, `failed`, `completed`, or any other
 *   state → abort the stream.
 *
 * Exported for unit testing; the full streaming-cancel branch in
 * `executeNodeInternal` only fires once per 10s (CANCEL_CHECK_INTERVAL_MS), so
 * integration-level coverage of the policy is timing-sensitive and flaky.
 */
export function shouldContinueStreamingForStatus(status: string | null): boolean {
  return status === 'running' || status === 'paused';
}

/** Throttle state for activity heartbeat writes (only used for stale/zombie detection) */
const lastNodeActivityUpdate = new Map<string, number>();
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;

/** Default DAG node retry for TRANSIENT errors */
const DEFAULT_NODE_MAX_RETRIES = 2;
const DEFAULT_NODE_RETRY_DELAY_MS = 3000;

/**
 * Max validate-and-reask attempts for a `best-effort` provider whose structured
 * output fails schema validation (separate from transient-error retries above).
 * Enforced providers don't reask — a validation failure there is a genuine edge
 * (refusal / max_tokens truncation) and fails fast.
 */
const STRUCTURED_OUTPUT_MAX_REASKS = 3;

/**
 * Tracks live background Agent tasks within one provider stream pass (#2083).
 *
 * Since Claude SDK 0.3.193 the model can delegate work to asynchronous
 * background agents, so a `result` chunk only means "top-level turn done" —
 * NOT "all work done". Breaking out of the stream loop at a result while
 * background tasks are live calls `.return()` on the generator chain, which
 * tears down the SDK subprocess (SIGTERM) and kills the tasks — the artifacts
 * they were producing silently never appear.
 *
 * Fed by the provider's `background_tasks` chunk (SDK `background_tasks_changed`,
 * v0.3.209+): a level signal carrying the FULL live set, REPLACE semantics.
 * Both dag-executor stream loops (AI node + loop iteration) instantiate one
 * tracker per stream pass and gate their break-on-result on it: when the set
 * is non-empty, keep consuming — the SDK keeps the subprocess alive until the
 * tasks drain, gives the agent a follow-up turn to integrate their output, and
 * emits a final `result` (verified empirically against SDK 0.3.209). The wait
 * is bounded by the existing idle-timeout machinery: `task_progress` chunks
 * (~30s cadence while subagents run) reset the idle timer, and a genuinely
 * hung task hits the normal idle-timeout path.
 *
 * Providers that never emit the chunk (Codex/Pi/OpenCode/Copilot, older Claude
 * CLIs) leave the set empty → break-on-first-result behavior is unchanged.
 */
function createBackgroundTaskTracker(): {
  update(tasks: { taskId: string; description: string }[]): void;
  shouldBreakOnResult(): boolean;
  count(): number;
  ids(): string[];
  /** True exactly once — lets the caller announce the wait a single time per pass. */
  shouldAnnounceWait(): boolean;
} {
  const live = new Map<string, string>(); // taskId → description
  let announced = false;
  return {
    update(tasks): void {
      live.clear();
      for (const t of tasks) live.set(t.taskId, t.description);
    },
    shouldBreakOnResult(): boolean {
      return live.size === 0;
    },
    count(): number {
      return live.size;
    },
    ids(): string[] {
      return [...live.keys()];
    },
    shouldAnnounceWait(): boolean {
      if (announced) return false;
      announced = true;
      return true;
    },
  };
}

/**
 * Get effective retry config for a DAG node.
 */
function getEffectiveNodeRetryConfig(node: DagNode): {
  maxRetries: number;
  delayMs: number;
  onError: 'transient' | 'all';
} {
  if ('retry' in node && node.retry) {
    return {
      maxRetries: node.retry.max_attempts,
      delayMs: node.retry.delay_ms ?? DEFAULT_NODE_RETRY_DELAY_MS,
      onError: node.retry.on_error ?? 'transient',
    };
  }
  return {
    maxRetries: DEFAULT_NODE_MAX_RETRIES,
    delayMs: DEFAULT_NODE_RETRY_DELAY_MS,
    onError: 'transient',
  };
}

/**
 * Check if a NodeOutput failure is transient by delegating to classifyError.
 * FATAL patterns (auth, permission, credits) take priority over TRANSIENT patterns,
 * matching the same precedence rules as classifyError(). This prevents an error
 * message that contains both a FATAL substring and a TRANSIENT substring (e.g.
 * "unauthorized: process exited with code 1") from being silently retried.
 */
function isTransientNodeError(errorMessage: string): boolean {
  return classifyError(new Error(errorMessage)) === 'TRANSIENT';
}

/**
 * Retry config for a deterministic (bash/script) node.
 *
 * Same field mapping as {@link getEffectiveNodeRetryConfig}, but deterministic
 * nodes get NO default: an absent `retry:` block returns `undefined` (single
 * attempt) rather than the AI-node default of {@link DEFAULT_NODE_MAX_RETRIES}
 * transient retries. Retry is strictly opt-in so side-effectful scripts (deploys,
 * `gh` mutations, external CLIs) are never silently re-run on a transient-looking
 * failure. Delegates so the two configs can't derive the retry block differently.
 */
function getExplicitNodeRetryConfig(
  node: DagNode
): ReturnType<typeof getEffectiveNodeRetryConfig> | undefined {
  return 'retry' in node && node.retry ? getEffectiveNodeRetryConfig(node) : undefined;
}

/**
 * Decide whether a failed node output warrants another retry attempt.
 *
 * Shared by {@link runNodeRetryLoop} for every node type so the retry decision
 * cannot drift. FATAL errors (auth, permissions, credit balance) are never
 * retried, even when `on_error: all` — matching {@link classifyError}'s
 * FATAL-over-TRANSIENT precedence. Also returns `isTransient` so callers can
 * label the notification.
 */
function shouldRetryNodeFailure(
  output: NodeOutput,
  onError: 'transient' | 'all'
): { shouldRetry: boolean; isTransient: boolean } {
  // Only failed outputs carry `error` (discriminated union); a non-failed output
  // is never retried. Callers already guard on `state === 'failed'`, but narrow
  // here too so `output.error` type-checks and the helper is safe standalone.
  if (output.state !== 'failed') {
    return { shouldRetry: false, isTransient: false };
  }
  const isFatal = output.error ? classifyError(new Error(output.error)) === 'FATAL' : false;
  const isTransient = output.error ? isTransientNodeError(output.error) : false;
  const shouldRetry = !isFatal && (onError === 'all' || (onError === 'transient' && isTransient));
  return { shouldRetry, isTransient };
}

/**
 * Run a node executor with the shared retry loop: exponential backoff, FATAL
 * never retried, and a platform notification before each retry. Used by both the
 * AI-node path in {@link runLayers} and {@link runDeterministicNodeWithRetry} so
 * the backoff math and user-facing wording are defined once and can't drift.
 * `initialOutput` seeds `output` for the (unreachable) zero-iteration case and is
 * generic in `T` so callers keep their richer result type (e.g. NodeExecutionResult).
 */
async function runNodeRetryLoop<T extends NodeOutput>(
  node: DagNode,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  retryConfig: { maxRetries: number; delayMs: number; onError: 'transient' | 'all' },
  run: () => Promise<T>,
  initialOutput: T
): Promise<T> {
  let output = initialOutput;
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    output = await run();
    if (output.state !== 'failed') break;

    const { shouldRetry, isTransient } = shouldRetryNodeFailure(output, retryConfig.onError);
    if (!shouldRetry || attempt >= retryConfig.maxRetries) break;

    const delayMs = retryConfig.delayMs * Math.pow(2, attempt);
    getLog().warn(
      {
        nodeId: node.id,
        attempt: attempt + 1,
        maxRetries: retryConfig.maxRetries,
        delayMs,
        error: output.error,
      },
      'dag_node_transient_retry'
    );

    const errorKind = isTransient ? 'transient error' : 'error';
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Node \`${node.id}\` failed with ${errorKind} (attempt ${String(attempt + 1)}/${String(retryConfig.maxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
      { workflowId: workflowRun.id, nodeName: node.id }
    );

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return output;
}

/**
 * Run a deterministic (bash/script) node with opt-in retry.
 *
 * Deterministic nodes get exactly one attempt unless they declare an explicit
 * `retry:` block. When they do, transient/all failures are retried via the shared
 * {@link runNodeRetryLoop} (same exponential-backoff + FATAL-never-retried
 * semantics as AI nodes). The single-attempt default is preserved so scripts with
 * side effects aren't silently re-executed (#2088).
 */
async function runDeterministicNodeWithRetry(
  node: DagNode,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  run: () => Promise<NodeOutput>
): Promise<NodeOutput> {
  const retryConfig = getExplicitNodeRetryConfig(node);
  // No explicit retry: preserve the single-attempt deterministic-node default.
  if (!retryConfig) {
    return run();
  }
  return runNodeRetryLoop(node, platform, conversationId, workflowRun, retryConfig, run, {
    state: 'failed',
    output: '',
    error: 'Node did not execute',
  });
}

/**
 * Single-quote a string for safe inline shell use.
 * Replaces each ' with '\'' (end quote, literal single-quote, re-open quote).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Shell-quote a value for bash, or write it to a file and return a $(cat ...) reference
 * when the value exceeds the inline size threshold.
 */
function shellQuoteOrFile(
  value: string,
  nodeId: string,
  field: string | undefined,
  outputFileDir: string | undefined
): string {
  if (outputFileDir && value.length > NODE_OUTPUT_FILE_THRESHOLD) {
    const filename = field ? `${nodeId}.${field}.nodeoutput` : `${nodeId}.nodeoutput`;
    const filePath = joinPath(outputFileDir, filename);
    try {
      writeFileSync(filePath, value);
      return `$(cat ${shellQuote(filePath)})`;
    } catch (fileErr) {
      const err = fileErr as Error;
      getLog().error(
        { err, nodeId, field, valueSize: value.length, filePath },
        'dag.large_output_file_write_failed'
      );
      return shellQuote(value); // fallback: inline (pre-file-spill behavior)
    }
  }
  return shellQuote(value);
}

/**
 * Substitute $node_id.output and $node_id.output.field references in a prompt.
 * Called AFTER the standard substituteWorkflowVariables pass.
 *
 * KEEP IN SYNC (three ref-surface enumerations must agree): the fields this is called on
 * (search call sites below), the loader's validateDagStructure scan (which validates the
 * same refs), and rewriteNodeOutputRefs in include-expander.ts (which renames them on
 * inline). Adding a substituted field to one means updating all three.
 *
 * @param escapedForBash - When true, wraps substituted values in single quotes so
 *   they are safe to embed in bash scripts passed to `bash -c`. Set true only for
 *   bash node script substitution; AI/command prompt substitution should use false.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash = false,
  outputFileDir?: string
): string {
  return prompt.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
    (match, nodeId: string, field: string | undefined) => {
      const nodeOutput = nodeOutputs.get(nodeId);
      if (!nodeOutput) {
        // A `.field` ref that resolves to no output (a typo the load-time validator
        // can't always see — refs in bash/script/approval/cancel fields and inside
        // command-file content aren't scanned — or a real node that hasn't run before
        // this reference) fails the consuming node loudly, matching the strict
        // no-silent-drop posture for known-producer field access below. The whole-text
        // `$id.output` form stays lenient ('') as a long-documented surface (changing
        // it is a bigger compatibility break).
        if (field) {
          throw new OutputRefError(
            nodeId,
            field,
            'unknown-node',
            similarNodeIds(nodeId, nodeOutputs.keys())
          );
        }
        getLog().warn({ nodeId, match }, 'dag_node_output_ref_unknown_node');
        return escapedForBash ? "''" : '';
      }
      if (!field) {
        return escapedForBash
          ? shellQuoteOrFile(nodeOutput.output, nodeId, undefined, outputFileDir)
          : nodeOutput.output;
      }
      // No-silent-drop field access (resolveNodeOutputField): prefers the parsed
      // structuredOutput payload, falls back to parsing `output`, and THROWS an
      // OutputRefError for an unresolvable reference (field not in the producer's
      // declared schema, or a schemaless node whose output isn't JSON / lacks the
      // key). The throw propagates to the dag-executor's per-node catch → the
      // consuming node fails visibly instead of receiving a poisoned ''. The only
      // value that resolves to empty is an author-declared-optional field.
      const resolution = resolveNodeOutputField(nodeOutput, nodeId, field);
      if (resolution.kind === 'empty') return escapedForBash ? "''" : '';
      const value = resolution.value;
      if (typeof value === 'string')
        return escapedForBash ? shellQuoteOrFile(value, nodeId, field, outputFileDir) : value;
      // numbers and booleans are shell-safe without quoting: JSON disallows
      // NaN/Infinity so String(number) is digits/sign/'.', and String(boolean) is
      // 'true'/'false' — no shell metacharacters.
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      // arrays and objects: JSON-stringify so downstream tools (jq, etc.) get a
      // single JSON literal argument.
      const json = JSON.stringify(value);
      return escapedForBash ? shellQuoteOrFile(json, nodeId, field, outputFileDir) : json;
    }
  );
}

/**
 * Collect the static ids of every node in a loop_group body, recursing into nested
 * loop_group bodies. This is the *typo detector* for `$LOOP_PREV.<id>.output.<field>`
 * refs: an id that matches no node anywhere in the (possibly nested) body is a genuine
 * typo, distinct from a real body id that merely has no prior-iteration output yet.
 *
 * The transitive set (not just the outer group's direct ids) is deliberate: nested
 * loop_group bodies reuse the OUTER loop's prior-iteration snapshot, so a ref inside a
 * nested body may legitimately name an inner-group node id (which resolves to '' at the
 * outer granularity — see {@link applyLoopPrevToBodyNode}). Including descendants keeps
 * such real-but-empty refs lenient while still catching ids that exist nowhere.
 */
function collectLoopBodyNodeIds(
  nodes: readonly DagNode[],
  into: Set<string> = new Set<string>()
): Set<string> {
  for (const n of nodes) {
    into.add(n.id);
    if (isLoopGroupNode(n)) collectLoopBodyNodeIds(n.loop_group.nodes, into);
  }
  return into;
}

/**
 * Resolve `$LOOP_PREV.<nodeId>.output` and `$LOOP_PREV.<nodeId>.output.<field>` references
 * against a loop_group body's *prior-iteration* node outputs.
 *
 * Cross-iteration analog of {@link substituteNodeOutputRefs}: where `$nodeId.output` reads
 * a node's output from the *current* iteration's scope, `$LOOP_PREV.<nodeId>.output` reads
 * the same node's output from the *previous* iteration — letting a body node reference what
 * a sibling (or itself) produced one iteration ago. On iteration 1 (no prior iteration)
 * `loopPrevOutputs` is empty/undefined and every `$LOOP_PREV.*` ref resolves to '' (matching
 * the empty-on-first semantics of the single-node `$LOOP_PREV_OUTPUT`).
 *
 * Field access reuses {@link resolveNodeOutputField} for the same strict no-silent-drop
 * semantics (declared-schema typo / schemaless non-JSON / missing key → throws
 * `OutputRefError`, propagating to the consuming node's failure). The only value that
 * resolves to empty is an author-declared-optional field — or any ref on iteration 1.
 *
 * Two static id sets from the enclosing loop_group (both via {@link collectLoopBodyNodeIds}
 * / its immediate-ids counterpart) drive the absent-output branch. `knownBodyIds` is the
 * TRANSITIVE set (this group's body plus every nested descendant); `directBodyIds` is only
 * THIS group's immediate body ids. When output is absent, the id is classified:
 *   - not in `knownBodyIds` → a typo that matches no body node anywhere. A `.field` ref
 *     throws `OutputRefError('unknown-node')` (loud, with a did-you-mean) — the loop_group
 *     analog of the same fix at the `$node.output.field` seam (#2135/#2142); a whole-text
 *     `$LOOP_PREV.<id>.output` ref stays lenient ('').
 *   - in `knownBodyIds` but not in `directBodyIds` → the id belongs to a NESTED loop_group,
 *     not this group's own body. The literal token is left INTACT (`return match`) so the
 *     inner loop_group resolves it against its OWN prior-iteration snapshot when it runs
 *     (nested body nodes get a second substituteLoopPrevRefs pass — the outer pass must not
 *     consume their tokens, or the inner loop could never see its own prior iteration).
 *   - in `directBodyIds` with no prior output → legitimate iteration-1 / skipped absence → ''.
 *
 * When `knownBodyIds` is undefined (raw callers with no static set) the seam stays fully
 * lenient — every absent ref resolves to '', preserving the pre-#2142 behavior.
 */
export function substituteLoopPrevRefs(
  prompt: string,
  loopPrevOutputs: Map<string, NodeOutput> | undefined,
  escapedForBash = false,
  outputFileDir?: string,
  knownBodyIds?: ReadonlySet<string>,
  directBodyIds?: ReadonlySet<string>
): string {
  // Fast path: no refs to resolve. When refs ARE present but the map is empty/undefined
  // (iteration 1 — no prior iteration), we still run the replace so each ref resolves to
  // '' via the `!nodeOutput` branch below, rather than leaving a literal `$LOOP_PREV.…`.
  if (!prompt.includes('$LOOP_PREV.')) {
    return prompt;
  }
  return prompt.replace(
    /\$LOOP_PREV\.([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
    (match, nodeId: string, field: string | undefined) => {
      const nodeOutput = loopPrevOutputs?.get(nodeId);
      if (!nodeOutput || nodeOutput.state === 'skipped' || nodeOutput.state === 'pending') {
        if (knownBodyIds) {
          if (!knownBodyIds.has(nodeId)) {
            // Typo: id matches NO body node anywhere in the enclosing loop_group (a typo
            // the loader can't see — it never scans `$LOOP_PREV.*` refs). A `.field` ref
            // fails the consuming node loudly, mirroring substituteNodeOutputRefs /
            // resolveOutputRef; a whole-text ref stays lenient ('' below). The static set
            // is required: the runtime `loopPrevOutputs` map is empty on iteration 1, so it
            // alone cannot tell a typo from a legitimate first-pass absence.
            if (field) {
              throw new OutputRefError(
                nodeId,
                field,
                'unknown-node',
                similarNodeIds(nodeId, knownBodyIds)
              );
            }
          } else if (directBodyIds && !directBodyIds.has(nodeId)) {
            // Known id owned by a NESTED loop_group, not this group's own body. Leave the
            // literal token intact so the inner loop_group resolves it against its OWN
            // prior-iteration snapshot when it executes — the outer pass must not consume
            // it, or the inner loop could never reference its own previous iteration.
            return match;
          }
          // else: known + direct id with no prior output → legitimate iteration-1 / skipped
          // absence → lenient '' below.
        }
        // No prior-iteration output for this body node (iteration 1, or the node was
        // skipped / hasn't settled last iteration). Resolve to empty rather than
        // throwing — the author opted into a cross-iteration ref, and absence on the
        // first pass (or after a skipped node) is expected.
        getLog().debug({ nodeId, match }, 'loop_group_prev_ref_no_prior_output');
        return escapedForBash ? "''" : '';
      }
      if (!field) {
        return escapedForBash
          ? shellQuoteOrFile(nodeOutput.output, nodeId, undefined, outputFileDir)
          : nodeOutput.output;
      }
      const resolution = resolveNodeOutputField(nodeOutput, nodeId, field);
      if (resolution.kind === 'empty') return escapedForBash ? "''" : '';
      const value = resolution.value;
      if (typeof value === 'string')
        return escapedForBash ? shellQuoteOrFile(value, nodeId, field, outputFileDir) : value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      const json = JSON.stringify(value);
      return escapedForBash ? shellQuoteOrFile(json, nodeId, field, outputFileDir) : json;
    }
  );
}

// buildSDKHooksFromYAML moved to @archon/providers/src/claude/provider.ts
// loadMcpConfig moved to @archon/providers/src/mcp/config.ts

/**
 * Resolve per-node provider and model.
 * Node-level overrides take precedence over workflow defaults.
 *
 * Provider-agnostic: builds universal base options + raw nodeConfig.
 * The provider internally translates nodeConfig to SDK-specific options.
 * Capability warnings inform users when features are unsupported.
 */
async function resolveNodeProviderAndModel(
  node: DagNode,
  workflowProvider: string,
  workflowModel: string | undefined,
  config: WorkflowConfig,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRunId: string,
  _cwd: string,
  workflowLevelOptions: WorkflowLevelOptions,
  aiProfile?: ResolvedAiProfile,
  workflowPreset?: ModelAliasPreset,
  execContext: ExecutionContext = { kind: 'host' }
): Promise<{
  provider: string;
  model: string | undefined;
  options: SendQueryOptions | undefined;
  tier?: TierName;
}> {
  const configuredProvider: string = node.provider ?? workflowProvider;
  let provider: string = configuredProvider;
  let preset: ModelAliasPreset | undefined;
  let model: string | undefined;

  if (node.model) {
    if (aiProfile) {
      const modelSpec = resolveModelSpec(aiProfile, node.model);
      if (isLiteralSpec(modelSpec)) {
        model = modelSpec.literal;
      } else {
        preset = modelSpec;
        provider = modelSpec.provider;
        model = modelSpec.model;
        if (node.provider && node.provider !== provider) {
          getLog().warn(
            {
              nodeId: node.id,
              configuredProvider: node.provider,
              resolvedProvider: provider,
              modelRef: node.model,
            },
            'dag.model_provider_conflict'
          );
          const delivered = await safeSendMessage(
            platform,
            conversationId,
            `Warning: Node '${node.id}' sets provider '${node.provider}' but model '${node.model}' resolves to provider '${provider}' — using '${provider}'.`,
            { workflowId: workflowRunId, nodeName: node.id }
          );
          if (!delivered) {
            getLog().error(
              { nodeId: node.id, workflowRunId },
              'dag.model_provider_conflict_warning_delivery_failed'
            );
          }
        }
      }
    } else {
      model = node.model;
    }
  }

  if (!isRegisteredProvider(provider)) {
    throw new Error(
      `Node '${node.id}': unknown provider '${provider}'. ` +
        `Registered: ${getRegisteredProviders()
          .map(p => p.id)
          .join(', ')}`
    );
  }

  const providerAssistantConfig = config.assistants[provider];
  model ??=
    provider === workflowProvider
      ? workflowModel
      : (providerAssistantConfig?.model as string | undefined);
  const effectivePreset =
    preset ?? (!node.model && provider === workflowProvider ? workflowPreset : undefined);

  // Get provider capabilities for capability warnings (static lookup, no instantiation)
  const caps = getProviderCapabilities(provider);

  // Runtime backstop for container dispatch: the run-start pre-scan
  // (collectContainerIncompatibleProviders) hand-mirrors this same provider
  // resolution, so it could drift. Re-check the RESOLVED provider here, at the
  // actual dispatch point, so a container turn can never reach a provider that
  // can't honor it — no silent host downgrade (defense in depth).
  if (execContext.kind === 'container' && !caps.containerExec) {
    throw new Error(
      `Provider '${provider}' cannot run inside a container yet (containerExec ` +
        'capability). Use provider claude, or run without --container.'
    );
  }

  // Capability warnings — inform users when features are unsupported
  const capChecks: [string, keyof ProviderCapabilities, boolean][] = [
    [
      'allowed_tools/denied_tools',
      'toolRestrictions',
      node.allowed_tools !== undefined || node.denied_tools !== undefined,
    ],
    ['hooks', 'hooks', node.hooks !== undefined],
    ['mcp', 'mcp', node.mcp !== undefined],
    ['skills', 'skills', node.skills !== undefined && node.skills.length > 0],
    ['agents', 'agents', node.agents !== undefined],
    ['effort', 'effortControl', (node.effort ?? workflowLevelOptions.effort) !== undefined],
    ['thinking', 'thinkingControl', (node.thinking ?? workflowLevelOptions.thinking) !== undefined],
    ['maxBudgetUsd', 'costControl', node.maxBudgetUsd !== undefined],
    [
      'fallbackModel',
      'fallbackModel',
      (node.fallbackModel ?? workflowLevelOptions.fallbackModel) !== undefined,
    ],
    ['sandbox', 'sandbox', (node.sandbox ?? workflowLevelOptions.sandbox) !== undefined],
    ['settingSources', 'settingSources', node.settingSources !== undefined],
    ['env', 'envInjection', (config.envVars && Object.keys(config.envVars).length > 0) === true],
  ];

  const unsupported: string[] = [];
  for (const [field, cap, isSet] of capChecks) {
    if (isSet && !caps[cap]) {
      unsupported.push(field);
    }
  }

  if (unsupported.length > 0) {
    getLog().warn({ nodeId: node.id, provider, unsupported }, 'dag.unsupported_capabilities');
    const delivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' uses ${unsupported.join(', ')} but ${provider} doesn't support ${unsupported.length === 1 ? 'it' : 'them'} — ${unsupported.length === 1 ? 'this will be' : 'these will be'} ignored.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
    if (!delivered) {
      getLog().error({ nodeId: node.id, workflowRunId }, 'dag.capability_warning_delivery_failed');
    }
  }

  // Surface agents + skills ID collision — user-defined 'dag-node-skills'
  // silently overrides Archon's skills wrapper. User wins (by design) but
  // the operator should know they've neutered the wrapper.
  if (
    node.agents?.['dag-node-skills'] !== undefined &&
    node.skills !== undefined &&
    node.skills.length > 0
  ) {
    getLog().warn({ nodeId: node.id }, 'dag.agents_skills_id_collision');
    await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' defines an agent with reserved ID 'dag-node-skills' AND uses 'skills:'. Your inline agent overrides Archon's automatic skills wrapper — the 'skills:' field will NOT take effect. Rename the agent or remove 'skills:' to fix.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
  }

  // Build universal base options
  const baseOptions: SendQueryOptions = {};
  if (model) baseOptions.model = model;
  // Only annotate options with the execution context when running in a container
  // (Phase B). Host is the default/absent case, so host runs produce byte-identical
  // options — the provider infers host behavior from the missing field.
  if (execContext.kind === 'container') {
    baseOptions.execContext = execContext;
  }
  if (config.envVars && Object.keys(config.envVars).length > 0) {
    baseOptions.env = config.envVars;
  }
  if (node.systemPrompt !== undefined) baseOptions.systemPrompt = node.systemPrompt;
  if (node.maxBudgetUsd !== undefined) baseOptions.maxBudgetUsd = node.maxBudgetUsd;
  const fb = node.fallbackModel ?? workflowLevelOptions.fallbackModel;
  if (fb) baseOptions.fallbackModel = fb;
  if (node.output_format) {
    baseOptions.outputFormat = { type: 'json_schema', schema: node.output_format };
  }

  // Build raw nodeConfig — provider translates internally
  const nodeConfig: NodeConfig = {
    nodeId: node.id,
    mcp: node.mcp,
    hooks: node.hooks,
    skills: node.skills,
    agents: node.agents,
    // Portable per-node Pi extension posture (#2133) — Pi provider reads it as
    // the highest-precedence override; ignored by other providers.
    pi: node.pi,
    allowed_tools: node.allowed_tools,
    denied_tools: node.denied_tools,
    effort: node.effort ?? workflowLevelOptions.effort,
    thinking: node.thinking ?? workflowLevelOptions.thinking,
    sandbox: node.sandbox ?? workflowLevelOptions.sandbox,
    betas: node.betas ?? workflowLevelOptions.betas,
    output_format: node.output_format,
    maxBudgetUsd: node.maxBudgetUsd,
    systemPrompt: node.systemPrompt,
    fallbackModel: fb,
    settingSources: node.settingSources,
  };

  // Pass assistantConfig from config — provider parses internally
  const assistantConfig: Record<string, unknown> = { ...(config.assistants[provider] ?? {}) };
  applyPresetOptions(
    provider,
    effectivePreset,
    node,
    workflowLevelOptions,
    nodeConfig,
    assistantConfig
  );

  const options: SendQueryOptions = {
    ...baseOptions,
    nodeConfig,
    assistantConfig,
  };

  // `node.model` is the original ref (e.g. "large"); `model` is the resolved
  // string (e.g. "opus"). Surface `tier` when the ref was a tier keyword — from
  // the node's own `model`, or (when the node inherits the workflow-level model)
  // from the workflow tier, mirroring the effectivePreset inheritance condition.
  const tier: 'small' | 'medium' | 'large' | undefined =
    node.model && isTierName(node.model)
      ? node.model
      : !node.model && provider === workflowProvider
        ? workflowLevelOptions.workflowTier
        : undefined;

  return { provider, model, options, tier };
}

/** Evaluate trigger rule for a node given its upstream states */
export function checkTriggerRule(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>
): 'run' | 'skip' {
  const nodeDeps = node.depends_on ?? [];
  if (nodeDeps.length === 0) return 'run';

  const upstreams = nodeDeps.map(
    id =>
      nodeOutputs.get(id) ??
      ({
        state: 'failed',
        output: '',
        error: `upstream '${id}' missing from outputs`,
      } as NodeOutput)
  );
  const rule: TriggerRule = node.trigger_rule ?? 'all_success';

  switch (rule) {
    case 'all_success':
      return upstreams.every(u => u.state === 'completed') ? 'run' : 'skip';
    case 'one_success':
      return upstreams.some(u => u.state === 'completed') ? 'run' : 'skip';
    case 'none_failed_min_one_success': {
      const anyFailed = upstreams.some(u => u.state === 'failed');
      const anySucceeded = upstreams.some(u => u.state === 'completed');
      return !anyFailed && anySucceeded ? 'run' : 'skip';
    }
    case 'all_done':
      return upstreams.every(u => u.state !== 'pending' && u.state !== 'running') ? 'run' : 'skip';
  }
}

/**
 * Build topological layers from DAG nodes using Kahn's algorithm.
 * Layer 0: nodes with no dependencies.
 * Layer N: nodes whose dependencies are all in layers 0..N-1.
 *
 * Cycle detection: if the sum of all layer sizes < nodes.length, a cycle exists.
 * (Cycle detection at load time is the primary guard; this is a runtime safety check.)
 */
export function buildTopologicalLayers(nodes: readonly DagNode[]): DagNode[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  const layers: DagNode[][] = [];
  let ready = [...nodes].filter(n => (inDegree.get(n.id) ?? 0) === 0);

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const node of ready) {
      for (const depId of dependents.get(node.id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) nextIds.push(depId);
      }
    }
    ready = nextIds
      .map(id => nodes.find(n => n.id === id))
      .filter((n): n is DagNode => n !== undefined);
  }

  const totalPlaced = layers.reduce((sum, l) => sum + l.length, 0);
  if (totalPlaced < nodes.length) {
    // Should never happen — cycle detection runs at load time
    throw new Error(
      '[DagExecutor] Cycle detected at runtime — was cycle detection skipped at load?'
    );
  }

  return layers;
}

/**
 * Execute a single DAG node. Returns NodeExecutionResult regardless of success/failure.
 * Always accumulates assistant text output (for $node_id.output substitution).
 * Parallel nodes and context: 'fresh' nodes always receive fresh sessions (caller ensures resumeSessionId is undefined).
 */
async function executeNodeInternal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: CommandNode | PromptNode,
  provider: string,
  nodeOptions: SendQueryOptions | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  resumeSessionId: string | undefined,
  configuredCommandFolder?: string,
  issueContext?: string,
  resolvedModel?: string,
  resolvedTier?: TierName,
  stepNamePrefix = '',
  iteration?: number
): Promise<NodeExecutionResult> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Persisted step_name is namespaced ('<groupId>.' prefix) for loop_group bodies;
  // '' for the top-level DAG → identical to node.id. The in-process emitter payloads
  // below stay raw (node.id) — live SSE/CLI consumers key off those. See #2090.
  const stepName = stepNamePrefix + node.id;
  // Only present inside a loop_group body — tags lifecycle rows with the iteration so
  // multi-iteration runs are disaggregatable in the event log.
  const iterationData = iteration !== undefined ? { iteration } : {};

  const configuredMcpNames = await loadConfiguredMcpServerNames(node.mcp, cwd);

  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, node.command ?? '<inline>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: stepName,
      data: {
        command: node.command ?? null,
        provider,
        model: resolvedModel,
        tier: resolvedTier,
        ...iterationData,
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.command ?? node.id,
    provider,
    model: resolvedModel,
    tier: resolvedTier,
  });

  // Load prompt
  let rawPrompt: string;
  if (node.command !== undefined) {
    const promptResult = await loadCommandPrompt(deps, cwd, node.command, configuredCommandFolder);
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      await logNodeError(logDir, workflowRun.id, node.id, errMsg);
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: { error: errMsg },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
            'workflow_event_persist_failed'
          );
        });
      emitter.emit({
        type: 'node_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.command,
        error: errMsg,
      });
      return { state: 'failed', output: '', error: errMsg };
    }
    rawPrompt = promptResult.content;
  } else {
    // node is PromptNode — prompt: string is guaranteed by the discriminated union
    rawPrompt = node.prompt;
  }

  // Standard variable substitution
  let substitutedPrompt: string;
  try {
    substitutedPrompt = buildPromptWithContext(
      rawPrompt,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      `dag node '${node.id}' prompt`
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ nodeId: node.id, error: err.message }, 'dag.node_prompt_substitution_failed');
    await safeSendMessage(
      platform,
      conversationId,
      `Node '${node.id}' failed: ${err.message}`,
      nodeContext
    );
    return { state: 'failed', output: '', error: err.message };
  }

  // Substitute upstream node output references
  const finalPrompt = substituteNodeOutputRefs(substitutedPrompt, nodeOutputs);

  const aiClient = deps.getAgentProvider(provider);
  const streamingMode = platform.getStreamingMode();

  let nodeOutputText = ''; // Always accumulate regardless of streaming mode
  let structuredOutput: unknown;
  let newSessionId: string | undefined;
  let nodeResumed: boolean | undefined;
  let nodeTokens: TokenUsage | undefined;
  let nodeCostUsd: number | undefined;
  let nodeStopReason: string | undefined;
  let nodeNumTurns: number | undefined;
  let nodeModelUsage: Record<string, unknown> | undefined;
  const batchMessages: string[] = [];

  // Create per-node abort controller for idle timeout cleanup
  const nodeAbortController = new AbortController();
  // Fork when resuming — leaves the source session untouched so retries are safe.
  const shouldForkSession = resumeSessionId !== undefined;
  const nodeOptionsWithAbort: SendQueryOptions | undefined = {
    ...nodeOptions,
    abortSignal: nodeAbortController.signal,
    ...(shouldForkSession ? { forkSession: true } : {}),
  };
  let nodeIdleTimedOut = false;
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;
  let lastToolStartedAt: { toolName: string; startedAt: number } | null = null;
  // Task ids still live when the stream ended abnormally (idle timeout /
  // subprocess death) — recorded on the node_completed event so an incomplete
  // node never masquerades as a clean success (#2083).
  let backgroundTasksIncomplete: string[] = [];

  // Best-effort providers (Pi/Copilot) get a bounded validate-and-reask loop: on a
  // structured-output validation miss, re-run the stream with the schema errors
  // appended. Enforced providers and non-output_format nodes get 0 reasks.
  const maxReasks =
    getProviderCapabilities(provider).structuredOutput === 'best-effort' &&
    nodeOptions?.outputFormat
      ? STRUCTURED_OUTPUT_MAX_REASKS
      : 0;
  let accumulatedCostUsd: number | undefined;

  // One sendQuery stream pass. Resets the per-attempt accumulators it mutates
  // (output text, structured output, the batched-message buffer, per-pass cost,
  // idle-timeout flag) so a prior reask attempt's state never leaks into this one,
  // then streams. Throws on SDK error / budget cap (propagates to the outer catch
  // — those failures are never reasked).
  const runStreamPass = async (
    attemptPrompt: string,
    attemptResumeId: string | undefined
  ): Promise<void> => {
    nodeOutputText = '';
    structuredOutput = undefined;
    batchMessages.length = 0; // else a failed attempt's prose flushes during reask
    nodeCostUsd = undefined;
    nodeIdleTimedOut = false;
    backgroundTasksIncomplete = [];
    const backgroundTasks = createBackgroundTaskTracker();
    for await (const msg of withIdleTimeout(
      aiClient.sendQuery(attemptPrompt, cwd, attemptResumeId, nodeOptionsWithAbort),
      effectiveIdleTimeout,
      () => {
        nodeIdleTimedOut = true;
        getLog().warn(
          { nodeId: node.id, timeoutMs: effectiveIdleTimeout },
          'dag_node_idle_timeout_reached'
        );
        nodeAbortController.abort();
      }
    )) {
      const tickNow = Date.now();
      const nodeKey = `${workflowRun.id}:${node.id}`;

      // Cancel/pause check — read-only, no write contention in WAL mode (every 10s).
      //
      // `paused` is tolerated here: an approval node can transition the run to
      // paused while this concurrent node is mid-stream (same topological layer).
      // The streaming node should be allowed to finish its own output — the
      // paused gate owns workflow progression, not individual node lifecycles.
      // Only truly terminal / unknown states (null, cancelled, failed, completed)
      // abort the in-flight stream.
      if (tickNow - (lastNodeCancelCheck.get(nodeKey) ?? 0) > CANCEL_CHECK_INTERVAL_MS) {
        lastNodeCancelCheck.set(nodeKey, tickNow);
        try {
          const streamStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
          if (!shouldContinueStreamingForStatus(streamStatus)) {
            getLog().info(
              { workflowRunId: workflowRun.id, nodeId: node.id, status: streamStatus ?? 'deleted' },
              'dag.stop_detected_during_streaming'
            );
            nodeAbortController.abort();
            break;
          }
        } catch (cancelCheckErr) {
          getLog().warn(
            { err: cancelCheckErr as Error, workflowRunId: workflowRun.id, nodeId: node.id },
            'dag.status_check_failed'
          );
        }
      }

      // Activity heartbeat — write, throttled to every 60s (only for stale/zombie detection)
      if (tickNow - (lastNodeActivityUpdate.get(nodeKey) ?? 0) > ACTIVITY_HEARTBEAT_INTERVAL_MS) {
        lastNodeActivityUpdate.set(nodeKey, tickNow);
        try {
          await deps.store.updateWorkflowActivity(workflowRun.id);
        } catch (e) {
          getLog().warn(
            { err: e as Error, workflowRunId: workflowRun.id },
            'dag.activity_update_failed'
          );
        }
      }

      if (msg.type === 'assistant' && msg.content) {
        nodeOutputText += msg.content; // ALWAYS capture for $node_id.output
        if (streamingMode === 'stream' || msg.flush) {
          // `flush` chunks (e.g. Pi notify() emitting a plannotator review URL)
          // must reach the user before the node blocks. Drain any queued batch
          // content first so order is preserved.
          if (streamingMode === 'batch' && batchMessages.length > 0) {
            await safeSendMessage(
              platform,
              conversationId,
              batchMessages.join('\n\n'),
              nodeContext
            );
            batchMessages.length = 0;
          }
          await safeSendMessage(platform, conversationId, msg.content, nodeContext);
        } else {
          batchMessages.push(msg.content);
        }
        await logAssistant(logDir, workflowRun.id, msg.content);
      } else if (msg.type === 'tool' && msg.toolName) {
        const now = Date.now();

        // Emit tool_completed for the previous tool (fire-and-forget)
        if (lastToolStartedAt) {
          const prevTool = lastToolStartedAt;
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: prevTool.toolName,
            stepName: node.id,
            durationMs: now - prevTool.startedAt,
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: stepName,
              data: {
                tool_name: prevTool.toolName,
                duration_ms: now - prevTool.startedAt,
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
        }
        lastToolStartedAt = { toolName: msg.toolName, startedAt: now };

        // Emit tool_started for the current tool (fire-and-forget)
        getWorkflowEventEmitter().emit({
          type: 'tool_started',
          runId: workflowRun.id,
          toolName: msg.toolName,
          stepName: node.id,
        });

        if (streamingMode === 'stream') {
          const toolMsg = formatToolCall(msg.toolName, msg.toolInput);
          await safeSendMessage(platform, conversationId, toolMsg, nodeContext, {
            category: 'tool_call_formatted',
          } as WorkflowMessageMetadata);

          // Send structured event to adapters that support it (Web UI)
          if (platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, msg);
          }
        }
        await logTool(logDir, workflowRun.id, msg.toolName, msg.toolInput ?? {});

        // Persist tool_called event for ALL adapters (fire-and-forget)
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'tool_called',
            step_name: stepName,
            data: {
              tool_name: msg.toolName,
              tool_input: msg.toolInput ?? {},
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'tool_called' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'tool_result' && msg.toolName) {
        if (streamingMode === 'stream' && platform.sendStructuredEvent) {
          await platform.sendStructuredEvent(conversationId, msg);
        }
      } else if (msg.type === 'result') {
        // Emit tool_completed for the last tool in the node
        if (lastToolStartedAt) {
          const prevTool = lastToolStartedAt;
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: prevTool.toolName,
            stepName: node.id,
            durationMs: Date.now() - prevTool.startedAt,
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: stepName,
              data: {
                tool_name: prevTool.toolName,
                duration_ms: Date.now() - prevTool.startedAt,
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
          lastToolStartedAt = null;
        }
        if (msg.sessionId) newSessionId = msg.sessionId;
        if (msg.resumed !== undefined) nodeResumed = msg.resumed;
        if (msg.tokens) nodeTokens = msg.tokens;
        if (msg.cost !== undefined) nodeCostUsd = msg.cost;
        if (msg.stopReason !== undefined) nodeStopReason = msg.stopReason;
        if (msg.numTurns !== undefined) nodeNumTurns = msg.numTurns;
        if (msg.modelUsage) nodeModelUsage = msg.modelUsage;
        if (msg.structuredOutput !== undefined) structuredOutput = msg.structuredOutput;
        // Fail the node if the SDK reports a cost cap exceeded error
        if (msg.isError && msg.errorSubtype === 'error_max_budget_usd') {
          const cap = nodeOptions?.maxBudgetUsd;
          getLog().warn(
            { nodeId: node.id, maxBudgetUsd: cap, durationMs: Date.now() - nodeStartTime },
            'dag.node_budget_cap_exceeded'
          );
          throw new Error(
            `Node '${node.id}' exceeded cost cap${cap !== undefined ? ` of $${cap.toFixed(2)}` : ''}.`
          );
        }
        // Fail loudly on any other SDK error result. Previously we broke out of
        // the stream silently, producing empty/partial output without signaling
        // failure — which let failed iterations masquerade as successes.
        // Exception: errorSubtype === 'success' is the Claude SDK's marker for a
        // clean stop_sequence termination. The Claude provider already filters
        // this out, but the guard here keeps a third-party IAgentProvider that
        // forwards the SDK pair raw from producing a "SDK returned success"
        // false failure.
        if (msg.isError && msg.errorSubtype !== 'success') {
          const subtype = msg.errorSubtype ?? 'unknown';
          const errorsDetail = msg.errors?.length ? ` — ${msg.errors.join('; ')}` : '';
          getLog().error(
            {
              nodeId: node.id,
              errorSubtype: subtype,
              errors: msg.errors,
              sessionId: msg.sessionId,
              stopReason: msg.stopReason,
              durationMs: Date.now() - nodeStartTime,
            },
            'dag.node_sdk_error_result'
          );
          throw new Error(`Node '${node.id}' failed: SDK returned ${subtype}${errorsDetail}`);
        }
        if (backgroundTasks.shouldBreakOnResult()) {
          break; // Result is the "I'm done" signal — don't wait for subprocess to exit
        }
        // Result arrived with background Agent tasks still live (#2083).
        // Breaking here would .return() the generator chain → SDK cleanup →
        // SIGTERM the CLI → kill the tasks and lose their pending artifacts.
        // Keep consuming: the SDK holds the subprocess open until the tasks
        // drain, runs a follow-up turn to integrate their output, and emits a
        // final result (whose fields overwrite the captures above — correct,
        // since SDK cost/usage are session-cumulative). Bounded by the
        // existing idle timeout; task_progress chunks reset it.
        getLog().warn(
          {
            nodeId: node.id,
            taskCount: backgroundTasks.count(),
            taskIds: backgroundTasks.ids(),
          },
          'dag.node_result_with_live_background_tasks'
        );
        if (backgroundTasks.shouldAnnounceWait()) {
          await safeSendMessage(
            platform,
            conversationId,
            `⏳ Node \`${node.id}\`: turn ended with ${String(backgroundTasks.count())} background agent task(s) still running — waiting for them to finish before completing the node.`,
            nodeContext
          );
        }
      } else if (msg.type === 'background_tasks') {
        // Level signal (REPLACE semantics): swap the live set for the payload.
        backgroundTasks.update(msg.tasks);
      } else if (msg.type === 'system' && msg.content) {
        // Providers yield system chunks for user-actionable issues (missing env
        // vars, Haiku+MCP, structured output failures, etc.). MCP-failure
        // chunks need filtering: user-level plugin MCPs inherited from
        // `~/.claude/` (e.g. `telegram`) routinely fail to connect inside the
        // headless subprocess and aren't actionable for the workflow author.
        // Other warnings (⚠️) are always actionable and surface verbatim.
        if (msg.content.startsWith(MCP_FAILURE_PREFIX)) {
          const failedEntries = parseMcpFailureServerNames(msg.content);
          const workflowFailures = failedEntries.filter(e => configuredMcpNames.has(e.name));
          const pluginFailures = failedEntries.filter(e => !configuredMcpNames.has(e.name));

          if (workflowFailures.length > 0) {
            const filteredMsg = `${MCP_FAILURE_PREFIX}${workflowFailures.map(e => e.segment).join(', ')}`;
            getLog().warn(
              { nodeId: node.id, systemContent: filteredMsg },
              'dag.provider_warning_forwarded'
            );
            const delivered = await safeSendMessage(
              platform,
              conversationId,
              filteredMsg,
              nodeContext
            );
            if (!delivered) {
              getLog().error(
                { nodeId: node.id, workflowRunId: workflowRun.id },
                'dag.provider_warning_delivery_failed'
              );
            }
          }
          if (pluginFailures.length > 0) {
            getLog().debug(
              { nodeId: node.id, pluginFailures: pluginFailures.map(e => e.name) },
              'dag.mcp_plugin_connection_suppressed'
            );
          }
        } else if (msg.content.startsWith('⚠️')) {
          getLog().warn(
            { nodeId: node.id, systemContent: msg.content },
            'dag.provider_warning_forwarded'
          );
          const delivered = await safeSendMessage(
            platform,
            conversationId,
            msg.content,
            nodeContext
          );
          if (!delivered) {
            getLog().error(
              { nodeId: node.id, workflowRunId: workflowRun.id },
              'dag.provider_warning_delivery_failed'
            );
          }
        } else {
          getLog().debug(
            { nodeId: node.id, systemContent: msg.content },
            'dag.system_message_unhandled'
          );
        }
      } else if (msg.type === 'task_started') {
        // Subagent task spawned inside this node (Claude Task tool or
        // inline sub-agent). Forward as a task_activity emitter event so
        // the Web UI can render it as an expandable sub-item under the
        // parent node in the run detail view.
        getWorkflowEventEmitter().emit({
          type: 'task_activity',
          runId: workflowRun.id,
          nodeId: node.id,
          taskId: msg.taskId,
          activity: 'started',
          ...(msg.description !== undefined ? { description: msg.description } : {}),
          ...(msg.taskType !== undefined ? { taskType: msg.taskType } : {}),
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'task_activity',
            step_name: stepName,
            data: {
              task_id: msg.taskId,
              activity: 'started',
              ...(msg.description !== undefined ? { description: msg.description } : {}),
              ...(msg.taskType !== undefined ? { task_type: msg.taskType } : {}),
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'task_activity' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'task_progress') {
        getWorkflowEventEmitter().emit({
          type: 'task_activity',
          runId: workflowRun.id,
          nodeId: node.id,
          taskId: msg.taskId,
          activity: 'progress',
          ...(msg.description !== undefined ? { description: msg.description } : {}),
          ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
          ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
          ...(msg.lastToolName !== undefined ? { lastToolName: msg.lastToolName } : {}),
        });
        // task_progress fires every ~30s while a subagent is running. Persist
        // it for the timeline view but don't log — the volume would dominate.
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'task_activity',
            step_name: stepName,
            data: {
              task_id: msg.taskId,
              activity: 'progress',
              ...(msg.description !== undefined ? { description: msg.description } : {}),
              ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
              ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
              ...(msg.lastToolName !== undefined ? { last_tool_name: msg.lastToolName } : {}),
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'task_activity' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'task_notification') {
        getWorkflowEventEmitter().emit({
          type: 'task_activity',
          runId: workflowRun.id,
          nodeId: node.id,
          taskId: msg.taskId,
          activity: msg.status,
          ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
          ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
          ...(msg.outputFile ? { outputFile: msg.outputFile } : {}),
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'task_activity',
            step_name: stepName,
            data: {
              task_id: msg.taskId,
              activity: msg.status,
              ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
              ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
              // Where the settled task wrote its output — the artifact trail
              // for delegated work (#2083).
              ...(msg.outputFile ? { output_file: msg.outputFile } : {}),
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'task_activity' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'hook_started') {
        getWorkflowEventEmitter().emit({
          type: 'hook_activity',
          runId: workflowRun.id,
          nodeId: node.id,
          hookId: msg.hookId,
          hookName: msg.hookName,
          hookEvent: msg.hookEvent,
          activity: 'started',
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'hook_activity',
            step_name: stepName,
            data: {
              hook_id: msg.hookId,
              hook_name: msg.hookName,
              hook_event: msg.hookEvent,
              activity: 'started',
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'hook_activity' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'hook_response') {
        getWorkflowEventEmitter().emit({
          type: 'hook_activity',
          runId: workflowRun.id,
          nodeId: node.id,
          hookId: msg.hookId,
          hookName: msg.hookName,
          hookEvent: msg.hookEvent,
          activity: 'response',
          outcome: msg.outcome,
          ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'hook_activity',
            step_name: stepName,
            data: {
              hook_id: msg.hookId,
              hook_name: msg.hookName,
              hook_event: msg.hookEvent,
              activity: 'response',
              outcome: msg.outcome,
              ...(msg.exitCode !== undefined ? { exit_code: msg.exitCode } : {}),
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'hook_activity' },
              'workflow_event_persist_failed'
            );
          });
      }
      // rate_limit chunks: already log.warn'd in claude.ts; not surfaced to SSE per design
    }

    // Stream ended with background tasks still live: the SDK subprocess died or
    // the idle timeout fired mid-wait. The tasks' artifacts may be missing —
    // record the incompleteness (surfaced on the node_completed event) and warn
    // loudly instead of silently completing (#2083). Cancellation is exempt:
    // the node returns 'failed — Cancelled by user' and the warning would be noise.
    if (!backgroundTasks.shouldBreakOnResult()) {
      backgroundTasksIncomplete = backgroundTasks.ids();
      const cancelled = nodeAbortController.signal.aborted && !nodeIdleTimedOut;
      getLog().warn(
        {
          nodeId: node.id,
          taskIds: backgroundTasksIncomplete,
          idleTimedOut: nodeIdleTimedOut,
          cancelled,
        },
        'dag.node_stream_ended_with_live_background_tasks'
      );
      if (!cancelled) {
        await safeSendMessage(
          platform,
          conversationId,
          `⚠️ Node \`${node.id}\`: the provider stream ended with ${String(backgroundTasksIncomplete.length)} background agent task(s) still running (${backgroundTasksIncomplete.join(', ')}). Their output may be missing — treat this node's artifacts as potentially incomplete.`,
          nodeContext
        );
      }
    }
  };

  // Build a reask prompt: the original prompt + a correction block listing the
  // schema errors. The provider still augments with the JSON schema itself
  // (best-effort providers add their own JSON-only instruction), so this only
  // appends the per-attempt feedback.
  const buildReaskPrompt = (errors: string[]): string =>
    `${finalPrompt}\n\n--- CORRECTION ---\n` +
    `Your previous response did not satisfy the required JSON schema: ${errors.join('; ')}. ` +
    'Respond again with ONLY a JSON object matching the schema — no prose, no code fences.';

  // Observability: log every reask; notify the user once (first reask) so a
  // best-effort provider being auto-corrected isn't invisible.
  const emitReask = async (attempt: number): Promise<void> => {
    getLog().warn(
      { nodeId: node.id, workflowRunId: workflowRun.id, attempt, maxReasks },
      'dag.structured_output_reask'
    );
    if (attempt === 1) {
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ Node \`${node.id}\`: structured output didn't match the schema — asking the model to correct it (up to ${maxReasks} attempt(s)).`,
        nodeContext
      );
    }
  };

  try {
    // Validate-and-reask loop. Enforced / non-output_format nodes run exactly once
    // (maxReasks = 0). A best-effort node whose structured output is missing or
    // schema-invalid is re-run with the errors appended, up to maxReasks times;
    // exhaustion (or a non-best-effort failure) throws → failed node.
    let reaskAttempt = 0;
    let reaskPrompt = finalPrompt;
    // Set up the next reask attempt (increment, augment the prompt, notify).
    const scheduleReask = async (errors: string[]): Promise<void> => {
      reaskAttempt++;
      reaskPrompt = buildReaskPrompt(errors);
      await emitReask(reaskAttempt);
    };
    while (true) {
      // Fresh session per reask attempt (resume only the original session on the
      // first pass) so a prior invalid turn isn't carried forward.
      await runStreamPass(reaskPrompt, reaskAttempt === 0 ? resumeSessionId : undefined);
      if (nodeCostUsd !== undefined) {
        accumulatedCostUsd = (accumulatedCostUsd ?? 0) + nodeCostUsd;
      }
      // Carry the running total onto nodeCostUsd every pass so the exhaustion throw
      // paths (which jump straight to the outer catch) report cost across ALL reask
      // attempts, not just the last pass. runStreamPass clears it next iteration.
      nodeCostUsd = accumulatedCostUsd;

      // When output_format is set and the provider returned structured_output, use
      // it instead of the concatenated assistant text. Each provider normalizes its
      // own structured output onto the result chunk — no provider branching here.
      if (!nodeOptions?.outputFormat) break;

      // Don't reask after an idle-timeout/abort — those are genuine failures, not
      // validation misses; they fall through to a cause-specific throw below.
      const canReask =
        reaskAttempt < maxReasks && !nodeIdleTimedOut && !nodeAbortController.signal.aborted;

      if (structuredOutput !== undefined) {
        // Validate against the declared schema for EVERY provider — SDK-enforced
        // ones still bypass grammar-constrained decoding on a refusal / max_tokens
        // truncation. Fail-SAFE on an uncompilable schema, but surface it.
        let schemaCompileError: string | undefined;
        const validation = validateStructuredOutput(
          structuredOutput,
          node.output_format ?? {},
          compileMsg => {
            schemaCompileError = compileMsg;
          }
        );
        if (schemaCompileError !== undefined) {
          getLog().warn(
            { nodeId: node.id, workflowRunId: workflowRun.id, compileMsg: schemaCompileError },
            'dag.structured_output_schema_uncompilable'
          );
          await safeSendMessage(
            platform,
            conversationId,
            `⚠️ Node '${node.id}': its \`output_format\` schema could not be compiled (${schemaCompileError}), so the structured output was NOT validated against it. Fix the schema to enforce it.`,
            nodeContext
          );
        }
        if (validation.valid) {
          try {
            nodeOutputText =
              typeof structuredOutput === 'string'
                ? structuredOutput
                : JSON.stringify(structuredOutput);
          } catch (serializeErr) {
            const err = serializeErr as Error;
            throw new Error(
              `Node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`
            );
          }
          getLog().debug({ nodeId: node.id, streamingMode }, 'dag.structured_output_override');
          break;
        }
        // Invalid payload.
        getLog().warn(
          { nodeId: node.id, workflowRunId: workflowRun.id, errors: validation.errors },
          'dag.structured_output_invalid'
        );
        if (canReask) {
          await scheduleReask(validation.errors);
          continue;
        }
        throw new Error(
          `Node '${node.id}': output_format declared but the provider's structured output failed schema validation: ${validation.errors.join('; ')}`
        );
      }

      // No structured output at all (prose / refusal / parse miss / timeout).
      getLog().warn(
        { nodeId: node.id, workflowRunId: workflowRun.id },
        'dag.structured_output_missing'
      );
      if (canReask) {
        await scheduleReask(['no JSON object was found in the response']);
        continue;
      }
      // Surface the real cause: a timeout/abort produces no structured output too,
      // and reporting it as "the model replied with prose" would mislead.
      if (nodeIdleTimedOut) {
        throw new Error(
          `Node '${node.id}': timed out (no output for ${String(effectiveIdleTimeout / 60000)} min) before producing the required structured output.`
        );
      }
      throw new Error(
        `Node '${node.id}': output_format declared but the provider returned no schema-valid structured output. ` +
          'The model likely replied with prose, refused, or emitted unparseable JSON.'
      );
    }

    // Only post "completed via idle timeout" when output exists — zero-output timeout falls through to the empty-output guard below.
    if (nodeIdleTimedOut && (nodeOutputText.trim() !== '' || structuredOutput !== undefined)) {
      getLog().warn(
        { nodeId: node.id, timeoutMs: effectiveIdleTimeout },
        'dag_node_completed_via_idle_timeout'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ Node \`${node.id}\` completed via idle timeout (no output for ${String(effectiveIdleTimeout / 60000)} min). The AI likely finished but the subprocess didn't exit cleanly.`,
        nodeContext
      );
    }

    // If cancelled during streaming (not idle timeout), return as failed with cancel reason
    if (nodeAbortController.signal.aborted && !nodeIdleTimedOut) {
      const duration = Date.now() - nodeStartTime;
      getLog().info(
        { nodeId: node.id, durationMs: duration },
        'dag_node_cancelled_during_streaming'
      );

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: { error: 'Cancelled by user', duration_ms: duration },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
            'workflow_event_persist_failed'
          );
        });

      emitter.emit({
        type: 'node_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.command ?? node.id,
        error: 'Cancelled by user',
      });

      // Clean up throttle entries
      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return { state: 'failed', output: nodeOutputText, error: 'Cancelled by user' };
    }

    if (streamingMode === 'batch' && batchMessages.length > 0) {
      const batchContent =
        structuredOutput !== undefined && nodeOptions?.outputFormat
          ? nodeOutputText
          : batchMessages.join('\n\n');
      await safeSendMessage(platform, conversationId, batchContent, nodeContext);
    }

    // Detect credit exhaustion: SDK returns it as assistant text, not a thrown error.
    const creditError = detectCreditExhaustion(nodeOutputText);

    if (creditError) {
      const duration = Date.now() - nodeStartTime;
      getLog().warn({ nodeId: node.id, durationMs: duration }, 'dag.node_credit_exhausted');
      await logNodeError(logDir, workflowRun.id, node.id, creditError);

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: { error: creditError },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
            'workflow_event_persist_failed'
          );
        });

      emitter.emit({
        type: 'node_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.command ?? node.id,
        error: creditError,
      });

      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return { state: 'failed', output: nodeOutputText, error: creditError };
    }

    // Fail for zero output: covers both silent non-timeout exits AND idle-timeout before first token (time-to-first-token exceeded the window).
    if (nodeOutputText.trim() === '' && structuredOutput === undefined) {
      const duration = Date.now() - nodeStartTime;
      const emptyError = nodeIdleTimedOut
        ? `Node '${node.id}' timed out with no output (idle for ${String(effectiveIdleTimeout / 60000)} min). The provider did not emit any content before the watchdog fired — likely time-to-first-token exceeded the timeout. Consider increasing idle_timeout or reducing prompt size.`
        : `Node '${node.id}' produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.`;
      getLog().error({ nodeId: node.id, durationMs: duration }, 'dag.node_empty_output');
      await logNodeError(logDir, workflowRun.id, node.id, emptyError);

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: { error: emptyError, duration_ms: duration },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
            'workflow_event_persist_failed'
          );
        });

      emitter.emit({
        type: 'node_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.command ?? node.id,
        error: emptyError,
      });

      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return { state: 'failed', output: '', error: emptyError };
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, node.command ?? '<inline>', {
      durationMs: duration,
      tokens: nodeTokens,
    });

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: {
          duration_ms: duration,
          node_output: nodeOutputText,
          ...(nodeCostUsd !== undefined ? { cost_usd: nodeCostUsd } : {}),
          ...(nodeStopReason ? { stop_reason: nodeStopReason } : {}),
          ...(nodeNumTurns !== undefined ? { num_turns: nodeNumTurns } : {}),
          ...(nodeModelUsage ? { model_usage: nodeModelUsage } : {}),
          // Background Agent tasks still live when the stream ended (#2083) —
          // this node's artifacts may be incomplete.
          ...(backgroundTasksIncomplete.length > 0
            ? { background_tasks_incomplete: backgroundTasksIncomplete }
            : {}),
          ...iterationData,
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.command ?? node.id,
      duration,
      ...(nodeCostUsd !== undefined ? { costUsd: nodeCostUsd } : {}),
      ...(nodeStopReason ? { stopReason: nodeStopReason } : {}),
      ...(nodeNumTurns !== undefined ? { numTurns: nodeNumTurns } : {}),
    });

    // Clean up throttle entries on completion
    lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
    lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

    // Capture the producer's declared field set so downstream `$node.output.field`
    // refs can tell a declared-optional-absent field ('') from a typo (throws).
    // Only present when output_format declares an object with `properties`.
    const declaredFields = declaredFieldsFromSchema(node.output_format);

    return {
      state: 'completed',
      output: nodeOutputText,
      sessionId: newSessionId,
      costUsd: nodeCostUsd,
      ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(declaredFields !== undefined ? { declaredFields } : {}),
      ...(nodeResumed !== undefined ? { resumed: nodeResumed } : {}),
    };
  } catch (error) {
    const err = error as Error;

    // Clean up throttle entries on failure
    lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
    lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

    // If the abort was triggered by user cancel (not idle timeout), classify as cancel
    if (nodeAbortController.signal.aborted && !nodeIdleTimedOut) {
      getLog().info({ nodeId: node.id }, 'dag_node_cancelled_via_abort');
      return {
        state: 'failed',
        output: nodeOutputText,
        error: 'Cancelled by user',
        costUsd: nodeCostUsd,
        ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      };
    }

    getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    await logNodeError(logDir, workflowRun.id, node.id, err.message);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: { error: err.message },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.command ?? node.id,
      error: err.message,
    });

    return {
      state: 'failed',
      output: '',
      error: err.message,
      costUsd: nodeCostUsd,
      ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
    };
  }
}

/** Default timeout for subprocess nodes (bash, script): 2 minutes */
const SUBPROCESS_DEFAULT_TIMEOUT = 120_000;

/**
 * Reduce a host-resolved command to the name the container image exposes on
 * PATH: strip any directory (a host absolute path like the Windows Git-Bash
 * `bash.exe` doesn't exist in the Linux runner) and a trailing `.exe`. `bash`,
 * `bun`, and `uv` all live on the runner image's PATH.
 */
export function containerCommandName(cmd: string): string {
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  return base.replace(/\.exe$/i, '');
}

/**
 * Run a deterministic subprocess (bash/script node body, loop `until_bash`) under
 * the given execution context.
 *
 * `options.env` is the ARCHON-MANAGED env only (node vars + codebase env + creds)
 * — NEVER pre-merged with `process.env`. The host path layers it over the
 * (already-cleaned) host `process.env`, byte-identical to before. The container
 * path delivers ONLY that managed env via `docker exec -e` (host `process.env`
 * never crosses the boundary — the isolation invariant) and runs the command
 * in-container at the same absolute cwd, so `bash:`/`script:` nodes have no
 * host-escape hole.
 */
/**
 * Build the `docker exec` argv for a deterministic subprocess (bash/script) in a
 * container. Env is delivered ONLY via `-e` flags (never merged with the docker
 * CLI's own env / host process.env — the isolation invariant); the command name
 * is normalized to the in-container binary. Exported for the env-isolation
 * enforcement test.
 */
export function buildSubprocessDockerArgs(
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): string[] {
  // Prefer the in-container workdir (mount ≠ host cwd, e.g. the WSL sandbox's
  // /work); fall back to the host cwd for the same-path model.
  const dockerArgs = ['exec', '-w', execContext.workdir ?? options.cwd];
  if (execContext.execUser) dockerArgs.push('-u', execContext.execUser);
  for (const [key, value] of Object.entries(options.env)) {
    // Skip the denylist (PATH/HOME/…): a project env var must not clobber the
    // in-container binary/home resolution — same policy as the Claude spawn path.
    if (value === undefined || CONTAINER_ENV_DENYLIST.has(key)) continue;
    // Remap host path values (ARTIFACTS_DIR/LOG_DIR/DOCS_DIR) to their in-container
    // mount location; non-path values pass through unchanged.
    dockerArgs.push('-e', `${key}=${remapContainerPath(value, execContext.pathMap)}`);
  }
  dockerArgs.push(execContext.containerId, containerCommandName(cmd), ...args);
  return dockerArgs;
}

async function runSubprocess(
  execContext: ExecutionContext,
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  if (execContext.kind === 'container') {
    const dockerArgs = buildSubprocessDockerArgs(execContext, cmd, args, {
      cwd: options.cwd,
      env: options.env,
    });
    return execFileAsync('docker', dockerArgs, { timeout: options.timeout });
  }
  return execFileAsync(cmd, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    env: { ...process.env, ...options.env },
  });
}

/** Threshold (bytes) above which $nodeId.output values are written to a temp file
 *  instead of inlined as bash -c arguments, to avoid silent data corruption. */
const NODE_OUTPUT_FILE_THRESHOLD = 32_768;

/**
 * Execute a bash (shell script) DAG node.
 * Runs the script via `bash -c`, captures stdout as node output.
 * No AI session is created — bash nodes are free/deterministic.
 */
async function executeBashNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: BashNode,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string,
  envVars?: Record<string, string>,
  stepNamePrefix = '',
  iteration?: number,
  execContext: ExecutionContext = { kind: 'host' }
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  const iterationData = iteration !== undefined ? { iteration } : {};

  getLog().info({ nodeId: node.id, type: 'bash' }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<bash>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: stepName,
      data: { type: 'bash', ...iterationData },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  // Variable substitution on script
  const { prompt: substitutedScript } = substituteWorkflowVariables(
    node.bash,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext,
    undefined,
    undefined,
    undefined,
    { shellSafe: true }
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, true, logDir);

  const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;
  // Archon-managed env only — runSubprocess adds the host env for host runs and
  // delivers ONLY this bag into the container (host process.env never crosses).
  // Configured project env (envVars) spreads FIRST so the engine-reserved keys below
  // always win — a codebase env var named ARGUMENTS/CONTEXT/… must never shadow the
  // values this node delivers (that IS the injection-safe delivery channel, #2115).
  // The GitHub-token scrub keys (GH_TOKEN/GITHUB_TOKEN/COPILOT_GITHUB_TOKEN) are
  // disjoint from the reserved set and stay in the bag, still overriding the ambient
  // host token via runSubprocess's process.env layering — the scrub is unaffected.
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...(envVars ?? {}),
    ARTIFACTS_DIR: artifactsDir,
    LOG_DIR: logDir,
    BASE_BRANCH: baseBranch,
    USER_MESSAGE: workflowRun.user_message,
    ARGUMENTS: workflowRun.user_message,
    LOOP_USER_INPUT: '',
    LOOP_PREV_OUTPUT: '',
    REJECTION_REASON: '',
    CONTEXT: issueContext ?? '',
    EXTERNAL_CONTEXT: issueContext ?? '',
    ISSUE_CONTEXT: issueContext ?? '',
  };

  const bashPath = resolveBashPath();
  try {
    const { stdout, stderr } = await runSubprocess(execContext, bashPath, ['-c', finalScript], {
      cwd,
      timeout,
      env: subprocessEnv,
    });

    // Trim trailing newline from stdout (common shell behavior)
    const output = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'bash_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Bash node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, '<bash>', { durationMs: duration });

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: { duration_ms: duration, type: 'bash', node_output: output, ...iterationData },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      duration,
    });

    return { state: 'completed', output };
  } catch (error) {
    const err = error as Error & { killed?: boolean; code?: number | string; stderr?: string };
    const isTimeout = err.killed === true || (err.message ?? '').includes('timed out');
    const label = `Bash node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in — the timeout message also contains the
    // full `Command failed: bash -c <body>` line and would otherwise leak.
    const formatted = formatSubprocessFailure(err, label);
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `${label} timed out after ${String(timeout)}ms`;
    } else if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      errorMsg =
        `${label} failed: bash executable not found at '${bashPath}'. ` +
        'Set ARCHON_BASH_PATH if Git Bash is installed elsewhere ' +
        '(e.g. user-scope installer at %LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe).';
    } else if (err.code === 'EACCES') {
      errorMsg = `${label} failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = formatted.userMessage;
    }

    getLog().error(
      { ...formatted.logFields, nodeId: node.id, nodeType: 'bash', isTimeout },
      'dag_node_failed'
    );
    await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: { error: errorMsg, type: 'bash' },
      })
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      error: errorMsg,
    });

    return { state: 'failed', output: '', error: errorMsg };
  }
}

/**
 * User-controlled workflow variables that {@link executeScriptNode} delivers via
 * subprocess env vars instead of splicing into the script source. Matches the
 * literal `$VAR` form only (word-boundary lookahead) so `$LOOP_PREV.<id>.output`
 * refs and `process.env.ARGUMENTS`-style accessors never false-positive (#2115).
 */
const SCRIPT_USER_VAR_PATTERN =
  /\$(?:USER_MESSAGE|ARGUMENTS|LOOP_USER_INPUT|LOOP_PREV_OUTPUT|REJECTION_REASON|CONTEXT|EXTERNAL_CONTEXT|ISSUE_CONTEXT)(?![A-Za-z0-9_])/g;

/**
 * Migration aid (#2115): script bodies used to raw-splice user-controlled text
 * ($ARGUMENTS/$CONTEXT family/…) directly into TS/Python source — an injection
 * channel. Those refs are now delivered as env vars and no longer substituted, so
 * a literal `$VAR` left in the body silently stops resolving. Warn the author (log
 * + one concise platform line) with the language-appropriate accessor for one
 * release before the refs are removed. `script` is the post-workflow-var,
 * pre-node-output string so an expanded `$nodeId.output` value can't false-positive.
 */
async function warnOnLiteralUserVars(
  node: ScriptNode,
  script: string,
  platform: IWorkflowPlatform,
  conversationId: string,
  nodeContext: SendMessageContext
): Promise<void> {
  const matches = script.match(SCRIPT_USER_VAR_PATTERN);
  if (!matches) return;
  const unique = [...new Set(matches)];
  const accessor = unique
    .map(v => (node.runtime === 'uv' ? `os.environ['${v.slice(1)}']` : `process.env.${v.slice(1)}`))
    .join(', ');
  getLog().warn(
    { nodeId: node.id, runtime: node.runtime, vars: unique },
    'script_node_literal_user_var'
  );
  await safeSendMessage(
    platform,
    conversationId,
    `Script node '${node.id}': ${unique.join(', ')} ${unique.length > 1 ? 'are' : 'is'} no longer ` +
      'substituted into script source (security hardening, #2115). ' +
      `Read from the environment instead: ${accessor}.`,
    nodeContext
  );
}

/**
 * Execute a script (TypeScript via bun or Python via uv) DAG node.
 * Supports both inline code snippets and named scripts discovered from .archon/scripts/.
 * stdout is captured and trimmed as the node output; stderr is logged as a warning.
 */
async function executeScriptNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: ScriptNode,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string,
  envVars?: Record<string, string>,
  stepNamePrefix = '',
  iteration?: number,
  // Per-iteration $LOOP_USER_INPUT free-text for loop_group body scripts, delivered via
  // env (never spliced into source — #2115). '' for top-level scripts and non-first
  // iterations (mirrors executeBashNode, which delivers loop input via quoted splice).
  loopUserInput = '',
  execContext: ExecutionContext = { kind: 'host' }
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  const iterationData = iteration !== undefined ? { iteration } : {};

  getLog().info({ nodeId: node.id, type: 'script', runtime: node.runtime }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<script>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: stepName,
      data: { type: 'script', runtime: node.runtime, ...iterationData },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  // Variable substitution on script field.
  // shellSafe: true skips literal substitution of the user-controlled variables
  // ($ARGUMENTS/$USER_MESSAGE/$CONTEXT family/$LOOP_*/$REJECTION_REASON) so
  // attacker-influenced text is never spliced into the TS/Python source that
  // `bun -e` / `uv run python -c` executes. Those values ride subprocess env vars
  // below instead (read via process.env.X / os.environ['X']), mirroring the
  // executeBashNode hardening. $nodeId.output refs keep raw substitution — the
  // strict producer contract bounds those values (#2115).
  const { prompt: substitutedScript } = substituteWorkflowVariables(
    node.script,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext,
    undefined,
    undefined,
    undefined,
    { shellSafe: true }
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, false);

  // One-release migration warn for any literal user-controlled var ref that no
  // longer substitutes now that delivery moved to env vars (#2115).
  await warnOnLiteralUserVars(node, substitutedScript, platform, conversationId, nodeContext);

  const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;
  // Archon-managed env only — runSubprocess adds the host env for host runs and
  // delivers ONLY this bag into the container (host process.env never crosses).
  // User-controlled values ride env vars (never spliced into source) — the
  // sanctioned injection-safe channel, matching executeBashNode (#2115).
  // Configured project env (envVars) spreads FIRST so the engine-reserved keys below
  // always win — a codebase env var named ARGUMENTS/CONTEXT/… must never shadow this
  // delivery channel. The GitHub-token scrub keys are disjoint from the reserved set
  // and still override the ambient host token via runSubprocess (scrub unaffected).
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...(envVars ?? {}),
    ARTIFACTS_DIR: artifactsDir,
    LOG_DIR: logDir,
    BASE_BRANCH: baseBranch,
    USER_MESSAGE: workflowRun.user_message,
    ARGUMENTS: workflowRun.user_message,
    LOOP_USER_INPUT: loopUserInput,
    LOOP_PREV_OUTPUT: '',
    REJECTION_REASON: '',
    CONTEXT: issueContext ?? '',
    EXTERNAL_CONTEXT: issueContext ?? '',
    ISSUE_CONTEXT: issueContext ?? '',
  };

  // Build the command and args based on runtime and inline vs named
  let cmd = '';
  let args: string[] = [];

  const nodeDeps = node.deps ?? [];

  try {
    if (isInlineScript(finalScript)) {
      // Inline code execution
      if (node.runtime === 'bun') {
        cmd = 'bun';
        // --no-env-file prevents Bun from auto-loading .env from the execution
        // cwd (the target repo). Without this, repo .env leaks into the script
        // subprocess despite Archon's parent process cleanup.
        args = ['--no-env-file', '-e', finalScript];
      } else {
        // uv run --with dep1 --with dep2 python -c <code>
        cmd = 'uv';
        const withFlags = nodeDeps.flatMap(dep => ['--with', dep]);
        args = ['run', ...withFlags, 'python', '-c', finalScript];
      }
    } else {
      // Named script — look up across repo and home scopes.
      // Precedence: <cwd>/.archon/scripts/ > ~/.archon/scripts/ (repo wins).
      // Wrap discovery in its own try/catch so a permission error on ~/.archon/scripts/
      // isn't mis-attributed by the outer catch's "permission denied (check cwd
      // permissions)" branch — that branch is for execFileAsync EACCES.
      let scripts: Awaited<ReturnType<typeof discoverScriptsForCwd>>;
      try {
        scripts = await discoverScriptsForCwd(cwd);
      } catch (discoveryErr) {
        const err = discoveryErr as Error;
        const errorMsg = `Script node '${node.id}': failed to discover scripts — ${err.message}`;
        getLog().error({ err, nodeId: node.id, cwd }, 'script_discovery_failed');
        await safeSendMessage(platform, conversationId, errorMsg, nodeContext);
        await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

        emitter.emit({
          type: 'node_failed',
          runId: workflowRun.id,
          nodeId: node.id,
          nodeName: node.id,
          error: errorMsg,
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'node_failed',
            step_name: stepName,
            data: { error: errorMsg, type: 'script' },
          })
          .catch((dbErr: Error) => {
            getLog().error(
              { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
              'workflow_event_persist_failed'
            );
          });

        return { state: 'failed', output: '', error: errorMsg };
      }
      const scriptDef = scripts.get(finalScript);

      if (!scriptDef) {
        const errorMsg = `Script node '${node.id}': named script '${finalScript}' not found in .archon/scripts/ or ~/.archon/scripts/`;
        getLog().error({ nodeId: node.id, scriptName: finalScript }, 'script_not_found');
        await safeSendMessage(platform, conversationId, errorMsg, nodeContext);
        await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

        emitter.emit({
          type: 'node_failed',
          runId: workflowRun.id,
          nodeId: node.id,
          nodeName: node.id,
          error: errorMsg,
        });
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'node_failed',
            step_name: stepName,
            data: { error: errorMsg, type: 'script' },
          })
          .catch((dbErr: Error) => {
            getLog().error(
              { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
              'workflow_event_persist_failed'
            );
          });

        return { state: 'failed', output: '', error: errorMsg };
      }

      // Use scriptDef.runtime (canonical source) instead of re-deriving from extension
      if (scriptDef.runtime === 'uv') {
        cmd = 'uv';
        const withFlags = nodeDeps.flatMap(dep => ['--with', dep]);
        args = ['run', ...withFlags, scriptDef.path];
      } else {
        cmd = 'bun';
        args = ['--no-env-file', 'run', scriptDef.path];
      }
    }

    const { stdout, stderr } = await runSubprocess(execContext, cmd, args, {
      cwd,
      timeout,
      env: subprocessEnv,
    });

    // Trim trailing newline from stdout (common shell behavior)
    const output = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'script_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Script node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, '<script>', { durationMs: duration });

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: { duration_ms: duration, type: 'script', node_output: output, ...iterationData },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      duration,
    });

    return { state: 'completed', output };
  } catch (error) {
    const err = error as Error & { killed?: boolean; code?: number | string; stderr?: string };
    const isTimeout = err.killed === true || (err.message ?? '').includes('timed out');
    const label = `Script node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in — the timeout message also contains the
    // full `Command failed: bun -e <body>` line and would otherwise leak.
    const formatted = formatSubprocessFailure(err, label);
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `${label} timed out after ${String(timeout)}ms`;
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `${label} failed: '${cmd}' executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
      errorMsg = `${label} failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = formatted.userMessage;
    }

    getLog().error(
      { ...formatted.logFields, nodeId: node.id, nodeType: 'script', isTimeout },
      'dag_node_failed'
    );
    await logNodeError(logDir, workflowRun.id, node.id, errorMsg);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: { error: errorMsg, type: 'script' },
      })
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });

    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      error: errorMsg,
    });

    return { state: 'failed', output: '', error: errorMsg };
  }
}

/** Cap for the iteration-output excerpt embedded in gate messages — keeps the
 *  persisted `metadata.approval.message` and SSE payloads bounded (mirrors the
 *  tool-input truncation used for progress events). */
const GATE_EXCERPT_MAX = 500;

/**
 * Build the honest interactive-gate message (#2074, change D): an engine-generated
 * status line (was the completion signal detected?) plus a bounded excerpt of the
 * final iteration output, prepended to the author's static `gate_message`. Shared
 * by executeLoopNode and executeLoopGroupNode so both gates tell the truth about
 * the iteration they paused on.
 */
function buildHonestGateMessage(
  completionDetected: boolean,
  untilSignal: string,
  lastIterationOutput: string,
  gateMessage: string
): string {
  const trimmed = lastIterationOutput.trim();
  const excerpt = trimmed.slice(0, GATE_EXCERPT_MAX);
  const statusLine = completionDetected
    ? `✅ Completion signal detected (\`${untilSignal}\`).`
    : `⚠️ No completion signal (\`${untilSignal}\`) in this iteration.`;
  const excerptBlock = excerpt
    ? `\n\n> ${excerpt}${trimmed.length > GATE_EXCERPT_MAX ? '…' : ''}`
    : '';
  return `${statusLine}${excerptBlock}\n\n${gateMessage}`;
}

/**
 * Finalize-on-approve (#2074), shared by executeLoopNode and executeLoopGroupNode:
 * a gate that paused on a signal-bearing iteration, resumed WITHOUT feedback,
 * completes the node from the persisted `signaledOutput` instead of re-running
 * the (expensive) iteration. Sends the user notice and writes/emits the
 * node_completed pair; the caller builds its own return value (the single-node
 * loop also threads the restored sessionId).
 */
async function finalizeLoopFromSignal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  nodeId: string,
  stepName: string,
  nodeLabel: string,
  finalizeOutput: string
): Promise<void> {
  // Impossible by construction today (the gate writes signaledOutput whenever
  // completionSignaled is true) — this warn guards a future decoupling so a
  // finalize that silently loses the iteration output is diagnosable.
  if (finalizeOutput === '') {
    getLog().warn(
      { workflowRunId: workflowRun.id, nodeId },
      'loop_node.finalize_missing_signaled_output'
    );
  }
  await safeSendMessage(
    platform,
    conversationId,
    `${nodeLabel} '${nodeId}' accepted at the completion signal (no re-run)`,
    { workflowId: workflowRun.id, nodeName: nodeId }
  );
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_completed',
      step_name: stepName,
      data: { duration_ms: 0, node_output: finalizeOutput },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
        'workflow_event_persist_failed'
      );
    });
  getWorkflowEventEmitter().emit({
    type: 'node_completed',
    runId: workflowRun.id,
    nodeId,
    nodeName: nodeId,
    duration: 0,
  });
}

/**
 * Execute a loop-group node — runs a multi-node sub-DAG body repeatedly until a
 * completion condition (`until` signal in the body's terminal-node output, and/or
 * `until_bash` exit code) or `max_iterations`.
 *
 * Mirrors {@link executeLoopNode} at subgraph granularity: each iteration runs the body's
 * topological layers via {@link runLayers} against a fresh scoped `nodeOutputs` map. The
 * body is a sealed sub-DAG. Every persisted body event — both runLayers' own control
 * events (skip/trigger_rule/when) AND the node executors' lifecycle events
 * (node_started/node_completed/node_failed, and tool/task/hook activity) — is namespaced
 * `{groupId}.{nodeId}` via `stepNamePrefix`, composing across nested groups; body node
 * lifecycle rows also carry the current `iteration` in their `data` (#2090). The in-process
 * emitter payloads stay raw (unprefixed nodeId) so live SSE/CLI consumers are unaffected.
 * `$LOOP_PREV.<id>.output` refs in body prompts resolve against a snapshot of the
 * *previous* iteration's body outputs (empty on iteration 1).
 *
 * `$groupId.output` (visible to the outer DAG) = the final iteration's terminal-node output
 * (mirrors the top-level run's terminal-output selection).
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) — the outer DAG executor owns run lifecycle
 * - Loop is encapsulated inside this one node; the outer DAG stays acyclic
 * - Usage (cost/tokens) is summed across iterations and returned on the final result,
 *   so the outer `runLayers` aggregates the group as one node's worth of usage
 */
async function executeLoopGroupNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: LoopGroupNode,
  workflowProvider: string,
  workflowModel: string | undefined,
  workflowLevelOptions: WorkflowLevelOptions,
  aiProfile: ResolvedAiProfile | undefined,
  workflowPreset: ModelAliasPreset | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  outerNodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  issueContext?: string,
  stepNamePrefix = '',
  execContext: ExecutionContext = { kind: 'host' },
  runChildWorkflow?: RunChildWorkflowFn
): Promise<NodeExecutionResult> {
  const group = node.loop_group;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // This group's OWN persisted step_name — namespaced by any enclosing group so nested
  // loop_groups compose (e.g. `outer.inner`); '' → node.id at the top level (#2090).
  const stepName = stepNamePrefix + node.id;

  // Body layering is recomputed per iteration from the (possibly $LOOP_PREV-substituted)
  // body nodes — runLayers walks ctx.layers, so the layers must reference the substituted
  // nodes for $LOOP_PREV resolution to take effect. depends_on shape is static, so the
  // layering is stable; only the prompt text changes per iteration.
  // Body nodes are namespaced under THIS group's (already-namespaced) step name so the
  // prefix composes across nested loop_groups: `<enclosing>.<groupId>.<bodyNodeId>`.
  const bodyStepNamePrefix = `${stepName}.`;

  // Static (iteration-invariant) id sets for `$LOOP_PREV.<id>.output[.field]` resolution
  // (#2142). `knownBodyIds` is TRANSITIVE (this group's body + every nested descendant) —
  // an id absent from it is a typo (`.field` ref → loud failure). `directBodyIds` is only
  // THIS group's immediate ids — an id in knownBodyIds but not directBodyIds belongs to a
  // nested group and its token is preserved for that inner group's own pass. Computed once
  // (body shape is static) and threaded into every applyLoopPrevToBodyNode call.
  const knownBodyIds = collectLoopBodyNodeIds(group.nodes);
  const directBodyIds = new Set(group.nodes.map(n => n.id));

  // Detect interactive loop resume (mirrors executeLoopNode).
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const isLoopResume = loopGateMeta?.type === 'interactive_loop' && loopGateMeta.nodeId === node.id;
  const startIteration = isLoopResume ? (loopGateMeta.iteration ?? 0) + 1 : 1;
  const loopGateRunMeta = (workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const loopUserInput = isLoopResume ? (loopGateRunMeta.loop_user_input ?? '') : '';

  // Finalize-on-approve (#2074): mirrors executeLoopNode — a signal-bearing gate
  // resumed WITHOUT feedback completes the group from the persisted output instead
  // of re-running the body.
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    await finalizeLoopFromSignal(
      deps,
      platform,
      conversationId,
      workflowRun,
      node.id,
      stepName,
      'Loop-group node',
      finalizeOutput
    );
    return { state: 'completed', output: finalizeOutput };
  }

  let loopPrevOutputs: Map<string, NodeOutput> | undefined; // undefined on iteration 1
  let lastIterationOutput = '';
  let loopTotalCostUsd: number | undefined;
  let loopTotalTokens: TokenUsage | undefined;
  // Loop-level session cursor: threaded across iterations when fresh_context is false
  // (so a body AI node resumes the prior iteration's session), reset to undefined when
  // fresh_context is true or on iteration 1. runLayers mutates this in place each call.
  // On interactive resume, restore the cursor persisted at pause time so
  // fresh_context: false continues the pre-pause conversation (mirrors executeLoopNode).
  // The provider tag must be restored WITH the session id (#1992) — metadata from a
  // pre-tag pause lacks it, and restoring an untagged cursor could thread the session
  // into a different provider on resume, so those legacy pauses restore fresh instead.
  let loopLastSequentialSession: SequentialSessionCursor | undefined =
    isLoopResume &&
    typeof loopGateMeta.sessionId === 'string' &&
    typeof loopGateMeta.sessionProvider === 'string'
      ? { sessionId: loopGateMeta.sessionId, provider: loopGateMeta.sessionProvider }
      : undefined;

  const logEventStoreError = (err: Error, iteration: number): void => {
    getLog().error({ err, nodeId: node.id, iteration }, 'loop_group_node.iteration_event_failed');
  };

  for (let i = startIteration; i <= group.max_iterations; i++) {
    const iterationStart = Date.now();

    // Between-iteration status check (paused tolerated — mirrors executeLoopNode).
    const runStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (!shouldContinueStreamingForStatus(runStatus)) {
      const effectiveStatus = runStatus ?? 'deleted';
      getLog().info(
        { workflowRunId: workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
        'loop_group_node.stop_detected'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `Loop-group node '${node.id}' stopped at iteration ${String(i)} (${effectiveStatus})`,
        msgContext
      );
      return { state: 'failed', output: '', error: `Workflow ${effectiveStatus}` };
    }

    // Emit iteration started.
    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_started',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      maxIterations: group.max_iterations,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_started',
        step_name: stepName,
        data: { iteration: i, maxIterations: group.max_iterations, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // Pre-substitute $LOOP_PREV.* refs and $LOOP_USER_INPUT into the body node prompt
    // fields. The body is a sealed sub-DAG whose executors build prompts from node
    // definitions; resolving these here (before runLayers) keeps the body executors
    // unaware of the enclosing loop iteration. On iteration 1 loopPrevOutputs is undefined
    // → $LOOP_PREV refs resolve to ''; $LOOP_USER_INPUT is '' except on the first resumed
    // iteration of an interactive loop.
    const prevSnapshot = loopPrevOutputs;
    const userInputForIter = isLoopResume && i === startIteration ? loopUserInput : '';
    const iterBodyNodes = group.nodes.map(n =>
      applyLoopPrevToBodyNode(
        n,
        prevSnapshot,
        userInputForIter,
        logDir,
        knownBodyIds,
        directBodyIds
      )
    );
    // Re-layer from the (possibly substituted) body nodes — runLayers walks ctx.layers,
    // not ctx.nodes, so the layers must reference the substituted nodes to take effect.
    const iterBodyLayers = buildTopologicalLayers(iterBodyNodes);

    // Fresh scoped output map per iteration. Seed it read-only with the outer DAG's
    // upstream outputs so body nodes can reference outer context via $nodeId.output if
    // needed (the body is sealed against depends_on, but prompt refs remain valid).
    const scopedNodeOutputs = new Map<string, NodeOutput>(outerNodeOutputs);

    const iterCtx: RunLayersContext = {
      deps,
      platform,
      conversationId,
      cwd,
      // Forwarded for completeness — a `workflow:` node inside a loop_group body is
      // rejected at load time, so this closure is never actually invoked here.
      runChildWorkflow,
      workflowRun,
      workflowName: node.id,
      config,
      workflowProvider,
      // Forward inherited workflow-level model/tier/options/profile so body AI nodes
      // resolve model aliases and workflow defaults the same way top-level nodes do.
      workflowModel,
      workflowLevelOptions,
      aiProfile,
      workflowPreset,
      artifactsDir,
      logDir,
      baseBranch,
      docsDir,
      configuredCommandFolder: undefined,
      issueContext,
      // Body nodes inherit the group's execution context so bash/script/AI inside
      // a loop_group body exec in the same place (host, or the container in Phase B)
      // — without this a loop_group body would be a host-escape hole.
      execContext,
      // persist_session across iterations is out of v1 scope (body sessions reset per
      // iteration, governed by fresh_context). Pass undefined/false so body nodes don't
      // participate in cross-run session persistence inside the loop — and therefore
      // no scope-artifact mirroring either.
      persistScopeKey: undefined,
      workflowPersistSessions: false,
      scopeArtifactsDir: undefined,
      layers: iterBodyLayers,
      nodeOutputs: scopedNodeOutputs,
      priorCompletedNodes: undefined, // body re-runs in full each iteration (v1)
      // Thread the loop-level session cursor: fresh_context (or the loop's true first
      // iteration) starts fresh; otherwise carry the prior iteration's last sequential
      // session forward so a body AI node resumes the prior iteration's conversation.
      // Gate on the literal i === 1 (not startIteration): on interactive resume the
      // first processed iteration must continue the restored pre-pause session.
      lastSequentialSession: group.fresh_context || i === 1 ? undefined : loopLastSequentialSession,
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalLoopIterations: 0,
      stepNamePrefix: bodyStepNamePrefix,
      iteration: i,
      // Deliver this iteration's approval-gate free-text to body script: nodes via env
      // (never spliced into source — #2115); matches applyLoopPrevToBodyNode's skip.
      bodyLoopUserInput: userInputForIter,
    };
    await runLayers(iterCtx);
    // A body approval/cancel node may have paused or cancelled the run mid-iteration.
    // `paused` is tolerated (a sibling gate in the same iteration layer) — mirror
    // executeLoopNode's between-iteration tolerance — but a terminal/cancelled state
    // means the loop must stop now, skipping snapshot/completion handling for this
    // iteration. Re-check before proceeding.
    const postBodyStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    // null (run row gone / deleted) is a stop condition too — treat it as 'deleted'.
    if (!shouldContinueStreamingForStatus(postBodyStatus)) {
      const effectiveStatus = postBodyStatus ?? 'deleted';
      getLog().info(
        { workflowRunId: workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
        'loop_group_node.post_body_stop'
      );
      return { state: 'failed', output: lastIterationOutput, error: `Workflow ${effectiveStatus}` };
    }
    // Accumulate usage across iterations (charged on the failure path below too).
    loopTotalCostUsd = (loopTotalCostUsd ?? 0) + iterCtx.totalCostUsd;
    if (iterCtx.totalTokensIn > 0 || iterCtx.totalTokensOut > 0) {
      loopTotalTokens = {
        input: (loopTotalTokens?.input ?? 0) + iterCtx.totalTokensIn,
        output: (loopTotalTokens?.output ?? 0) + iterCtx.totalTokensOut,
      };
    }

    // A failed body node fails the group immediately — mirrors the top-level DAG
    // (any failed node fails the run) and executeLoopNode (an iteration failure stops
    // the loop). Silently re-running the body would burn AI cost every remaining
    // iteration and bury the root cause under a generic max-iterations error.
    const failedBodyNodes = iterBodyNodes.flatMap(n => {
      const o = scopedNodeOutputs.get(n.id);
      return o?.state === 'failed' ? [`'${n.id}': ${o.error}`] : [];
    });
    if (failedBodyNodes.length > 0) {
      const errorMsg = `Loop-group node '${node.id}' failed at iteration ${String(i)}: ${failedBodyNodes.join('; ')}`;
      getLog().warn(
        { nodeId: node.id, iteration: i, failedCount: failedBodyNodes.length },
        'loop_group_node.body_node_failed'
      );
      await safeSendMessage(platform, conversationId, errorMsg, msgContext);
      return {
        state: 'failed',
        output: lastIterationOutput,
        error: errorMsg,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
      };
    }

    // Carry the body's final sequential session into the next iteration (unless
    // fresh_context forces a reset, handled above by seeding undefined).
    loopLastSequentialSession = iterCtx.lastSequentialSession;

    // Carry prior-iteration snapshot forward for $LOOP_PREV.* on the next iteration.
    loopPrevOutputs = new Map(scopedNodeOutputs);

    // Determine this iteration's terminal output (first completed terminal node in
    // definition order — mirrors the top-level run's terminal-output selection).
    const allDeps = new Set(iterBodyNodes.flatMap(n => n.depends_on ?? []));
    const terminalOutput = iterBodyNodes
      .filter(n => !allDeps.has(n.id))
      .map(n => scopedNodeOutputs.get(n.id))
      .find(o => o?.state === 'completed' && o.output.trim().length > 0)?.output;
    const iterationOutput = terminalOutput ?? '';
    // Capture the PREVIOUS iteration's (cleaned) output before overwriting — the
    // until_bash env below exposes it as LOOP_PREV_OUTPUT (previous iteration, same
    // semantics as executeLoopNode; empty on the first iteration).
    const prevIterationOutput = lastIterationOutput;
    // Signal detection uses the raw output; the stored/returned output is stripped of
    // completion-signal tags so the marker never leaks into $groupId.output (mirrors
    // executeLoopNode's cleanOutput handling).
    lastIterationOutput = stripCompletionTags(iterationOutput, group.until);

    // Completion gate: until-signal in the terminal output, and/or until_bash exit 0.
    // Short-circuit: if the until-signal already detected completion, skip the
    // until_bash subprocess (avoids unnecessary side effects and shell cost) — OR
    // semantics mean the group is already complete.
    const signalDetected = detectCompletionSignal(iterationOutput, group.until);

    let bashComplete = false;
    if (group.until_bash && !signalDetected) {
      // Resolve outside the try so ARCHON_BASH_PATH validation errors bubble up
      // to the caller instead of being swallowed by the per-iteration catch.
      const groupBashPath = resolveBashPath();
      try {
        const { prompt: bashPrompt } = substituteWorkflowVariables(
          group.until_bash,
          workflowRun.id,
          workflowRun.user_message,
          artifactsDir,
          baseBranch,
          docsDir,
          issueContext,
          i === startIteration ? loopUserInput : undefined,
          undefined,
          undefined,
          { shellSafe: true }
        );
        const substitutedBash = substituteNodeOutputRefs(
          bashPrompt,
          scopedNodeOutputs,
          true, // escapedForBash
          logDir
        );
        await runSubprocess(execContext, groupBashPath, ['-c', substitutedBash], {
          cwd,
          timeout: SUBPROCESS_DEFAULT_TIMEOUT,
          // Archon-managed env only (no process.env spread) — runSubprocess
          // layers the host env for host runs, or delivers ONLY this bag into
          // the container. Configured project env spreads FIRST so the reserved
          // workflow vars below win over any colliding codebase env var (#2115);
          // the token-scrub keys are disjoint and still override the ambient host
          // token via runSubprocess, so the unconnected-user scrub is unaffected.
          env: {
            ...(config.envVars ?? {}),
            USER_MESSAGE: workflowRun.user_message,
            ARGUMENTS: workflowRun.user_message,
            LOOP_USER_INPUT: i === startIteration ? (loopUserInput ?? '') : '',
            LOOP_PREV_OUTPUT: prevIterationOutput,
            REJECTION_REASON: '',
            CONTEXT: issueContext ?? '',
            EXTERNAL_CONTEXT: issueContext ?? '',
            ISSUE_CONTEXT: issueContext ?? '',
          },
        });
        bashComplete = true;
      } catch (e) {
        const bashErr = e as NodeJS.ErrnoException;
        // System-level errors (ENOENT/EACCES/ENOTDIR) mean the bash binary itself
        // is unreachable — looping forever on bashComplete=false is wrong. Throw
        // out of the group with a clear actionable error instead (mirrors
        // executeLoopNode's until_bash handling).
        if (bashErr.code === 'ENOENT' || bashErr.code === 'EACCES' || bashErr.code === 'ENOTDIR') {
          getLog().error(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_group.until_bash_failed'
          );
          throw new Error(
            `Loop group '${node.id}' until_bash failed: cannot execute bash at ` +
              `'${groupBashPath}' (${bashErr.code}). Set ARCHON_BASH_PATH if Git Bash ` +
              'is installed elsewhere.'
          );
        }
        // Non-exec errors (template substitution, etc.) have no err.code — they
        // should halt the group, not silently re-iterate.
        if (typeof bashErr.code !== 'number') {
          getLog().error(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_group.until_bash_unexpected_error'
          );
          throw bashErr;
        }
        // Numeric exit code from the bash script = condition not met yet, keep looping.
        bashComplete = false;
      }
    }

    const duration = Date.now() - iterationStart;
    const completionDetected = signalDetected || bashComplete;

    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      duration,
      completionDetected,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_completed',
        step_name: stepName,
        data: { iteration: i, duration, completionDetected, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // Completion: honor the signal only when the AI had input to evaluate (interactive
    // first run always gates first — mirrors executeLoopNode's interactiveFirstRun),
    // UNLESS the author opted into autonomous completion via signal_completes (#2074).
    const interactiveFirstRun = group.interactive && !isLoopResume;
    const signalCompletes = group.signal_completes === true;
    if (completionDetected && (!interactiveFirstRun || signalCompletes)) {
      await safeSendMessage(
        platform,
        conversationId,
        `Loop-group node '${node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
        msgContext
      );
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_completed',
          step_name: stepName,
          data: {
            duration_ms: duration,
            node_output: lastIterationOutput,
            ...(loopTotalCostUsd !== undefined ? { cost_usd: loopTotalCostUsd } : {}),
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
            'workflow_event_persist_failed'
          );
        });
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.id,
        duration,
        ...(loopTotalCostUsd !== undefined ? { costUsd: loopTotalCostUsd } : {}),
      });
      return {
        state: 'completed',
        output: lastIterationOutput,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
      };
    }

    // Interactive gate — pause after an iteration that did not complete (or, when
    // interactiveFirstRun && !signalCompletes, an iteration that DID signal — the honest
    // status line + persisted signal state (#2074) let a bare approve finalize it).
    if (group.interactive && group.gate_message) {
      const honestMessage = buildHonestGateMessage(
        completionDetected,
        group.until,
        lastIterationOutput,
        group.gate_message
      );
      const gateMsg =
        `⏸ **Input required** (loop_group \`${node.id}\`, iteration ${String(i)}): ${honestMessage}\n\n` +
        `Run ID: \`${workflowRun.id}\`\n` +
        `Respond: \`/workflow approve ${workflowRun.id} <your feedback>\` | Cancel: \`/workflow reject ${workflowRun.id}\``;
      const gateSent = await safeSendMessage(platform, conversationId, gateMsg, {
        workflowId: workflowRun.id,
        nodeName: node.id,
      });
      if (!gateSent) {
        getLog().error(
          { nodeId: node.id, workflowRunId: workflowRun.id, iteration: i },
          'loop_group_node.gate_message_send_failed'
        );
        return {
          state: 'failed',
          output: lastIterationOutput,
          error: `Loop-group gate message failed to deliver for node '${node.id}' — cannot pause safely`,
        };
      }
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'approval_requested',
          step_name: stepName,
          data: { message: honestMessage, iteration: i, completionSignaled: completionDetected },
        })
        .catch((err: Error) => {
          logEventStoreError(err, i);
        });
      await pauseGateRespectingExternalTransition(deps, workflowRun.id, {
        nodeId: node.id,
        message: honestMessage,
        type: 'interactive_loop',
        iteration: i,
        // Persist the body's session cursor so a resumed fresh_context: false loop
        // continues the pre-pause conversation (restored into the cursor on resume).
        // The provider tag rides along so the restore never threads the session into
        // a different provider (#1992). EXPLICIT null (not key omission) when there
        // is no cursor — SQLite's json_patch deep-merge would otherwise let a stale
        // sessionId/sessionProvider from a previous pause of this run survive (same
        // convention as `resolved`; RFC 7396 null removes the key).
        sessionId: loopLastSequentialSession?.sessionId ?? null,
        sessionProvider: loopLastSequentialSession?.provider ?? null,
        // Signal state for finalize-on-bare-approve (#2074): written unconditionally
        // for honesty; pauseWorkflowRun nulls both on every fresh pause.
        completionSignaled: completionDetected,
        signaledOutput: completionDetected ? lastIterationOutput : null,
      });
      return {
        state: 'completed',
        output: lastIterationOutput,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
      };
    }
  }

  // Max iterations exceeded.
  const errorMsg = `Loop-group node '${node.id}' exceeded max iterations (${String(group.max_iterations)}) without completion signal '${group.until}'`;
  getLog().warn(
    { nodeId: node.id, maxIterations: group.max_iterations, signal: group.until },
    'loop_group_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return {
    state: 'failed',
    output: lastIterationOutput,
    error: errorMsg,
    costUsd: loopTotalCostUsd,
    ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
    loopIterations: group.max_iterations,
  };
}

/**
 * Clone a body node with `$LOOP_PREV.<id>.output[.field]` refs and `$LOOP_USER_INPUT`
 * pre-substituted into every text field a body executor reads prompts from. Used by
 * {@link executeLoopGroupNode} so the sealed body sub-DAG's executors stay unaware of the
 * enclosing loop iteration (the body's own executors call substituteWorkflowVariables, but
 * that uses the run's user_message — not the loop's per-iteration user input — so
 * $LOOP_USER_INPUT must be resolved here, at the loop-group level).
 *
 * Only prompt-bearing fields are substituted in v1; `when:` conditions are NOT (they use
 * evaluateCondition, which does not call substituteLoopPrevRefs). Body authors who need
 * cross-iteration gating should branch on prompt content, not `when:`.
 *
 * `knownBodyIds` (transitive body-id set) and `directBodyIds` (this group's immediate body
 * ids) are threaded UNCHANGED into every substituteLoopPrevRefs call AND into the
 * nested-loop_group recursion — deliberately not recomputed for the inner group. This keeps
 * `$LOOP_PREV.*` refs validated against the OUTER loop's snapshot (whose body they resolve
 * against): a ref to an outer-direct id resolves now, a ref owned by a nested group is left
 * intact for that inner group's own pass, and a ref to nothing is a typo. Both omitted by
 * raw callers, which then skip the typo/nested classification entirely (fully lenient).
 */
export function applyLoopPrevToBodyNode(
  node: DagNode,
  loopPrevOutputs: Map<string, NodeOutput> | undefined,
  loopUserInput: string,
  outputFileDir?: string,
  knownBodyIds?: ReadonlySet<string>,
  directBodyIds?: ReadonlySet<string>
): DagNode {
  // Substitute $LOOP_USER_INPUT (user free-text) and $LOOP_PREV.* refs.
  // Resolve $LOOP_PREV FIRST, then splice $LOOP_USER_INPUT — so user input containing a
  // literal "$LOOP_PREV." is not itself reprocessed as a workflow-ref. `escapedForBash`
  // is true for shell-bound fields (bash/until_bash): $LOOP_PREV values are shell-quoted
  // (spilling to a file over the size threshold, same as substituteNodeOutputRefs), and
  // $LOOP_USER_INPUT is shell-quoted before splicing (user input is free-text; unquoted
  // it could break or inject into the bash command). Non-shell display/prompt fields
  // (prompt/approval.message/command, and cancel reasons) use the raw values.
  // `skipUserInput` is set ONLY for `script:` bodies: $LOOP_USER_INPUT is free-text that
  // cannot be safely quoted into TS/Python source, so it is left as a literal token here
  // and delivered to the script as a subprocess env var instead (#2115) — matching how
  // executeScriptNode delivers every other user-controlled variable. $LOOP_PREV.* refs
  // stay raw-spliced (bounded producer contract), routed through the knownBodyIds/
  // directBodyIds typo-vs-nested-vs-absent decision table (#2165).
  const sub = (s: string, escapedForBash = false, skipUserInput = false): string => {
    const prevResolved = substituteLoopPrevRefs(
      s,
      loopPrevOutputs,
      escapedForBash,
      outputFileDir,
      knownBodyIds,
      directBodyIds
    );
    if (skipUserInput) return prevResolved;
    const userInputForField = escapedForBash ? shellQuote(loopUserInput) : loopUserInput;
    return prevResolved.replace(/\$LOOP_USER_INPUT/g, userInputForField);
  };
  if (isLoopNode(node)) {
    // until_bash is shell-bound: an unresolved $LOOP_PREV would silently degrade to an
    // (empty) shell variable expansion inside bash -c.
    return {
      ...node,
      loop: {
        ...node.loop,
        // A command-backed loop has no inline prompt to substitute — its prompt text
        // is loaded from the command file inside executeLoopNode. Group-level
        // $LOOP_PREV.<bodyId>.output refs are resolved only in YAML fields (this
        // pass); they are not scanned inside command-file bodies.
        ...(node.loop.prompt !== undefined ? { prompt: sub(node.loop.prompt) } : {}),
        ...(node.loop.until_bash !== undefined
          ? { until_bash: sub(node.loop.until_bash, true) }
          : {}),
      },
    };
  }
  if (isLoopGroupNode(node)) {
    // Nested loop_group: recurse into the body. `knownBodyIds`/`directBodyIds` are the OUTER
    // group's sets, threaded UNCHANGED — so during this OUTER pass a ref to an inner-owned id
    // (in knownBodyIds but not directBodyIds) is left intact (return match) for the inner
    // group's own pass, while a ref to an OUTER-direct id resolves here at the outer
    // granularity and a true typo still throws. The inner group's own executeLoopGroupNode
    // computes fresh sets when it runs, so inner-owned refs resolve at the inner iteration
    // granularity. The inner group's until_bash is shell-bound and only ever substituted
    // here for OUTER-loop refs (a nested group's own until_bash cannot reference its own body
    // via $LOOP_PREV — executeLoopGroupNode does not re-run this pass on the group's until_bash).
    return {
      ...node,
      loop_group: {
        ...node.loop_group,
        ...(node.loop_group.until_bash !== undefined
          ? { until_bash: sub(node.loop_group.until_bash, true) }
          : {}),
        nodes: node.loop_group.nodes.map(n =>
          applyLoopPrevToBodyNode(
            n,
            loopPrevOutputs,
            loopUserInput,
            outputFileDir,
            knownBodyIds,
            directBodyIds
          )
        ),
      },
    };
  }
  if (isApprovalNode(node)) {
    return { ...node, approval: { ...node.approval, message: sub(node.approval.message) } };
  }
  if (isBashNode(node)) return { ...node, bash: sub(node.bash, true) };
  // Scripts never pass through a shell (execFile argv) — bash-quoting would inject
  // literal quote artifacts into TS/Python source. $LOOP_PREV.* refs are spliced raw
  // (mirroring executeScriptNode's substituteNodeOutputRefs(..., false)); $LOOP_USER_INPUT
  // is skipped here (skipUserInput) and delivered via env by executeScriptNode (#2115).
  if (isScriptNode(node)) return { ...node, script: sub(node.script, false, true) };
  // Cancel reason is display text, never executed — mirrors the normal-path default.
  if (isCancelNode(node)) return { ...node, cancel: sub(node.cancel) };
  if ('command' in node && typeof node.command === 'string')
    return { ...node, command: sub(node.command) };
  if ('prompt' in node && typeof node.prompt === 'string')
    return { ...node, prompt: sub(node.prompt) };
  return node;
}

/**
 * Execute a loop node — runs prompt repeatedly until completion signal or max iterations.
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) — DAG executor owns workflow lifecycle
 * - Receives upstream node outputs for $nodeId.output substitution
 * - Does not write current_step_index (DAG tracks per-node completion)
 */
async function executeLoopNode(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflowRun: WorkflowRun,
  node: LoopNode,
  workflowProvider: string,
  resolvedOptions: SendQueryOptions | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  issueContext?: string,
  configuredCommandFolder?: string,
  stepNamePrefix = '',
  execContext: ExecutionContext = { kind: 'host' }
): Promise<NodeExecutionResult> {
  const loop = node.loop;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name when this loop node runs inside a loop_group body
  // ('' → node.id at top level, #2090). The loop's own per-iteration number lives in
  // each event's data (`iteration`), so no separate iteration param is threaded here.
  const stepName = stepNamePrefix + node.id;

  // Emit node_started up-front so every terminal outcome of this loop node is
  // paired with a corresponding _started event — same pattern the bash and
  // script node executors follow. The pairing contract: every `return` of a
  // failed result below goes through `failLoopNode` (one terminal log line, one
  // persisted node_failed row, exactly one node_failed emitter event), success
  // paths write node_completed, and a gate pause intentionally has NO terminal
  // event (the node is still in flight; the resumed invocation emits its own
  // node_started and eventually the terminal event). Exits that THROW (e.g.
  // until_bash system errors) are paired by the dispatcher's catch in
  // runLayers, which emits its own node_failed.
  getLog().info({ nodeId: node.id, type: 'loop' }, 'loop_node.started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<loop>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: stepName,
      data: { type: 'loop', command: loop.command ?? null },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });

  getWorkflowEventEmitter().emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  /**
   * Single failure finalizer for this loop node (see the pairing contract on
   * the node_started comment above). Call sites keep their specific diagnostic
   * logs/events (e.g. loop_iteration_failed with per-iteration data); this
   * closes the node's lifecycle exactly once.
   */
  const failLoopNode = async (
    error: string,
    extras: {
      output?: string;
      costUsd?: number;
      tokens?: TokenUsage;
      loopIterations?: number;
      /** Extra persisted node_failed payload (e.g. the failing command name). */
      data?: Record<string, unknown>;
    } = {}
  ): Promise<NodeExecutionResult> => {
    getLog().error({ nodeId: node.id, error, ...(extras.data ?? {}) }, 'loop_node.failed');
    await logNodeError(logDir, workflowRun.id, node.id, error);
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: { error, ...(extras.data ?? {}) },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });
    getWorkflowEventEmitter().emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: node.id,
      error,
    });
    return {
      state: 'failed',
      output: extras.output ?? '',
      error,
      ...(extras.costUsd !== undefined ? { costUsd: extras.costUsd } : {}),
      ...(extras.tokens !== undefined ? { tokens: extras.tokens } : {}),
      ...(extras.loopIterations !== undefined ? { loopIterations: extras.loopIterations } : {}),
    };
  };

  // Detect interactive loop resume — check if workflowRun.metadata has loop gate state for this node
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const isLoopResume = loopGateMeta?.type === 'interactive_loop' && loopGateMeta.nodeId === node.id;
  const startIteration = isLoopResume ? (loopGateMeta.iteration ?? 0) + 1 : 1;
  let currentSessionId: string | undefined = isLoopResume
    ? (loopGateMeta.sessionId ?? undefined)
    : undefined;
  const loopGateRunMeta = (workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const loopUserInput = isLoopResume ? (loopGateRunMeta.loop_user_input ?? '') : '';

  // Finalize-on-approve (#2074): a gate that paused on a signal-bearing iteration,
  // resumed WITHOUT feedback, completes the node from the persisted output instead of
  // re-running the (expensive) iteration. Feedback (loop_feedback_given) OR a
  // non-signaled gate falls through to a normal resumed iteration below. Runs
  // BEFORE prompt-source resolution: a bare approve never needs the prompt, so a
  // command file deleted while the run sat paused cannot fail the finalize.
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    await finalizeLoopFromSignal(
      deps,
      platform,
      conversationId,
      workflowRun,
      node.id,
      stepName,
      'Loop node',
      finalizeOutput
    );
    return { state: 'completed', output: finalizeOutput, sessionId: currentSessionId };
  }

  // Resolve the iteration prompt source. `loop.prompt` is used directly;
  // `loop.command` is read ONCE per run/node: the first invocation loads the
  // command file, and the interactive gate persists the loaded text
  // (`commandSnapshot` in the pause context) so a resumed invocation reuses the
  // snapshot instead of re-reading — a command file edited or deleted while the
  // run sat paused at a gate can neither change nor break the running loop's
  // prompt. The schema guarantees exactly one of prompt/command is defined.
  let loopPromptTemplate: string;
  if (typeof loop.prompt === 'string') {
    loopPromptTemplate = loop.prompt;
  } else if (typeof loop.command === 'string') {
    if (isLoopResume && typeof loopGateMeta?.commandSnapshot === 'string') {
      loopPromptTemplate = loopGateMeta.commandSnapshot;
    } else {
      // Fresh execution — or a resume of a run paused under a build that
      // predates commandSnapshot: fall back to a fresh read (documented,
      // fail-safe) rather than failing an otherwise-valid resume.
      const promptResult = await loadCommandPrompt(
        deps,
        cwd,
        loop.command,
        configuredCommandFolder
      );
      if (!promptResult.success) {
        getLog().error(
          { nodeId: node.id, command: loop.command, error: promptResult.message },
          'loop_node.command_load_failed'
        );
        // The failing command name travels on the node_failed payload so the
        // event stream carries the same context as the structured log.
        return failLoopNode(promptResult.message, { data: { command: loop.command } });
      }
      loopPromptTemplate = promptResult.content;
    }
  } else {
    // Unreachable: superRefine on loopNodeConfigSchema enforces exactly-one.
    throw new Error(
      `Loop node '${node.id}' has neither 'loop.prompt' nor 'loop.command' — schema invariant violated`
    );
  }

  // Resolve AI client — fail fast with descriptive error
  let aiClient: ReturnType<typeof deps.getAgentProvider>;
  try {
    aiClient = deps.getAgentProvider(workflowProvider);
  } catch (error) {
    const err = error as Error;
    const errorMsg = `Invalid provider '${workflowProvider}' for loop node '${node.id}'. Check workflow YAML or .archon/config.yaml. Original: ${err.message}`;
    getLog().error(
      { err, nodeId: node.id, provider: workflowProvider },
      'loop_node.provider_failed'
    );
    return failLoopNode(errorMsg, { data: { provider: workflowProvider } });
  }

  let lastIterationOutput = '';
  let lastIterationStructuredOutput: unknown;
  let loopTotalCostUsd: number | undefined;
  let loopFinalStopReason: string | undefined;
  let loopTotalNumTurns: number | undefined;
  let loopTotalTokens: TokenUsage | undefined;
  // Union of task ids still live when ANY iteration's stream ended abnormally
  // (idle timeout / subprocess death) — #2083. Union rather than last-iteration:
  // a mid-loop iteration that lost its background tasks may have produced
  // incomplete artifacts even when a later iteration finishes cleanly and
  // signals completion — last-iteration-only reporting would hide that.
  // Recorded on the node_completed event so an incomplete node never
  // masquerades as a clean success (mirrors the AI-node path in
  // executeNodeInternal).
  const loopBackgroundTasksIncomplete = new Set<string>();
  // Helper to log event store errors consistently
  const logEventStoreError = (err: Error, iteration: number): void => {
    getLog().error({ err, nodeId: node.id, iteration }, 'loop_node.iteration_event_failed');
  };

  for (let i = startIteration; i <= loop.max_iterations; i++) {
    const iterationStart = Date.now();

    // Check for non-running status between iterations. `paused` is tolerated
    // here for the same reason as the streaming check: a sibling approval
    // node in the same topological layer may pause the run while this loop
    // is between iterations — the loop should continue its own iterations
    // regardless of unrelated pauses elsewhere in the DAG.
    const runStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (!shouldContinueStreamingForStatus(runStatus)) {
      const effectiveStatus = runStatus ?? 'deleted';
      getLog().info(
        { workflowRunId: workflowRun.id, nodeId: node.id, iteration: i, status: effectiveStatus },
        'loop_node.stop_detected'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `Loop node '${node.id}' stopped at iteration ${String(i)} (${effectiveStatus})`,
        msgContext
      );
      return failLoopNode(`Workflow ${effectiveStatus}`, {
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i - 1,
        data: { status: effectiveStatus, iteration: i },
      });
    }

    // Emit iteration started
    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_started',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      maxIterations: loop.max_iterations,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_started',
        step_name: stepName,
        data: { iteration: i, maxIterations: loop.max_iterations, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // Session threading
    const needsFreshSession = loop.fresh_context || i === 1;
    const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

    // Stream AI response for this iteration
    let fullOutput = ''; // raw, for signal detection
    let cleanOutput = ''; // stripped, for platform display
    let iterationIdleTimedOut = false;
    const iterationAbortController = new AbortController();
    // Mid-stream cancel-check throttle (see the check inside the stream loop).
    // The between-iteration status check just ran, so start the clock at the
    // iteration start. A local timestamp rather than the module-level
    // lastNodeCancelCheck map the AI node uses: the loop owns its whole
    // lifecycle in this stack frame, so a local needs no per-return-path map
    // cleanup.
    let lastStreamStatusCheckAt = iterationStart;
    // Status observed by the mid-stream check when it aborts (for the failure
    // message); undefined when the stream ends for any other reason.
    let streamStopStatus: string | undefined;

    // Background-task gate (#2083) — see createBackgroundTaskTracker. When the
    // set is non-empty at result time this iteration keeps consuming, so a
    // single iteration can now observe MULTIPLE result chunks. SDK cost/usage
    // are session-cumulative, so the per-result `+=` accumulation used before
    // would double-count: capture last-seen values (overwrite semantics) and
    // fold them into the loop totals once, after the stream ends.
    const backgroundTasks = createBackgroundTaskTracker();
    let iterationCost: number | undefined;
    let iterationTokens: TokenUsage | undefined;
    let iterationNumTurns: number | undefined;
    // Fold the last-seen per-iteration values into the loop totals exactly
    // once — called on both the normal exit and the catch path (an SDK-error
    // result still carries the iteration's cost, which the totals reported
    // on the failure return must include, matching the old += behavior).
    let iterationUsageFolded = false;
    const foldIterationUsage = (): void => {
      if (iterationUsageFolded) return;
      iterationUsageFolded = true;
      if (iterationCost !== undefined) {
        loopTotalCostUsd = (loopTotalCostUsd ?? 0) + iterationCost;
      }
      if (iterationTokens !== undefined) {
        loopTotalTokens = {
          input: (loopTotalTokens?.input ?? 0) + iterationTokens.input,
          output: (loopTotalTokens?.output ?? 0) + iterationTokens.output,
        };
      }
      if (iterationNumTurns !== undefined) {
        loopTotalNumTurns = (loopTotalNumTurns ?? 0) + iterationNumTurns;
      }
    };

    try {
      // Build prompt — substituteWorkflowVariables throws if $BASE_BRANCH referenced but empty
      // Pass loopUserInput on the first resumed iteration; '' on all others (non-interactive
      // or subsequent iterations) so $LOOP_USER_INPUT substitutes to empty string explicitly.
      // $LOOP_PREV_OUTPUT carries the previous iteration's cleaned output and is empty on
      // the first iteration (no prior output exists). Across an interactive resume, the
      // executor starts a fresh `lastIterationOutput` variable, so the first iteration of
      // the resume also receives an empty $LOOP_PREV_OUTPUT.
      const { prompt: substitutedPrompt } = substituteWorkflowVariables(
        loopPromptTemplate,
        workflowRun.id,
        workflowRun.user_message,
        artifactsDir,
        baseBranch,
        docsDir,
        issueContext,
        i === startIteration ? loopUserInput : '',
        undefined, // rejectionReason
        i === startIteration ? '' : lastIterationOutput
      );
      const finalPrompt = substituteNodeOutputRefs(substitutedPrompt, nodeOutputs);

      const iterationOptions: SendQueryOptions | undefined = {
        ...resolvedOptions,
        abortSignal: iterationAbortController.signal,
      };

      const generator = aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, iterationOptions);
      let lastToolStartedAt: { toolName: string; startedAt: number } | null = null;

      const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;

      for await (const msg of withIdleTimeout(generator, effectiveIdleTimeout, () => {
        iterationIdleTimedOut = true;
        getLog().warn(
          { nodeId: node.id, iteration: i, timeoutMs: effectiveIdleTimeout },
          'loop_node.idle_timeout_reached'
        );
        iterationAbortController.abort();
      })) {
        // Mid-stream cancel/pause check (every CANCEL_CHECK_INTERVAL_MS) —
        // lifted from the AI-node stream loop in executeNodeInternal. Same
        // posture: `paused` is tolerated (a sibling approval node may pause
        // the run while this loop streams); only terminal/unknown states
        // abort the in-flight iteration. Without this, a cancelled run kept
        // streaming until the iteration finished on its own — and the
        // post-stream `cancelled` exemption below was unreachable.
        const tickNow = Date.now();
        if (tickNow - lastStreamStatusCheckAt > CANCEL_CHECK_INTERVAL_MS) {
          lastStreamStatusCheckAt = tickNow;
          try {
            const streamStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
            if (!shouldContinueStreamingForStatus(streamStatus)) {
              streamStopStatus = streamStatus ?? 'deleted';
              getLog().info(
                {
                  workflowRunId: workflowRun.id,
                  nodeId: node.id,
                  iteration: i,
                  status: streamStopStatus,
                },
                'loop_node.stop_detected_during_streaming'
              );
              iterationAbortController.abort();
              break;
            }
          } catch (statusErr) {
            getLog().warn(
              { err: statusErr as Error, workflowRunId: workflowRun.id, nodeId: node.id },
              'loop_node.status_check_failed'
            );
          }
        }

        if (msg.type === 'assistant') {
          fullOutput += msg.content;
          const cleaned = stripCompletionTags(msg.content, loop.until);
          cleanOutput += cleaned;
          if (platform.getStreamingMode() === 'stream' && cleaned) {
            await safeSendMessage(platform, conversationId, cleaned, msgContext);
          }
          await logAssistant(logDir, workflowRun.id, msg.content);
        } else if (msg.type === 'result') {
          // Emit tool_completed for the last tool in the iteration
          if (lastToolStartedAt) {
            const prevTool = lastToolStartedAt;
            getWorkflowEventEmitter().emit({
              type: 'tool_completed',
              runId: workflowRun.id,
              toolName: prevTool.toolName,
              stepName: node.id,
              durationMs: Date.now() - prevTool.startedAt,
            });
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'tool_completed',
                step_name: stepName,
                data: {
                  tool_name: prevTool.toolName,
                  duration_ms: Date.now() - prevTool.startedAt,
                },
              })
              .catch((err: Error) => {
                logEventStoreError(err, i);
              });
            lastToolStartedAt = null;
          }
          if (msg.sessionId) currentSessionId = msg.sessionId;
          // Overwrite, don't accumulate — a later result in the same iteration
          // (background-task wait, #2083) carries session-cumulative values.
          if (msg.cost !== undefined) {
            iterationCost = msg.cost;
          }
          if (msg.tokens !== undefined) {
            // Provider-supplied numbers — see the NaN guard rationale at the
            // DAG-level accumulator.
            if (Number.isFinite(msg.tokens.input) && Number.isFinite(msg.tokens.output)) {
              iterationTokens = { input: msg.tokens.input, output: msg.tokens.output };
            } else {
              getLog().warn(
                { nodeId: node.id, tokens: msg.tokens },
                'loop_node.usage_tokens_non_finite_ignored'
              );
            }
          }
          if (msg.stopReason !== undefined) loopFinalStopReason = msg.stopReason;
          if (msg.numTurns !== undefined) {
            iterationNumTurns = msg.numTurns;
          }
          if (msg.structuredOutput !== undefined) {
            lastIterationStructuredOutput = msg.structuredOutput;
          }
          // Fail the iteration loudly on SDK error results. Previously we broke
          // silently, producing empty output and continuing to the next iteration —
          // which made `error_during_execution` on resumed interactive loops look
          // like a "5-second crash" that kept burning iterations.
          // Exception: errorSubtype === 'success' is the Claude SDK's marker for a
          // clean stop_sequence termination (the SDK sets is_error: true alongside
          // subtype: 'success' to encode "non-default termination, not a failure").
          // The Claude provider already filters this; the guard here defends
          // against a third-party IAgentProvider that forwards the SDK pair raw.
          if (msg.isError && msg.errorSubtype !== 'success') {
            const subtype = msg.errorSubtype ?? 'unknown';
            const errorsDetail = msg.errors?.length ? ` — ${msg.errors.join('; ')}` : '';
            getLog().error(
              {
                nodeId: node.id,
                iteration: i,
                errorSubtype: subtype,
                errors: msg.errors,
                sessionId: msg.sessionId,
                stopReason: msg.stopReason,
              },
              'loop_node.iteration_sdk_error'
            );
            throw new Error(
              `Loop '${node.id}' iteration ${String(i)} failed: SDK returned ${subtype}${errorsDetail}`
            );
          }
          if (backgroundTasks.shouldBreakOnResult()) {
            break; // Result is the "I'm done" signal — don't wait for subprocess to exit
          }
          // Result with live background Agent tasks (#2083): breaking would
          // SIGTERM the SDK subprocess and kill them. Keep consuming until the
          // final result — see the AI-node stream loop for the full rationale.
          getLog().warn(
            {
              nodeId: node.id,
              iteration: i,
              taskCount: backgroundTasks.count(),
              taskIds: backgroundTasks.ids(),
            },
            'loop_node.iteration_result_with_live_background_tasks'
          );
          if (backgroundTasks.shouldAnnounceWait()) {
            await safeSendMessage(
              platform,
              conversationId,
              `⏳ Loop \`${node.id}\` iteration ${String(i)}: turn ended with ${String(backgroundTasks.count())} background agent task(s) still running — waiting for them to finish.`,
              msgContext
            );
          }
        } else if (msg.type === 'background_tasks') {
          // Level signal (REPLACE semantics): swap the live set for the payload.
          backgroundTasks.update(msg.tasks);
        } else if (msg.type === 'tool' && msg.toolName) {
          const now = Date.now();

          // Emit tool_completed for the previous tool
          if (lastToolStartedAt) {
            const prevTool = lastToolStartedAt;
            getWorkflowEventEmitter().emit({
              type: 'tool_completed',
              runId: workflowRun.id,
              toolName: prevTool.toolName,
              stepName: node.id,
              durationMs: now - prevTool.startedAt,
            });
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'tool_completed',
                step_name: stepName,
                data: { tool_name: prevTool.toolName, duration_ms: now - prevTool.startedAt },
              })
              .catch((err: Error) => {
                logEventStoreError(err, i);
              });
          }
          lastToolStartedAt = { toolName: msg.toolName, startedAt: now };

          // Emit tool_started for the current tool (fire-and-forget)
          getWorkflowEventEmitter().emit({
            type: 'tool_started',
            runId: workflowRun.id,
            toolName: msg.toolName,
            stepName: node.id,
          });

          if (platform.getStreamingMode() === 'stream') {
            const toolMsg = formatToolCall(msg.toolName, msg.toolInput);
            if (toolMsg) {
              await safeSendMessage(platform, conversationId, toolMsg, msgContext, {
                category: 'tool_call_formatted',
              } as WorkflowMessageMetadata);
            }
            if (platform.sendStructuredEvent) {
              await platform.sendStructuredEvent(conversationId, msg);
            }
          }

          const toolInput: Record<string, unknown> = msg.toolInput
            ? Object.fromEntries(
                Object.entries(msg.toolInput).map(([k, v]) =>
                  typeof v === 'string' && v.length > 500 ? [k, v.slice(0, 500) + '...'] : [k, v]
                )
              )
            : {};
          await logTool(logDir, workflowRun.id, msg.toolName, toolInput);

          // Persist tool_called event
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_called',
              step_name: stepName,
              data: { tool_name: msg.toolName, tool_input: toolInput },
            })
            .catch((err: Error) => {
              logEventStoreError(err, i);
            });
        } else if (msg.type === 'tool_result' && platform.sendStructuredEvent) {
          await platform.sendStructuredEvent(conversationId, msg);
        }
        // rate_limit chunks: already log.warn'd in claude.ts; not surfaced to SSE per design
      }
      foldIterationUsage();

      // Stream ended with background tasks still live (idle timeout mid-wait or
      // subprocess death): their artifacts may be missing — record the
      // incompleteness (surfaced on the node_completed event) and warn loudly
      // instead of silently continuing (#2083). Cancellation is exempt from the
      // user-facing warning (the mid-stream check above returns the node as
      // failed with its own message just below), but still recorded in the
      // union — the audit trail should not depend on why the stream ended.
      if (!backgroundTasks.shouldBreakOnResult()) {
        const danglingTaskIds = backgroundTasks.ids();
        for (const id of danglingTaskIds) loopBackgroundTasksIncomplete.add(id);
        const cancelled = iterationAbortController.signal.aborted && !iterationIdleTimedOut;
        getLog().warn(
          {
            nodeId: node.id,
            iteration: i,
            taskIds: danglingTaskIds,
            idleTimedOut: iterationIdleTimedOut,
            cancelled,
          },
          'loop_node.iteration_stream_ended_with_live_background_tasks'
        );
        if (!cancelled) {
          await safeSendMessage(
            platform,
            conversationId,
            `⚠️ Loop \`${node.id}\` iteration ${String(i)}: the provider stream ended with ${String(backgroundTasks.count())} background agent task(s) still running (${danglingTaskIds.join(', ')}). Their output may be missing.`,
            msgContext
          );
        }
      }

      // Cancelled mid-stream (not idle timeout): stop the node before signal
      // detection / until_bash / the interactive gate run against a truncated
      // iteration — mirrors both the AI-node 'Cancelled by user' return and
      // this loop's own between-iteration stop path.
      if (iterationAbortController.signal.aborted && !iterationIdleTimedOut) {
        const effectiveStatus = streamStopStatus ?? 'cancelled';
        await safeSendMessage(
          platform,
          conversationId,
          `Loop node '${node.id}' stopped during iteration ${String(i)} (${effectiveStatus})`,
          msgContext
        );
        return await failLoopNode(`Workflow ${effectiveStatus}`, {
          costUsd: loopTotalCostUsd,
          ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
          loopIterations: i,
          data: { status: effectiveStatus, iteration: i },
        });
      }
    } catch (error) {
      foldIterationUsage();
      const err = error as Error;
      const duration = Date.now() - iterationStart;
      getLog().error({ err, nodeId: node.id, iteration: i }, 'loop_node.iteration_failed');
      getWorkflowEventEmitter().emit({
        type: 'loop_iteration_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        iteration: i,
        error: err.message,
      });
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'loop_iteration_failed',
          step_name: stepName,
          data: { iteration: i, error: err.message, duration, nodeId: node.id },
        })
        .catch((evtErr: Error) => {
          logEventStoreError(evtErr, i);
        });
      return failLoopNode(`Loop iteration ${i} failed: ${err.message}`, {
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
        data: { iteration: i },
      });
    }

    // Notify on idle timeout
    if (iterationIdleTimedOut) {
      await safeSendMessage(
        platform,
        conversationId,
        `Loop node '${node.id}' iteration ${String(i)} completed via idle timeout (no output for ${String((node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS) / 60000)} min)`,
        msgContext
      );
    }

    // Empty assistant output is an iteration failure for AI loops — same
    // contract as the single-shot AI-node guard in executeNodeInternal. A
    // provider stream that closed cleanly with zero content typically means
    // a silent rejection or interruption; left unchecked, an interactive
    // loop would pause with a blank gate or burn the full max_iterations
    // budget producing nothing. Idle-timeout exits are exempt — the
    // notification above has already told the user the iteration completed
    // via timeout, and flipping that to a failure would contradict it.
    if (!iterationIdleTimedOut && fullOutput.trim() === '') {
      const iterationDuration = Date.now() - iterationStart;
      const emptyError =
        'Loop iteration produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.';
      getLog().error(
        { nodeId: node.id, iteration: i, durationMs: iterationDuration },
        'loop_node.iteration_empty_output'
      );
      getWorkflowEventEmitter().emit({
        type: 'loop_iteration_failed',
        runId: workflowRun.id,
        nodeId: node.id,
        iteration: i,
        error: emptyError,
      });
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'loop_iteration_failed',
          step_name: stepName,
          data: {
            iteration: i,
            error: emptyError,
            duration: iterationDuration,
            nodeId: node.id,
          },
        })
        .catch((evtErr: Error) => {
          logEventStoreError(evtErr, i);
        });
      return failLoopNode(`Loop iteration ${i} failed: ${emptyError}`, {
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
        data: { iteration: i },
      });
    }

    // Batch mode: send accumulated output
    if (platform.getStreamingMode() === 'batch' && cleanOutput) {
      await safeSendMessage(platform, conversationId, cleanOutput, msgContext);
    }

    const prevIterationOutput = lastIterationOutput;
    lastIterationOutput = cleanOutput || fullOutput;

    // Check LLM completion signal — the AI decides whether the user approved.
    // For interactive loops, the AI emits the signal when the user explicitly approves
    // (e.g., "approved", "looks good"). The prompt instructs the AI on when to emit it.
    const signalDetected = detectCompletionSignal(fullOutput, loop.until);

    // Check deterministic bash condition (if configured)
    let bashComplete = false;
    if (loop.until_bash) {
      // Resolve outside the try so ARCHON_BASH_PATH validation errors bubble up
      // to the caller instead of being swallowed by the per-iteration catch.
      const loopBashPath = resolveBashPath();
      try {
        const { prompt: bashPrompt } = substituteWorkflowVariables(
          loop.until_bash,
          workflowRun.id,
          workflowRun.user_message,
          artifactsDir,
          baseBranch,
          docsDir,
          issueContext,
          undefined,
          undefined,
          undefined,
          { shellSafe: true }
        );
        const substitutedBash = substituteNodeOutputRefs(
          bashPrompt,
          nodeOutputs,
          true, // escapedForBash
          logDir
        );
        await runSubprocess(execContext, loopBashPath, ['-c', substitutedBash], {
          cwd,
          timeout: SUBPROCESS_DEFAULT_TIMEOUT,
          // Archon-managed env only (no process.env spread) — runSubprocess
          // layers the host env for host runs, or delivers ONLY this bag into
          // the container. Configured project env (managed per-project vars +
          // per-user GitHub token overrides incl. the unconnected-user scrub)
          // spreads FIRST so the reserved workflow vars below win over any
          // colliding codebase env var (#2115). The scrub keys (GH_TOKEN/
          // GITHUB_TOKEN/COPILOT_GITHUB_TOKEN) are disjoint from the reserved set
          // and stay in the bag, so they still override the server's ambient GH
          // token via runSubprocess's process.env layering — scrub unaffected.
          env: {
            ...(config.envVars ?? {}),
            USER_MESSAGE: workflowRun.user_message,
            ARGUMENTS: workflowRun.user_message,
            LOOP_USER_INPUT: i === startIteration ? (loopUserInput ?? '') : '',
            LOOP_PREV_OUTPUT: prevIterationOutput,
            REJECTION_REASON: '',
            CONTEXT: issueContext ?? '',
            EXTERNAL_CONTEXT: issueContext ?? '',
            ISSUE_CONTEXT: issueContext ?? '',
          },
        });
        bashComplete = true; // exit 0 = complete
      } catch (e) {
        const bashErr = e as NodeJS.ErrnoException;
        // System-level errors (ENOENT/EACCES/ENOTDIR) mean the bash binary itself
        // is unreachable — looping forever on bashComplete=false is wrong. Throw
        // out of the loop with a clear actionable error instead.
        if (bashErr.code === 'ENOENT' || bashErr.code === 'EACCES' || bashErr.code === 'ENOTDIR') {
          getLog().error({ err: bashErr, nodeId: node.id, iteration: i }, 'loop.until_bash_failed');
          throw new Error(
            `Loop node '${node.id}' until_bash failed: cannot execute bash at ` +
              `'${loopBashPath}' (${bashErr.code}). Set ARCHON_BASH_PATH if Git Bash ` +
              'is installed elsewhere.'
          );
        }
        // Non-exec errors (resolveBashPath validation, template substitution, etc.)
        // have no err.code — they should halt the loop, not silently re-iterate.
        if (typeof bashErr.code !== 'number') {
          getLog().error(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop.until_bash_unexpected_error'
          );
          throw bashErr;
        }
        // Numeric exit code from the bash script = condition not met yet, keep looping.
        bashComplete = false;
      }
    }

    const duration = Date.now() - iterationStart;
    const completionDetected = signalDetected || bashComplete;

    // Emit iteration completed
    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_completed',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      duration,
      completionDetected,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_completed',
        step_name: stepName,
        data: { iteration: i, duration, completionDetected, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    await logNodeComplete(logDir, workflowRun.id, `${node.id}-iteration-${String(i)}`, node.id, {
      durationMs: duration,
    });

    // Completion signal detected — exit the loop.
    // For interactive loops: only honor the signal when the AI had user input to evaluate
    // (i.e., this is a resume iteration with loopUserInput). On the first iteration of a
    // fresh interactive loop, the user hasn't seen anything yet — always gate first,
    // UNLESS the author opted into autonomous completion via signal_completes (#2074).
    // For non-interactive loops: the AI signals task completion at any point.
    const interactiveFirstRun = loop.interactive && !isLoopResume;
    const signalCompletes = loop.signal_completes === true;
    if (completionDetected && (!interactiveFirstRun || signalCompletes)) {
      await safeSendMessage(
        platform,
        conversationId,
        `Loop node '${node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
        msgContext
      );
      // Write node_completed event so resume logic (getCompletedDagNodeOutputs) knows this
      // node is done. Without this, a resumed DAG would re-enter the loop node.
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_completed',
          step_name: stepName,
          data: {
            duration_ms: Date.now() - iterationStart,
            node_output: lastIterationOutput,
            ...(loopTotalCostUsd !== undefined ? { cost_usd: loopTotalCostUsd } : {}),
            ...(loopFinalStopReason ? { stop_reason: loopFinalStopReason } : {}),
            ...(loopTotalNumTurns !== undefined ? { num_turns: loopTotalNumTurns } : {}),
            // Background Agent tasks still live when any iteration's stream
            // ended (#2083) — this node's artifacts may be incomplete, even
            // though a later iteration signaled completion.
            ...(loopBackgroundTasksIncomplete.size > 0
              ? { background_tasks_incomplete: [...loopBackgroundTasksIncomplete] }
              : {}),
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'node_completed' },
            'workflow_event_persist_failed'
          );
        });
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: workflowRun.id,
        nodeId: node.id,
        nodeName: node.id,
        duration: Date.now() - iterationStart,
        ...(loopTotalCostUsd !== undefined ? { costUsd: loopTotalCostUsd } : {}),
        ...(loopFinalStopReason ? { stopReason: loopFinalStopReason } : {}),
        ...(loopTotalNumTurns !== undefined ? { numTurns: loopTotalNumTurns } : {}),
      });
      return {
        state: 'completed',
        output: lastIterationOutput,
        sessionId: currentSessionId,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
        ...(lastIterationStructuredOutput !== undefined
          ? { structuredOutput: lastIterationStructuredOutput }
          : {}),
      };
    }

    // Interactive loop gate — pause after an iteration that did not complete (or, when
    // interactiveFirstRun && !signalCompletes, an iteration that DID signal — the honest
    // status line + persisted signal state (#2074) let a bare approve finalize it).
    // On a non-signaled gate, the user's feedback feeds the next iteration, which exits
    // above once the AI emits the signal.
    if (loop.interactive && loop.gate_message) {
      const honestMessage = buildHonestGateMessage(
        completionDetected,
        loop.until,
        lastIterationOutput,
        loop.gate_message
      );
      const gateMsg =
        `\u23f8 **Input required** (loop \`${node.id}\`, iteration ${String(i)}): ${honestMessage}\n\n` +
        `Run ID: \`${workflowRun.id}\`\n` +
        `Respond: \`/workflow approve ${workflowRun.id} <your feedback>\` | Cancel: \`/workflow reject ${workflowRun.id}\``;
      const gateSent = await safeSendMessage(platform, conversationId, gateMsg, {
        workflowId: workflowRun.id,
        nodeName: node.id,
      });
      if (!gateSent) {
        // Gate message failed to deliver — do not pause; fail the node so the user
        // sees a clear error rather than a silently orphaned paused run.
        getLog().error(
          { nodeId: node.id, workflowRunId: workflowRun.id, iteration: i },
          'loop_node.gate_message_send_failed'
        );
        return failLoopNode(
          `Loop gate message failed to deliver for node '${node.id}' — cannot pause safely`,
          {
            output: lastIterationOutput,
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            loopIterations: i,
            data: { iteration: i },
          }
        );
      }
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'approval_requested',
          step_name: stepName,
          data: { message: honestMessage, iteration: i, completionSignaled: completionDetected },
        })
        .catch((err: Error) => {
          logEventStoreError(err, i);
        });
      await pauseGateRespectingExternalTransition(deps, workflowRun.id, {
        nodeId: node.id,
        message: honestMessage,
        type: 'interactive_loop',
        iteration: i,
        // Explicit null (never key omission) when there is no session — SQLite's
        // json_patch deep-merge would otherwise let a stale sessionId from a previous
        // pause of this run survive (same convention as `resolved`).
        sessionId: currentSessionId ?? null,
        // Signal state for finalize-on-bare-approve (#2074): written unconditionally
        // for honesty; pauseWorkflowRun nulls both on every fresh pause.
        completionSignaled: completionDetected,
        signaledOutput: completionDetected ? lastIterationOutput : null,
        // Read-once command body for command-backed loops: the resumed invocation
        // reuses this snapshot instead of re-reading the file (explicit null for
        // prompt-based loops — same json_patch convention as `sessionId`).
        commandSnapshot: typeof loop.command === 'string' ? loopPromptTemplate : null,
      });
      // Return completed — the between-layer status check sees 'paused' and halts cleanly.
      // This mirrors the approval-node pattern, preventing false "DAG nodes failed" warnings
      // in multi-node workflows. Resume correctness relies on the 'paused' DB status, not
      // on the node's output state.
      return {
        state: 'completed',
        output: lastIterationOutput,
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        loopIterations: i,
      };
    }
  }

  // Max iterations exceeded
  const errorMsg = `Loop node '${node.id}' exceeded max iterations (${String(loop.max_iterations)}) without completion signal '${loop.until}'`;
  getLog().warn(
    { nodeId: node.id, maxIterations: loop.max_iterations, signal: loop.until },
    'loop_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return failLoopNode(errorMsg, {
    output: lastIterationOutput,
    costUsd: loopTotalCostUsd,
    ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
    loopIterations: loop.max_iterations,
    data: { maxIterations: loop.max_iterations },
  });
}

/**
 * Pause the run for a human gate, tolerating a lost CAS when the run was
 * externally transitioned while the gate was being raised — e.g. a killed CLI's
 * signal cleanup marked the run failed mid-pause (#1123), or an operator
 * cancelled it from another surface. `pauseWorkflowRun`'s UPDATE only matches
 * status='running'; when it misses, re-read the status: any non-running status
 * means the pause lost a legitimate external race — log, skip the
 * approval_pending emit, and return so the caller's normal completed-shaped
 * output lets the between-layer status check halt the DAG cleanly (the same
 * path a successful pause takes). On a successful pause, the approval_pending
 * live signal is emitted HERE (from the ApprovalContext's own nodeId/message)
 * so no call site can accidentally emit it after a lost CAS. A store error
 * while the run is still 'running' is a genuine pause failure and rethrows.
 *
 * Deliberately NOT used by the container write-back gate (raiseWriteBackGate),
 * which must stay fail-closed: a lost pause there may never fall through
 * toward the apply/teardown path — throwing is the safe behavior, and the H2
 * teardown-preserve logic keeps the overlay volume for a retry.
 */
async function pauseGateRespectingExternalTransition(
  deps: WorkflowDeps,
  runId: string,
  approvalContext: ApprovalContext
): Promise<void> {
  try {
    await deps.store.pauseWorkflowRun(runId, approvalContext);
  } catch (pauseErr) {
    let status: string | null;
    try {
      status = await deps.store.getWorkflowRunStatus(runId);
    } catch {
      // Status unknowable — surface the original pause failure.
      throw pauseErr;
    }
    if (status === 'running') throw pauseErr;
    getLog().warn(
      { workflowRunId: runId, status, err: pauseErr as Error },
      'dag.gate_pause_skipped_external_transition'
    );
    return;
  }
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId,
    nodeId: approvalContext.nodeId,
    message: approvalContext.message,
  });
}

/**
 * Execute an approval node — pauses workflow for human review.
 * On rejection resume (when on_reject is configured): runs the on_reject prompt via AI,
 * then re-pauses at the approval gate. After max_attempts rejections, cancels normally.
 */
async function executeApprovalNode(
  node: ApprovalNode,
  workflowRun: WorkflowRun,
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowProvider: string,
  workflowModel: string | undefined,
  cwd: string,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  workflowLevelOptions: WorkflowLevelOptions,
  configuredCommandFolder?: string,
  issueContext?: string,
  aiProfile?: ResolvedAiProfile,
  workflowPreset?: ModelAliasPreset,
  stepNamePrefix = '',
  iteration?: number,
  execContext: ExecutionContext = { kind: 'host' }
): Promise<NodeOutput> {
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;

  // Detect rejection resume — check metadata for rejection_reason set by reject handlers
  const rawApproval = workflowRun.metadata?.approval;
  const approvalMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const rawRejection = workflowRun.metadata?.rejection_reason;
  const rejectionReason =
    approvalMeta?.type === 'approval' &&
    approvalMeta.nodeId === node.id &&
    typeof rawRejection === 'string' &&
    rawRejection !== ''
      ? rawRejection
      : '';

  // On rejection resume with on_reject configured: run the on_reject prompt via AI
  if (rejectionReason !== '' && node.approval.on_reject) {
    const maxAttempts = node.approval.on_reject.max_attempts ?? 3;
    const rejectionCount = (workflowRun.metadata?.rejection_count as number | undefined) ?? 0;

    // Check if max attempts exhausted
    if (rejectionCount >= maxAttempts) {
      await deps.store.cancelWorkflowRun(workflowRun.id);
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'workflow_cancelled',
          step_name: stepName,
          data: { reason: `max_attempts (${String(maxAttempts)}) exhausted` },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'workflow_cancelled' },
            'workflow.event_persist_failed'
          );
        });
      getWorkflowEventEmitter().emit({
        type: 'workflow_cancelled',
        runId: workflowRun.id,
        nodeId: node.id,
        reason: `max_attempts (${String(maxAttempts)}) exhausted`,
      });
      const cancelMsg = `❌ Approval node \`${node.id}\` cancelled after ${String(maxAttempts)} rejections.`;
      await safeSendMessage(platform, conversationId, cancelMsg, msgContext);
      return { state: 'completed' as const, output: '' };
    }

    // Run the on_reject prompt via AI
    const { prompt: substitutedPrompt } = substituteWorkflowVariables(
      node.approval.on_reject.prompt,
      workflowRun.id,
      workflowRun.user_message ?? '',
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      undefined, // loopUserInput
      rejectionReason
    );

    // Build a synthetic PromptNode to reuse executeNodeInternal.
    // Use a distinct ID so the node_completed event written by executeNodeInternal
    // does not collide with the approval gate's own ID in getCompletedDagNodeOutputs.
    // If we used node.id here, a resumed run would find the event and treat the
    // approval gate as already completed, bypassing the human gate entirely.
    //
    // Note: executeNodeInternal also emits node_started/node_completed WorkflowEmitterEvents
    // with nodeId = `${node.id}:on_reject`. These flow through SSE into the web UI, where
    // WorkflowExecution.tsx builds its nodeMap from all node_* events unconditionally.
    // This means a transient `${node.id}:on_reject` phantom entry may appear in the UI's
    // execution view during an on_reject cycle. This is cosmetic-only — the approval gate
    // still re-presents correctly and the human gate contract is preserved. A follow-up can
    // filter synthetic `:on_reject` IDs from the UI's nodeMap if needed.
    const syntheticNode: PromptNode = {
      id: `${node.id}:on_reject`,
      prompt: substituteNodeOutputRefs(substitutedPrompt, nodeOutputs),
      ...(node.depends_on ? { depends_on: node.depends_on } : {}),
      ...(node.idle_timeout ? { idle_timeout: node.idle_timeout } : {}),
    };

    const {
      provider,
      model: resolvedNodeModel,
      options: nodeOptions,
      tier: resolvedTier,
    } = await resolveNodeProviderAndModel(
      syntheticNode,
      workflowProvider,
      workflowModel,
      config,
      platform,
      conversationId,
      workflowRun.id,
      cwd,
      workflowLevelOptions,
      aiProfile,
      workflowPreset,
      execContext
    );

    const output = await executeNodeInternal(
      deps,
      platform,
      conversationId,
      cwd,
      workflowRun,
      syntheticNode,
      provider,
      nodeOptions,
      artifactsDir,
      logDir,
      baseBranch,
      docsDir,
      nodeOutputs,
      undefined, // fresh session
      configuredCommandFolder,
      issueContext,
      resolvedNodeModel,
      resolvedTier,
      stepNamePrefix,
      iteration
    );

    if (output.state === 'failed') {
      return output;
    }
    // Fall through to re-pause at the approval gate
  }

  // Standard approval gate — send message and pause.
  // Resolve $nodeId.output[.field] references so the human sees concrete values
  // (parity with prompt/bash/loop/cancel nodes, which all run the same substitution).
  const renderedMessage = substituteNodeOutputRefs(node.approval.message, nodeOutputs);
  const approvalMsg =
    `⏸ **Approval required**: ${renderedMessage}\n\n` +
    `Run ID: \`${workflowRun.id}\`\n` +
    `Approve: \`/workflow approve ${workflowRun.id}\` | Reject: \`/workflow reject ${workflowRun.id}\``;
  await safeSendMessage(platform, conversationId, approvalMsg, msgContext);

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'approval_requested',
      step_name: stepName,
      data: { message: renderedMessage },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'approval_requested' },
        'workflow.event_persist_failed'
      );
    });

  await pauseGateRespectingExternalTransition(deps, workflowRun.id, {
    message: renderedMessage,
    nodeId: node.id,
    type: 'approval',
    captureResponse: node.approval.capture_response,
    onRejectPrompt: node.approval.on_reject?.prompt,
    onRejectMaxAttempts: node.approval.on_reject?.max_attempts,
  });

  // Return completed — the between-layer status check will see 'paused' (or the
  // external transition that beat the pause) and break.
  // On resume, the approve endpoint writes a real node_completed event with the user's response.
  return { state: 'completed' as const, output: '' };
}

/**
 * Execute a `workflow:` (sub-run) node (#2121 Phase 2). Starts — or, on parent
 * resume, re-inspects — a CHILD workflow run and threads its terminal output back
 * as this node's output. The re-entry table (D5) makes this idempotent and
 * cross-process-safe:
 *  - no child yet        → start one in-process, interpret the outcome.
 *  - child completed     → thread its summary/cost (runLayers writes node_completed).
 *  - child failed        → resume-through-parent ONCE, then re-interpret.
 *  - child cancelled     → fail the node.
 *  - child paused/running → pause the PARENT "blocked on child" WITHOUT writing
 *    node_completed (mirrors executeApprovalNode), so the node re-runs when the
 *    parent auto-resumes after the child terminates.
 */
async function executeWorkflowNode(
  node: WorkflowNode,
  ctx: RunLayersContext
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, cwd, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };

  // Build the failed result AND persist a node_failed event with the reason. Unlike
  // command/prompt/bash/script nodes (which write their own node_failed inside their
  // executor), the workflow node returns a failed NodeExecutionResult that runLayers
  // does NOT turn into an event — so without this the sub-run failure reason (cycle,
  // unknown target, cancelled child, …) would be swallowed into the run-level DAG
  // summary and never auditable per-node. Fire-and-forget like every other event.
  const failResult = (error: string): NodeExecutionResult => {
    deps.store
      .createWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'node_failed',
        step_name: ctx.stepNamePrefix + node.id,
        data: { error, type: 'workflow' },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: parentRun.id, eventType: 'node_failed' },
          'workflow.event_persist_failed'
        );
      });
    getWorkflowEventEmitter().emit({
      type: 'node_failed',
      runId: parentRun.id,
      nodeId: node.id,
      nodeName: node.id,
      error,
    });
    return { state: 'failed', output: '', error };
  };

  if (!ctx.runChildWorkflow) {
    // Fail fast: executor.ts MUST inject the closure. A missing one means a caller
    // wired executeDagWorkflow without sub-run support — never silently no-op.
    return failResult(
      "Internal error: 'workflow:' node cannot run — runChildWorkflow closure was not injected."
    );
  }

  // Resolve the input data string (workflow vars + $node.output refs), exactly as
  // prompt/bash nodes resolve their text surface.
  const rawInput = node.input ?? '';
  const { prompt: substitutedInput } = substituteWorkflowVariables(
    rawInput,
    parentRun.id,
    parentRun.user_message ?? '',
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext
  );
  const input = substituteNodeOutputRefs(substitutedInput, ctx.nodeOutputs);

  // Producer's declared field set (only when output_format declares object
  // properties) so a downstream `$node.output.field` on a JSON-emitting child
  // resolves declared-optional-absent → '' vs a typo → throw.
  const declaredFields = declaredFieldsFromSchema(node.output_format);
  // Build the completed result AND write the node_completed event. Unlike
  // command/prompt/bash/script nodes (which write their own inside their executor)
  // and unlike approval nodes (written by the approve handler), the workflow node
  // writes node_completed HERE — and ONLY on true completion, never on the paused
  // branch — so getCompletedDagNodeOutputs skips a truly-finished sub-run on resume
  // but re-runs one still blocked on its child.
  const asCompleted = (outcome: ChildWorkflowOutcome): NodeExecutionResult => {
    if (outcome.output === undefined) {
      // A completed child with no non-blank terminal output threads '' into
      // $<node>.output — legal, but indistinguishable downstream from an
      // intentional empty result, so leave a trace for the author.
      getLog().warn(
        { parentRunId: parentRun.id, nodeId: node.id, childRunId: outcome.childRunId },
        'workflow.subrun_completed_without_output'
      );
    }
    const output = outcome.output ?? '';
    // Fire-and-forget (matches every other event write in this file): the run
    // lifecycle must not hinge on the observability event. Awaiting it unguarded
    // would let a transient event-store failure report a successfully-completed
    // child as a FAILED parent node (it self-heals on resume, but reads wrong). A
    // lost write just means the node re-runs on resume and re-threads the same
    // completed child — idempotent.
    deps.store
      .createWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'node_completed',
        step_name: ctx.stepNamePrefix + node.id,
        data: {
          node_output: output,
          type: 'workflow',
          child_run_id: outcome.childRunId,
          ...(outcome.costUsd !== undefined ? { cost_usd: outcome.costUsd } : {}),
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: parentRun.id, eventType: 'node_completed' },
          'workflow.event_persist_failed'
        );
      });
    getWorkflowEventEmitter().emit({
      type: 'node_completed',
      runId: parentRun.id,
      nodeId: node.id,
      nodeName: node.id,
      // The wrapper node has no meaningful duration of its own — the child run's
      // own events carry real timing. Emitted as 0 to satisfy NodeCompletedEvent.
      duration: 0,
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    });
    return {
      state: 'completed',
      output,
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
      ...(declaredFields !== undefined ? { declaredFields } : {}),
    };
  };

  // Pause the PARENT "blocked on child" — mirrors executeApprovalNode's PAUSE
  // primitives: pause, emit, return {completed, ''} WITHOUT node_completed so the
  // node re-runs on the parent's resume (getCompletedDagNodeOutputs reads only
  // node_completed). The RESUME side deliberately differs: an approval gate is
  // resolved externally by the approve handler, while this node re-runs and
  // re-inspects its child. Also unlike the approval node, no approval_requested
  // workflow_event row is persisted here — the block reason lives on the run
  // itself (metadata.approval), and there is no human decision to audit for a
  // gate that resolves automatically on child completion.
  const pauseParentOnChild = async (childRunId: string): Promise<NodeExecutionResult> => {
    // KNOWN LIMITATION (#2180): the run has a SINGLE approval-gate slot. If two
    // gate-pausing nodes (two `workflow:` children, or a `workflow:` + an `approval:`)
    // land in the SAME topological layer, the second pauseWorkflowRun matches 0 rows
    // (the first already flipped running→paused) and throws — swallowed into a node
    // failure the paused run then short-circuits past. The loser's child is real but
    // unmentioned until a later resume re-pauses on it. A retry can't fix this (there
    // is nowhere to record a second simultaneous block); the real fix is a gate queue
    // or a load-time reject of multiple gate-pausing nodes per layer — tracked in #2180.
    const message =
      `Sub-run \`${node.workflow}\` (run \`${childRunId.slice(0, 8)}\`) is paused awaiting review. ` +
      `Approve it by run id: \`/workflow approve ${childRunId}\``;
    await deps.store.pauseWorkflowRun(parentRun.id, {
      message,
      nodeId: node.id,
      type: 'child_workflow',
      childRunId,
    });
    getWorkflowEventEmitter().emit({
      type: 'approval_pending',
      runId: parentRun.id,
      nodeId: node.id,
      message,
    });
    await safeSendMessage(
      platform,
      conversationId,
      `⏸ **Blocked on sub-run** \`${node.workflow}\`: ${message}`,
      msgContext
    );
    return { state: 'completed', output: '' };
  };

  const interpret = async (outcome: ChildWorkflowOutcome): Promise<NodeExecutionResult> => {
    switch (outcome.status) {
      case 'completed':
        return asCompleted(outcome);
      case 'paused':
        return pauseParentOnChild(outcome.childRunId);
      case 'failed':
        return failResult(outcome.error ?? `Sub-run '${node.workflow}' failed`);
      case 'cancelled':
        return failResult(`Sub-run '${node.workflow}' was cancelled`);
      default: {
        // Compile-time exhaustiveness + runtime fail-loud: without this, a status
        // outside the union would silently return `undefined` into runLayers.
        const unreachable: never = outcome.status;
        return failResult(
          `Sub-run '${node.workflow}' returned unexpected status '${String(unreachable)}'`
        );
      }
    }
  };

  // Re-entry: find THIS node's child (a parent may run several workflow: nodes, so
  // filter by parent_node_id). At most one child per node in slice 1; if somehow
  // several, the most recent wins.
  let existing: WorkflowRun | undefined;
  try {
    const children = (await deps.store.findChildRuns(parentRun.id)).filter(
      c => (c.metadata as Record<string, unknown> | undefined)?.parent_node_id === node.id
    );
    existing = children.length > 0 ? children[children.length - 1] : undefined;
  } catch (err) {
    return failResult(
      `Failed to look up child runs for node '${node.id}': ${(err as Error).message}`
    );
  }

  const childArgs = {
    parentRun,
    nodeId: node.id,
    childWorkflowName: node.workflow,
    input,
    cwd,
    conversationId,
    conversationDbId: parentRun.conversation_id,
    userId: parentRun.user_id ?? undefined,
    codebaseId: parentRun.codebase_id ?? undefined,
  };

  try {
    if (existing === undefined) {
      return await interpret(await ctx.runChildWorkflow(childArgs));
    }
    if (existing.status === 'failed') {
      // Resume-through-parent recovery (D5/#1764): re-drive the failed child once.
      return await interpret(
        await ctx.runChildWorkflow({ ...childArgs, resumeFailedChild: existing })
      );
    }
    if (
      existing.status === 'paused' ||
      existing.status === 'running' ||
      existing.status === 'pending'
    ) {
      // Still in progress (awaiting a human or a concurrent run). Re-pause the
      // parent; NEVER resume a paused child.
      return await pauseParentOnChild(existing.id);
    }
    // completed / cancelled — thread the outcome through the same state table a
    // freshly-run child uses (interpret handles both).
    return await interpret(childOutcomeFromRun(existing));
  } catch (err) {
    return failResult(`Sub-run '${node.workflow}' errored: ${(err as Error).message}`);
  }
}

/**
 * True when a node participates in cross-run session persistence: a command/prompt
 * node (see {@link isPersistableNode}) that hasn't opted out via `context: 'fresh'`,
 * with `persist_session: true` set directly or inherited from the workflow-level
 * `persist_sessions` default. Single source of truth for both the session
 * lookup/persist gates and the #1846 scope-artifact mirror.
 */
function nodeUsesPersistedScope(node: DagNode, workflowPersistSessions: boolean): boolean {
  if (!isPersistableNode(node)) return false;
  if (node.context === 'fresh') return false;
  const nodePersist = 'persist_session' in node ? node.persist_session : undefined;
  return nodePersist ?? workflowPersistSessions;
}

/**
 * Build the by-reference recovery suffix for a cold-resume warning (#1846): list
 * the typed artifacts that PRIOR invocations of this workflow+scope left in the
 * stable scope dir, as absolute file paths — never pasted content. Entries
 * produced by the current run are excluded (they can't recover anything the
 * fresh session doesn't already have). Returns `''` when there is nothing to
 * point at, or when the scope dir can't be read — recovery is best-effort and
 * must never turn a successful (if cold) node into a failure.
 */
async function buildColdResumeRecoveryPointer(
  scopeArtifactsDir: string,
  currentRunId: string,
  nodeId: string
): Promise<string> {
  try {
    const priorArtifacts = (await readNodeArtifacts(scopeArtifactsDir))
      .filter(entry => entry.runId !== currentRunId)
      .sort((a, b) => b.producedAt.localeCompare(a.producedAt));
    if (priorArtifacts.length === 0) return '';
    const lines = priorArtifacts.map(
      entry =>
        `- ${entry.outputType} (\`${entry.nodeId}\`): ${joinPath(scopeArtifactsDir, entry.path)}`
    );
    return `\nArtifacts from the previous invocation are available for recovery (read on demand):\n${lines.join('\n')}`;
  } catch (err) {
    getLog().warn(
      { err: err as Error, scopeArtifactsDir, nodeId },
      'dag.cold_resume_artifacts_read_failed'
    );
    return '';
  }
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
 * events emitted inside executeNodeInternal / executeBashNode / executeScriptNode /
 * executeLoopNode / executeApprovalNode. Body lifecycle rows additionally carry `iteration`
 * in `data`. The in-process emitter payloads stay raw (unprefixed) — see #2090.
 */
interface RunLayersContext {
  // --- run-level invariants (shared by top-level DAG and loop_group body) ---
  deps: WorkflowDeps;
  platform: IWorkflowPlatform;
  conversationId: string;
  cwd: string;
  /**
   * Injected closure that starts a child sub-run for a `workflow:` node (#2121
   * Phase 2). Undefined when the caller (e.g. a unit test) doesn't wire it — a
   * `workflow:` node then fails fast rather than silently no-op'ing. Forwarded
   * into loop_group body contexts too, though a `workflow:` node inside a
   * loop_group body is rejected at load time.
   */
  runChildWorkflow?: RunChildWorkflowFn;
  /** Where nodes in these layers execute (host, or the container in Phase B). Threaded
   *  into every AI turn's SendQueryOptions and every deterministic subprocess. */
  execContext: ExecutionContext;
  workflowRun: WorkflowRun;
  /** Workflow name — used for persist_session keying + telemetry. */
  workflowName: string;
  config: WorkflowConfig;
  workflowProvider: string;
  workflowModel: string | undefined;
  workflowLevelOptions: WorkflowLevelOptions;
  aiProfile?: ResolvedAiProfile;
  workflowPreset?: ModelAliasPreset;
  artifactsDir: string;
  logDir: string;
  baseBranch: string;
  docsDir: string;
  configuredCommandFolder?: string;
  issueContext?: string;
  /** Cross-run session-persistence scope key (DB conversation UUID), or undefined to skip. */
  persistScopeKey: string | undefined;
  /** Workflow-level default for per-node `persist_session` (opt-in). */
  workflowPersistSessions: boolean;
  /**
   * Stable cross-invocation artifact scope dir (`scopes/<workflow>/<scope>/`), or
   * undefined when the workflow doesn't use session persistence. When set,
   * persistence-participating nodes with `output_type` mirror their typed sidecars
   * here, and a cold session resume points the user at the prior invocation's
   * artifacts by reference (#1846). Always undefined for loop_group bodies
   * (which also run with `persistScopeKey: undefined`).
   */
  scopeArtifactsDir: string | undefined;

  // --- per-subgraph mutable state (varies between top-level DAG and loop_group body) ---
  /** Pre-computed topological layers (caller builds once — body shape is static). runLayers walks ONLY these; there is deliberately no flat node list here. */
  layers: DagNode[][];
  /** Shared node-output map (caller owns; runLayers writes node results here). */
  nodeOutputs: Map<string, NodeOutput>;
  /** Resume cache: node ids that completed in a prior run (top-level only; undefined for body). */
  priorCompletedNodes?: Map<string, string>;
  /** Sequential-session threading cursor (mutated by runLayers). Provider-tagged so the
   *  session is only threaded into nodes that resolve to the SAME provider (#1992). */
  lastSequentialSession: SequentialSessionCursor | undefined;
  /** Run-level usage accumulators (mutated by runLayers; caller reads after). */
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalLoopIterations: number;
  /** Prefix prepended to every persisted `step_name` ('' for top-level, '{groupId}.' for a loop_group body). */
  stepNamePrefix: string;
  /**
   * The enclosing loop_group iteration (1-based) when these layers are a group body,
   * else undefined for the top-level DAG. Tagged into body node lifecycle event `data`
   * so multi-iteration runs are disaggregatable in the persisted event log (#2090).
   */
  iteration?: number;
  /**
   * Per-iteration `$LOOP_USER_INPUT` free-text for loop_group body `script:` nodes,
   * delivered into the subprocess as an env var (never spliced into TS/Python source —
   * #2115). Only non-empty on the first resumed iteration of an interactive group;
   * undefined for the top-level DAG (top-level scripts have no loop user input).
   */
  bodyLoopUserInput?: string;
}

/**
 * Walk the topological `layers` of a DAG (or subgraph), executing each layer's nodes
 * concurrently, aggregating results into `ctx.nodeOutputs`, and accumulating usage into
 * `ctx`. Stops early (returns) when a between-layer status check sees a non-running run
 * state (paused/cancelled/deleted) — the caller always proceeds to its own terminal tally.
 *
 * Extracted verbatim from the former `executeDagWorkflow` layer loop; the only behavioral
 * addition is `ctx.stepNamePrefix` (empty for the top-level DAG → identical `step_name`s).
 * Shared by the top-level DAG and `executeLoopGroupNode`'s per-iteration body execution.
 */
async function runLayers(ctx: RunLayersContext): Promise<void> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    execContext,
    workflowRun,
    workflowName,
    config,
    workflowProvider,
    workflowModel,
    workflowLevelOptions,
    aiProfile,
    workflowPreset,
    artifactsDir,
    logDir,
    baseBranch,
    docsDir,
    configuredCommandFolder,
    issueContext,
    persistScopeKey,
    workflowPersistSessions,
    scopeArtifactsDir,
    layers,
    priorCompletedNodes,
    stepNamePrefix,
    iteration,
  } = ctx;
  // nodeOutputs + accumulators + lastSequentialSession are mutated in place on `ctx`.

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
    }

    // Execute all nodes in the layer concurrently. `sessionProvider` is the resolved
    // provider that produced `output.sessionId` — set only by the session-producing
    // dispatch paths (AI command/prompt nodes and loop nodes) so the cursor write
    // below can tag the session with its owner (#1992).
    const layerResults = await Promise.allSettled(
      layer.map(async (node): Promise<LayerNodeResult> => {
        try {
          // Include nodes are expanded away at discovery time (include-expander.ts): one
          // must never reach the executor. This guard is FIRST in the per-node body — before
          // resume-skip, `when:`, and trigger-rule handling — so an unexpanded include node
          // cannot slip through by matching a prior-completed entry, a false `when:`, or a
          // failing trigger rule. If one gets here, discovery was bypassed; fail loud rather
          // than silently accepting an invalid runtime DAG.
          if (isIncludeNode(node)) {
            throw new Error(
              `Internal error: include node '${node.id}' reached the executor unexpanded. ` +
                'Include nodes must be resolved by expandWorkflowIncludes() during discovery.'
            );
          }

          // 0. Skip if this node completed successfully in a prior run (resume path).
          // `always_run: true` opts the node out of resume caching — re-execute even
          // when the prior run completed it.
          if (priorCompletedNodes?.has(node.id)) {
            if (node.always_run) {
              getLog().info({ nodeId: node.id }, 'dag.node_always_run_resume_forced');
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_always_run_reset',
                  step_name: stepNamePrefix + node.id,
                  data: { prior_output: priorCompletedNodes.get(node.id) ?? '' },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_always_run_reset' },
                    'workflow_event_persist_failed'
                  );
                });
              // falls through to re-execute the node
            } else {
              getLog().info({ nodeId: node.id }, 'dag.node_skipped_prior_success');
              await logNodeSkip(logDir, workflowRun.id, node.id, 'prior_success').catch(
                (err: Error) => {
                  getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
                }
              );
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped_prior_success',
                  step_name: stepNamePrefix + node.id,
                  data: {
                    reason: 'prior_success',
                    node_output: priorCompletedNodes.get(node.id) ?? '',
                  },
                })
                .catch((err: Error) => {
                  getLog().error(
                    {
                      err,
                      workflowRunId: workflowRun.id,
                      eventType: 'node_skipped_prior_success',
                    },
                    'workflow_event_persist_failed'
                  );
                });
              const emitterPrior = getWorkflowEventEmitter();
              emitterPrior.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'prior_success',
              });
              // Return the pre-populated output (already in nodeOutputs)
              return {
                nodeId: node.id,
                output: ctx.nodeOutputs.get(node.id) ?? { state: 'skipped' as const, output: '' },
              };
            }
          }

          // 1. Evaluate trigger rule
          const triggerDecision = checkTriggerRule(node, ctx.nodeOutputs);
          if (triggerDecision === 'skip') {
            getLog().info({ nodeId: node.id, reason: 'trigger_rule' }, 'dag_node_skipped');
            await logNodeSkip(logDir, workflowRun.id, node.id, 'trigger_rule').catch(
              (err: Error) => {
                getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
              }
            );
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'node_skipped',
                step_name: stepNamePrefix + node.id,
                data: { reason: 'trigger_rule' },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                  'workflow_event_persist_failed'
                );
              });
            const emitter = getWorkflowEventEmitter();
            emitter.emit({
              type: 'node_skipped',
              runId: workflowRun.id,
              nodeId: node.id,
              nodeName: node.command ?? node.id,
              reason: 'trigger_rule',
            });
            return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
          }

          // 2. Evaluate when: condition
          if (node.when !== undefined) {
            const { result: conditionPasses, parsed: conditionParsed } = evaluateCondition(
              node.when,
              ctx.nodeOutputs
            );
            if (!conditionParsed) {
              const parseErrMsg = `⚠️ Node '${node.id}': unparseable \`when:\` expression "${node.when}" — node skipped (fail-closed). Check syntax: \`$nodeId.output == 'VALUE'\`, \`$nodeId.output > '5'\`, or compound \`$a.output == 'X' && $b.output != 'Y'\`.`;
              await safeSendMessage(platform, conversationId, parseErrMsg, {
                workflowId: workflowRun.id,
                nodeName: node.id,
              });
              getLog().error(
                { nodeId: node.id, when: node.when },
                'dag_node_skipped_condition_parse_error'
              );
              await logNodeSkip(
                logDir,
                workflowRun.id,
                node.id,
                'when_condition_parse_error'
              ).catch((err: Error) => {
                getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped',
                  step_name: stepNamePrefix + node.id,
                  data: { reason: 'when_condition_parse_error', expr: node.when },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                    'workflow_event_persist_failed'
                  );
                });
              const emitter = getWorkflowEventEmitter();
              emitter.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'when_condition_parse_error',
              });
              return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
            }
            if (!conditionPasses) {
              getLog().info({ nodeId: node.id, when: node.when }, 'dag_node_skipped_condition');
              await logNodeSkip(logDir, workflowRun.id, node.id, 'when_condition').catch(
                (err: Error) => {
                  getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
                }
              );
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'node_skipped',
                  step_name: stepNamePrefix + node.id,
                  data: { reason: 'when_condition', expr: node.when },
                })
                .catch((err: Error) => {
                  getLog().error(
                    { err, workflowRunId: workflowRun.id, eventType: 'node_skipped' },
                    'workflow_event_persist_failed'
                  );
                });
              const emitter = getWorkflowEventEmitter();
              emitter.emit({
                type: 'node_skipped',
                runId: workflowRun.id,
                nodeId: node.id,
                nodeName: node.command ?? node.id,
                reason: 'when_condition',
              });
              return {
                nodeId: node.id,
                output: { state: 'skipped' as const, output: '' },
              };
            }
          }

          // 3. Bash node dispatch — no AI, no session. Opt-in retry only: a
          // deterministic node retries solely when it declares an explicit
          // `retry:` block (single attempt otherwise), so side-effectful scripts
          // aren't silently re-run (#2088).
          if (isBashNode(node)) {
            const output = await runDeterministicNodeWithRetry(
              node,
              platform,
              conversationId,
              workflowRun,
              () =>
                executeBashNode(
                  deps,
                  platform,
                  conversationId,
                  cwd,
                  workflowRun,
                  node,
                  artifactsDir,
                  logDir,
                  baseBranch,
                  docsDir,
                  ctx.nodeOutputs,
                  issueContext,
                  config.envVars,
                  stepNamePrefix,
                  iteration,
                  execContext
                )
            );
            return { nodeId: node.id, output };
          }

          // 3b. Loop node dispatch — manages its own AI sessions and iteration
          if (isLoopNode(node)) {
            const { provider: loopProvider, options: loopOptions } =
              await resolveNodeProviderAndModel(
                node,
                workflowProvider,
                workflowModel,
                config,
                platform,
                conversationId,
                workflowRun.id,
                cwd,
                workflowLevelOptions,
                aiProfile,
                workflowPreset,
                execContext
              );

            const output = await executeLoopNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              loopProvider,
              loopOptions,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              ctx.nodeOutputs,
              config,
              issueContext,
              configuredCommandFolder,
              stepNamePrefix,
              execContext
            );
            // Loop nodes run every iteration on the same resolved provider, so the
            // result session (if any) is attributable to loopProvider — tag it so a
            // downstream sequential node on a different provider starts fresh (#1992).
            return { nodeId: node.id, output, sessionProvider: loopProvider };
          }

          // 3b'. Loop-group node dispatch — manages its own subgraph iteration
          // (body is a sealed sub-DAG re-executed per iteration; the loop is
          // encapsulated inside this one node, keeping the outer DAG acyclic).
          if (isLoopGroupNode(node)) {
            // Resolve provider for the group (group-level provider/model overrides are
            // forwarded to body AI nodes; the group itself never calls sendQuery, so
            // the resolved SendQueryOptions are not needed here).
            const { provider: loopGroupProvider } = await resolveNodeProviderAndModel(
              node,
              workflowProvider,
              workflowModel,
              config,
              platform,
              conversationId,
              workflowRun.id,
              cwd,
              workflowLevelOptions,
              aiProfile,
              workflowPreset,
              execContext
            );

            const output = await executeLoopGroupNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              loopGroupProvider,
              workflowModel,
              workflowLevelOptions,
              aiProfile,
              workflowPreset,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              ctx.nodeOutputs,
              config,
              issueContext,
              stepNamePrefix,
              execContext,
              ctx.runChildWorkflow
            );
            return { nodeId: node.id, output };
          }

          // 3c. Approval node dispatch — pauses workflow for human review
          if (isApprovalNode(node)) {
            const output = await executeApprovalNode(
              node,
              workflowRun,
              deps,
              platform,
              conversationId,
              workflowProvider,
              workflowModel,
              cwd,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              ctx.nodeOutputs,
              config,
              workflowLevelOptions,
              configuredCommandFolder,
              issueContext,
              aiProfile,
              workflowPreset,
              stepNamePrefix,
              iteration,
              execContext
            );
            return { nodeId: node.id, output };
          }

          // 3d. Cancel node dispatch — terminates the workflow run
          if (isCancelNode(node)) {
            const reason = substituteNodeOutputRefs(node.cancel, ctx.nodeOutputs);
            const cancelMsg = `❌ **Workflow cancelled** (node \`${node.id}\`): ${reason}`;
            await safeSendMessage(platform, conversationId, cancelMsg, {
              workflowId: workflowRun.id,
              nodeName: node.id,
            });
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'workflow_cancelled',
                step_name: stepNamePrefix + node.id,
                data: { reason },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'workflow_cancelled' },
                  'workflow.event_persist_failed'
                );
              });
            await deps.store.cancelWorkflowRun(workflowRun.id);
            getWorkflowEventEmitter().emit({
              type: 'workflow_cancelled',
              runId: workflowRun.id,
              nodeId: node.id,
              reason,
            });
            // Return completed — the between-layer status check will see 'cancelled' and break.
            return { nodeId: node.id, output: { state: 'completed' as const, output: reason } };
          }

          // 3e. Script node dispatch — runs via bun or uv. Opt-in retry only,
          // same as bash (#2088): retries solely when an explicit `retry:` block
          // is declared, single attempt otherwise.
          if (isScriptNode(node)) {
            const output = await runDeterministicNodeWithRetry(
              node,
              platform,
              conversationId,
              workflowRun,
              () =>
                executeScriptNode(
                  deps,
                  platform,
                  conversationId,
                  cwd,
                  workflowRun,
                  node,
                  artifactsDir,
                  logDir,
                  baseBranch,
                  docsDir,
                  ctx.nodeOutputs,
                  issueContext,
                  config.envVars,
                  stepNamePrefix,
                  iteration,
                  ctx.bodyLoopUserInput ?? '',
                  execContext
                )
            );
            return { nodeId: node.id, output };
          }

          // 3f. Workflow (sub-run) node dispatch — starts/re-inspects a child run
          // (#2121 Phase 2). Makes no direct provider call; the closure captured on
          // ctx.runChildWorkflow drives the child's own executeWorkflow. The
          // output_type sidecar is handled by the shared completed-node path;
          // node_completed is written inline by executeWorkflowNode itself (see
          // asCompleted — only on true completion, never on the paused branch).
          if (isWorkflowNode(node)) {
            const output = await executeWorkflowNode(node, ctx);
            return { nodeId: node.id, output };
          }

          // 4. Resolve per-node provider/model/options
          const {
            provider,
            model: resolvedNodeModel,
            options: nodeOptions,
            tier: resolvedTier,
          } = await resolveNodeProviderAndModel(
            node,
            workflowProvider,
            workflowModel,
            config,
            platform,
            conversationId,
            workflowRun.id,
            cwd,
            workflowLevelOptions,
            aiProfile,
            workflowPreset,
            execContext
          );

          // 5. Determine session — parallel or context:fresh → always fresh
          // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
          // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
          // isFreshSequential controls in-run threading (lastSequentialSession).
          // Cross-provider guard (#1992): a session id can only be resumed by the provider
          // that created it, so the cursor is threaded only into nodes that resolve to the
          // SAME provider — on a provider change the node starts fresh instead of failing
          // (Claude) or silently cold-falling-back (Codex) on a foreign session id.
          const isFreshSequential = isParallelLayer || node.context === 'fresh';
          const cursor = ctx.lastSequentialSession;
          let resumeSessionId: string | undefined;
          if (isFreshSequential || cursor === undefined) {
            resumeSessionId = undefined;
          } else if (cursor.provider === provider) {
            resumeSessionId = cursor.sessionId;
          } else {
            resumeSessionId = undefined;
            getLog().info(
              { nodeId: node.id, provider, cursorProvider: cursor.provider },
              'dag.session_provider_boundary_fresh'
            );
          }

          // Strictly opt-in: on only when the node sets persist_session (or inherits the
          // workflow-level persist_sessions default) and doesn't opt out via context:'fresh'.
          // A parallel-layer node CAN still use persist_session — it just doesn't share
          // with siblings. Same predicate gates the scope-artifact mirror below.
          const usesPersistedScope = nodeUsesPersistedScope(node, workflowPersistSessions);

          if (usesPersistedScope) {
            // Runtime capability guard via the resolved provider instance (catches the
            // case where provider was resolved from .archon/config.yaml defaults).
            // Uses the instance's getCapabilities() rather than the static registry so
            // tests can substitute mock providers with different caps without registering.
            const caps = deps.getAgentProvider(provider).getCapabilities();
            if (!caps.sessionResume) {
              throw new Error(
                `Node '${node.id}' has persist_session: true but resolved provider '${provider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`
              );
            }
            if (persistScopeKey) {
              try {
                const persisted = await deps.store.getWorkflowNodeSession({
                  workflow_name: workflowName,
                  node_id: node.id,
                  scope_key: persistScopeKey,
                  provider,
                });
                if (persisted) {
                  resumeSessionId = persisted.provider_session_id;
                  // workflow_events is broader-scoped and longer-lived than the
                  // node-session table. A session ID can resume a conversation, so we
                  // store only an 8-char prefix here — enough for observability without
                  // leaving a resumable artifact in the event log.
                  const sessionIdPreview = `${persisted.provider_session_id.slice(0, 8)}…`;
                  deps.store
                    .createWorkflowEvent({
                      workflow_run_id: workflowRun.id,
                      event_type: 'node_session_resumed',
                      step_name: stepNamePrefix + node.id,
                      data: {
                        provider,
                        scope_key: persistScopeKey,
                        provider_session_id_preview: sessionIdPreview,
                      },
                    })
                    .catch((err: Error) => {
                      getLog().warn(
                        { err, nodeId: node.id },
                        'persist_session_resumed_event_persist_failed'
                      );
                    });
                }
              } catch (err) {
                // Non-fatal: the node still runs (fresh, no resume), but the user opted
                // into persistence — a DB error here silently breaks continuity, so warn
                // them as well as the logs. (A "no row" result is not an error: it returns
                // null above and this catch never fires for it.)
                getLog().warn(
                  {
                    err: err as Error,
                    nodeId: node.id,
                    workflow: workflowName,
                    scopeKey: persistScopeKey,
                    provider,
                  },
                  'persist_session_lookup_failed'
                );
                await safeSendMessage(
                  platform,
                  conversationId,
                  `⚠️ Could not load the persisted session for node \`${node.id}\` — it will run without prior context. Session continuity may be broken; if this recurs, check server logs or run \`/workflow reset-sessions ${workflowName}\`.`,
                  { workflowId: workflowRun.id, nodeName: node.id }
                );
              }
            }
          }

          // 6. Execute with retry for transient failures. AI nodes get the
          // default 2 transient retries; the shared loop applies the same
          // backoff + FATAL-never-retried semantics as deterministic nodes.
          const output = await runNodeRetryLoop(
            node,
            platform,
            conversationId,
            workflowRun,
            getEffectiveNodeRetryConfig(node),
            () =>
              executeNodeInternal(
                deps,
                platform,
                conversationId,
                cwd,
                workflowRun,
                node,
                provider,
                nodeOptions,
                artifactsDir,
                logDir,
                baseBranch,
                docsDir,
                ctx.nodeOutputs,
                // Always pass the prior session ID — forkSession:true in
                // executeNodeInternal ensures the source is never mutated, so
                // retries can safely resume from it.
                resumeSessionId,
                configuredCommandFolder,
                issueContext,
                resolvedNodeModel,
                resolvedTier,
                stepNamePrefix,
                iteration
              ),
            { state: 'failed', output: '', error: 'Node did not execute' } as NodeExecutionResult
          );

          // Cold-resume surfacing: this node requested a session resume but the
          // provider reported it came back cold (resumed === false) — the prior
          // context is gone. Every provider's cold fallback is already a clean
          // fresh session, so the run we just completed is a valid fresh-context
          // result; we keep it and persist its fresh session id below. Surface the
          // lost continuity to the user (no silent failure) so a degraded run isn't
          // mistaken for a normal resumed one — but do NOT re-run: a replay would
          // only repeat the same fresh run at double the cost and side effects.
          if (
            resumeSessionId !== undefined &&
            output.state === 'completed' &&
            output.resumed === false
          ) {
            // By-reference recovery (#1846): the prior session is gone, but prior
            // invocations of this workflow+scope may have left typed artifacts in
            // the stable scope dir. Point at them (paths only — never pasted
            // content) so the lost context is recoverable on demand. Entries from
            // THIS run are excluded — they were produced by the current (fresh)
            // invocation and recover nothing. Best-effort: a scope-dir read
            // failure degrades to the plain warning, never fails the node.
            const recoveryPointer = scopeArtifactsDir
              ? await buildColdResumeRecoveryPointer(scopeArtifactsDir, workflowRun.id, node.id)
              : '';
            // Mask the session id: it's a resumable artifact, so log only an
            // 8-char preview (same policy as the node_session_resumed event above).
            getLog().warn(
              {
                nodeId: node.id,
                provider,
                workflowRunId: workflowRun.id,
                resumeSessionId: `${resumeSessionId.slice(0, 8)}…`,
                priorArtifactsFound: recoveryPointer !== '',
              },
              'dag.session_resume_failed'
            );
            await safeSendMessage(
              platform,
              conversationId,
              `⚠️ Node \`${node.id}\`: could not resume the prior session — continued with a fresh session, so the earlier context was not restored.${recoveryPointer}`,
              { workflowId: workflowRun.id, nodeName: node.id }
            );
          }

          // Persist (or drop) the node's provider session ID for the next run in this scope.
          // context:'fresh' nodes are excluded (the author opted out of any cross-run memory).
          if (usesPersistedScope && persistScopeKey && output.state === 'completed') {
            try {
              if (output.sessionId !== undefined) {
                await deps.store.upsertWorkflowNodeSession({
                  workflow_name: workflowName,
                  node_id: node.id,
                  scope_key: persistScopeKey,
                  provider,
                  provider_session_id: output.sessionId,
                  last_run_id: workflowRun.id,
                });
              } else {
                // Provider returned no session ID (e.g. Codex with no thread ID).
                // Drop the stale row for THIS provider only — leave other providers'
                // rows intact so switching providers between runs doesn't clobber
                // the other side's continuity.
                await deps.store.deleteWorkflowNodeSessions({
                  workflow_name: workflowName,
                  scope_key: persistScopeKey,
                  node_id: node.id,
                  provider,
                });
              }
            } catch (err) {
              // Non-fatal: persistence failure does not undo a successful node execution.
              // But the user opted into persistence — the next run will start fresh for
              // this node, so warn them as well as the logs.
              getLog().warn(
                {
                  err: err as Error,
                  nodeId: node.id,
                  workflow: workflowName,
                  scopeKey: persistScopeKey,
                  provider,
                },
                'persist_session_upsert_failed'
              );
              await safeSendMessage(
                platform,
                conversationId,
                `⚠️ Could not persist the session for node \`${node.id}\` (${provider}). The next run will start this node fresh.`,
                { workflowId: workflowRun.id, nodeName: node.id }
              );
            }
          }

          return { nodeId: node.id, output, sessionProvider: provider };
        } catch (error) {
          const err = error as Error;
          getLog().error({ err, nodeId: node.id }, 'dag_node_pre_execution_failed');
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'node_failed',
              step_name: stepNamePrefix + node.id,
              data: { error: err.message },
            })
            .catch((dbErr: Error) => {
              getLog().error({ err: dbErr, nodeId: node.id }, 'workflow_event_persist_failed');
            });
          getWorkflowEventEmitter().emit({
            type: 'node_failed',
            runId: workflowRun.id,
            nodeId: node.id,
            nodeName: node.command ?? node.id,
            error: err.message,
          });
          await safeSendMessage(
            platform,
            conversationId,
            `Node '${node.id}' failed before execution: ${err.message}`,
            { workflowId: workflowRun.id, nodeName: node.id }
          );
          return {
            nodeId: node.id,
            output: { state: 'failed' as const, output: '', error: err.message },
          };
        }
      })
    );

    // Process layer results — store all outputs, track failures
    const nodeById = new Map(layer.map(n => [n.id, n]));
    let layerHadFailure = false;
    for (const result of layerResults) {
      if (result.status === 'fulfilled') {
        const { nodeId, output, sessionProvider } = result.value;
        // SINGLE aggregation point for run-level usage telemetry. Per-node
        // cost/tokens must be summed here and ONLY here — adding a per-node
        // telemetry capture elsewhere would double-count against the totals
        // sent on workflow_completed/workflow_failed.
        if (output.costUsd !== undefined) ctx.totalCostUsd += output.costUsd;
        if (output.tokens !== undefined) {
          // Token values come from providers (incl. community ones) — guard so
          // a NaN can't silently poison the totals (NaN > 0 is false, which
          // would silently drop the fields from telemetry with no trace).
          if (Number.isFinite(output.tokens.input) && Number.isFinite(output.tokens.output)) {
            ctx.totalTokensIn += output.tokens.input;
            ctx.totalTokensOut += output.tokens.output;
          } else {
            getLog().warn({ nodeId, tokens: output.tokens }, 'dag.usage_tokens_non_finite_ignored');
          }
        }
        if (output.loopIterations !== undefined) ctx.totalLoopIterations += output.loopIterations;
        ctx.nodeOutputs.set(nodeId, output);
        // Typed artifact: when a node declares `output_type`, persist its output
        // as a typed sidecar (nodes/<id>.md + .meta.json) so other nodes and
        // later runs can locate it by type. Best-effort — a metadata write must
        // never fail an otherwise-successful node.
        const completedNode = nodeById.get(nodeId);
        if (output.state === 'completed' && completedNode?.output_type) {
          const meta = {
            nodeId,
            outputType: completedNode.output_type,
            runId: workflowRun.id,
            producedAt: new Date().toISOString(),
            // `sessionId` may be undefined (e.g. bash/script nodes have no
            // session); writeNodeArtifact omits it from the metadata when so.
            sessionId: output.sessionId,
          };
          try {
            await writeNodeArtifact(artifactsDir, meta, output.output);
          } catch (err) {
            getLog().warn(
              { err: err as Error, nodeId, workflowRunId: workflowRun.id },
              'artifacts.write_failed'
            );
          }
          // Scope mirror (#1846): persistence-participating nodes also write their
          // typed sidecar into the stable `scopes/<workflow>/<scope>/` dir, so the
          // NEXT invocation can recover this output by reference if its persisted
          // session comes back cold. Per-node files; concurrent same-scope runs are
          // last-writer-wins for a given node. Best-effort, like the run-dir write.
          if (scopeArtifactsDir && nodeUsesPersistedScope(completedNode, workflowPersistSessions)) {
            try {
              await writeNodeArtifact(scopeArtifactsDir, meta, output.output);
            } catch (err) {
              getLog().warn(
                { err: err as Error, nodeId, workflowRunId: workflowRun.id, scopeArtifactsDir },
                'artifacts.scope_write_failed'
              );
            }
          }
        }
        if (output.state === 'completed' && !isParallelLayer && output.sessionId !== undefined) {
          // Tag the cursor with the provider that created the session (#1992). A session
          // id from a path that can't attest its provider is never threaded — fail-safe:
          // a fresh downstream session beats a guaranteed-broken cross-provider resume.
          ctx.lastSequentialSession =
            sessionProvider !== undefined
              ? { sessionId: output.sessionId, provider: sessionProvider }
              : undefined;
        }
        if (output.state === 'failed') layerHadFailure = true;
      } else {
        // Should not happen — all errors are caught in the inner try-catch
        // Handle defensively: log the unexpected rejection
        getLog().error({ err: result.reason as Error, layerIdx }, 'dag_node_unexpected_rejection');
        layerHadFailure = true;
        await safeSendMessage(
          platform,
          conversationId,
          `An unexpected error occurred executing a node in layer ${String(layerIdx)}. Check server logs.`,
          { workflowId: workflowRun.id }
        );
      }
    }

    if (layerHadFailure) {
      getLog().warn({ layerIdx, nodeCount: layer.length }, 'dag_layer_had_failures');
    }

    // Check for non-running status between DAG layers (cancellation, deletion, pause)
    try {
      const dagStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
      if (dagStatus === null || dagStatus !== 'running') {
        const effectiveStatus = dagStatus ?? 'deleted';
        getLog().info(
          {
            workflowRunId: workflowRun.id,
            layerIdx,
            totalLayers: layers.length,
            status: effectiveStatus,
          },
          'dag.stop_detected_between_layers'
        );
        // Paused is intentional (approval gate) — the approval message was already sent
        if (effectiveStatus !== 'paused') {
          await safeSendMessage(
            platform,
            conversationId,
            `⚠️ **Workflow stopped** (${effectiveStatus}): DAG execution stopped after layer ${String(layerIdx + 1)}/${String(layers.length)}`,
            { workflowId: workflowRun.id }
          );
        }
        break;
      }
    } catch (statusErr) {
      // Non-fatal — status check failure should not crash the workflow
      getLog().warn(
        { err: statusErr as Error, workflowRunId: workflowRun.id },
        'dag.status_check_failed'
      );
    }
  }
}

/**
 * Resolve the AI provider a node would use, WITHOUT the messaging/side effects
 * of `resolveNodeProviderAndModel` — just enough for the container capability
 * pre-flight. Mirrors the provider half of that resolver: `node.provider ??
 * workflowProvider`, then a model tier/alias ref may override the provider.
 */
function resolveNodeProviderForPreflight(
  node: DagNode,
  workflowProvider: string,
  aiProfile?: ResolvedAiProfile
): string {
  let provider: string = node.provider ?? workflowProvider;
  if (node.model && aiProfile) {
    const spec = resolveModelSpec(aiProfile, node.model);
    if (!isLiteralSpec(spec)) provider = spec.provider;
  }
  return provider;
}

/**
 * Collect providers used by AI nodes that CANNOT run inside a container
 * (`capabilities.containerExec === false`), recursing loop_group bodies. bash/
 * script/cancel nodes are deterministic (they exec via `docker exec` directly,
 * no provider) and are skipped; an approval node counts only when it has an
 * `on_reject` reprompt (the one AI turn it can spawn). Unknown providers are
 * skipped here — they fail later with a clearer "unknown provider" error.
 */
export function collectContainerIncompatibleProviders(
  nodes: readonly DagNode[],
  workflowProvider: string,
  aiProfile?: ResolvedAiProfile
): Set<string> {
  const incompatible = new Set<string>();
  const check = (provider: string): void => {
    if (!isRegisteredProvider(provider)) return;
    if (!getProviderCapabilities(provider).containerExec) incompatible.add(provider);
  };
  const visit = (ns: readonly DagNode[]): void => {
    for (const node of ns) {
      if (isBashNode(node) || isScriptNode(node) || isCancelNode(node)) continue;
      if (isLoopGroupNode(node)) {
        check(resolveNodeProviderForPreflight(node, workflowProvider, aiProfile));
        visit(node.loop_group.nodes);
        continue;
      }
      if (isApprovalNode(node)) {
        if (node.approval.on_reject) {
          check(resolveNodeProviderForPreflight(node, workflowProvider, aiProfile));
        }
        continue;
      }
      // command / prompt / loop → AI node
      check(resolveNodeProviderForPreflight(node, workflowProvider, aiProfile));
    }
  };
  visit(nodes);
  return incompatible;
}

/**
 * Emit + persist a container-lifecycle event (fire-and-forget DB write). Mirrors
 * the `container_created`/`container_destroyed` pattern already in this file so
 * the stop/resume/write-back phases surface in all three logging layers.
 */
function emitContainerLifecycleEvent(
  deps: WorkflowDeps,
  runId: string,
  phase: ContainerLifecyclePhase,
  eventType: ContainerLifecycleDbEvent,
  containerId?: string,
  data: Record<string, unknown> = {}
): void {
  getWorkflowEventEmitter().emit({
    type: 'container_lifecycle',
    runId,
    phase,
    ...(containerId ? { containerId } : {}),
  });
  deps.store
    .createWorkflowEvent({
      workflow_run_id: runId,
      event_type: eventType,
      step_name: 'container',
      data,
    })
    .catch((err: Error) => {
      getLog().error({ err, workflowRunId: runId, eventType }, 'workflow_event_persist_failed');
    });
}

/** Container-lifecycle phases carried by the emitter event (superset of the DB rows). */
type ContainerLifecyclePhase =
  | 'created'
  | 'stopped'
  | 'resumed'
  | 'destroyed'
  | 'writeback_requested'
  | 'writeback_applied'
  | 'writeback_discarded';

/** DB `workflow_events.event_type` values for container lifecycle. */
type ContainerLifecycleDbEvent =
  | 'container_created'
  | 'container_stopped'
  | 'container_resumed'
  | 'container_destroyed'
  | 'writeback_requested'
  | 'writeback_applied'
  | 'writeback_discarded';

/**
 * Suspend the container on pause (`docker stop`) so a multi-day wait costs ~0
 * resources. Best-effort: a suspend failure leaves the container running (a
 * resource leak the resume/teardown reclaims) but must NOT throw — throwing here
 * would mask the pause and flip the run to failed. Surfaced loud (error log +
 * platform note); the `container_stopped` event only fires on success.
 */
async function suspendContainerForPause(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  containerCtx: ContainerRunContext,
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  runId: string
): Promise<void> {
  try {
    await containerCtx.backend.suspend(containerCtx.envId);
    emitContainerLifecycleEvent(
      deps,
      runId,
      'stopped',
      'container_stopped',
      execContext.containerId
    );
    getLog().info({ runId, envId: containerCtx.envId }, 'dag.container_suspended_on_pause');
  } catch (err) {
    getLog().error(
      { err: err as Error, runId, envId: containerCtx.envId },
      'dag.container_suspend_on_pause_failed'
    );
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Run paused, but its isolation container could not be stopped: ${
        (err as Error).message
      }. It keeps running until resume/teardown reclaims it.`,
      { workflowId: runId }
    );
  }
}

/** Render the write-back change summary + approve/reject instructions for the gate message. */
/**
 * Sanitize an AGENT-CONTROLLED string (a file path or symlink target) before it is
 * interpolated into the approval-gate message (R2-F3). The container agent chooses
 * these, so a raw newline could forge extra lines in the approver's view and Markdown
 * could forge formatting/links. We (1) replace every control char (C0/C1, incl.
 * newline/CR/tab) with a visible `?`, then (2) wrap the result in inline code with
 * backticks escaped, so the whole token renders literally and inertly regardless of
 * its content. Truncated to keep one entry from dominating the message.
 */
function sanitizeGateText(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching control chars to neutralize them
  const noControl = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  const capped = noControl.length > 300 ? `${noControl.slice(0, 300)}…` : noControl;
  return `\`${capped.replace(/`/g, "'")}\``;
}

function renderWriteBackSummary(summary: OverlayChangeSummary): string {
  const { added, modified, deleted, symlinks, skipped, totalCount, truncated } = summary;
  // Faithfully represent what apply will do (M1): files by kind, symlinks as
  // `path -> target` with escaping ones flagged (apply REFUSES them), and the
  // entries apply will skip. The approver sees exactly what lands and what won't.
  // Every agent-controlled path/target is sanitized (R2-F3) so it can't forge lines
  // or Markdown in the approver's view.
  const preview = [
    ...added.map(p => `+ ${sanitizeGateText(p)}`),
    ...modified.map(p => `~ ${sanitizeGateText(p)}`),
    ...deleted.map(p => `- ${sanitizeGateText(p)}`),
    ...symlinks.map(
      s =>
        `${s.escapes ? '⚠ ' : ''}@ ${sanitizeGateText(s.path)} -> ${sanitizeGateText(s.target)}${s.escapes ? '  (ESCAPES — will be refused)' : ''}`
    ),
  ].slice(0, 25);
  const lines = [
    '**Container run finished — review the changes before they touch the live folder.**',
    '',
    `${totalCount} change(s): ${added.length} added, ${modified.length} modified, ${deleted.length} deleted, ${symlinks.length} symlink(s):`,
    ...preview.map(p => `  ${p}`),
  ];
  if (truncated || totalCount > preview.length) {
    lines.push(`  … and ${totalCount - preview.length} more`);
  }
  if (skipped.length > 0) {
    lines.push(
      '',
      `${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} will be SKIPPED (special files / unsafe / escaping):`
    );
    for (const s of skipped.slice(0, 10)) {
      lines.push(`  ! ${sanitizeGateText(s.path)} (${sanitizeGateText(s.reason)})`);
    }
    if (skipped.length > 10) lines.push(`  … and ${skipped.length - 10} more`);
  }
  lines.push('', 'Approve to APPLY these changes to the live folder, or reject to discard them.');
  return lines.join('\n');
}

/**
 * The engine-level container write-back gate (Phase C). Runs after the last node
 * succeeds, and again on each resume (the DAG re-runs with every node skipped and
 * lands here). Returns:
 *  - `paused`    — pending an approval decision; the container was suspended.
 *  - `applied`   — the overlay diff landed on the live root (auto policy, or
 *                  resume-after-approve). Fall through to complete the run.
 *  - `discarded` — the overlay was discarded (resume-after-reject). Complete.
 *  - `skipped`   — empty diff; nothing to apply. Complete normally.
 */
async function runContainerWriteBackGate(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext,
  execContext: Extract<ExecutionContext, { kind: 'container' }>
): Promise<'paused' | 'applied' | 'discarded' | 'skipped'> {
  const run = await deps.store.getWorkflowRun(runId);
  const meta = run?.metadata ?? {};
  const pending = meta.pending_writeback as
    | { envId: string; summary?: OverlayChangeSummary }
    | undefined;
  // Idempotent re-entry: a resume after the decision already applied/discarded on a
  // prior invocation just completes (L2 — never re-pause a resolved gate). Return the
  // HONEST outcome (`writeback_outcome`) so a re-entered DISCARDED run isn't mislabeled
  // as applied.
  if (meta.writeback_resolved === true) {
    return meta.writeback_outcome === 'discarded' ? 'discarded' : 'applied';
  }

  const rawApproval = meta.approval;
  const approval = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const isWriteBackGate = approval?.type === 'writeback';

  // RESUME after the gate was raised. Decide STRICTLY on THIS gate's own resolution
  // (`metadata.approval.resolved` for the `type:'writeback'` context) — NEVER the
  // run-wide `approval_response` (a stale value from an earlier mid-DAG approval node
  // would auto-apply) and NEVER "anything but rejected" (a plain `/workflow resume`
  // carries no decision → must not apply). Unresolved ⇒ FAIL CLOSED (re-pause).
  if (pending && isWriteBackGate) {
    if (approval.resolved === 'approved') {
      // Retry-safe apply (R2-F4). CLAIM the apply atomically BEFORE mutating the live
      // root. Semantics:
      //  - `claimed` false ⇒ a concurrent/prior resume already claimed the apply (or a
      //    crash left it claimed AFTER a successful apply). Do NOT re-apply — no path
      //    applies twice — and complete as applied (the resume CAS already serializes
      //    resumes; the only skipped-apply window is a sub-ms crash between claim and
      //    the apply call, which leaves the volume preserved by H2 for manual recovery).
      //  - `claimed` true ⇒ we own the apply. On SUCCESS record `writeback_resolved`;
      //    on FAILURE release the claim so `workflow resume` can retry (H2), keep the
      //    volume, and rethrow so the run fails with the reconcile teardown message.
      const { claimed } = await deps.store.claimWriteback(runId);
      if (!claimed) {
        getLog().warn({ runId }, 'dag.writeback_apply_already_claimed');
        await deps.store
          .updateWorkflowRun(runId, {
            metadata: { writeback_resolved: true, writeback_outcome: 'applied' },
          })
          .catch(() => undefined);
        return 'applied';
      }
      let applied;
      try {
        applied = await containerCtx.backend.applyChanges(containerCtx.envId);
      } catch (applyErr) {
        await deps.store.releaseWritebackClaim(runId).catch((relErr: unknown) => {
          getLog().error({ err: relErr as Error, runId }, 'dag.writeback_release_claim_failed');
        });
        throw applyErr;
      }
      await deps.store.updateWorkflowRun(runId, {
        metadata: { writeback_resolved: true, writeback_outcome: 'applied' },
      });
      emitContainerLifecycleEvent(
        deps,
        runId,
        'writeback_applied',
        'writeback_applied',
        undefined,
        {
          files_applied: applied.filesApplied,
          files_deleted: applied.filesDeleted,
        }
      );
      await safeSendMessage(
        platform,
        conversationId,
        `✅ Applied to the live folder: ${applied.filesApplied} file(s) written, ${applied.filesDeleted} deleted.` +
          (applied.warnings.length > 0 ? `\n⚠️ ${applied.warnings.join('; ')}` : ''),
        { workflowId: runId }
      );
      return 'applied';
    }
    if (approval.resolved === 'rejected') {
      await containerCtx.backend.discardChanges(containerCtx.envId);
      await deps.store.updateWorkflowRun(runId, {
        metadata: { writeback_resolved: true, writeback_outcome: 'discarded' },
      });
      emitContainerLifecycleEvent(deps, runId, 'writeback_discarded', 'writeback_discarded');
      await safeSendMessage(
        platform,
        conversationId,
        '🗑️ Changes discarded — the live folder was left untouched. (The run itself succeeded; artifacts remain.)',
        { workflowId: runId }
      );
      return 'discarded';
    }
    // FAIL CLOSED: a resume reached the still-open gate with no decision (e.g. a bare
    // `/workflow resume`). Re-raise the gate rather than touching the live root.
    getLog().warn({ runId }, 'dag.writeback_resume_unresolved_repause');
    const summary =
      pending.summary ?? (await containerCtx.backend.finalize(containerCtx.envId)).changeSummary;
    await raiseWriteBackGate(
      deps,
      platform,
      conversationId,
      runId,
      containerCtx,
      execContext,
      summary
    );
    return 'paused';
  }

  // FIRST arrival: inspect the overlay diff.
  const finalize = await containerCtx.backend.finalize(containerCtx.envId);
  const summary = finalize.changeSummary;
  if (!finalize.requiresApproval || !summary || summary.totalCount === 0) {
    getLog().info({ runId }, 'dag.writeback_empty_diff_skipped');
    return 'skipped';
  }

  // `auto` policy: apply without pausing (logged). For unattended workflows.
  if (containerCtx.writeBack === 'auto') {
    // N1 — set the `pending_writeback` preserve marker BEFORE mutating the live root,
    // even in auto mode (which never pauses). If applyChanges throws partway, the run
    // fails with the marker set + unresolved, so the teardown PRESERVES the volume
    // (the un-applied remainder is recoverable) instead of destroying it. Cleared to
    // resolved on success so normal teardown cleanup proceeds. (No claim CAS here:
    // auto runs in one process; a resume of a failed auto run re-enters this first-
    // arrival path and re-applies idempotently.)
    await deps.store.updateWorkflowRun(runId, {
      metadata: { pending_writeback: { envId: containerCtx.envId } },
    });
    const applied = await containerCtx.backend.applyChanges(containerCtx.envId);
    await deps.store.updateWorkflowRun(runId, {
      metadata: { writeback_resolved: true, writeback_outcome: 'applied' },
    });
    emitContainerLifecycleEvent(deps, runId, 'writeback_applied', 'writeback_applied', undefined, {
      files_applied: applied.filesApplied,
      files_deleted: applied.filesDeleted,
      auto: true,
    });
    await safeSendMessage(
      platform,
      conversationId,
      `✅ Auto-applied ${applied.filesApplied} file(s) to the live folder (${applied.filesDeleted} deleted). ` +
        '(`container.write_back: auto` — no approval gate.)',
      { workflowId: runId }
    );
    getLog().info({ runId, filesApplied: applied.filesApplied }, 'dag.writeback_auto_applied');
    return 'applied';
  }

  // `approve` policy (default): raise the write-back gate (pause + suspend).
  await raiseWriteBackGate(
    deps,
    platform,
    conversationId,
    runId,
    containerCtx,
    execContext,
    summary
  );
  return 'paused';
}

/**
 * Raise (or re-raise) the write-back approval gate: pause the run with a synthetic
 * `type:'writeback'` ApprovalContext, persist `pending_writeback`, emit the events +
 * live pause signal, suspend the container, and message the user. Reused by the
 * first-arrival approve path AND the fail-closed re-pause on an unresolved resume.
 */
async function raiseWriteBackGate(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  containerCtx: ContainerRunContext,
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  summary: OverlayChangeSummary | undefined
): Promise<void> {
  const message = summary
    ? renderWriteBackSummary(summary)
    : 'Container run finished — review before applying to the live folder.';
  // Fold `pending_writeback` into the SAME pause write so there is no window where the
  // run is paused-for-writeback without the resume marker (M3): pass it as extra
  // metadata alongside the approval context, both in one merged write.
  await deps.store.pauseWorkflowRun(
    runId,
    { nodeId: WRITEBACK_GATE_NODE_ID, message, type: 'writeback' },
    { pending_writeback: { envId: containerCtx.envId, ...(summary ? { summary } : {}) } }
  );
  emitContainerLifecycleEvent(
    deps,
    runId,
    'writeback_requested',
    'writeback_requested',
    undefined,
    {
      total_count: summary?.totalCount ?? 0,
    }
  );
  // Live pause signal for the CLI progress renderer + console dock (same event the
  // approval node emits, so the existing pause UI shows approve/reject).
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId,
    nodeId: WRITEBACK_GATE_NODE_ID,
    message,
  });
  await suspendContainerForPause(deps, platform, conversationId, containerCtx, execContext, runId);
  await safeSendMessage(platform, conversationId, message, { workflowId: runId });
}

/**
 * Execute a complete DAG workflow.
 * Called from executeWorkflow() in executor.ts.
 */
export async function executeDagWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: {
    name: string;
    nodes: readonly DagNode[];
    /** Workflow-level default for per-node `persist_session` (read directly here). */
    persist_sessions?: boolean;
    /** Raw workflow-level `model` ref — used only to derive the workflow tier
     *  keyword for node_started attribution (resolution uses `workflowModel`). */
    model?: string;
    /** Terminal-success evidence gate (#2230) — read at the completion path. */
    evidence_policy?: WorkflowEvidencePolicy;
  } & WorkflowLevelOptions,
  workflowRun: WorkflowRun,
  workflowProvider: string,
  workflowModel: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  config: WorkflowConfig,
  configuredCommandFolder?: string,
  issueContext?: string,
  priorCompletedNodes?: Map<string, string>,
  /** Discovery source — telemetry only (custom-vs-default + name redaction). */
  source?: WorkflowSource,
  aiProfile?: ResolvedAiProfile,
  workflowPreset?: ModelAliasPreset,
  /**
   * Stable cross-invocation artifact scope dir (`scopes/<workflow>/<scope>/`),
   * resolved by executor.ts when the workflow uses session persistence (#1846).
   * Undefined otherwise — no mirroring, no cold-resume pointer.
   */
  scopeArtifactsDir?: string,
  /**
   * Execution context for this run (host by default; the container backend
   * threads a container context in Phase B). Threaded onto every node's
   * `RunLayersContext` so provider turns and subprocesses exec in the right place.
   */
  execContext: ExecutionContext = { kind: 'host' },
  /**
   * Container run context (Phase C): the write-back backend port + env id + policy.
   * Present only for container runs. Drives suspend-on-pause and the engine-level
   * write-back gate that runs after the last node before the run completes.
   */
  containerCtx?: ContainerRunContext,
  /**
   * Injected closure that starts a child sub-run for a `workflow:` node (#2121
   * Phase 2). executor.ts is the sole caller and passes it; other callers (unit
   * tests) may omit it, in which case a `workflow:` node fails fast.
   */
  runChildWorkflow?: RunChildWorkflowFn
): Promise<string | undefined> {
  const dagStartTime = Date.now();

  // Container capability fail-fast: before ANY node runs (and before any
  // container work), reject a container run whose AI nodes resolve to a provider
  // that can't spawn in-container. No silent downgrade to the host — the user
  // asked for isolation and must get it or a clear error.
  if (execContext.kind === 'container') {
    const incompatible = collectContainerIncompatibleProviders(
      workflow.nodes,
      workflowProvider,
      aiProfile
    );
    if (incompatible.size > 0) {
      const list = [...incompatible].sort().join(', ');
      throw new Error(
        `Provider${incompatible.size === 1 ? '' : 's'} '${list}' cannot run inside a ` +
          'container yet (containerExec capability). Use provider claude, or run without ' +
          '--container.'
      );
    }

    // Container is live for this run — surface it in all three logging layers. A
    // resume (the container was rediscovered + restarted by the caller) emits
    // `container_resumed` rather than `container_created` so the timeline is honest.
    const isResume = priorCompletedNodes !== undefined && priorCompletedNodes.size > 0;
    emitContainerLifecycleEvent(
      deps,
      workflowRun.id,
      isResume ? 'resumed' : 'created',
      isResume ? 'container_resumed' : 'container_created',
      execContext.containerId,
      { containerId: execContext.containerId }
    );

    // H4 — native overlay mode grants CAP_SYS_ADMIN, so an adversarial in-container
    // agent can remount the read-only lower read-write and bypass the write-back
    // gate. Warn LOUDLY at run start (console/platform + a workflow event) so the
    // operator knows the isolation is accident-protection, not a hostile-agent
    // sandbox, in this mode. Warning-only in v1 (see SECURITY.md).
    if (containerCtx?.overlayMode === 'native') {
      await safeSendMessage(
        platform,
        conversationId,
        '⚠️ Container is running in NATIVE overlay mode (CAP_SYS_ADMIN). An adversarial ' +
          'agent could bypass the write-back review by remounting the project root — treat ' +
          'this run as accident-protection, not a sandbox against hostile code. (See SECURITY.md.)',
        { workflowId: workflowRun.id }
      );
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'container_created',
          step_name: 'container',
          data: { overlayMode: 'native', gateBypassable: true },
        })
        .catch((err: Error) => {
          // Persist failure of the security-audit event is worth a log (R2-F7) — the
          // console/platform warning already fired, so this is observability, not fatal.
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'container_created' },
            'workflow_event_persist_failed'
          );
        });
      getLog().warn({ workflowRunId: workflowRun.id }, 'dag.container_native_mode_gate_bypassable');
    }
  }

  const workflowTier = workflow.model && isTierName(workflow.model) ? workflow.model : undefined;
  const workflowLevelOptions = {
    effort: workflow.effort,
    thinking: workflow.thinking,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
    workflowTier,
  };
  const layers = buildTopologicalLayers(workflow.nodes);
  const nodeOutputs = new Map<string, NodeOutput>();

  // Pre-populate nodeOutputs from prior run so already-completed nodes are
  // treated as done for trigger-rule and $nodeId.output substitution purposes.
  // Nodes flagged `always_run: true` are excluded — they re-execute on resume
  // and downstream consumers must see the fresh output, not the cached one.
  if (priorCompletedNodes && priorCompletedNodes.size > 0) {
    const nodesById = new Map(workflow.nodes.map(n => [n.id, n]));
    let prepopulatedCount = 0;
    for (const [nodeId, output] of priorCompletedNodes) {
      const node = nodesById.get(nodeId);
      // Nodes flagged always_run re-execute on resume — leave them for fresh output.
      if (node?.always_run) continue;
      // Re-derive the producer's declared field set from the loaded definition so the
      // strict `$node.output.field` contract (output-ref.ts) is invariant across fresh
      // vs resumed runs. getCompletedDagNodeOutputs rehydrates text only, so without
      // this a declared-optional-absent field would throw instead of resolving to ''
      // and an undeclared key would resolve instead of throwing (#2091). Mirrors the
      // fresh-completion capture above.
      const declaredFields = declaredFieldsFromSchema(node?.output_format);
      nodeOutputs.set(nodeId, {
        state: 'completed',
        output,
        ...(declaredFields !== undefined ? { declaredFields } : {}),
      });
      prepopulatedCount++;
    }
    getLog().info(
      {
        workflowRunId: workflowRun.id,
        priorCompletedCount: priorCompletedNodes.size,
        prepopulatedCount,
        alwaysRunResumedCount: priorCompletedNodes.size - prepopulatedCount,
      },
      'dag.workflow_resume_prepopulated'
    );
  }

  getLog().info(
    {
      workflowName: workflow.name,
      nodeCount: workflow.nodes.length,
      layerCount: layers.length,
      hasIssueContext: !!issueContext,
      issueContextLength: issueContext?.length ?? 0,
    },
    'dag_workflow_starting'
  );

  // Per-node session persistence across workflow re-runs. Scope = the DB conversation
  // UUID. The `?? undefined` guard keeps an empty/missing conversation_id from keying
  // every invocation to the same blank scope — persistence is simply skipped in that case.
  // Distinct from AgentRequestOptions.persistSession (Claude SDK on-disk transcript flag).
  const persistScopeKey: string | undefined = workflowRun.conversation_id ?? undefined;
  const workflowPersistSessions = workflow.persist_sessions === true;

  // Run the topological layers. runLayers mutates the context's mutable fields in place
  // (nodeOutputs, lastSequentialSession, usage accumulators); we read them back below
  // for the terminal tally. stepNamePrefix is '' for the top-level DAG so node event
  // step_names are the raw node ids (identical to pre-refactor behavior).
  const runCtx: RunLayersContext = {
    deps,
    platform,
    conversationId,
    cwd,
    execContext,
    runChildWorkflow,
    workflowRun,
    workflowName: workflow.name,
    config,
    workflowProvider,
    workflowModel,
    workflowLevelOptions,
    aiProfile,
    workflowPreset,
    artifactsDir,
    logDir,
    baseBranch,
    docsDir,
    configuredCommandFolder,
    issueContext,
    persistScopeKey,
    workflowPersistSessions,
    // Scope-keyed persistence surface: without a scope key there is no durable
    // scope to mirror into or recover from, so the dir is dropped alongside it.
    scopeArtifactsDir: persistScopeKey !== undefined ? scopeArtifactsDir : undefined,
    layers,
    nodeOutputs,
    priorCompletedNodes,
    lastSequentialSession: undefined,
    totalCostUsd: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalLoopIterations: 0,
    stepNamePrefix: '',
  };
  await runLayers(runCtx);
  // Pull the mutated accumulators back into local scope for the terminal tally below.
  const totalCostUsd = runCtx.totalCostUsd;
  const totalTokensIn = runCtx.totalTokensIn;
  const totalTokensOut = runCtx.totalTokensOut;
  const totalLoopIterations = runCtx.totalLoopIterations;

  // Container pause economics (Phase C): if a node paused the run (approval /
  // interactive gate), suspend the container so a multi-day wait costs ~0 RAM/CPU.
  // The pause happens BETWEEN layers, after node completion — the #2134 background-
  // task wait gate has already drained and no `docker exec` is in flight (docker
  // stop would kill any live exec) — so it is safe to stop here. Resume rediscovers
  // and restarts. Terminal (failed / cancelled) runs are left for teardown, not
  // suspended. Only 'paused' triggers this.
  if (execContext.kind === 'container' && containerCtx) {
    const pausedStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (pausedStatus === 'paused') {
      await suspendContainerForPause(
        deps,
        platform,
        conversationId,
        containerCtx,
        execContext,
        workflowRun.id
      );
      return;
    }
  }

  /**
   * Bail out of the final completion/failure write if the run was transitioned
   * externally. Strict `!== 'running'` check is correct here because we don't
   * want to mark a paused run as complete — the approval gate is still live.
   *
   * Emitter unregister is conditional: terminal states (cancelled / deleted /
   * completed / failed) unregister to release subscription resources, but
   * `paused` keeps the emitter registered so SSE stays connected while the
   * approval gate awaits the user — crucial for resume observability.
   */
  async function skipIfStatusChanged(logEvent: string): Promise<boolean> {
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === 'running') return false;
    getLog().info({ workflowRunId: workflowRun.id, status: status ?? 'deleted' }, logEvent);
    if (status !== 'paused') {
      getWorkflowEventEmitter().unregisterRun(workflowRun.id);
    }
    return true;
  }

  // Single-pass: compute node outcome counts and derive success/failure booleans
  const nodeCounts = { completed: 0, failed: 0, skipped: 0, total: workflow.nodes.length };
  for (const o of nodeOutputs.values()) {
    if (o.state === 'completed') nodeCounts.completed++;
    else if (o.state === 'failed') nodeCounts.failed++;
    else if (o.state === 'skipped') nodeCounts.skipped++;
  }
  const anyCompleted = nodeCounts.completed > 0;
  const anyFailed = nodeCounts.failed > 0;
  // Categorical failure taxonomy for telemetry: type of the first failed node
  // in stored (Map insertion) order — for parallel layers this is layer-array
  // order, not completion order; any failed node is equally representative —
  // plus a fixed-enum error class derived from the stored node error. Raw
  // error text never leaves.
  const failureTaxonomy = firstFailedNodeTaxonomy(nodeOutputs, workflow.nodes);
  const runUsageProps = buildRunUsageProps({
    costUsd: totalCostUsd,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    loopIterations: totalLoopIterations,
  });

  getLog().info(
    { nodeCount: workflow.nodes.length, anyCompleted, anyFailed },
    'dag_workflow_finished'
  );

  if (!anyCompleted) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    const failedNodes: string[] = [];
    for (const [nodeId, o] of nodeOutputs) {
      if (o.state === 'failed') failedNodes.push(nodeId);
    }
    const failMsg =
      failedNodes.length > 0
        ? `DAG workflow '${workflow.name}' failed: node${failedNodes.length > 1 ? 's' : ''} ${failedNodes.join(', ')} failed. ` +
          `${nodeCounts.skipped} downstream node${nodeCounts.skipped !== 1 ? 's were' : ' was'} skipped.`
        : `DAG workflow '${workflow.name}' completed with no successful nodes. ` +
          'Check node conditions, trigger rules, and upstream failures.';
    // Anonymous telemetry: terminal failure (no successful nodes). Counts/
    // duration are in scope here even though they aren't persisted to the DB row.
    captureWorkflowCompleted({
      outcome: 'failed',
      workflowName: workflow.name,
      workflowSource: source,
      provider: workflowProvider,
      durationMs: Date.now() - dagStartTime,
      nodesCompleted: nodeCounts.completed,
      nodesFailed: nodeCounts.failed,
      nodesSkipped: nodeCounts.skipped,
      nodesTotal: nodeCounts.total,
      exitReason: 'no_nodes_completed',
      ...failureTaxonomy,
      ...runUsageProps,
    });
    // Note: nodeCounts not stored for failed runs — failWorkflowRun only stores { error }.
    // Frontend guards with isValidNodeCounts so missing node_counts is safe.
    await deps.store.failWorkflowRun(workflowRun.id, failMsg).catch((dbErr: Error) => {
      getLog().error({ err: dbErr, workflowRunId: workflowRun.id }, 'dag_db_fail_failed');
    });
    await logWorkflowError(logDir, workflowRun.id, failMsg).catch((logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    });
    const emitterForFail = getWorkflowEventEmitter();
    emitterForFail.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: failMsg,
    });
    emitterForFail.unregisterRun(workflowRun.id);
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    // DO NOT throw — outer executor.ts catch would duplicate workflow_failed events
    return;
  }

  if (anyFailed) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    const failedNodes = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
      .join('; ');
    const failMsg = `DAG workflow '${workflow.name}' completed with failures: ${failedNodes}`;
    // Anonymous telemetry: terminal failure (some nodes failed).
    captureWorkflowCompleted({
      outcome: 'failed',
      workflowName: workflow.name,
      workflowSource: source,
      provider: workflowProvider,
      durationMs: Date.now() - dagStartTime,
      nodesCompleted: nodeCounts.completed,
      nodesFailed: nodeCounts.failed,
      nodesSkipped: nodeCounts.skipped,
      nodesTotal: nodeCounts.total,
      exitReason: 'node_error',
      ...failureTaxonomy,
      ...runUsageProps,
    });
    await deps.store.failWorkflowRun(workflowRun.id, failMsg).catch((dbErr: Error) => {
      getLog().error({ err: dbErr, workflowRunId: workflowRun.id }, 'dag_db_fail_failed');
    });
    await logWorkflowError(logDir, workflowRun.id, failMsg).catch((logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    });
    const emitterForFail = getWorkflowEventEmitter();
    emitterForFail.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: failMsg,
    });
    emitterForFail.unregisterRun(workflowRun.id);
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    // DO NOT throw — outer executor.ts catch would duplicate workflow_failed events
    return;
  }

  // Check if status was changed externally (e.g. cancelled) before marking complete.
  if (await skipIfStatusChanged('dag.skip_complete_status_changed')) return;

  // Evidence gate (#2230): thin terminal-success gate, a sibling of the
  // approval/write-back gates (run-status transitions are engine governance).
  // When the workflow declares `evidence_policy.required: true`, refuse to flip
  // the run to `completed` unless `$ARTIFACTS_DIR/evidence.json` exists — the
  // workflow's own bash/script nodes compute what counts as evidence; the
  // engine checks PRESENCE only (no schema validation, no content checks, no
  // git/gh I/O — constitution: code computes, YAML coordinates). Placed BEFORE
  // the container write-back gate so a run that cannot complete never pauses
  // for (or applies) write-back — mirroring how node-failure runs skip that
  // gate entirely. Resume-safe: the run id (and therefore artifactsDir) is
  // stable across resume, so a failed run resumed after evidence.json is
  // produced re-enters here with all nodes prior-completed and completes.
  if (workflow.evidence_policy?.required === true) {
    const evidencePath = joinPath(artifactsDir, 'evidence.json');
    if (!existsSync(evidencePath)) {
      const failMsg =
        `DAG workflow '${workflow.name}' failed the evidence gate: ` +
        `evidence_policy.required is true but no evidence file exists at ${evidencePath}. ` +
        'All nodes succeeded — produce evidence.json from a bash/script node, ' +
        'then resume the run once the file exists.';
      getLog().error({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_failed');
      // Anonymous telemetry: terminal failure (evidence missing at completion).
      captureWorkflowCompleted({
        outcome: 'failed',
        workflowName: workflow.name,
        workflowSource: source,
        provider: workflowProvider,
        durationMs: Date.now() - dagStartTime,
        nodesCompleted: nodeCounts.completed,
        nodesFailed: nodeCounts.failed,
        nodesSkipped: nodeCounts.skipped,
        nodesTotal: nodeCounts.total,
        exitReason: 'evidence_missing',
        ...runUsageProps,
      });
      // Structured, machine-readable note first (metadata merge), then the
      // failed-status write — so metadata.evidence_validation is already present
      // the moment the run reads as failed.
      await deps.store
        .updateWorkflowRun(workflowRun.id, {
          metadata: {
            evidence_validation: {
              status: 'missing',
              policy: 'evidence_policy.required',
              expected_path: evidencePath,
              checked_at: new Date().toISOString(),
            },
          },
        })
        .catch((dbErr: Error) => {
          getLog().error(
            { err: dbErr, workflowRunId: workflowRun.id },
            'dag.evidence_metadata_write_failed'
          );
        });
      await deps.store.failWorkflowRun(workflowRun.id, failMsg).catch((dbErr: Error) => {
        getLog().error({ err: dbErr, workflowRunId: workflowRun.id }, 'dag_db_fail_failed');
      });
      // Persist the reason into the workflow-events log (contract: never throws).
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'evidence_validation_failed',
        data: { policy: 'evidence_policy.required', expected_path: evidencePath },
      });
      await logWorkflowError(logDir, workflowRun.id, failMsg).catch((logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      });
      const emitterForEvidence = getWorkflowEventEmitter();
      emitterForEvidence.emit({
        type: 'workflow_failed',
        runId: workflowRun.id,
        workflowName: workflow.name,
        error: failMsg,
      });
      emitterForEvidence.unregisterRun(workflowRun.id);
      await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
        workflowId: workflowRun.id,
      });
      // DO NOT throw — outer executor.ts catch would duplicate workflow_failed events
      return;
    }
    getLog().info({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_passed');
  }

  // Container write-back gate (Phase C): all nodes succeeded — before completing,
  // present the overlay diff and (unless auto) pause for approval. This is an
  // ENGINE-level gate with no DAG node. On the FIRST arrival it either pauses
  // (approve policy, non-empty diff) or applies (auto / has changes) / skips
  // (empty diff). On a RESUME after the decision, the DAG re-ran with every node
  // skipped and lands here again with `pending_writeback` set — it applies or
  // discards and falls through to completion. `paused` short-circuits (the gate
  // suspended the container); any other outcome falls through to completeWorkflowRun.
  if (execContext.kind === 'container' && containerCtx) {
    const gate = await runContainerWriteBackGate(
      deps,
      platform,
      conversationId,
      workflowRun.id,
      containerCtx,
      execContext
    );
    if (gate === 'paused') return;
  }

  // Terminal output (first sink node, non-blank, definition order) — the run's
  // "summary". Computed BEFORE completeWorkflowRun so a sub-run can persist it into
  // its own metadata: a `workflow:` parent re-reads it from there on auto-resume
  // (the child's executeWorkflow return value is discarded across the human gate).
  const allDependencies = new Set(workflow.nodes.flatMap(n => n.depends_on ?? []));
  const terminalOutput = workflow.nodes
    .filter(n => !allDependencies.has(n.id))
    .map(n => nodeOutputs.get(n.id))
    .find(o => o?.state === 'completed' && o.output.trim().length > 0)?.output;

  // Update DB and emit completion
  try {
    await deps.store.completeWorkflowRun(workflowRun.id, {
      node_counts: nodeCounts,
      // totalCostUsd starts at 0; only write metadata when at least one node reported cost
      ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
      // Persist token totals (D8) so a `workflow:` parent rolls up tokens as well as
      // cost. Only when non-zero (telemetry-only fields otherwise).
      ...(totalTokensIn > 0 ? { total_tokens_in: totalTokensIn } : {}),
      ...(totalTokensOut > 0 ? { total_tokens_out: totalTokensOut } : {}),
      // A sub-run persists its terminal summary so the parent can thread it as
      // `$<node>.output` on re-entry. Gated on parent_run_id to bound metadata
      // growth to child runs only (top-level runs return the summary directly).
      ...(workflowRun.parent_run_id && terminalOutput ? { summary: terminalOutput } : {}),
    });
  } catch (dbErr) {
    getLog().error(
      { err: dbErr as Error, workflowRunId: workflowRun.id },
      'dag_db_complete_failed'
    );
    await safeSendMessage(
      platform,
      conversationId,
      'Warning: workflow completed but the run status could not be saved. The workflow result may appear inconsistent.',
      { workflowId: workflowRun.id }
    );
  }
  await logWorkflowComplete(logDir, workflowRun.id);
  const duration = Date.now() - dagStartTime;
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration,
  });
  // Anonymous telemetry: successful terminal run with outcome + duration + counts.
  captureWorkflowCompleted({
    outcome: 'completed',
    workflowName: workflow.name,
    workflowSource: source,
    provider: workflowProvider,
    durationMs: duration,
    nodesCompleted: nodeCounts.completed,
    nodesFailed: nodeCounts.failed,
    nodesSkipped: nodeCounts.skipped,
    nodesTotal: nodeCounts.total,
    ...runUsageProps,
  });
  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_completed',
      data: { duration_ms: duration },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'workflow_completed' },
        'workflow_event_persist_failed'
      );
    });
  emitter.unregisterRun(workflowRun.id);

  // terminalOutput (computed above, before the completion write) is the run's
  // summary for the parent conversation and the `workflow:` re-entry path.
  return terminalOutput;
}
