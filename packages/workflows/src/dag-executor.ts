/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute, join as joinPath, resolve as resolvePath, sep } from 'path';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { discoverScriptsForCwd } from './script-discovery';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import {
  liveSourceRoots,
  resolveChildDiscoveryRoot,
  type WorkflowSourceRoots,
} from './workflow-source';
import { resolveWorkflowName } from './router';
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
  ResolvedModel,
  ExecutionContext,
  OverlayChangeSummary,
} from '@archon/providers/types';
import { CONTAINER_ENV_DENYLIST, mergeTokenUsage } from '@archon/providers/types';
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
  IncludeDirective,
  GateNode,
  WaitNode,
  ExecNode,
  AgentNode,
  LoopNode,
  LoopGroupNode,
  WorkflowNode,
  FanOutConfig,
  NodeOutput,
  TriggerRule,
  WorkflowRun,
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
  WebSearchMode,
  WorkflowSource,
  WorkflowDefinition,
  LoopGateRunMetadata,
  ApprovalContext,
  WorkflowEvidencePolicy,
  WorkflowBudgetPolicy,
  WorkflowRunOutcome,
  NodeArtifactLoopFrame,
  WorkflowRunNodeSession,
  WorkflowRunStatus,
  WorkflowWaitContext,
  ScheduledWorkflowResume,
} from './schemas';
import {
  isExecNode,
  isAgentNode,
  isLoopNode,
  isLoopGroupNode,
  isGateNode,
  isWaitNode,
  isWorkflowWaitContext,
  isScheduledWorkflowResume,
  isHaltNode,
  isIncludeDirective,
  isPersistableNode,
  readSubrunMetadata,
  isApprovalContext,
  inputEnvKey,
  isNodeContextResume,
  isBindingDirective,
  SUBRUN_METADATA_KEYS,
  WAIT_NODE_OUTPUT_FORMAT,
  waitUntilTimestampSchema,
  waitCondition,
} from './schemas';
import type { BindingDirective } from './schemas';
import type { PersistedNodeOutput } from './store';
import { formatToolCall } from './utils/tool-formatter';
import { createLogger, captureWorkflowCompleted } from '@archon/paths';
import type { WorkflowErrorClass, WorkflowNodeType } from '@archon/paths';
import { getWorkflowEventEmitter } from './event-emitter';
import { evaluateCondition } from './condition-evaluator';
import {
  declaredFieldsFromSchema,
  resolveNodeOutputField,
  assertProducerNotFailed,
  OutputRefError,
  similarNodeIds,
  canonicalValueText,
  parseWholeOutputRef,
  parseWholeInputsRef,
  substituteInputRefs,
  type JsonValue,
} from './output-ref';
import { buildTruncationMarker } from './utils/output-truncation';
import { writeNodeArtifact, readNodeArtifacts } from './artifacts-index';
import {
  COMPILED_LOOP_COMMAND,
  COMPOSED_NODE,
  readComposedMeta,
  type LoopWithCompiledCommand,
  type NodeWithComposedMeta,
} from './compiled-command';
import { assistantModelDefaults, resolveNodeModel } from './node-model-resolution';
import {
  logNodeStart,
  logNodeComplete,
  logNodeSkip,
  logNodeError,
  logAssistant,
  logTool,
  logWorkflowComplete,
  logWorkflowError,
  type WorkflowUsage,
} from './logger';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from './utils/idle-timeout';
import { mapWithLimit } from './utils/map-with-limit';
import {
  classifyError,
  toTelemetryErrorClass,
  detectCreditExhaustion,
  isQuotaExhaustionError,
  extractQuotaResetAt,
  loadCommandPrompt,
  substituteWorkflowVariables,
  buildPromptWithContext,
  detectCompletionSignal,
  describeUnmetCompletion,
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
  resolvePresetEffort,
  type ModelAliasPreset,
  type ResolvedAiProfile,
  type TierName,
} from './model-validation';

/**
 * Closed-set node type for telemetry — mirrors the DagNode discriminators.
 */
function dagNodeTelemetryType(node: DagNode): WorkflowNodeType {
  switch (node.kind) {
    case 'agent':
      return node.source.kind === 'command' ? 'command' : 'prompt';
    case 'exec':
      return node.runtime === 'sh' ? 'bash' : 'script';
    case 'loop':
      return 'loop';
    case 'loop_group':
      return 'loop_group';
    case 'gate':
      return 'approval';
    case 'wait':
      return 'wait';
    case 'halt':
      return 'cancel';
    case 'workflow':
      return 'workflow';
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

/**
 * Display name for a node in user-facing events: a command node's file name (matching
 * today's `node.command ?? node.id` convention), otherwise the node's own id.
 */
function nodeDisplayName(node: DagNode): string {
  return isAgentNode(node) && node.source.kind === 'command' ? node.source.name : node.id;
}

/**
 * Resolve this run's named inputs (#2470) from persisted sub-run metadata. Non-empty
 * only for `workflow:` sub-run children (the parent stamps `metadata.inputs` at spawn);
 * a top-level run has none. Threaded into every AI/prompt substitution so `$INPUTS.<name>`
 * resolves, and mangled to `INPUTS_<UPPER_SNAKE>` env vars for bash/script nodes.
 * Values are logical JSON values (#2637): `readSubrunMetadata` prefers the
 * `inputs_values` sibling key and degrades to the legacy text map.
 */
function resolveRunInputs(
  workflowRun: Pick<WorkflowRun, 'metadata'>
): Record<string, JsonValue> | undefined {
  return readSubrunMetadata(workflowRun.metadata as Record<string, unknown> | undefined).inputs;
}

/**
 * Everything resolving a composed input value needs; the caller has all of it in scope.
 * `workflowRun` is a Pick so the dry-run simulator — which has no WorkflowRun row —
 * can construct one for {@link resolveNodeBindings} (#2637); executor callers pass
 * their full run unchanged.
 */
export interface ShellInputContext {
  workflowRun: Pick<WorkflowRun, 'id' | 'user_message' | 'metadata'>;
  artifactsDir: string;
  stateDir: string;
  baseBranch: string;
  docsDir: string;
  issueContext?: string;
  nodeOutputs: Map<string, NodeOutput>;
}

/**
 * Env-var bag delivering named inputs to a bash/script node as `INPUTS_<UPPER_SNAKE>`.
 *
 * Two sources, in precedence order:
 *   - the RUN's own inputs (#2470) — a `workflow:` sub-run child carries them in metadata.
 *   - the node's COMPOSED inputs (#1764) — the contract-resolved `inputs:` of the workflow
 *     this node was authored in, stamped at expansion when it arrived through `include:`.
 *     These win: a node's own file is the nearer contract, and it is the only channel a
 *     NAMED script file has (its source is opaque, so the load-time `$INPUTS` macro that
 *     serves inline bodies can never reach it).
 *
 * A composed value gets the same two passes a `workflow:` node's `with:` map does —
 * workflow variables (NOT shell-safe: these become env values, never shell source) then
 * `$node.output` refs — resolved here rather than at load because a value may hold
 * `$ARTIFACTS_DIR` or a ref that only exists at run time. Values are never shell-escaped:
 * the env bag is itself the injection-safe channel (#2115), which is why they never touch
 * the script source. Both shell env sites call this one function so the bag and its
 * ordering cannot diverge between them.
 */
function inputEnvVars(node: DagNode, ctx: ShellInputContext): NodeJS.ProcessEnv {
  const runInputs = resolveRunInputs(ctx.workflowRun);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(runInputs ?? {})) {
    // Canonical text (#2637): env vars are text, so a typed input rides its one
    // deterministic representation (strings raw, everything else JSON text).
    env[inputEnvKey(name)] = canonicalValueText(value);
  }
  for (const [name, value] of Object.entries(readComposedMeta(node)?.inputs ?? {})) {
    // Only strings can carry templates/refs; a typed composed value passes as-is.
    env[inputEnvKey(name)] =
      typeof value === 'string'
        ? substituteNodeOutputRefs(
            substituteWorkflowVariables(
              value,
              ctx.workflowRun.id,
              ctx.workflowRun.user_message,
              ctx.artifactsDir,
              ctx.baseBranch,
              ctx.docsDir,
              ctx.issueContext,
              undefined,
              undefined,
              undefined,
              { stateDir: ctx.stateDir, inputs: runInputs }
            ).prompt,
            ctx.nodeOutputs
          )
        : canonicalValueText(value);
  }
  // Node-local bindings (#2637) — a script node's own `with:` map, resolved against
  // upstream outputs. Third and NEAREST source: the node's own file is the nearest
  // contract, so it wins over composed and run inputs (extends the documented order
  // above). Resolution failures throw and fail the node — never a silent ''.
  if (isExecNode(node) && node.runtime !== 'sh' && node.with !== undefined) {
    for (const [name, value] of Object.entries(
      resolveNodeBindings(node.id, node.with, ctx, runInputs)
    )) {
      env[inputEnvKey(name)] = canonicalValueText(value);
    }
  }
  return env;
}

/**
 * The logical value of one whole `$node.output[.field]` reference (#2637): the
 * producer's parsed structured payload when it has one (else its output text) for
 * the unfielded form, and the raw field value under the strict no-silent-drop
 * contract for the fielded form (declared-optional-absent → '').
 *
 * A failed producer never resolves here, fielded or not (#2713): `resolveBindingDirective`
 * already guards its own call below before reaching this function, so the check below only
 * ever fires for this function's OTHER caller, `resolveWorkflowValue`'s whole-ref tier — the
 * plain (non-directive) `with:` value on a script/command node, a `workflow:` node's `with:`,
 * or `fan_out`'s static `with:`, none of which had #2710's guard. Routes through
 * `assertProducerNotFailed` in output-ref.ts (#2722), which every other whole-text reader
 * of `nodeOutputs` shares.
 */
function wholeRefLogicalValue(
  producer: NodeOutput,
  nodeId: string,
  field: string | undefined
): JsonValue {
  if (field === undefined) {
    assertProducerNotFailed(
      producer,
      failed =>
        `Binding value '$${nodeId}.output' references node '${nodeId}', but it failed ` +
        `(${failed.error}), so its output cannot be trusted. Fix the failure, or guard ` +
        "the referencing node with a 'when:' condition that excludes the failed branch."
    );
    const structured = 'structuredOutput' in producer ? producer.structuredOutput : undefined;
    // Provider payloads are ajv-validated / DB-round-tripped JSON, so the cast
    // asserts what production already guarantees.
    return structured !== undefined ? (structured as JsonValue) : producer.output;
  }
  // A failed producer's fielded form is rejected inside resolveNodeOutputField itself
  // (#2713) — the same 'producer-failed' guard as the unfielded branch above.
  const resolution = resolveNodeOutputField(producer, nodeId, field);
  return resolution.kind === 'empty' ? '' : (resolution.value as JsonValue);
}

/**
 * Resolve one `with:` value to its logical JSON value (#2637).
 *
 * Three tiers, in order:
 *  - a non-string literal (boolean/number/null/array/object) passes through as-is;
 *  - a string that is EXACTLY one whole `$INPUTS.<name>` or `$node.output[.field]`
 *    reference resolves to the LOGICAL value (type preserved);
 *  - any other string is a template: two-pass text substitution (workflow vars,
 *    then `$node.output` refs), exactly as `input:` resolves.
 *
 * `strictWholeRef` selects the unknown-producer posture for the unfielded whole-ref
 * form: node-local bindings are a new surface and FAIL (with a did-you-mean hint);
 * `workflow:`/fan-out `with:` values keep the template path's historical lenient ''
 * so pre-#2637 workflows resolve byte-identically. Fielded refs fail everywhere.
 */
function resolveWorkflowValue(
  rawValue: JsonValue,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined,
  strictWholeRef: boolean
): JsonValue {
  if (typeof rawValue !== 'string') return rawValue;
  const inputsName = parseWholeInputsRef(rawValue);
  if (inputsName !== undefined) {
    const name = inputsName;
    if (runInputs && Object.hasOwn(runInputs, name)) return runInputs[name];
    // Same loud posture (and hint shape) as the text splice in executor-shared.
    const known = runInputs ? Object.keys(runInputs) : [];
    const hint = similarNodeIds(name, known);
    const suffix =
      hint.length > 0
        ? ` Did you mean ${hint.map(h => `$INPUTS.${h}`).join(', ')}?`
        : known.length > 0
          ? ` Available inputs: ${known.map(k => `$INPUTS.${k}`).join(', ')}.`
          : ' This run has no declared inputs.';
    throw new Error(`Unknown input '$INPUTS.${name}'.${suffix}`);
  }
  const wholeRef = parseWholeOutputRef(rawValue);
  if (wholeRef !== undefined) {
    const producer = ctx.nodeOutputs.get(wholeRef.nodeId);
    if (producer !== undefined) {
      return wholeRefLogicalValue(producer, wholeRef.nodeId, wholeRef.field);
    }
    if (wholeRef.field !== undefined) {
      throw new OutputRefError(
        wholeRef.nodeId,
        wholeRef.field,
        'unknown-node',
        similarNodeIds(wholeRef.nodeId, ctx.nodeOutputs.keys())
      );
    }
    if (strictWholeRef) {
      const candidates = similarNodeIds(wholeRef.nodeId, ctx.nodeOutputs.keys());
      const hint =
        candidates.length > 0 ? ` Did you mean: ${candidates.map(c => `'${c}'`).join(', ')}?` : '';
      throw new Error(
        `Binding value '$${wholeRef.nodeId}.output' references node '${wholeRef.nodeId}', ` +
          'but no node with that id has produced output at this point — the id is either ' +
          'unknown (a typo) or belongs to a node that has not run before this reference.' +
          `${hint} Fix the id, or add '${wholeRef.nodeId}' to depends_on.`
      );
    }
    // Lenient legacy surface: fall through to the template path, which resolves the
    // unknown whole-text ref to '' with a warn — byte-identical to pre-#2637.
  }
  const { prompt: substituted } = substituteWorkflowVariables(
    rawValue,
    ctx.workflowRun.id,
    ctx.workflowRun.user_message,
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext,
    undefined,
    undefined,
    undefined,
    { stateDir: ctx.stateDir, inputs: runInputs }
  );
  return substituteNodeOutputRefs(substituted, ctx.nodeOutputs);
}

/**
 * Resolve a command/script node's node-local `with:` map (#2637) to logical values.
 *
 * A plain-object value is the explicit binding directive `{ from, if_skipped? }`:
 * `from` reads one whole upstream ref; a producer that did not run (skipped or
 * pending — reachable under `trigger_rule: all_done` across a skipped branch)
 * takes `if_skipped` instead, and without one the node fails with the fix named.
 * Everything else resolves through {@link resolveWorkflowValue} in strict mode.
 * The loader guarantees bound producers are upstream `depends_on`, so resolution
 * here is a per-node pre-step with no new scheduling.
 *
 * `runInputs` is explicit (not derived from ctx) so the dry-run simulator can pass
 * its effective input map — its synthetic context carries no run metadata. Exported
 * for that simulator only; it must resolve bindings with THIS function so preview
 * and execution cannot drift (#2637 R2).
 */
export function resolveNodeBindings(
  consumerId: string,
  withMap: Record<string, JsonValue | BindingDirective>,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {};
  for (const [name, rawValue] of Object.entries(withMap)) {
    if (isBindingDirective(rawValue)) {
      resolved[name] = resolveBindingDirective(consumerId, name, rawValue, ctx);
      continue;
    }
    if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
      // The loader rejects this shape at load time; programmatic definitions can
      // still reach here, so keep the failure loud and actionable.
      throw new Error(
        `Node '${consumerId}' binding '${name}': an object value must be a binding directive ` +
          "{ from: '$node.output[.field]', if_skipped?: <value> }. Use a string, number, " +
          'boolean, null, or array for a literal value.'
      );
    }
    resolved[name] = resolveWorkflowValue(rawValue, ctx, runInputs, true);
  }
  return resolved;
}

function resolveBindingDirective(
  consumerId: string,
  name: string,
  directive: BindingDirective,
  ctx: ShellInputContext
): JsonValue {
  const ref = parseWholeOutputRef(directive.from);
  if (ref === undefined) {
    throw new Error(
      `Node '${consumerId}' binding '${name}': 'from' must be exactly one whole ` +
        `'$node.output' or '$node.output.field' reference, got '${directive.from}'.`
    );
  }
  const producer = ctx.nodeOutputs.get(ref.nodeId);
  if (producer === undefined || producer.state === 'skipped' || producer.state === 'pending') {
    // Presence-keyed: `if_skipped: null` (or false/0/'') is a real declared default.
    if (Object.hasOwn(directive, 'if_skipped')) return directive.if_skipped as JsonValue;
    throw new Error(
      `Node '${consumerId}' binding '${name}' reads '${directive.from}', but node ` +
        `'${ref.nodeId}' did not run (skipped or pending), so it has no output to read. ` +
        "Declare 'if_skipped:' on the binding to supply a default for that branch, or " +
        `guard '${consumerId}' with a 'when:' condition.`
    );
  }
  // A failed producer never falls back to `if_skipped` (#2696): that default exists for
  // a branch that legitimately didn't run, not for a run that ran and produced a result
  // that can't be trusted (a loop_group's failure paths carry the last completed
  // iteration's real output text — non-empty, often valid JSON — which would otherwise
  // resolve here as if the group had succeeded). Routes through `assertProducerNotFailed`
  // in output-ref.ts (#2722, extending #2710's original guard to every whole-text reader
  // of nodeOutputs through one shared function).
  assertProducerNotFailed(
    producer,
    failed =>
      `Node '${consumerId}' binding '${name}' reads '${directive.from}', but node ` +
      `'${ref.nodeId}' failed (${failed.error}), so its output cannot be trusted. ` +
      "A binding never falls back to 'if_skipped' for a failed producer — fix the " +
      `failure, or guard '${consumerId}' with a 'when:' condition that excludes the ` +
      'failed branch.'
  );
  return wholeRefLogicalValue(producer, ref.nodeId, ref.field);
}

interface RunningTool {
  toolName: string;
  startedAt: number;
}

function findRunningTool(
  runningTools: Map<string, RunningTool>,
  toolName: string,
  toolCallId: string | undefined
): [string, RunningTool] | undefined {
  if (toolCallId) {
    const tool = runningTools.get(toolCallId);
    return tool ? [toolCallId, tool] : undefined;
  }

  return Array.from(runningTools.entries())
    .reverse()
    .find(([, tool]) => tool.toolName === toolName);
}

/**
 * Usage totals for the terminal telemetry event. Fields are omitted (not sent
 * as zero) when nothing was reported, so absence in PostHog means "providers
 * reported no usage", never "zero spend".
 */
function buildRunUsageProps(totals: {
  costUsd: number;
  tokens?: TokenUsage;
  loopIterations: number;
}): {
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cachePartialTokens?: true;
  loopIterations?: number;
} {
  return {
    ...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
    ...(totals.tokens !== undefined
      ? {
          tokensIn: totals.tokens.input,
          tokensOut: totals.tokens.output,
          ...(totals.tokens.cacheRead !== undefined
            ? { cacheReadTokens: totals.tokens.cacheRead }
            : {}),
          ...(totals.tokens.cacheWrite !== undefined
            ? { cacheWriteTokens: totals.tokens.cacheWrite }
            : {}),
          // Without this a floor is indistinguishable from a complete total, which would
          // bias aggregate cache stats low instead of merely leaving them absent (#2662).
          ...(totals.tokens.cachePartial ? { cachePartialTokens: true as const } : {}),
        }
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
  declaredEffort: string | undefined,
  nodeConfig: NodeConfig
): void {
  if (!preset) return;

  if (
    preset.thinking !== undefined &&
    node.thinking === undefined &&
    workflowLevelOptions.thinking === undefined
  ) {
    nodeConfig.thinking = preset.thinking;
  }

  // An effort declared on the node or workflow outranks the preset's. Passed in
  // rather than re-derived so this cannot disagree with the chain that builds
  // `nodeConfig.effort` below — the two disagreeing is exactly what made an
  // explicit `effort:` on a Codex node suppress its tier's effort and apply
  // nothing at all (#2556).
  if (preset.effort === undefined || declaredEffort !== undefined) return;

  // Shared with the chat orchestrator's `applyPresetToRequestOptions`, so the
  // same tier cannot mean one depth in a workflow and another in chat. The
  // classifier returns the reason; each caller keeps its own event namespace.
  const decision = resolvePresetEffort(provider, preset.effort);
  if (!decision.ok) {
    // Warn rather than silently drop it — fail-loud per the project's fail-fast
    // guideline. `unsupported` means the resolved provider has no reasoning
    // control at all (e.g. a `tiers:` entry sets `effort` on an OpenCode tier).
    getLog().warn(
      { provider, effort: preset.effort, nodeId: node.id, valid: decision.valid },
      decision.reason === 'unsupported'
        ? 'dag.preset_effort_unsupported'
        : 'dag.preset_effort_unknown'
    );
    return;
  }
  nodeConfig.effort = preset.effort;
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

/** Workflow-level provider options. The provider options have node-level
 *  counterparts and are resolved as `node.X ?? workflowLevelOptions.X`. Two do
 *  not: `webSearchMode`, absent from `dagNodeSchema` so a workflow-level value
 *  is the only value, and `workflowTier`, which is not an author-facing field at
 *  all — it carries the workflow's resolved tier keyword for annotation. */
interface WorkflowLevelOptions {
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  fallbackModel?: string;
  betas?: string[];
  sandbox?: SandboxSettings;
  /** Codex-only: web-search mode, consumed as `assistantConfig.webSearchMode`.
   *  Permanently workflow-level-only — decided in #2556, and the ONLY
   *  workflow-level field with no per-node counterpart. */
  webSearchMode?: WebSearchMode;
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

/**
 * Add provider usage, keeping each cache axis that was actually reported and marking the
 * result a floor when some contribution stayed silent (see `mergeTokenUsage`).
 * Required non-finite counters invalidate only that contribution; malformed optional
 * counters are treated as unknown while valid gross input/output remain usable.
 */
function sumTokenUsage(
  usages: readonly TokenUsage[],
  context: Record<string, unknown> = {}
): TokenUsage | undefined {
  const valid: TokenUsage[] = [];
  for (const usage of usages) {
    if (!Number.isFinite(usage.input) || !Number.isFinite(usage.output)) {
      getLog().warn({ ...context, tokens: usage }, 'dag.usage_tokens_non_finite_ignored');
      continue;
    }
    // Spread rather than rebuild field-by-field: a rebuilt literal silently drops any
    // axis this function does not know about, which is how `cachePartial` was lost on
    // re-aggregation (a partial total became complete on the next merge).
    const normalized: TokenUsage = { ...usage };
    for (const axis of ['cacheRead', 'cacheWrite'] as const) {
      const value = usage[axis];
      if (value === undefined) continue;
      if (!Number.isFinite(value)) {
        // Cleared rather than deleted (no-dynamic-delete): every reader treats an
        // undefined axis as unreported, and JSON.stringify omits the key entirely.
        normalized[axis] = undefined;
        getLog().warn({ ...context, axis, value }, 'dag.usage_optional_tokens_non_finite_ignored');
      }
    }
    valid.push(normalized);
  }
  // The merge rule itself lives with TokenUsage so every aggregation site shares one
  // owner; this function keeps the validation and warn events, which differ per caller.
  return mergeTokenUsage(valid);
}

// ---------------------------------------------------------------------------
// workflow: (sub-run) node — cross-run composition (#2121 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Usage a resumed run already consumed in earlier passes, rebuilt from its persisted
 * node completion and failure events by `getDagResumeSnapshot`. Both axes travel
 * together because they are one concept — what this run has spent so far — and seeding
 * only one of them is how cost came to under-report every resumed run while tokens did
 * not (#2469).
 */
export interface PriorRunUsage {
  tokens?: TokenUsage;
  costUsd: number;
  /** Started node attempts from prior passes (#1961) — seeds the work-unit budget ledger. */
  workUnits: number;
}

/**
 * Shared, mutated-in-place ledger backing run-wide budget enforcement (#1961).
 * Created once per `executeDagWorkflow` when the workflow declares `budget:` and
 * passed BY REFERENCE into loop-group body contexts and child-spawn drivers so
 * every attempt and spawn counts toward one ceiling. `spendUsd` is seeded from
 * prior usage on resume; `workUnits` counts node attempts (one `node_started`
 * audit row each) and spawn decisions (one `work_unit_charged` audit row each),
 * so a cold resume reconstructs both from the event log.
 */
export interface RunBudgetLedger {
  spendUsd: number;
  workUnits: number;
}

/** The axis that tripped, with the limit and the observed value — the payload of a `budget_exhausted` event. */
export interface BudgetExhaustion {
  budget: 'max_spend_usd' | 'max_work_units';
  limit: number;
  current: number;
}

/**
 * Which run-wide ceiling (if any) the ledger already meets or exceeds. Checked
 * before dispatching new work; nodes already in flight are allowed to finish,
 * so exhaustion overshoot is bounded by one layer.
 */
function checkBudgetExhaustion(
  budget: WorkflowBudgetPolicy | undefined,
  ledger: RunBudgetLedger | undefined
): BudgetExhaustion | undefined {
  if (budget === undefined || ledger === undefined) return undefined;
  if (budget.max_spend_usd !== undefined && ledger.spendUsd >= budget.max_spend_usd) {
    return { budget: 'max_spend_usd', limit: budget.max_spend_usd, current: ledger.spendUsd };
  }
  if (budget.max_work_units !== undefined && ledger.workUnits >= budget.max_work_units) {
    return { budget: 'max_work_units', limit: budget.max_work_units, current: ledger.workUnits };
  }
  return undefined;
}

function describeBudgetExhaustion(e: BudgetExhaustion): string {
  const axis = e.budget === 'max_spend_usd' ? 'spend' : 'work-unit';
  return (
    `${axis} budget exhausted: ${e.budget} limit $${e.limit} reached ($${e.current} recorded). ` +
    `Raise budget.${e.budget} in the workflow definition or cancel the run.`
  );
}

/**
 * Charge one work unit to the run's shared ledger when one exists (#1961), and
 * persist a matching `work_unit_charged` audit row so the charge is reconstructible
 * from the event log on cold resume (`getDagResumeSnapshot` counts these rows back).
 * The persist is awaited — a fire-and-forget write would let a transient DB failure
 * drop the row while the live ledger still counts the unit, silently loosening the
 * `max_work_units` ceiling on the next cold resume. The increment happens synchronously
 * with the caller's exhaustion check — concurrent fan-out workers share the gate read and
 * an awaited gap between them would let several siblings reserve the same unit. A failed
 * persist rolls the reservation back and THROWS, failing the spawn explicitly rather than
 * continuing with diverged accounting.
 */
async function chargeBudgetWorkUnit(ctx: RunLayersContext, nodeId: string): Promise<void> {
  if (ctx.budgetLedger === undefined) return;
  // Reserve before awaiting anything so the check-then-reserve pair is atomic against the
  // other workers inside mapWithLimit; rolled back if the persist fails below.
  ctx.budgetLedger.workUnits++;
  try {
    await ctx.deps.store.createWorkflowEvent({
      workflow_run_id: ctx.workflowRun.id,
      event_type: 'work_unit_charged',
      step_name: ctx.stepNamePrefix + nodeId,
      data: { kind: 'spawn_decision' },
    });
  } catch (err) {
    ctx.budgetLedger.workUnits--;
    getLog().error(
      { err, workflowRunId: ctx.workflowRun.id, eventType: 'work_unit_charged' },
      'workflow.event_persist_failed'
    );
    throw err;
  }
}

/** Terminal (or paused) outcome of a child sub-run, as consumed by a `workflow:` node. */
export interface ChildWorkflowOutcome {
  childRunId: string;
  status: 'completed' | 'paused' | 'failed' | 'cancelled';
  /** Child's terminal output (its first sink node's output), threaded as `$<id>.output`. */
  output?: string;
  /**
   * The terminal node's structured payload (#2637), read from `metadata.summary_value`
   * when the child stamped one. Threads the LOGICAL value back to the parent so
   * `$<id>.output.field` access and fan-out aggregation keep the type instead of
   * re-encoding the text. Absent for text-only children and pre-#2637 rows.
   */
  structuredOutput?: unknown;
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
  /**
   * Per-child isolation mode (#2121 slice 2, PR-A). `'worktree'` runs the child in
   * its own git worktree via the injected child-isolation resolver; `'inherit'`
   * (or undefined) shares the parent's checkout. Threaded from `node.isolation`.
   */
  isolation?: WorkflowNode['isolation'];
  /**
   * Fan-out instance index (#2121 slice 2, PR-C). Set when this child is one of N
   * spawned by a `fan_out:` node; stamped into the child's `metadata.child_index` so
   * parent resume can re-key the ordered instance set by index. Undefined for a
   * single (non-fan-out) `workflow:` child. Also seeds the per-child worktree branch
   * identifier so N fan-out children get distinct worktrees.
   */
  childIndex?: number;
  /**
   * Content hash of a fan-out child's input (#2121 slice 2, PR-C). Stamped into
   * `metadata.fan_out_item_hash` at spawn so parent resume can WARN when a
   * non-deterministic items producer changed the item at a given index (never re-keys).
   */
  itemHash?: string;
  /** Present only when re-driving a FAILED child on parent resume (D5 recovery path). */
  resumeFailedChild?: WorkflowRun;
  /**
   * Named inputs (#2470) — the resolved `with:` map the parent supplied, plus (for a
   * fan-out child) the per-item `fan_out.as` entry. Logical JSON values (#2637).
   * Persisted to the child's `metadata.inputs` (canonical text) plus, when any value
   * is non-string, the `metadata.inputs_values` sibling, so `$INPUTS.<name>` resolves
   * at runtime and reconstitutes typed on cold resume. Undefined/empty when the node
   * declares no `with:`/`as`.
   */
  inputs?: Record<string, JsonValue>;
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
 * Derive a child's node-facing outcome from its persisted run row. Cost and tokens are
 * written into the child's metadata at its run tail regardless of outcome (#2469) and
 * the terminal `summary` at completion, so both the synchronous path (runChildWorkflow
 * reads the row back) and the re-entry path (executeWorkflowNode finds an
 * already-terminal child) read the same source — and a child that burned tokens and
 * then failed or was cancelled still reports what it spent.
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
  const cacheRead =
    typeof md.total_cache_read_tokens === 'number' ? md.total_cache_read_tokens : undefined;
  const cacheWrite =
    typeof md.total_cache_write_tokens === 'number' ? md.total_cache_write_tokens : undefined;
  const tokens =
    input !== undefined || output !== undefined
      ? {
          input: input ?? 0,
          output: output ?? 0,
          ...(cacheRead !== undefined ? { cacheRead } : {}),
          ...(cacheWrite !== undefined ? { cacheWrite } : {}),
          // Persisted by persistRunUsage; without it a child's floor would contribute to
          // the parent as though it were an exact total.
          ...(md.total_cache_partial === true ? { cachePartial: true as const } : {}),
        }
      : undefined;
  // Presence-keyed (#2637): `false`/`0`/`null` are legitimate structured values, so
  // reading through readSubrunMetadata's summaryValue keeps them distinguishable
  // from "not stamped".
  const summaryValue = readSubrunMetadata(md).summaryValue;
  return {
    childRunId: run.id,
    status: run.status,
    output: typeof md.summary === 'string' ? md.summary : undefined,
    ...(summaryValue !== undefined ? { structuredOutput: summaryValue } : {}),
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

/** Makes a provider session durable before its node becomes authoritatively complete. */
type SessionCheckpoint = (sessionId: string) => Promise<void>;

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
 *   down unrelated in-flight streams. See the doc comment on
 *   `workflowRunStatusSchema` (schemas/workflow-run.ts), where this contract is
 *   also stated on the status type itself.
 * - `null` (run deleted), `cancelled`, `failed`, `completed`, or any other
 *   state → abort the stream.
 *
 * Exported for unit testing; the full streaming-cancel branch in
 * `executeNodeInternal` only fires once per 10s (CANCEL_CHECK_INTERVAL_MS), so
 * integration-level coverage of the policy is timing-sensitive and flaky.
 */
export function shouldContinueStreamingForStatus(status: WorkflowRunStatus | null): boolean {
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
 * cannot drift. Decisive FATAL errors (credentials, authorization, quota/limit
 * windows) are never retried, even when `on_error: all`; generic "auth error"
 * text is fatal only when no transient signal matches. Also returns `isTransient`
 * so callers can label the notification.
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
  const errorType = output.error ? classifyError(new Error(output.error)) : undefined;
  const isFatal = errorType === 'FATAL';
  const isTransient = errorType === 'TRANSIENT';
  const shouldRetry = !isFatal && (onError === 'all' || (onError === 'transient' && isTransient));
  return { shouldRetry, isTransient };
}

/**
 * Run a node executor with the shared retry loop: exponential backoff, FATAL
 * never retried, and a platform notification before each retry. Used by both the
 * AI-node path in {@link runLayers} and {@link runDeterministicNodeWithRetry} so
 * the backoff math and user-facing wording are defined once and can't drift.
 * `initialOutput` seeds `output` for the unreachable zero-iteration case. Usage is
 * accumulated across failed attempts so a later success still reports all paid work.
 *
 * Each attempt also writes its OWN terminal event carrying only that attempt's usage,
 * so the event log and this accumulated total agree rather than double-counting: two
 * attempts costing $0.02 then $0.03 leave two rows summing to $0.05, which is what this
 * returns. That is the "money burned" reading of a run's total — every attempt counts
 * (#2654 made failed rows contribute; see getDagResumeSnapshot for what that means).
 */
async function runNodeRetryLoop(
  node: DagNode,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  retryConfig: { maxRetries: number; delayMs: number; onError: 'transient' | 'all' },
  run: () => Promise<NodeExecutionResult>,
  initialOutput: NodeExecutionResult
): Promise<NodeExecutionResult> {
  let output = initialOutput;
  let accumulatedCostUsd: number | undefined;
  let accumulatedTokens: TokenUsage | undefined;
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    output = await run();
    if (output.costUsd !== undefined) {
      accumulatedCostUsd = (accumulatedCostUsd ?? 0) + output.costUsd;
    }
    if (output.tokens !== undefined) {
      accumulatedTokens = sumTokenUsage(
        [...(accumulatedTokens !== undefined ? [accumulatedTokens] : []), output.tokens],
        { nodeId: node.id }
      );
    }
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
  output.costUsd = accumulatedCostUsd;
  output.tokens = accumulatedTokens;
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
  run: () => Promise<NodeExecutionResult>
): Promise<NodeExecutionResult> {
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
 * Absolute directories a run writes into by engine design (artifacts, state, logs).
 * Changes under them never count against a node's `mutates_checkout: false`
 * assertion (#2771) — extend here if another engine-write root appears.
 */
function checkoutSnapshotExcludes(
  artifactsDir: string,
  stateDir: string,
  logDir: string
): readonly string[] {
  return [artifactsDir, stateDir, logDir].map(d => resolvePath(d));
}

function isInsideAny(absPath: string, dirs: readonly string[]): boolean {
  return dirs.some(d => absPath === d || absPath.startsWith(d + sep));
}

/** Path operands of one `git status --porcelain` line (`XY path` or `XY old -> new`). */
function porcelainPaths(line: string): string[] {
  const body = line.slice(3);
  const unquote = (p: string): string =>
    p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return (body.includes(' -> ') ? body.split(' -> ') : [body]).map(unquote);
}

/**
 * Snapshot the working tree's dirty state (`git status --porcelain`) for a node's
 * `mutates_checkout: false` assertion (#2771), dropping entries under `excludeDirs`.
 * Returns `undefined` when the check cannot run — cwd outside a repo, or git failing
 * — so a broken assertion degrades to no check rather than breaking unrelated runs.
 */
async function snapshotCheckout(
  cwd: string,
  excludeDirs: readonly string[]
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // core.quotePath=false keeps non-ASCII paths literal instead of C-escaped, so
      // exclusion matching against real directory names cannot miss them.
      ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=normal'],
      { cwd, timeout: 10_000 }
    );
    const relevant = stdout
      .split('\n')
      .filter(line => line.length > 3)
      .filter(
        line => !porcelainPaths(line).some(p => isInsideAny(resolvePath(cwd, p), excludeDirs))
      );
    return relevant.join('\n');
  } catch {
    return undefined;
  }
}

/**
 * Enforce a node's `mutates_checkout: false` declaration (#2771): when the node ran
 * successfully but the pre-run snapshot changed, rewrite its result to a failure that
 * names the node and lists what moved, and persist the standard `node_failed` event so
 * the violation surfaces like any other node failure. Applied OUTSIDE the retry loop so
 * the failure is non-retryable by construction — retrying a node that provably mutates
 * would only multiply the damage. A node that already failed keeps its own attributable
 * outcome; an absent snapshot (`undefined`) means the check could not run and is skipped.
 */
async function assertCheckoutUntouched(
  node: DagNode,
  cwd: string,
  excludeDirs: readonly string[],
  before: string | undefined,
  result: NodeExecutionResult,
  deps: WorkflowDeps,
  workflowRunId: string,
  stepName: string
): Promise<NodeExecutionResult> {
  if (node.mutates_checkout !== false || before === undefined || result.state !== 'completed') {
    return result;
  }
  const after = await snapshotCheckout(cwd, excludeDirs);
  if (after === undefined || after === before) {
    return result;
  }
  const changedPaths = after
    .split('\n')
    .filter(Boolean)
    .flatMap(porcelainPaths)
    .slice(0, 10)
    .join(', ');
  const error = `Node \`${node.id}\` declared \`mutates_checkout: false\` but modified the working tree: ${changedPaths}`;
  getLog().error({ nodeId: node.id, changed: changedPaths }, 'dag_mutates_checkout_violation');
  const emitter = getWorkflowEventEmitter();
  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'node_failed',
      step_name: stepName,
      data: { error },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId, eventType: 'node_failed' },
        'workflow_event_persist_failed'
      );
    });
  emitter.emit({
    type: 'node_failed',
    runId: workflowRunId,
    nodeId: node.id,
    nodeName: node.id,
    error,
  });
  return { ...result, state: 'failed', output: '', error };
}

/**
 * Single-quote a string for safe inline shell use.
 * Replaces each ' with '\'' (end quote, literal single-quote, re-open quote).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Write `value` to `<dir>/<filename>`, creating `dir` as needed. Returns the full
 * path on success, or `undefined` after logging on any failure (permission, disk
 * space, etc.) — callers own their own fallback; this never throws.
 */
function writeSpillFile(dir: string, filename: string, value: string): string | undefined {
  const filePath = joinPath(dir, filename);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, value);
    return filePath;
  } catch (fileErr) {
    const err = fileErr as Error;
    getLog().error(
      { err, dir, filename, valueSize: value.length, filePath },
      'dag.spill_file_write_failed'
    );
    return undefined;
  }
}

/**
 * Shell-quote a value for bash, or write it under the run artifact directory's
 * engine-owned spill child and return a $(cat ...) reference when the value exceeds
 * the inline size threshold.
 */
function shellQuoteOrFile(
  value: string,
  nodeId: string,
  field: string | undefined,
  artifactsDir: string | undefined
): string {
  if (artifactsDir && value.length > NODE_OUTPUT_FILE_THRESHOLD) {
    const spillDir = joinPath(artifactsDir, '.archon', 'node-output-spills');
    const filename = field ? `${nodeId}.${field}.nodeoutput` : `${nodeId}.nodeoutput`;
    const filePath = writeSpillFile(spillDir, filename, value);
    if (filePath) return `$(cat ${shellQuote(filePath)})`;
    return shellQuote(value); // fallback: inline (pre-file-spill behavior)
  }
  return shellQuote(value);
}

/**
 * Substitute $node_id.output and $node_id.output.field references in a prompt.
 * Called AFTER the standard substituteWorkflowVariables pass.
 *
 * KEEP IN SYNC: public YAML call sites, the loader's validateDagStructure scan, and
 * rewriteNodeOutputRefs must cover the same runtime node-ref surfaces. Included
 * loop-command bodies are validated separately during materialization. applyInputsMacro
 * walks the same set since #1764 — `systemPrompt` and `agents.*` used to accept include
 * inputs without receiving runtime substitution, which made one file behave differently
 * composed and standalone (#2476); they are ordinary runtime surfaces now.
 *
 * @param escapedForBash - When true, wraps substituted values in single quotes so
 *   they are safe to embed in bash scripts passed to `bash -c`. Set true only for
 *   bash node script substitution; AI/command prompt substitution should use false.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash = false,
  artifactsDir?: string
): string {
  return prompt.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g,
    (match, nodeId: string, field: string | undefined) => {
      const nodeOutput = nodeOutputs.get(nodeId);
      if (!nodeOutput) {
        // A `.field` ref that resolves to no output (for example, a programmatically
        // constructed definition that bypassed discovery, or a real producer whose
        // output is unavailable on this execution path) fails the consuming node loudly,
        // matching the strict
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
        // A failed producer's stale output is never spliced into a consumer's own
        // prompt/bash/command body (#2713) — matches resolveBindingDirective's #2710
        // guard for the same class of bug (a loop_group's failure paths leave real,
        // last-completed-iteration text behind). Routes through `assertProducerNotFailed`
        // in output-ref.ts (#2722), which every whole-text reader of nodeOutputs shares.
        assertProducerNotFailed(
          nodeOutput,
          failed =>
            `'$${nodeId}.output' references node '${nodeId}', but it failed ` +
            `(${failed.error}), so its output cannot be spliced into this node's ` +
            "prompt/script — a failed producer's stale output is never trusted. Fix the " +
            "failure, or guard this node with a 'when:' condition that excludes the " +
            'failed branch.'
        );
        return escapedForBash
          ? shellQuoteOrFile(nodeOutput.output, nodeId, undefined, artifactsDir)
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
      // numbers and booleans are shell-safe without quoting: JSON disallows
      // NaN/Infinity so String(number) is digits/sign/'.', and String(boolean) is
      // 'true'/'false' — no shell metacharacters.
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      // Everything else takes the one value→text rule (strings raw; arrays/objects/
      // null as canonical JSON so downstream tools like jq get one JSON literal),
      // with the bash-escaping decision staying here at the call site.
      const text = canonicalValueText(value);
      return escapedForBash ? shellQuoteOrFile(text, nodeId, field, artifactsDir) : text;
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
  nodes: readonly (DagNode | IncludeDirective)[],
  into: Set<string> = new Set<string>()
): Set<string> {
  for (const n of nodes) {
    into.add(n.id);
    if (!isIncludeDirective(n) && isLoopGroupNode(n))
      collectLoopBodyNodeIds(n.loop_group.nodes, into);
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
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      const text = canonicalValueText(value);
      return escapedForBash ? shellQuoteOrFile(text, nodeId, field, outputFileDir) : text;
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
  aiProfile: ResolvedAiProfile | undefined,
  workflowPreset: ModelAliasPreset | undefined,
  /**
   * Resolve workflow variables and `$node.output` refs in the node's AI-configuration
   * text (#2476/#1764). Required rather than optional so a new call site has to decide:
   * omitting it silently ships `$ARTIFACTS_DIR` and `$plan.output` to the provider as
   * literal text, which is the defect this closes. Pass `text => text` only where the
   * node is engine-synthesised and cannot carry these fields.
   */
  resolveAiText: (text: string) => string,
  /**
   * Provider/model conflicts already reported this run. A conflict declared once at
   * workflow level is collapsed onto every node (#1764), so without de-duplication one
   * authoring mistake produces one chat message per node.
   */
  warnedProviderConflicts: Set<string> | undefined,
  execContext: ExecutionContext = { kind: 'host' }
): Promise<{
  provider: string;
  model: string | undefined;
  options: SendQueryOptions | undefined;
  tier?: TierName;
  effort?: string;
}> {
  // The chain itself lives in node-model-resolution.ts so `workflow dry-run` reports the
  // same answer this produces (#1764). Everything below is the part a dry run must NOT
  // do: warn the user, throw, and build provider options.
  const resolution = resolveNodeModel(
    node,
    {
      provider: workflowProvider,
      model: workflowModel,
      preset: workflowPreset,
      tier: workflowLevelOptions.workflowTier,
      effort: workflowLevelOptions.effort,
      // Only used to LABEL an inherited provider in a dry run; the executor discards it.
      providerOrigin: 'workflow',
    },
    assistantModelDefaults(config),
    aiProfile
  );
  const { provider, model, preset: effectivePreset } = resolution;

  const conflict = resolution.providerConflict;
  const conflictKey = conflict && `${conflict.declared}|${conflict.resolved}|${conflict.modelRef}`;
  if (conflict && conflictKey !== undefined && !warnedProviderConflicts?.has(conflictKey)) {
    warnedProviderConflicts?.add(conflictKey);
    getLog().warn(
      {
        nodeId: node.id,
        configuredProvider: conflict.declared,
        resolvedProvider: conflict.resolved,
        modelRef: conflict.modelRef,
      },
      'dag.model_provider_conflict'
    );
    const delivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Node '${node.id}' sets provider '${conflict.declared}' but model '${conflict.modelRef}' resolves to provider '${conflict.resolved}' — using '${conflict.resolved}'.`,
      { workflowId: workflowRunId, nodeName: node.id }
    );
    if (!delivered) {
      getLog().error(
        { nodeId: node.id, workflowRunId },
        'dag.model_provider_conflict_warning_delivery_failed'
      );
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

  // Get provider capabilities for capability warnings (static lookup, no instantiation)
  const caps = getProviderCapabilities(provider);

  // `webSearchMode:` is Codex's alone — no other provider reads it, and #2556
  // decided it keeps no node-level form, making it the single workflow-level
  // field with no per-node counterpart. There is deliberately no
  // ProviderCapabilities axis for one provider's one field.
  //
  // Reasoning depth is NOT in this category any more: the loader translates the
  // deprecated `modelReasoningEffort:` into `effort:`, so the executor sees one
  // provider-agnostic field and needs no Codex branch for it.
  const isCodex = provider === 'codex';

  // The one reasoning depth this node will run at, before any preset fallback.
  const declaredEffort = resolution.declaredEffort;

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
    ['effort', 'effortControl', declaredEffort !== undefined],
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

  // `webSearchMode` has no ProviderCapabilities axis, so capChecks above cannot
  // see it. Surfacing it here reuses the existing loud-mismatch path so a
  // workflow that declares it on a node that cannot read it gets the same
  // warning every other capability mismatch produces, instead of a silent no-op.
  if (!isCodex && workflowLevelOptions.webSearchMode !== undefined) {
    unsupported.push('webSearchMode');
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
  if (config.protectedEnvKeys && config.protectedEnvKeys.length > 0) {
    baseOptions.protectedEnvKeys = config.protectedEnvKeys;
  }
  // Resolved, never mutated in place: the node object is the shared definition and a loop
  // or a resume would otherwise substitute into an already-substituted string.
  const systemPrompt =
    node.systemPrompt !== undefined ? resolveAiText(node.systemPrompt) : undefined;
  const agents =
    node.agents !== undefined
      ? Object.fromEntries(
          Object.entries(node.agents).map(([id, agent]) => [
            id,
            {
              ...agent,
              prompt: resolveAiText(agent.prompt),
              description: resolveAiText(agent.description),
            },
          ])
        )
      : undefined;
  if (systemPrompt !== undefined) baseOptions.systemPrompt = systemPrompt;
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
    agents,
    // Portable per-node Pi extension posture (#2133) — Pi provider reads it as
    // the highest-precedence override; ignored by other providers.
    pi: node.pi,
    allowed_tools: node.allowed_tools,
    denied_tools: node.denied_tools,
    // Dropped for a provider with no reasoning control, matching what the preset
    // path does two functions up. `capChecks` has already told the author it
    // will be ignored; writing it anyway would make `node_started` report a
    // depth that was never applied, and would leave declared and preset effort
    // behaving oppositely on the same provider.
    effort: caps.effortControl ? declaredEffort : undefined,
    thinking: node.thinking ?? workflowLevelOptions.thinking,
    sandbox: node.sandbox ?? workflowLevelOptions.sandbox,
    betas: node.betas ?? workflowLevelOptions.betas,
    output_format: node.output_format,
    maxBudgetUsd: node.maxBudgetUsd,
    systemPrompt,
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
    declaredEffort,
    nodeConfig
  );
  // `webSearchMode:` has no node-level form and no other consumer, so the
  // workflow-level value is the only value — written only where it is read.
  if (isCodex && workflowLevelOptions.webSearchMode !== undefined) {
    assistantConfig.webSearchMode = workflowLevelOptions.webSearchMode;
  }

  // There is one effort channel now, so telemetry has one place to read (#2556).
  // `nodeConfig.effort` holds whatever will be applied — declared, or filled in
  // from the preset just above, or absent when the provider warned and dropped
  // it. `assistants.<provider>.modelReasoningEffort` from config.yaml never
  // enters nodeConfig, so it stays the fallback.
  //
  // Providers clamp a rung their SDK lacks (`max` → `xhigh` on Codex/Copilot),
  // and this reports the declared rung rather than the clamped one — consistent
  // across providers, and no longer able to name a field the provider ignored,
  // which was the #2395 failure mode.
  const assistantEffort =
    typeof assistantConfig.modelReasoningEffort === 'string'
      ? assistantConfig.modelReasoningEffort
      : undefined;
  const resolvedEffort: string | undefined = nodeConfig.effort ?? assistantEffort;

  const options: SendQueryOptions = {
    ...baseOptions,
    nodeConfig,
    assistantConfig,
  };

  // `node.model` is the original ref (e.g. "large"); `model` is the resolved
  // string (e.g. "opus"). Surface `tier` when the ref was a tier keyword — from
  // the node's own `model`, or (when the node inherits the workflow-level model)
  // from the workflow tier, mirroring the effectivePreset inheritance condition.
  return { provider, model, options, tier: resolution.tier, effort: resolvedEffort };
}

/** Evaluate trigger rule for a node given its upstream states */
export function checkTriggerRule(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>
): 'run' | 'skip' {
  const nodeDeps = node.depends_on ?? [];
  return checkTriggerRuleForDependencies(nodeDeps, node.trigger_rule ?? 'all_success', nodeOutputs);
}

function checkTriggerRuleForDependencies(
  nodeDeps: readonly string[],
  rule: TriggerRule,
  nodeOutputs: Map<string, NodeOutput>
): 'run' | 'skip' {
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
 * Enforce caller-level include predicates that load-time flattening attached to every
 * descendant. Entry nodes normally keep using their ordinary trigger/when fields so they
 * retain the existing diagnostics. A cached entry is the exception: resume would otherwise
 * return its prior output before those fields run, so its boundary must be checked here too.
 */
export function checkComposedBlockBoundaries(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>,
  inputs?: Record<string, JsonValue>,
  evaluateEntryBoundary = false
): 'run' | 'skip' {
  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    if (boundary.isEntry && !evaluateEntryBoundary) continue;

    const triggerRules =
      boundary.isEntry && evaluateEntryBoundary
        ? [boundary.entryTriggerRule]
        : boundary.entryTriggerRules;
    const dependencyEligible = triggerRules.some(
      rule => checkTriggerRuleForDependencies(boundary.dependsOn, rule, nodeOutputs) === 'run'
    );
    if (!dependencyEligible) return 'skip';

    if (boundary.when !== undefined) {
      try {
        const condition = evaluateCondition(boundary.when, nodeOutputs, inputs);
        if (!condition.parsed || !condition.result) return 'skip';
      } catch {
        // Entry nodes own the actionable missing-ref error. Descendants only need to stay
        // inside the failed boundary, without repeating the same failure for every node.
        return 'skip';
      }
    }
  }
  return 'run';
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
  node: AgentNode,
  provider: string,
  nodeOptions: SendQueryOptions | undefined,
  artifactsDir: string,
  stateDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  resumeSessionId: string | undefined,
  configuredCommandFolder?: string,
  issueContext?: string,
  resolvedModel?: string,
  resolvedTier?: TierName,
  resolvedEffort?: string,
  stepNamePrefix = '',
  iteration?: number,
  checkpointSession?: SessionCheckpoint,
  /** Roots command files resolve under; always supplied from RunLayersContext. */
  workflowSourceRoots?: WorkflowSourceRoots,
  /** Invoked once per attempt beside the node_started write (#1961 work-unit accounting). */
  chargeWorkUnit?: () => void
): Promise<NodeExecutionResult> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Command file name when this agent node is command-sourced, undefined for an
  // inline prompt — replaces the old `node.command` field access throughout.
  const commandName = node.source.kind === 'command' ? node.source.name : undefined;
  const nodeWith = node.source.kind === 'command' ? node.source.with : undefined;
  // Persisted step_name is namespaced ('<groupId>.' prefix) for loop_group bodies;
  // '' for the top-level DAG → identical to node.id. The in-process emitter payloads
  // below stay raw (node.id) — live SSE/CLI consumers key off those. See #2090.
  const stepName = stepNamePrefix + node.id;
  // Only present inside a loop_group body — tags lifecycle rows with the iteration so
  // multi-iteration runs are disaggregatable in the event log.
  const iterationData = iteration !== undefined ? { iteration } : {};
  const namedResumeSourceNodeId = isNodeContextResume(node.context)
    ? node.context.resume
    : undefined;
  const namedSessionAuditData =
    namedResumeSourceNodeId !== undefined
      ? {
          session_source_node_id: namedResumeSourceNodeId,
          session_fork_requested: true,
        }
      : {};

  const configuredMcpNames = await loadConfiguredMcpServerNames(node.mcp, cwd);

  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, commandName ?? '<inline>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: stepName,
      data: {
        command: commandName ?? null,
        provider,
        model: resolvedModel,
        tier: resolvedTier,
        ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
        ...namedSessionAuditData,
        ...iterationData,
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });
  chargeWorkUnit?.();

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: commandName ?? node.id,
    provider,
    model: resolvedModel,
    tier: resolvedTier,
    ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
  });

  // Load prompt
  let rawPrompt: string;
  if (commandName !== undefined) {
    const promptResult = await loadCommandPrompt(
      deps,
      cwd,
      commandName,
      configuredCommandFolder,
      workflowSourceRoots
    );
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      await logNodeError(logDir, workflowRun.id, node.id, errMsg);
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: { error: errMsg, ...namedSessionAuditData },
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
        nodeName: commandName,
        error: errMsg,
      });
      return { state: 'failed', output: '', error: errMsg };
    }
    rawPrompt = promptResult.content;
  } else {
    // commandName undefined implies node.source.kind === 'inline' by construction
    // (AgentBody.source is a two-member union) — but the compiler can't correlate
    // that back across the two independent derivations, so fail loud rather than
    // silently defaulting if that ever stops being true.
    if (node.source.kind !== 'inline') {
      throw new Error(
        `unreachable: node '${node.id}' has no commandName but source.kind is not 'inline'`
      );
    }
    rawPrompt = node.source.prompt;
  }

  // Standard variable substitution
  let substitutedPrompt: string;
  try {
    // Node-local bindings (#2637): a command node's `with:` map resolves against
    // upstream outputs and merges OVER the run's inputs into the `$INPUTS` bag —
    // nearest-wins, the same precedence the shell env channel documents. A binding
    // that cannot be satisfied throws here and fails the node via the catch below.
    const runInputs = resolveRunInputs(workflowRun);
    const nodeBindings =
      nodeWith !== undefined
        ? resolveNodeBindings(
            node.id,
            nodeWith,
            {
              workflowRun,
              artifactsDir,
              stateDir,
              baseBranch,
              docsDir,
              issueContext,
              nodeOutputs,
            },
            runInputs
          )
        : undefined;
    const promptInputs =
      nodeBindings !== undefined ? { ...(runInputs ?? {}), ...nodeBindings } : runInputs;
    substitutedPrompt = buildPromptWithContext(
      rawPrompt,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      `dag node '${node.id}' prompt`,
      { stateDir, inputs: promptInputs }
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ nodeId: node.id, error: err.message }, 'dag.node_prompt_substitution_failed');
    await logNodeError(logDir, workflowRun.id, node.id, err.message);
    // Emit the terminal event (mirrors the command-load failure path above).
    // Without it the node emits node_started and then vanishes with no terminal
    // event, so downstream all_success rules silently skip instead of the run
    // surfacing the failure.
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: { error: err.message, ...namedSessionAuditData },
      })
      .catch((persistErr: Error) => {
        getLog().error(
          { err: persistErr, workflowRunId: workflowRun.id, eventType: 'node_failed' },
          'workflow_event_persist_failed'
        );
      });
    emitter.emit({
      type: 'node_failed',
      runId: workflowRun.id,
      nodeId: node.id,
      nodeName: commandName ?? node.id,
      error: err.message,
    });
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
  let nodeResolvedModel: ResolvedModel | undefined;
  const batchMessages: string[] = [];

  // What this node reported, built once and passed whole rather than re-listed per sink:
  // the DB event and the JSONL transcript row, on every outcome that can hold spend —
  // completion, failure, and user cancellation alike (#2693). See WorkflowUsage.
  const nodeUsageEventData = (): WorkflowUsage => ({
    ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
    ...(nodeCostUsd !== undefined ? { cost_usd: nodeCostUsd } : {}),
  });

  // Create per-node abort controller for idle timeout cleanup
  const nodeAbortController = new AbortController();
  // Request a fork when resuming. Exact-fork callers gate on sessionFork first;
  // legacy resume-only providers may continue the source session in place.
  const shouldForkSession = resumeSessionId !== undefined;
  const nodeOptionsWithAbort: SendQueryOptions | undefined = {
    ...nodeOptions,
    abortSignal: nodeAbortController.signal,
    ...(shouldForkSession ? { forkSession: true } : {}),
  };
  let nodeIdleTimedOut = false;
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;
  const runningTools = new Map<string, RunningTool>();
  let anonymousToolSequence = 0;
  let lastAnonymousToolCallId: string | undefined;
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
  let accumulatedTokens: TokenUsage | undefined;

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
    newSessionId = undefined;
    nodeResumed = undefined;
    batchMessages.length = 0; // else a failed attempt's prose flushes during reask
    nodeCostUsd = undefined;
    nodeTokens = undefined;
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
        const toolCallId = msg.toolCallId ?? `anonymous-${String(++anonymousToolSequence)}`;

        // Providers without stable IDs report sequential tool calls. Preserve their
        // legacy boundary while allowing identified calls to overlap.
        const previousTool = lastAnonymousToolCallId
          ? runningTools.get(lastAnonymousToolCallId)
          : undefined;
        if (previousTool && lastAnonymousToolCallId !== undefined) {
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: previousTool.toolName,
            stepName: node.id,
            durationMs: now - previousTool.startedAt,
            toolCallId: lastAnonymousToolCallId,
            toolOutcome: 'unknown',
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: stepName,
              data: {
                tool_name: previousTool.toolName,
                duration_ms: now - previousTool.startedAt,
                tool_call_id: lastAnonymousToolCallId,
                tool_outcome: 'unknown',
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
          runningTools.delete(lastAnonymousToolCallId);
        }
        runningTools.set(toolCallId, { toolName: msg.toolName, startedAt: now });
        if (!msg.toolCallId) lastAnonymousToolCallId = toolCallId;

        // Emit tool_started for the current tool (fire-and-forget)
        getWorkflowEventEmitter().emit({
          type: 'tool_started',
          runId: workflowRun.id,
          toolName: msg.toolName,
          stepName: node.id,
          toolCallId,
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
              tool_call_id: toolCallId,
            },
          })
          .catch((err: Error) => {
            getLog().error(
              { err, workflowRunId: workflowRun.id, eventType: 'tool_called' },
              'workflow_event_persist_failed'
            );
          });
      } else if (msg.type === 'tool_result' && msg.toolName) {
        const now = Date.now();
        const completedTool = findRunningTool(runningTools, msg.toolName, msg.toolCallId);
        if (completedTool) {
          const [completedToolCallId, tool] = completedTool;
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: tool.toolName,
            stepName: node.id,
            durationMs: now - tool.startedAt,
            toolCallId: completedToolCallId,
            ...(msg.toolOutcome !== undefined ? { toolOutcome: msg.toolOutcome } : {}),
            ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: stepName,
              data: {
                tool_name: tool.toolName,
                duration_ms: now - tool.startedAt,
                tool_call_id: completedToolCallId,
                ...(msg.toolOutcome !== undefined ? { tool_outcome: msg.toolOutcome } : {}),
                ...(msg.exitCode !== undefined ? { exit_code: msg.exitCode } : {}),
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
          runningTools.delete(completedToolCallId);
          if (completedToolCallId === lastAnonymousToolCallId) {
            lastAnonymousToolCallId = undefined;
          }
        }
        if (streamingMode === 'stream' && platform.sendStructuredEvent) {
          await platform.sendStructuredEvent(conversationId, msg);
        }
      } else if (msg.type === 'result') {
        // A terminal result closes every outstanding lifecycle.
        for (const [toolCallId, prevTool] of runningTools) {
          getWorkflowEventEmitter().emit({
            type: 'tool_completed',
            runId: workflowRun.id,
            toolName: prevTool.toolName,
            stepName: node.id,
            durationMs: Date.now() - prevTool.startedAt,
            toolCallId,
            toolOutcome: 'unknown',
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'tool_completed',
              step_name: stepName,
              data: {
                tool_name: prevTool.toolName,
                duration_ms: Date.now() - prevTool.startedAt,
                tool_call_id: toolCallId,
                tool_outcome: 'unknown',
              },
            })
            .catch((err: Error) => {
              getLog().error(
                { err, workflowRunId: workflowRun.id, eventType: 'tool_completed' },
                'workflow_event_persist_failed'
              );
            });
          runningTools.delete(toolCallId);
        }
        if (msg.sessionId) newSessionId = msg.sessionId;
        if (msg.resumed !== undefined) nodeResumed = msg.resumed;
        if (msg.tokens !== undefined) {
          nodeTokens = sumTokenUsage([msg.tokens], { nodeId: node.id });
        }
        if (msg.cost !== undefined) {
          if (Number.isFinite(msg.cost)) {
            nodeCostUsd = msg.cost;
          } else {
            getLog().warn(
              { nodeId: node.id, costUsd: msg.cost },
              'dag_node.usage_cost_non_finite_ignored'
            );
          }
        }
        if (msg.stopReason !== undefined) nodeStopReason = msg.stopReason;
        if (msg.numTurns !== undefined) nodeNumTurns = msg.numTurns;
        // Assigned UNCONDITIONALLY. A guarded assignment cannot CLEAR a stale value:
        // Pi/Copilot reask loops yield several result chunks, and Pi omits resolvedModel
        // when its later assistant message has no responseModel — so an earlier attempt's
        // model would be persisted as the final attempt's answer. Fabricated attribution
        // is the exact defect #2314 exists to prevent; absence must stay absence.
        nodeResolvedModel = msg.resolvedModel;
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
      // Legacy reasks use a fresh throwaway session so an invalid turn is not carried
      // forward. Named resume is stricter: every accepted pass must independently fork
      // the declared source rather than inheriting stale attestation from an earlier pass.
      const reaskResumeSessionId =
        namedResumeSourceNodeId !== undefined || reaskAttempt === 0 ? resumeSessionId : undefined;
      try {
        await runStreamPass(reaskPrompt, reaskResumeSessionId);
      } finally {
        if (nodeCostUsd !== undefined) {
          accumulatedCostUsd = (accumulatedCostUsd ?? 0) + nodeCostUsd;
        }
        if (nodeTokens !== undefined) {
          accumulatedTokens = sumTokenUsage(
            [...(accumulatedTokens !== undefined ? [accumulatedTokens] : []), nodeTokens],
            { nodeId: node.id }
          );
        }
        // Keep cumulative usage on the node result even when this pass throws.
        nodeCostUsd = accumulatedCostUsd;
        nodeTokens = accumulatedTokens;
      }

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
            nodeOutputText = canonicalValueText(structuredOutput);
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
      // Cancellation is a terminal outcome like any other failure, and the work it
      // interrupted was already paid for. This branch wrote no transcript row at all
      // until #2693, so a cancelled node's spend reached the DB and nothing else.
      await logNodeError(
        logDir,
        workflowRun.id,
        node.id,
        'Cancelled by user',
        nodeUsageEventData()
      );

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: {
            error: 'Cancelled by user',
            duration_ms: duration,
            ...nodeUsageEventData(),
            ...namedSessionAuditData,
          },
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
        nodeName: commandName ?? node.id,
        error: 'Cancelled by user',
      });

      // Clean up throttle entries
      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return {
        state: 'failed',
        output: nodeOutputText,
        error: 'Cancelled by user',
        costUsd: nodeCostUsd,
        ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      };
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
      await logNodeError(logDir, workflowRun.id, node.id, creditError, nodeUsageEventData());

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: { error: creditError, ...nodeUsageEventData(), ...namedSessionAuditData },
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
        nodeName: commandName ?? node.id,
        error: creditError,
      });

      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return {
        state: 'failed',
        output: nodeOutputText,
        error: creditError,
        costUsd: nodeCostUsd,
        ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      };
    }

    // Fail for zero output: covers both silent non-timeout exits AND idle-timeout before first token (time-to-first-token exceeded the window).
    if (nodeOutputText.trim() === '' && structuredOutput === undefined) {
      const duration = Date.now() - nodeStartTime;
      const emptyError = nodeIdleTimedOut
        ? `Node '${node.id}' timed out with no output (idle for ${String(effectiveIdleTimeout / 60000)} min). The provider did not emit any content before the watchdog fired — likely time-to-first-token exceeded the timeout. Consider increasing idle_timeout or reducing prompt size.`
        : `Node '${node.id}' produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.`;
      getLog().error({ nodeId: node.id, durationMs: duration }, 'dag.node_empty_output');
      await logNodeError(logDir, workflowRun.id, node.id, emptyError, nodeUsageEventData());

      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_failed',
          step_name: stepName,
          data: {
            error: emptyError,
            duration_ms: duration,
            ...nodeUsageEventData(),
            ...namedSessionAuditData,
          },
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
        nodeName: commandName ?? node.id,
        error: emptyError,
      });

      lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
      lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

      return {
        state: 'failed',
        output: '',
        error: emptyError,
        costUsd: nodeCostUsd,
        ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      };
    }

    if (namedResumeSourceNodeId !== undefined) {
      if (nodeResumed !== true) {
        throw new Error(
          `Node '${node.id}' could not resume the exact session from '${namedResumeSourceNodeId}'. The provider reported that prior context was not restored.`
        );
      }
      if (newSessionId === undefined || newSessionId.trim() === '') {
        throw new Error(
          `Node '${node.id}' forked the session from '${namedResumeSourceNodeId}' but the provider returned no branch session ID.`
        );
      }
      if (newSessionId === resumeSessionId) {
        throw new Error(
          `Node '${node.id}' did not create an immutable fork of '${namedResumeSourceNodeId}': the provider reused the source session ID.`
        );
      }
    }

    if (newSessionId !== undefined) {
      await checkpointSession?.(newSessionId);
    }

    const duration = Date.now() - nodeStartTime;
    getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');
    await logNodeComplete(logDir, workflowRun.id, node.id, commandName ?? '<inline>', {
      durationMs: duration,
      ...nodeUsageEventData(),
    });

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: {
          duration_ms: duration,
          node_output: nodeOutputText,
          // The logical value beside its text (#2637), so a cold resume rehydrates
          // typed field access instead of degrading to a text re-parse. Additive:
          // rows without it resume exactly as before.
          ...(structuredOutput !== undefined ? { structured_output: structuredOutput } : {}),
          ...nodeUsageEventData(),
          ...(nodeStopReason ? { stop_reason: nodeStopReason } : {}),
          ...(nodeNumTurns !== undefined ? { num_turns: nodeNumTurns } : {}),
          ...(nodeResolvedModel
            ? { model_usage: { requested: resolvedModel, resolved: nodeResolvedModel.id } }
            : {}),
          ...(namedResumeSourceNodeId !== undefined
            ? {
                session_source_node_id: namedResumeSourceNodeId,
                session_forked: true,
              }
            : {}),
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
      nodeName: commandName ?? node.id,
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

    const cancelled = nodeAbortController.signal.aborted && !nodeIdleTimedOut;
    const failureMessage = cancelled ? 'Cancelled by user' : err.message;
    if (cancelled) {
      getLog().info({ nodeId: node.id }, 'dag_node_cancelled_via_abort');
    } else {
      getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    }
    // Transcript row on BOTH branches. The persisted event below is written either way,
    // so the transcript must not disagree with it depending on how the cancel arrived.
    // A cancel reaches this catch mainly through the engine's own structured-output
    // gate: it runs before the streaming-cancel branch and cannot reask once the signal
    // is aborted, so an aborted node declaring `output_format` throws here instead of
    // returning there. A provider SDK that throws on abort also lands here. Neither is
    // a reason for a node to be missing from the run's transcript (#2693).
    await logNodeError(logDir, workflowRun.id, node.id, failureMessage, nodeUsageEventData());

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: { error: failureMessage, ...nodeUsageEventData(), ...namedSessionAuditData },
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
      nodeName: commandName ?? node.id,
      error: failureMessage,
    });

    return {
      state: 'failed',
      output: '',
      error: failureMessage,
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
  const dockerArgs = ['exec', '-w', options.cwd];
  if (execContext.execUser) dockerArgs.push('-u', execContext.execUser);
  for (const [key, value] of Object.entries(options.env)) {
    // Skip the denylist (PATH/HOME/…): a project env var must not clobber the
    // in-container binary/home resolution — same policy as the Claude spawn path.
    if (value === undefined || CONTAINER_ENV_DENYLIST.has(key)) continue;
    dockerArgs.push('-e', `${key}=${value}`);
  }
  dockerArgs.push(execContext.containerId, containerCommandName(cmd), ...args);
  return dockerArgs;
}

/** The shape `execFile` rejects with: argv-bearing fields plus the classifier fields. */
type RawSubprocessRejection = Error & {
  stdout?: string;
  stderr?: string;
  cmd?: string;
  spawnargs?: string[];
};

const CREDENTIAL_ENV_KEY_SUFFIX = /(?:TOKEN|KEY|SECRET|PASSWORD)$/i;
const CREDENTIAL_ENV_KEYS = new Set(['DATABASE_URL']);

function collectSubprocessCredentialValues(
  env: NodeJS.ProcessEnv,
  protectedEnvKeys: readonly string[] | undefined,
  protectedCredentialValues: readonly string[] | undefined
): string[] {
  const explicitlyProtected = new Set(protectedEnvKeys);
  const values = Object.entries(env).flatMap(([key, value]) =>
    value &&
    (explicitlyProtected.has(key) ||
      CREDENTIAL_ENV_KEYS.has(key) ||
      CREDENTIAL_ENV_KEY_SUFFIX.test(key))
      ? [value]
      : []
  );
  return [...new Set([...values, ...(protectedCredentialValues ?? [])])]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

function redactCredentialValues(input: string, credentialValues: readonly string[]): string {
  let result = input;
  for (const value of credentialValues) {
    result = result.replaceAll(value, '[REDACTED]');
  }
  return result;
}

/**
 * Scrub credentials from every subprocess rejection field that can carry
 * subprocess text. The exact values come from the engine's injected-credential
 * provenance plus secret-named project env entries, so provider credentials are
 * removed even when the failed process echoes them without their env key.
 *
 * Mutates in place rather than returning a fresh Error: callers classify the
 * rejection by reading `killed` (timeout) and `code`/`message` (ENOENT/EACCES) off
 * the original object, and a replacement would silently drop those and turn every
 * timeout into a generic failure.
 *
 * `cmd` and `spawnargs` are not redundant with `message`. They can be the only
 * carriers when the rejection
 * is not a non-zero exit: a maxBuffer overflow rejects with `message` = 'stdout
 * maxBuffer length exceeded' — no argv at all — so the credentials survive solely
 * in `cmd`. Pino serializes every enumerable `err` property, so an unredacted `cmd`
 * writes the token to the detached-run log even when `message` is already clean.
 */
function redactSubprocessError(
  e: RawSubprocessRejection,
  credentialValues: readonly string[]
): RawSubprocessRejection {
  e.message = redactCredentialValues(e.message, credentialValues);
  if (e.stack) e.stack = redactCredentialValues(e.stack, credentialValues);
  if (typeof e.stdout === 'string') {
    e.stdout = redactCredentialValues(e.stdout, credentialValues);
  }
  if (typeof e.stderr === 'string') {
    e.stderr = redactCredentialValues(e.stderr, credentialValues);
  }
  if (typeof e.cmd === 'string') e.cmd = redactCredentialValues(e.cmd, credentialValues);
  if (Array.isArray(e.spawnargs)) {
    e.spawnargs = e.spawnargs.map(arg => redactCredentialValues(arg, credentialValues));
  }
  return e;
}

async function runSubprocess(
  execContext: ExecutionContext,
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
    protectedEnvKeys?: readonly string[];
    protectedCredentialValues?: readonly string[];
  }
): Promise<{ stdout: string; stderr: string }> {
  const subprocessEnv =
    execContext.kind === 'container' ? options.env : { ...process.env, ...options.env };
  try {
    if (execContext.kind === 'container') {
      const dockerArgs = buildSubprocessDockerArgs(execContext, cmd, args, {
        cwd: options.cwd,
        env: options.env,
      });
      // Container env is delivered in argv, while either execution mode can echo a
      // credential in output. Sanitize at the shared throw boundary so every
      // downstream reader receives the same safe rejection.
      return await execFileAsync('docker', dockerArgs, { timeout: options.timeout });
    }
    return await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      env: subprocessEnv,
    });
  } catch (err) {
    const credentialValues = collectSubprocessCredentialValues(
      subprocessEnv,
      options.protectedEnvKeys,
      options.protectedCredentialValues
    );
    throw redactSubprocessError(err as RawSubprocessRejection, credentialValues);
  }
}

/** Threshold (bytes) above which $nodeId.output values are written to a temp file
 *  instead of inlined as bash -c arguments, to avoid silent data corruption. */
const NODE_OUTPUT_FILE_THRESHOLD = 32_768;

/** Maximum UTF-8 bytes retained for a successful exec node's stdout in workflow events. */
const PERSISTED_NODE_OUTPUT_MAX_BYTES = 32 * 1024;

function utf8SequenceLength(leadByte: number): number {
  if (leadByte < 0x80) return 1;
  if (leadByte < 0xe0) return 2;
  if (leadByte < 0xf0) return 3;
  return 4;
}

/**
 * Cap `output` to a bounded preview for persistence, and — when it exceeds the cap —
 * ALSO spill the full, untruncated bytes under the run's artifacts directory so a
 * resumed run can rehydrate the complete value instead of the preview (#2726).
 *
 * `spillKey` should be the row's own `step_name` (`stepNamePrefix + node.id`), matching
 * exactly what `getDagResumeSnapshot` keys `completedNodeOutputs` by. A loop_group body
 * node's `step_name` is the SAME across every iteration (only `data.iteration` differs
 * per row), and `completedNodeOutputs` is already last-write-wins per `step_name` — so
 * the spill file being overwritten each iteration is correct: it always holds exactly
 * what the next resume's snapshot will resolve to for that key, never a stale iteration.
 *
 * A spill write failure never fails the node — it degrades to preview-only persistence,
 * matching `shellQuoteOrFile`'s existing fallback behavior for the same class of error.
 *
 * Because the spill filename is reused (see above), the returned `originalBytes` is
 * also this write's identity token: `getDagResumeSnapshot` (packages/core) validates a
 * spill's actual byte length against the row's own recorded `originalBytes` before
 * trusting it, so a spill overwritten by a LATER execution racing an unlanded
 * fire-and-forget event insert is detected as stale rather than silently trusted.
 */
function formatPersistedNodeOutput(
  output: string,
  artifactsDir: string,
  spillKey: string
): {
  nodeOutput: string;
  truncated: boolean;
  originalBytes?: number;
  spillPath?: string;
} {
  const outputBytes = Buffer.from(output, 'utf8');
  if (outputBytes.byteLength <= PERSISTED_NODE_OUTPUT_MAX_BYTES) {
    return { nodeOutput: output, truncated: false };
  }

  const marker = buildTruncationMarker(outputBytes.byteLength);
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let headEnd = PERSISTED_NODE_OUTPUT_MAX_BYTES - markerBytes;

  // The byte cap can land inside a multi-byte code point. Inspect the final
  // sequence in the prefix and drop it when it is incomplete before decoding.
  let sequenceStart = headEnd - 1;
  while (sequenceStart >= 0 && (outputBytes[sequenceStart] & 0xc0) === 0x80) {
    sequenceStart--;
  }
  if (sequenceStart >= 0) {
    const leadByte = outputBytes[sequenceStart];
    const expectedLength = utf8SequenceLength(leadByte);
    if (headEnd - sequenceStart < expectedLength) headEnd = sequenceStart;
  }

  const spillDir = joinPath(artifactsDir, '.archon', 'node-output-spills', 'persisted');
  const spillPath = writeSpillFile(spillDir, `${spillKey}.nodeoutput`, output);

  return {
    nodeOutput: outputBytes.subarray(0, headEnd).toString('utf8') + marker,
    truncated: true,
    originalBytes: outputBytes.byteLength,
    ...(spillPath ? { spillPath } : {}),
  };
}

/**
 * Build the `data` fragment for a persisted event carrying a `formatPersistedNodeOutput`
 * result: the (possibly capped) text under `fieldName`, plus the conditional
 * `<fieldName>_truncated`/`_original_bytes`/`_spill_path` metadata when it was capped.
 * `fieldName` differs by event type (`node_output` for `node_completed`/
 * `node_skipped_prior_success`; `prior_output` for the `node_always_run_reset`/
 * `node_prior_cache_invalidated` audit events) — shared here so all five persist sites
 * stay in sync instead of repeating the same conditional spread independently.
 */
function persistedOutputEventFields(
  persistedOutput: ReturnType<typeof formatPersistedNodeOutput>,
  fieldName: 'node_output' | 'prior_output'
): Record<string, unknown> {
  return {
    [fieldName]: persistedOutput.nodeOutput,
    ...(persistedOutput.truncated
      ? {
          [`${fieldName}_truncated`]: true,
          [`${fieldName}_original_bytes`]: persistedOutput.originalBytes,
          ...(persistedOutput.spillPath
            ? { [`${fieldName}_spill_path`]: persistedOutput.spillPath }
            : {}),
        }
      : {}),
  };
}

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
  node: ExecNode,
  artifactsDir: string,
  stateDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string,
  envVars?: Record<string, string>,
  protectedEnvKeys?: readonly string[],
  protectedCredentialValues?: readonly string[],
  stepNamePrefix = '',
  iteration?: number,
  // Per-iteration $LOOP_USER_INPUT free-text for loop_group body bash nodes, delivered via
  // env (#2725). This is bash's SECOND delivery channel — the literal "$LOOP_USER_INPUT"
  // token is already shell-quoted and spliced into the script source by
  // applyLoopPrevToBodyNode before this function runs; this env var is what a script that
  // reads the variable indirectly (${LOOP_USER_INPUT}, printenv, env) actually sees. ''
  // for top-level bash nodes and non-first iterations.
  loopUserInput = '',
  execContext: ExecutionContext = { kind: 'host' },
  /** Invoked once per attempt beside the node_started write (#1961 work-unit accounting). */
  chargeWorkUnit?: () => void
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
  chargeWorkUnit?.();

  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
  });

  // Variable substitution on script
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
    { shellSafe: true, stateDir }
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, true, artifactsDir);

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
    // Named run and composed-workflow inputs as INPUTS_<UPPER_SNAKE> env vars
    // (#2470/#1764). Spread after envVars so a configured project env var can never
    // shadow an input's delivery, and before the engine-reserved keys so those still
    // win (same ordering rationale).
    ...inputEnvVars(node, {
      workflowRun,
      artifactsDir,
      stateDir,
      baseBranch,
      docsDir,
      issueContext,
      nodeOutputs,
    }),
    ARTIFACTS_DIR: artifactsDir,
    STATE_DIR: stateDir,
    LOG_DIR: logDir,
    // $WORKFLOW_ID substitutes into the body, but a heredoc'd python/node block
    // reads os.environ and found it missing while its siblings above were all
    // present. Deliver it the same way.
    WORKFLOW_ID: workflowRun.id,
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

  const bashPath = resolveBashPath();
  try {
    const { stdout, stderr } = await runSubprocess(execContext, bashPath, ['-c', finalScript], {
      cwd,
      timeout,
      env: subprocessEnv,
      protectedEnvKeys,
      protectedCredentialValues,
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

    const persistedOutput = formatPersistedNodeOutput(output, artifactsDir, stepName);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: {
          duration_ms: duration,
          type: 'bash',
          ...persistedOutputEventFields(persistedOutput, 'node_output'),
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
  node: ExecNode,
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
  node: ExecNode,
  artifactsDir: string,
  stateDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  issueContext?: string,
  envVars?: Record<string, string>,
  protectedEnvKeys?: readonly string[],
  protectedCredentialValues?: readonly string[],
  stepNamePrefix = '',
  iteration?: number,
  // Per-iteration $LOOP_USER_INPUT free-text for loop_group body scripts, delivered via
  // env (never spliced into source — #2115). '' for top-level scripts and non-first
  // iterations. This is script's ONLY delivery channel; executeBashNode also uses this
  // same env-var parameter (#2725), but additionally has the literal "$LOOP_USER_INPUT"
  // token pre-spliced (shell-quoted) into its script source by applyLoopPrevToBodyNode
  // before it runs — a channel script deliberately has no equivalent of.
  loopUserInput = '',
  execContext: ExecutionContext = { kind: 'host' },
  /** Roots named scripts resolve under; always supplied from RunLayersContext. */
  workflowSourceRoots?: WorkflowSourceRoots,
  /** Invoked once per attempt beside the node_started write (#1961 work-unit accounting). */
  chargeWorkUnit?: () => void
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
  chargeWorkUnit?.();

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
    { shellSafe: true, stateDir }
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
    // Named run and composed-workflow inputs as INPUTS_<UPPER_SNAKE> env vars
    // (#2470/#1764) — same ordering rationale as executeBashNode: after envVars,
    // before the engine-reserved keys.
    ...inputEnvVars(node, {
      workflowRun,
      artifactsDir,
      stateDir,
      baseBranch,
      docsDir,
      issueContext,
      nodeOutputs,
    }),
    ARTIFACTS_DIR: artifactsDir,
    STATE_DIR: stateDir,
    LOG_DIR: logDir,
    // $WORKFLOW_ID substitutes into the body, but a heredoc'd python/node block
    // reads os.environ and found it missing while its siblings above were all
    // present. Deliver it the same way.
    WORKFLOW_ID: workflowRun.id,
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
        scripts = await discoverScriptsForCwd(cwd, workflowSourceRoots);
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
      protectedEnvKeys,
      protectedCredentialValues,
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

    const persistedOutput = formatPersistedNodeOutput(output, artifactsDir, stepName);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: {
          duration_ms: duration,
          type: 'script',
          ...persistedOutputEventFields(persistedOutput, 'node_output'),
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

type LoopCompletionCheck =
  | { channel: 'until'; signal: string; completed: boolean }
  | { channel: 'until_bash'; completed: boolean }
  | { channel: 'until_field'; field: string; completed: boolean };

function describeLoopCompletionCheck(check: LoopCompletionCheck): string {
  switch (check.channel) {
    case 'until':
      return `\`until\` signal (\`${check.signal}\`)`;
    case 'until_bash':
      return '`until_bash`';
    case 'until_field':
      return `\`until_field\` (\`${check.field}\`)`;
  }
  const unreachable: never = check;
  return unreachable;
}

/**
 * Build the honest interactive-gate message (#2074, change D): an engine-generated
 * status line naming the completion channels that fired (or every declared channel
 * when none fired), plus a bounded excerpt of the final iteration output, prepended
 * to the author's static `gate_message`. Shared by executeLoopNode and
 * executeLoopGroupNode so both gates tell the truth about the iteration they paused on.
 */
function buildHonestGateMessage(
  completionChecks: LoopCompletionCheck[],
  lastIterationOutput: string,
  gateMessage: string
): string {
  const trimmed = lastIterationOutput.trim();
  const excerpt = trimmed.slice(0, GATE_EXCERPT_MAX);
  const completedChecks = completionChecks.filter(check => check.completed);
  const describedChecks = (completedChecks.length > 0 ? completedChecks : completionChecks).map(
    describeLoopCompletionCheck
  );
  const statusLine =
    completedChecks.length > 0
      ? `✅ Completion condition${completedChecks.length === 1 ? '' : 's'} met via ${describedChecks.join(' and ')}.`
      : `⚠️ No completion condition met in this iteration (${describedChecks.join(', ')}).`;
  const excerptBlock = excerpt
    ? `\n\n> ${excerpt}${trimmed.length > GATE_EXCERPT_MAX ? '…' : ''}`
    : '';
  return `${statusLine}${excerptBlock}\n\n${gateMessage}`;
}

/**
 * Narrow the token usage a loop gate persisted in its approval context (#2333).
 *
 * `metadata.approval` is free-form JSON read back from the DB and `isApprovalContext`
 * only vouches for nodeId/message, so the declared type carries no runtime authority
 * here: a run paused by a build that predates the field has none, and a malformed or
 * non-finite value must be dropped rather than persisted onward as a number a
 * consumer would believe.
 */
function readSignaledTokens(
  raw: unknown,
  context: { workflowRunId: string; nodeId: string }
): TokenUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') {
    const { input, output, cacheRead, cacheWrite, cachePartial } = raw as {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      cachePartial?: unknown;
    };
    if (
      typeof input === 'number' &&
      typeof output === 'number' &&
      Number.isFinite(input) &&
      Number.isFinite(output)
    ) {
      return sumTokenUsage(
        [
          {
            input,
            output,
            ...(cacheRead !== undefined ? { cacheRead: cacheRead as number } : {}),
            ...(cacheWrite !== undefined ? { cacheWrite: cacheWrite as number } : {}),
            // A loop that paused on a floor must not resume claiming an exact total.
            ...(cachePartial === true ? { cachePartial: true as const } : {}),
          },
        ],
        context
      );
    }
  }
  getLog().warn({ ...context, tokens: raw }, 'dag_loop.signaled_tokens_invalid_ignored');
  return undefined;
}

/** Narrow the cumulative cost stored beside signaledTokens in a loop gate. */
function readSignaledCostUsd(
  raw: unknown,
  context: { workflowRunId: string; nodeId: string }
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  getLog().warn({ ...context, costUsd: raw }, 'dag_loop.signaled_cost_invalid_ignored');
  return undefined;
}

/**
 * Finalize-on-approve (#2074), shared by executeLoopNode and executeLoopGroupNode:
 * a gate that paused on a completion-bearing iteration, resumed WITHOUT feedback,
 * completes the node from the persisted `signaledOutput` instead of re-running
 * the (expensive) iteration. Sends the user notice and writes/emits the
 * node_completed pair; the caller builds its own return value (the single-node
 * loop also threads the restored sessionId).
 *
 * `finalizeUsage` is the usage the pausing invocation consumed, carried
 * across the gate in the approval context (#2333) — without it this path persists a
 * node_completed reporting no usage for iterations that really ran. Passed by the
 * single-node loop ONLY: its per-iteration rows carry no tokens, so this row is the
 * only record. A loop_group omits it — its body nodes persisted their own namespaced
 * rows (with tokens) before the pause, and those rows survive it, so repeating the
 * total here would double-count in the one event stream.
 *
 * `finalizeStructuredOutput` is the signaled iteration's structured payload, carried
 * across the gate the same way (#2637) — persisted here so a resume AFTER the
 * finalize rehydrates the payload exactly like a natural completion's row.
 */
async function finalizeLoopFromSignal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  nodeId: string,
  stepName: string,
  nodeLabel: string,
  finalizeOutput: string,
  finalizeUsage?: { costUsd?: number; tokens?: TokenUsage },
  finalizeStructuredOutput?: unknown
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
    `${nodeLabel} '${nodeId}' accepted after a completion condition was met (no re-run)`,
    { workflowId: workflowRun.id, nodeName: nodeId }
  );
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_completed',
      step_name: stepName,
      data: {
        duration_ms: 0,
        node_output: finalizeOutput,
        ...(finalizeStructuredOutput !== undefined
          ? { structured_output: finalizeStructuredOutput }
          : {}),
        ...(finalizeUsage?.costUsd !== undefined ? { cost_usd: finalizeUsage.costUsd } : {}),
        ...(finalizeUsage?.tokens !== undefined ? { tokens: finalizeUsage.tokens } : {}),
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
    nodeId,
    nodeName: nodeId,
    duration: 0,
    ...(finalizeUsage?.costUsd !== undefined ? { costUsd: finalizeUsage.costUsd } : {}),
  });
}

/**
 * The body's designated pause node for #2707 step 3's gate-terminated pattern: a
 * `gate:` node that is the body's SOLE terminal sink (nothing depends on it, and
 * it is the only node nothing else depends on) — mirrors the placement rule
 * `loader.ts`'s `collectGateAndLoopDeprecationWarnings` already checks at load
 * time. Returns `undefined` for a body with no gate, or one that is misplaced
 * (mid-body, or co-terminal with another sink) — 3a already warns on that at
 * load time; this runtime code makes no special attempt to handle it, and such
 * a gate simply keeps behaving as it does today (silently ignored for
 * escalation purposes, since there is no unambiguous single pause node to
 * escalate).
 */
function findLoopGroupTerminalSuspendNode(
  bodyNodes: readonly DagNode[]
): GateNode | WaitNode | undefined {
  const dependedOn = new Set(bodyNodes.flatMap(n => n.depends_on ?? []));
  const sinks = bodyNodes.filter(n => !dependedOn.has(n.id));
  return sinks.length === 1 && (isGateNode(sinks[0]) || sinks[0]?.kind === 'wait')
    ? sinks[0]
    : undefined;
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
  stateDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  outerNodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  /** Shared by reference with the enclosing run so a body cannot re-report a conflict.
   *  Positioned among the REQUIRED parameters deliberately: as a trailing optional it
   *  could be omitted, silently handing the body an isolated Set and quietly undoing the
   *  de-duplication, with no compiler signal. */
  warnedProviderConflicts: Set<string>,
  /** Ordered enclosing loop_group frames. Required so nested artifact identity cannot
   *  silently fall back to only the immediate group. */
  enclosingLoopGroupPath: NodeArtifactLoopFrame[],
  issueContext?: string,
  stepNamePrefix = '',
  execContext: ExecutionContext = { kind: 'host' },
  runChildWorkflow?: RunChildWorkflowFn,
  /** Roots body nodes read command files and named scripts from; see RunLayersContext. */
  workflowSourceRoots?: WorkflowSourceRoots,
  /** Run-wide budget policy + shared ledger (#1961), threaded by reference so body
   *  attempts gate on and charge the same ceilings as top-level nodes. */
  budget?: WorkflowBudgetPolicy,
  budgetLedger?: RunBudgetLedger
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

  // Detect loop resume (mirrors executeLoopNode). Two shapes recognized:
  //  - the ORIGINAL interactive_loop gate (group.interactive + gate_message).
  //  - the #2707 step 3 ESCALATED shape — a gate node that is the body's sole
  //    terminal sink paused generically as an ordinary 'approval' gate, then
  //    rewritten (see the post-runLayers escalation below) so nodeId points at
  //    THIS group and bodyGateId carries the gate's own id. `$LOOP_USER_INPUT`
  //    does not apply to this shape — the human's text flows via the ordinary
  //    $LOOP_PREV.<gateId>.output.text channel instead, like any other body
  //    node's output — so `loopUserInput` below stays scoped to the legacy shape.
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const rawWait = workflowRun.metadata?.wait;
  const loopWaitMeta = isWorkflowWaitContext(rawWait) ? rawWait : undefined;
  const loopOwnedWaitMeta = loopWaitMeta?.owner === 'loop_group' ? loopWaitMeta : undefined;
  const isLegacyInteractiveLoopResume =
    loopGateMeta?.type === 'interactive_loop' && loopGateMeta.nodeId === node.id;
  const isEscalatedGateResume =
    loopGateMeta?.type === 'approval' &&
    loopGateMeta.nodeId === node.id &&
    loopGateMeta.bodyGateId !== undefined;
  const isEscalatedWaitResume = loopOwnedWaitMeta?.nodeId === node.id;
  const isLoopResume =
    isLegacyInteractiveLoopResume || isEscalatedGateResume || isEscalatedWaitResume;
  const resumeIteration = loopGateMeta?.iteration ?? loopOwnedWaitMeta?.iteration ?? 0;
  const startIteration = isLoopResume ? resumeIteration + 1 : 1;
  const loopGateRunMeta = (workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const loopUserInput = isLegacyInteractiveLoopResume
    ? (loopGateRunMeta.loop_user_input ?? '')
    : '';

  // Finalize-on-approve (#2074): mirrors executeLoopNode — a completion-bearing gate
  // resumed WITHOUT feedback completes the group from the persisted output instead
  // of re-running the body.
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    // The signaled iteration's structured payload (#2637): attaching it keeps this
    // route's `$group.output.field` tier IDENTICAL to natural completion (tier-2
    // lenient) — without it the same absent optional field would throw here and
    // resolve to '' there. null/absent (pre-#2637 gates) → text-only, as before.
    const finalizeStructured = loopGateMeta.signaledStructuredOutput ?? null;
    await finalizeLoopFromSignal(
      deps,
      platform,
      conversationId,
      workflowRun,
      node.id,
      stepName,
      'Loop-group node',
      finalizeOutput,
      // NO usage, deliberately — same double-count reasoning as the
      // natural-completion group row below. A loop_group's body nodes wrote their own
      // `<groupId>.<nodeId>` node_completed rows (with tokens) BEFORE the gate paused,
      // and those rows survive the pause: they are already in the event stream this
      // finalize row is appended to. Reporting the group total here would make a
      // consumer summing usage count the pausing iteration twice. The plain `loop`
      // DOES pass it — its per-iteration rows carry no usage, so its finalize row is
      // the only record.
      undefined,
      finalizeStructured ?? undefined
    );
    return {
      state: 'completed',
      output: finalizeOutput,
      ...(finalizeStructured !== null ? { structuredOutput: finalizeStructured } : {}),
    };
  }

  if (isEscalatedWaitResume) {
    const terminalNode = findLoopGroupTerminalSuspendNode(group.nodes as DagNode[]);
    if (terminalNode?.kind !== 'wait') {
      throw new Error(`Loop group '${node.id}' resumed with wait state but has no terminal wait`);
    }
    const waitOutput = await executeWaitNode(
      terminalNode,
      workflowRun,
      deps,
      outerNodeOutputs,
      bodyStepNamePrefix,
      {
        groupId: node.id,
        iteration: resumeIteration,
        sessionId: loopOwnedWaitMeta?.sessionId ?? null,
        sessionProvider: loopOwnedWaitMeta?.sessionProvider ?? null,
      }
    );
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === 'paused') {
      return { state: 'completed', output: '', loopIterations: resumeIteration };
    }
    outerNodeOutputs.set(bodyStepNamePrefix + terminalNode.id, waitOutput);
  }

  let loopPrevOutputs: Map<string, NodeOutput> | undefined; // undefined on iteration 1
  // Restore the body-output snapshot $LOOP_PREV.* reads, for the resumed iteration
  // (#2748). The pause boundary discards this function's local state, but the last
  // iteration's direct body-node outputs already survive as persisted
  // `<groupId>.<bodyId>` node_completed rows — `outerNodeOutputs` was ALREADY
  // pre-populated from them (executeDagWorkflow's resume pre-population, itself
  // sourced from getDagResumeSnapshot's #2726/#2732 bounded-rows + spill/rehydrate
  // read), keyed by that full step name. Re-key to the bare body id so
  // substituteLoopPrevRefs finds them exactly as it would mid-loop.
  if (isLoopResume) {
    const restoredLoopPrevOutputs = new Map<string, NodeOutput>();
    const bodyNodesById = new Map((group.nodes as DagNode[]).map(n => [n.id, n]));
    for (const id of directBodyIds) {
      const prior = outerNodeOutputs.get(bodyStepNamePrefix + id);
      if (!prior) continue;
      // The persisted row's dotted `<groupId>.<bodyId>` step name never matches a
      // TOP-LEVEL node id, so the pre-population `prior` came from (dag-executor.ts
      // ~10037-10052) always drops declaredFields for it. Re-derive it from the body
      // node's OWN current definition — the same source the in-process per-iteration
      // path uses (~line 3111) — so a resumed $LOOP_PREV.<id>.output.<field> ref keeps
      // the same schema-typo strictness a live iteration has, instead of silently
      // degrading to lenient '' for a genuinely undeclared field.
      const bodyNodeDef = bodyNodesById.get(id);
      const declaredFields =
        bodyNodeDef !== undefined && !isLoopGroupNode(bodyNodeDef)
          ? declaredFieldsFromSchema(bodyNodeDef.output_format)
          : undefined;
      restoredLoopPrevOutputs.set(id, {
        ...prior,
        ...(declaredFields !== undefined ? { declaredFields } : {}),
      });
    }
    // Kept as an empty-map guard for clarity only — substituteLoopPrevRefs reads via
    // `loopPrevOutputs?.get(id)`, so an empty Map and undefined are indistinguishable
    // to every consumer; this has no behavioral effect either way.
    if (restoredLoopPrevOutputs.size > 0) loopPrevOutputs = restoredLoopPrevOutputs;
  }

  // #2707 step 3: an escalated gate-terminated-body resume might already be
  // "done" — the human's answer, just reconstructed above (the SAME restoration
  // #2748 built for $LOOP_PREV, now also finding the gate's own resolution
  // thanks to the namespaced write-path fix), may satisfy the group's own
  // until_bash. The legacy interactive_loop resume always advances blindly to
  // iteration+1; that would be WRONG here — it would silently start a whole new
  // iteration (re-running the body's pre-gate work) while ignoring an answer
  // that already meant "stop". Re-run the same completion check the normal
  // per-iteration path runs below, fed from the reconstructed data instead of a
  // fresh runLayers call — decision (b) settled that resume re-enters at the
  // iteration boundary, so the pre-gate body nodes' already-produced outputs are
  // safe to reuse as-is; only the gate's own answer needed reconstructing.
  if ((isEscalatedGateResume || isEscalatedWaitResume) && loopPrevOutputs !== undefined) {
    const terminalNode = findLoopGroupTerminalSuspendNode(group.nodes as DagNode[]);
    const terminalSink = terminalNode ? loopPrevOutputs.get(terminalNode.id) : undefined;
    if (terminalSink !== undefined) {
      const resumedIteration = resumeIteration;
      const rawIterationOutput = terminalSink.output;
      const resumedSignalDetected =
        group.until !== undefined && detectCompletionSignal(rawIterationOutput, group.until);
      let resumedBashComplete = false;
      if (group.until_bash && !resumedSignalDetected) {
        // No $LOOP_PREV history survives a resume beyond the single reconstructed
        // iteration above — #2748 restores only the LATEST persisted body outputs,
        // not a full history — so an until_bash referencing $LOOP_PREV from the
        // iteration BEFORE this one resolves empty here, same as a fresh
        // iteration 1. Not expected to matter in practice: Design A's canonical
        // pattern reads only $<gateId>.output inside until_bash, never $LOOP_PREV.
        const { prompt: resumedBashPrompt } = substituteWorkflowVariables(
          group.until_bash,
          workflowRun.id,
          workflowRun.user_message,
          artifactsDir,
          baseBranch,
          docsDir,
          issueContext,
          undefined,
          undefined,
          undefined,
          { shellSafe: true, stateDir }
        );
        // Merge outer-DAG outputs underneath the reconstructed body outputs —
        // mirrors how a normal (non-resumed) iteration seeds scopedNodeOutputs
        // (`new Map(outerNodeOutputs)`, then overwritten by this iteration's own
        // body results) — so an until_bash combining an outer-scope ref with the
        // gate's own decision resolves the outer ref correctly on resume too,
        // not just mid-loop. outerNodeOutputs is already an in-scope parameter;
        // no new reconstruction needed.
        const resumedScope = new Map([...outerNodeOutputs, ...loopPrevOutputs]);
        const resumedSubstitutedBash = substituteNodeOutputRefs(
          resumedBashPrompt,
          resumedScope,
          true, // escapedForBash
          artifactsDir
        );
        const resumedBashPath = resolveBashPath();
        try {
          await runSubprocess(execContext, resumedBashPath, ['-c', resumedSubstitutedBash], {
            cwd,
            timeout: SUBPROCESS_DEFAULT_TIMEOUT,
            protectedEnvKeys: config.protectedEnvKeys,
            protectedCredentialValues: config.protectedCredentialValues,
            env: {
              ...(config.envVars ?? {}),
              USER_MESSAGE: workflowRun.user_message,
              ARGUMENTS: workflowRun.user_message,
              LOOP_USER_INPUT: '',
              LOOP_PREV_OUTPUT: '',
              REJECTION_REASON: '',
              CONTEXT: issueContext ?? '',
              EXTERNAL_CONTEXT: issueContext ?? '',
              ISSUE_CONTEXT: issueContext ?? '',
            },
          });
          resumedBashComplete = true;
        } catch (e) {
          const bashErr = e as NodeJS.ErrnoException;
          if (
            bashErr.code === 'ENOENT' ||
            bashErr.code === 'EACCES' ||
            bashErr.code === 'ENOTDIR'
          ) {
            getLog().error(
              { err: bashErr, nodeId: node.id, iteration: resumedIteration },
              'loop_group.until_bash_failed'
            );
            throw new Error(
              `Loop group '${node.id}' until_bash failed: cannot execute bash at ` +
                `'${resumedBashPath}' (${bashErr.code}). Set ARCHON_BASH_PATH if Git Bash ` +
                'is installed elsewhere.'
            );
          }
          if (typeof bashErr.code !== 'number') {
            getLog().error(
              { err: bashErr, nodeId: node.id, iteration: resumedIteration },
              'loop_group.until_bash_unexpected_error'
            );
            throw bashErr;
          }
          resumedBashComplete = false;
        }
      }
      if (resumedSignalDetected || resumedBashComplete) {
        const resumedOutput = stripCompletionTags(rawIterationOutput, group.until);
        const resumedStructuredOutput =
          'structuredOutput' in terminalSink ? terminalSink.structuredOutput : undefined;
        await safeSendMessage(
          platform,
          conversationId,
          `Loop-group node '${node.id}' completed after ${String(resumedIteration)} iteration${resumedIteration > 1 ? 's' : ''}`,
          msgContext
        );
        deps.store
          .createWorkflowEvent({
            workflow_run_id: workflowRun.id,
            event_type: 'node_completed',
            step_name: stepName,
            data: {
              node_output: resumedOutput,
              ...(resumedStructuredOutput !== undefined
                ? { structured_output: resumedStructuredOutput }
                : {}),
              aggregate: true,
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
          duration: 0,
        });
        return {
          state: 'completed',
          output: resumedOutput,
          loopIterations: resumedIteration,
          ...(resumedStructuredOutput !== undefined
            ? { structuredOutput: resumedStructuredOutput }
            : {}),
        };
      }
      // Not complete — fall through. startIteration is already iteration+1 (set
      // above from loopGateMeta.iteration), so the for loop below proceeds into a
      // genuinely fresh iteration, exactly as it would for any other resume.
    }
  }

  let lastIterationOutput = '';
  // The terminal sink's structured payload for the same iteration (#2637) — tracked
  // beside the text so the group's completed NodeOutput carries the logical value
  // (sibling `loop:` has done this since #2563; the group used to discard it).
  let lastIterationStructuredOutput: unknown;
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
  const resumedLoopSessionId = loopGateMeta?.sessionId ?? loopOwnedWaitMeta?.sessionId;
  const resumedLoopSessionProvider =
    loopGateMeta?.sessionProvider ?? loopOwnedWaitMeta?.sessionProvider;
  let loopLastSequentialSession: SequentialSessionCursor | undefined =
    isLoopResume &&
    typeof resumedLoopSessionId === 'string' &&
    typeof resumedLoopSessionProvider === 'string'
      ? {
          sessionId: resumedLoopSessionId,
          provider: resumedLoopSessionProvider,
        }
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
    // The executor only ever receives already-expanded nodes (see the justification at
    // the other `applyLoopPrevToBodyNode` call site above), so the body is include-free.
    const iterBodyNodes = (group.nodes as DagNode[]).map(n =>
      applyLoopPrevToBodyNode(
        n,
        prevSnapshot,
        userInputForIter,
        artifactsDir,
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
      // A body node's commands and scripts come from the same frozen source as the
      // enclosing run's — the group is part of one workflow, not a separate one. The
      // enclosing context already normalized these, so the fallback is unreachable; it
      // exists because the positional parameter cannot be made required after optionals.
      workflowSourceRoots: workflowSourceRoots ?? liveSourceRoots(cwd),
      config,
      workflowProvider,
      // Forward inherited workflow-level model/tier/options/profile so body AI nodes
      // resolve model aliases and workflow defaults the same way top-level nodes do.
      workflowModel,
      workflowLevelOptions,
      aiProfile,
      workflowPreset,
      artifactsDir,
      stateDir,
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
      warnedProviderConflicts,
      totalCostUsd: 0,
      totalTokens: undefined,
      totalLoopIterations: 0,
      stepNamePrefix: bodyStepNamePrefix,
      loopGroupPath: [...enclosingLoopGroupPath, { groupId: node.id, iteration: i }],
      // Deliver this iteration's approval-gate free-text to body exec: nodes via env
      // (#2115, #2725). Script bodies use this as their ONLY channel (applyLoopPrevToBodyNode
      // skips their literal token, unsafe to splice into TS/Python source). Bash bodies get
      // it as a SECOND channel — applyLoopPrevToBodyNode already spliced the literal
      // "$LOOP_USER_INPUT" token into the script source; this env var covers indirect reads
      // (${LOOP_USER_INPUT}, printenv, env) that splice can't reach.
      bodyLoopUserInput: userInputForIter,
      budget,
      budgetLedger,
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
    if (iterCtx.totalTokens !== undefined) {
      loopTotalTokens = sumTokenUsage(
        [...(loopTotalTokens !== undefined ? [loopTotalTokens] : []), iterCtx.totalTokens],
        { nodeId: node.id, iteration: i }
      );
    }

    // #2707 step 3: pause escalation. A gate node that is the body's sole terminal
    // sink pauses generically via executeApprovalNode (called through runLayers,
    // like any other body node) — that pause alone does NOT stop this loop: the
    // `paused` tolerance above (needed for a genuinely unrelated sibling gate
    // pausing in the same layer) would otherwise let the loop barrel straight into
    // the next iteration, immediately re-pausing and burning cost every time. This
    // detects THAT specific pause and escalates it: rewrite the ApprovalContext so
    // it points at THIS group (the top-level DAG only knows top-level node ids,
    // never a nested body id — mirrors exactly how the interactive_loop gate below
    // already works) and return the same "paused" shape that path uses. Placed
    // AFTER the usage accumulation above (not right after runLayers) so this
    // iteration's own spend — the 'work' node plus the gate check that just ran —
    // is already folded into loopTotalCostUsd/loopTotalTokens by the time the
    // escalation return reads them; reading them any earlier would silently drop
    // this iteration's cost from the run's live totals for the whole pause window.
    const terminalSuspendNode = findLoopGroupTerminalSuspendNode(iterBodyNodes);
    if (terminalSuspendNode && postBodyStatus === 'paused') {
      // Fresh read — workflowRun is this call's stale snapshot from before
      // runLayers ran; the gate's own pause just wrote metadata.approval.
      const freshRun = await deps.store.getWorkflowRun(workflowRun.id);
      const freshApproval = isApprovalContext(freshRun?.metadata?.approval)
        ? freshRun.metadata.approval
        : undefined;
      if (isGateNode(terminalSuspendNode) && freshApproval?.nodeId === terminalSuspendNode.id) {
        const rewritten: ApprovalContext = {
          ...freshApproval,
          nodeId: node.id,
          bodyGateId: terminalSuspendNode.id,
          iteration: i,
          sessionId: loopLastSequentialSession?.sessionId ?? null,
          sessionProvider: loopLastSequentialSession?.provider ?? null,
        };
        const { resolved } = await deps.store.rewriteApprovalContext(workflowRun.id, rewritten);
        if (resolved) {
          return {
            state: 'completed',
            output: lastIterationOutput,
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            loopIterations: i,
          };
        }
        // A human resolved the ORIGINAL bare-gate pause before the rewrite landed
        // (an astronomically narrow race) — fall through rather than error or
        // corrupt state. This does NOT behave the same as a normal resolved gate,
        // though: the resolution was written under the bare gate id, with
        // bodyGateId still unset, so it's unreachable by the namespaced restore
        // path this mechanism depends on — the loop proceeds toward
        // max_iterations instead of honoring the human's answer. Accepted for
        // this race's vanishingly narrow window rather than built out further.
        // (The postBodyStatus tolerance above already let a 'paused' status
        // through; nothing here re-checks it.)
      }
      const freshWait = isWorkflowWaitContext(freshRun?.metadata?.wait)
        ? freshRun.metadata.wait
        : undefined;
      if (
        terminalSuspendNode.kind === 'wait' &&
        freshWait?.owner === 'loop_group' &&
        freshWait.nodeId === node.id &&
        freshWait.bodyWaitId === terminalSuspendNode.id &&
        freshWait.iteration === i
      ) {
        return {
          state: 'completed',
          output: lastIterationOutput,
          costUsd: loopTotalCostUsd,
          ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
          loopIterations: i,
        };
      }
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
    // DELIBERATELY NOT `returns:`-aware (#2470): a loop_group's per-iteration output is
    // the iteration's own result, not a caller contract — `returns:` selects a WORKFLOW's
    // result and only rebinds a child run's terminal output (see executeDagWorkflow). Leave
    // this positional scan as-is; do not "fix" the inconsistency.
    const allDeps = new Set(iterBodyNodes.flatMap(n => n.depends_on ?? []));
    const terminalSink = iterBodyNodes
      .filter(n => !allDeps.has(n.id))
      .map(n => scopedNodeOutputs.get(n.id))
      .find(o => o?.state === 'completed' && o.output.trim().length > 0);
    const iterationOutput = terminalSink?.output ?? '';
    // Capture the PREVIOUS iteration's (cleaned) output before overwriting — the
    // until_bash env below exposes it as LOOP_PREV_OUTPUT (previous iteration, same
    // semantics as executeLoopNode; empty on the first iteration).
    const prevIterationOutput = lastIterationOutput;
    // Signal detection uses the raw output; the stored/returned output is stripped of
    // completion-signal tags so the marker never leaks into $groupId.output (mirrors
    // executeLoopNode's cleanOutput handling).
    lastIterationOutput = stripCompletionTags(iterationOutput, group.until);
    // The sink's structured payload rides along AS-IS (#2637): a JSON payload never
    // contains the completion tag, so no stripping applies to it.
    lastIterationStructuredOutput =
      terminalSink !== undefined && 'structuredOutput' in terminalSink
        ? terminalSink.structuredOutput
        : undefined;

    // Completion gate: until-signal in the terminal output, and/or until_bash exit 0.
    // Short-circuit: if the until-signal already detected completion, skip the
    // until_bash subprocess (avoids unnecessary side effects and shell cost) — OR
    // semantics mean the group is already complete.
    //
    // `until` is optional (#2563): a group that declared only `until_bash` has no
    // prose path at all, so never call detectCompletionSignal with an undefined
    // signal — its regexes would be built from the empty string and match anything.
    const signalDetected =
      group.until !== undefined && detectCompletionSignal(iterationOutput, group.until);

    let bashComplete = false;
    if (group.until_bash && !signalDetected) {
      // Resolve outside the try so ARCHON_BASH_PATH validation errors bubble up
      // to the caller instead of being swallowed by the per-iteration catch.
      const groupBashPath = resolveBashPath();
      try {
        // Resolve this group's own cross-iteration refs against the snapshot captured
        // before its body ran. `loopPrevOutputs` now contains the CURRENT iteration, so
        // using it here would collapse `$LOOP_PREV` into `$node.output` semantics. Only
        // direct body ids belong to this scope; refs owned by an enclosing group were
        // already resolved while preparing this nested group, and descendant ids are not
        // present in this group's per-iteration output map.
        const prevResolvedBash = substituteLoopPrevRefs(
          group.until_bash,
          prevSnapshot,
          true,
          logDir,
          directBodyIds,
          directBodyIds
        );
        const { prompt: bashPrompt } = substituteWorkflowVariables(
          prevResolvedBash,
          workflowRun.id,
          workflowRun.user_message,
          artifactsDir,
          baseBranch,
          docsDir,
          issueContext,
          i === startIteration ? loopUserInput : undefined,
          undefined,
          undefined,
          { shellSafe: true, stateDir }
        );
        const substitutedBash = substituteNodeOutputRefs(
          bashPrompt,
          scopedNodeOutputs,
          true, // escapedForBash
          artifactsDir
        );
        await runSubprocess(execContext, groupBashPath, ['-c', substitutedBash], {
          cwd,
          timeout: SUBPROCESS_DEFAULT_TIMEOUT,
          protectedEnvKeys: config.protectedEnvKeys,
          protectedCredentialValues: config.protectedCredentialValues,
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

    const completionChecks: LoopCompletionCheck[] = [];
    if (group.until !== undefined) {
      completionChecks.push({ channel: 'until', signal: group.until, completed: signalDetected });
    }
    if (group.until_bash !== undefined) {
      completionChecks.push({ channel: 'until_bash', completed: bashComplete });
    }

    const duration = Date.now() - iterationStart;
    const completionDetected = completionChecks.some(check => check.completed);

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

    // Completion: honor the completed iteration only when the AI had input to evaluate (interactive
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
            // The terminal sink's logical value (#2637) — persisted so cold resume
            // rehydrates typed `$group.output.field` access identically to fresh runs.
            ...(lastIterationStructuredOutput !== undefined
              ? { structured_output: lastIterationStructuredOutput }
              : {}),
            // This row is an AGGREGATE of rows that are already in the event log.
            // Unlike every other node type, a loop_group's body nodes write their OWN
            // node_completed rows (namespaced `<groupId>.<nodeId>`, one per iteration)
            // carrying their own usage, so any consumer summing usage across
            // node_completed rows would count this group twice.
            //
            // `tokens` is omitted outright: the leaves are authoritative (they are
            // per-provider — a body node may override `provider:`, so the group total
            // can mix providers and is useless for the cross-provider comparison #2333
            // exists to enable) and the group total is recoverable by summing the
            // `<groupId>.` prefix. The RETURN value below still carries `tokens` — that
            // is the run-level roll-up path, which counts each group exactly once (body
            // results land in the scoped iteration ctx, never the run ctx).
            //
            // `cost_usd` is KEPT, because the console renders it per event
            // (web/.../console/primitives/event.ts) and dropping it would blank the
            // loop_group card's cost. `aggregate: true` is what makes that safe: it
            // marks the row as derived so a summing consumer can skip it. #2469 added
            // the first such consumer (getDagResumeSnapshot rebuilds cost across resume
            // passes), which turned this from a latent shape into a live double count.
            aggregate: true,
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
        // The final iteration's sink payload, so downstream `$group.output.field`
        // resolves from the logical value (#2637). No declaredFields: a group's
        // own output_format is ignored, so field access stays tier-2 lenient.
        ...(lastIterationStructuredOutput !== undefined
          ? { structuredOutput: lastIterationStructuredOutput }
          : {}),
      };
    }

    // Interactive gate — pause after an iteration that did not complete (or, when
    // interactiveFirstRun && !signalCompletes, an iteration that DID complete — the honest
    // status line + persisted completion state (#2074) let a bare approve finalize it).
    if (group.interactive && group.gate_message) {
      const honestMessage = buildHonestGateMessage(
        completionChecks,
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
        // a different provider (#1992). null = this pause has no cursor to restore.
        sessionId: loopLastSequentialSession?.sessionId ?? null,
        sessionProvider: loopLastSequentialSession?.provider ?? null,
        // Signal state for finalize-on-bare-approve (#2074). The structured payload
        // rides along (#2637) so the finalize attaches it like a natural completion.
        completionSignaled: completionDetected,
        signaledOutput: completionDetected ? lastIterationOutput : null,
        signaledStructuredOutput: completionDetected
          ? (lastIterationStructuredOutput ?? null)
          : null,
        // NO `signaledTokens` — a loop_group gate has no consumer for it. The body's
        // own `<groupId>.<nodeId>` rows already persisted this iteration's usage before
        // the pause, so the finalize path deliberately writes no `tokens` (see the
        // finalizeLoopFromSignal call above). Only the plain `loop` gate carries it.
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
  const errorMsg = `Loop-group node '${node.id}' exceeded max iterations (${String(group.max_iterations)}) ${describeUnmetCompletion(group)}`;
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
 * Prompt-bearing fields include node prompts, AI configuration, and load-time compiled loop
 * command prompts. `when:` conditions are NOT substituted (they use evaluateCondition, which
 * does not call substituteLoopPrevRefs). Body authors who need cross-iteration gating should
 * branch on prompt content, not `when:`.
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
  // Node-local `with:` bindings (#2637) are per-iteration surfaces like every other
  // body field: string values (whole refs and templates alike) get the same raw
  // `$LOOP_PREV` splice — raw because binding values never touch shell source, the
  // env bag / `$INPUTS` channel is the injection-safe delivery (#2115). A spliced
  // `$LOOP_PREV.<id>.output` therefore delivers the previous iteration's TEXT
  // ('' on iteration 1), exactly like the prompt/bash surfaces — never the literal
  // token. Directives stay untouched: `from` must remain a current-iteration node
  // ref (the loader rejects `$LOOP_PREV` there, naming this string form), and only
  // a string `if_skipped` default carries the splice, mirroring the include macro.
  const subWithMap = (
    withMap: Record<string, JsonValue | BindingDirective>
  ): Record<string, JsonValue | BindingDirective> =>
    Object.fromEntries(
      Object.entries(withMap).map(([name, value]): [string, JsonValue | BindingDirective] => {
        if (isBindingDirective(value)) {
          return [
            name,
            typeof value.if_skipped === 'string'
              ? { ...value, if_skipped: sub(value.if_skipped) }
              : value,
          ];
        }
        return [name, typeof value === 'string' ? sub(value) : value];
      })
    );
  // AI configuration is live prompt text too. Resolve it in this same per-iteration pass
  // before the ordinary workflow-variable/node-output pass runs in `runLayers`, otherwise
  // a namespaced `$LOOP_PREV` inside an included block reaches the provider literally.
  const substitutedNode: DagNode = {
    ...node,
    ...(node.systemPrompt !== undefined ? { systemPrompt: sub(node.systemPrompt) } : {}),
    ...(node.agents !== undefined
      ? {
          agents: Object.fromEntries(
            Object.entries(node.agents).map(([id, agent]) => [
              id,
              {
                ...agent,
                description: sub(agent.description),
                prompt: sub(agent.prompt),
              },
            ])
          ),
        }
      : {}),
  };
  const composedMeta = readComposedMeta(node);
  if (composedMeta?.inputs !== undefined) {
    (substitutedNode as DagNode & NodeWithComposedMeta)[COMPOSED_NODE] = {
      ...composedMeta,
      inputs: Object.fromEntries(
        // Only strings carry substitutable refs (#2637); typed values pass through.
        Object.entries(composedMeta.inputs).map(([name, value]) => [
          name,
          typeof value === 'string' ? sub(value) : value,
        ])
      ),
    };
  }

  if (isLoopNode(substitutedNode)) {
    // until_bash is shell-bound: an unresolved $LOOP_PREV would silently degrade to an
    // (empty) shell variable expansion inside bash -c.
    const loop = {
      ...substitutedNode.loop,
      ...(substitutedNode.loop.prompt !== undefined
        ? { prompt: sub(substitutedNode.loop.prompt) }
        : {}),
      ...(substitutedNode.loop.until_bash !== undefined
        ? { until_bash: sub(substitutedNode.loop.until_bash, true) }
        : {}),
    };
    const compiled = (
      substitutedNode.loop as typeof substitutedNode.loop & LoopWithCompiledCommand
    )[COMPILED_LOOP_COMMAND];
    if (compiled?.prompt !== undefined) {
      (loop as typeof loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND] = {
        prompt: sub(compiled.prompt),
      };
    }
    return {
      ...substitutedNode,
      loop: {
        ...loop,
      },
    };
  }
  if (isLoopGroupNode(substitutedNode)) {
    // Nested loop_group: recurse into the body. `knownBodyIds`/`directBodyIds` are the OUTER
    // group's sets, threaded UNCHANGED — so during this OUTER pass a ref to an inner-owned id
    // (in knownBodyIds but not directBodyIds) is left intact (return match) for the inner
    // group's own pass, while a ref to an OUTER-direct id resolves here at the outer
    // granularity and a true typo still throws. The inner group's own executeLoopGroupNode
    // computes fresh sets when it runs, so inner-owned refs in both body nodes and its
    // completion script resolve at the inner iteration granularity. This outer pass still
    // resolves enclosing-group refs in the nested until_bash before that inner execution.
    return {
      ...substitutedNode,
      loop_group: {
        ...substitutedNode.loop_group,
        ...(substitutedNode.loop_group.until_bash !== undefined
          ? { until_bash: sub(substitutedNode.loop_group.until_bash, true) }
          : {}),
        // The executor only ever receives already-expanded nodes (runLayers throws on any
        // surviving IncludeDirective before node execution begins), so a loop_group body
        // here is always include-free even though the type admits IncludeDirective for
        // the general pre-expansion case (#2486).
        nodes: (substitutedNode.loop_group.nodes as DagNode[]).map(n =>
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
  if (isGateNode(substitutedNode)) {
    return {
      ...substitutedNode,
      message: sub(substitutedNode.message),
      decisions: substitutedNode.decisions.map(decision =>
        decision.rework !== undefined
          ? { ...decision, rework: { ...decision.rework, prompt: sub(decision.rework.prompt) } }
          : decision
      ),
    };
  }
  if (isWaitNode(substitutedNode)) {
    const condition = waitCondition(substitutedNode.wait);
    if (condition.kind === 'duration') return substitutedNode;
    return condition.kind === 'until'
      ? { ...substitutedNode, wait: { until: sub(condition.timestamp) } }
      : {
          ...substitutedNode,
          wait: { event: sub(condition.event), deadline_ms: condition.deadlineMs },
        };
  }
  // Bash never passes through a shell escape hazard-free path — escapedForBash=true
  // shell-quotes $LOOP_PREV/$LOOP_USER_INPUT before splicing into the `bash -c` body.
  // Scripts never pass through a shell (execFile argv) — bash-quoting would inject
  // literal quote artifacts into TS/Python source. $LOOP_PREV.* refs are spliced raw
  // (mirroring executeScriptNode's substituteNodeOutputRefs(..., false)); $LOOP_USER_INPUT
  // is skipped here (skipUserInput) and delivered via env by executeScriptNode (#2115).
  if (isExecNode(substitutedNode)) {
    return substitutedNode.runtime === 'sh'
      ? { ...substitutedNode, script: sub(substitutedNode.script, true) }
      : {
          ...substitutedNode,
          script: sub(substitutedNode.script, false, true),
          ...(substitutedNode.with !== undefined ? { with: subWithMap(substitutedNode.with) } : {}),
        };
  }
  // Halt reason is display text, never executed — mirrors the normal-path default.
  if (isHaltNode(substitutedNode))
    return { ...substitutedNode, reason: sub(substitutedNode.reason) };
  if (isAgentNode(substitutedNode)) {
    return {
      ...substitutedNode,
      source:
        substitutedNode.source.kind === 'command'
          ? {
              ...substitutedNode.source,
              name: sub(substitutedNode.source.name),
              ...(substitutedNode.source.with !== undefined
                ? { with: subWithMap(substitutedNode.source.with) }
                : {}),
            }
          : { ...substitutedNode.source, prompt: sub(substitutedNode.source.prompt) },
    };
  }
  return substitutedNode;
}

/**
 * Execute a loop node — runs the prompt until a declared completion channel fires or the
 * maximum iteration count is reached.
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
  stateDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  issueContext?: string,
  configuredCommandFolder?: string,
  stepNamePrefix = '',
  execContext: ExecutionContext = { kind: 'host' },
  resolvedModel?: string,
  resolvedTier?: TierName,
  resolvedEffort?: string,
  checkpointSession?: SessionCheckpoint,
  /** Roots a `loop.command` file resolves under; always supplied from RunLayersContext. */
  workflowSourceRoots?: WorkflowSourceRoots,
  /** Invoked once per execution beside the node_started write (#1961 work-unit accounting). */
  chargeWorkUnit?: () => void
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
      data: {
        type: 'loop',
        command: loop.command ?? null,
        // Requested-model attribution, same fields the AI-node path records
        // (#2314) — every iteration runs on this one resolved provider/model,
        // so it belongs on the node's single _started row.
        provider: workflowProvider,
        model: resolvedModel,
        tier: resolvedTier,
        ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'node_started' },
        'workflow_event_persist_failed'
      );
    });
  chargeWorkUnit?.();

  getWorkflowEventEmitter().emit({
    type: 'node_started',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
    provider: workflowProvider,
    model: resolvedModel,
    tier: resolvedTier,
    ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
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
    // A loop that failed part-way still paid for the iterations it ran. Built once and
    // spread into both sinks, so the transcript row and the persisted event cannot
    // disagree — the same reason executeNodeInternal routes both through
    // nodeUsageEventData (#2693).
    const loopUsage: WorkflowUsage = {
      ...(extras.tokens !== undefined ? { tokens: extras.tokens } : {}),
      ...(extras.costUsd !== undefined ? { cost_usd: extras.costUsd } : {}),
    };
    await logNodeError(logDir, workflowRun.id, node.id, error, loopUsage);
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: {
          error,
          ...loopUsage,
          ...(extras.data ?? {}),
        },
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
  const persistedUsageContext = { workflowRunId: workflowRun.id, nodeId: node.id };
  const persistedLoopCostUsd = isLoopResume
    ? readSignaledCostUsd(loopGateMeta.signaledCostUsd, persistedUsageContext)
    : undefined;
  const persistedLoopTokens = isLoopResume
    ? readSignaledTokens(loopGateMeta.signaledTokens, persistedUsageContext)
    : undefined;

  // Finalize-on-approve (#2074): a gate that paused on a completion-bearing iteration,
  // resumed WITHOUT feedback, completes the node from the persisted output instead of
  // re-running the (expensive) iteration. Feedback (loop_feedback_given) OR a
  // non-completing gate falls through to a normal resumed iteration below. Runs
  // BEFORE prompt-source resolution: a bare approve never needs the prompt, so a
  // command file deleted while the run sat paused cannot fail the finalize.
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    // The signaled iteration's structured payload (#2637) — attached below so this
    // route matches natural completion's NodeOutput exactly. null/absent
    // (pre-#2637 gates) → text-only, as before.
    const finalizeStructured = loopGateMeta.signaledStructuredOutput ?? null;
    if (currentSessionId !== undefined) {
      await checkpointSession?.(currentSessionId);
    }
    await finalizeLoopFromSignal(
      deps,
      platform,
      conversationId,
      workflowRun,
      node.id,
      stepName,
      'Loop node',
      finalizeOutput,
      {
        ...(persistedLoopCostUsd !== undefined ? { costUsd: persistedLoopCostUsd } : {}),
        ...(persistedLoopTokens !== undefined ? { tokens: persistedLoopTokens } : {}),
      },
      finalizeStructured ?? undefined
    );
    // Same declared-field capture as the normal completion return below and as the
    // resume-hydration path (#2091). This is a COMPLETION exit, so a consumer's
    // `$loop.output.field` must get the identical strict contract here: without it a
    // declared-optional field that the payload omits would throw instead of resolving
    // to '', and an explicit null would substitute the literal "null". Re-derived
    // from the definition rather than carried through the pause, exactly like resume.
    const finalizeDeclaredFields = declaredFieldsFromSchema(node.output_format);
    return {
      state: 'completed',
      output: finalizeOutput,
      sessionId: currentSessionId,
      ...(persistedLoopCostUsd !== undefined ? { costUsd: persistedLoopCostUsd } : {}),
      ...(persistedLoopTokens !== undefined ? { tokens: persistedLoopTokens } : {}),
      ...(finalizeDeclaredFields !== undefined ? { declaredFields: finalizeDeclaredFields } : {}),
      ...(finalizeStructured !== null ? { structuredOutput: finalizeStructured } : {}),
    };
  }

  // Resolve the iteration prompt source once per run/node. The interactive gate
  // persists the resolved template (`commandSnapshot` in the pause context) for
  // both inline and command-backed loops. Included loops retain their command identity
  // plus a load-time compiled prompt/error; rediscovery after a pause cannot change their
  // running prompt because a persisted snapshot takes precedence over that metadata.
  // The schema guarantees exactly one of prompt/command is defined.
  let loopPromptTemplate: string;
  if (isLoopResume && typeof loopGateMeta?.commandSnapshot === 'string') {
    loopPromptTemplate = loopGateMeta.commandSnapshot;
  } else if (typeof loop.command === 'string') {
    const compiled = (loop as typeof loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND];
    const hasCompiledError = compiled !== undefined && typeof compiled.error === 'string';
    const hasCompiledPrompt = compiled !== undefined && typeof compiled.prompt === 'string';
    if (hasCompiledError && !hasCompiledPrompt) {
      getLog().error(
        { nodeId: node.id, command: loop.command, error: compiled.error },
        'loop_node.command_compilation_failed'
      );
      return failLoopNode(compiled.error, { data: { command: loop.command } });
    }
    if (hasCompiledPrompt && !hasCompiledError) {
      loopPromptTemplate = compiled.prompt;
    } else if (compiled !== undefined) {
      const errorMsg = `Loop node '${node.id}' has malformed compiled command metadata for '${loop.command}' — expected exactly one string prompt or error.`;
      getLog().error(
        { nodeId: node.id, command: loop.command, compiled },
        'loop_node.command_compilation_metadata_invalid'
      );
      return failLoopNode(errorMsg, { data: { command: loop.command } });
    } else {
      const promptResult = await loadCommandPrompt(
        deps,
        cwd,
        loop.command,
        configuredCommandFolder,
        workflowSourceRoots
      );
      if (!promptResult.success) {
        getLog().error(
          { nodeId: node.id, command: loop.command, error: promptResult.message },
          'loop_node.command_load_failed'
        );
        return failLoopNode(promptResult.message, { data: { command: loop.command } });
      }
      loopPromptTemplate = promptResult.content;
    }
  } else if (typeof loop.prompt === 'string') {
    loopPromptTemplate = loop.prompt;
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
  let loopTotalCostUsd: number | undefined = persistedLoopCostUsd;
  let loopFinalStopReason: string | undefined;
  let loopTotalNumTurns: number | undefined;
  let loopTotalTokens: TokenUsage | undefined = persistedLoopTokens;
  // Concrete model the provider resolved to (#2314). Last-seen wins, like
  // loopFinalStopReason: every iteration runs on the same resolved provider and
  // model, so the final iteration's report is the node's report.
  let loopResolvedModel: ResolvedModel | undefined;
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

    // Stream AI response for this iteration.
    //
    // ── Structured-output attempts (#2563) ──────────────────────────────────
    // When the node declares `output_format`, an iteration is one or more STREAM
    // ATTEMPTS: the payload is validated against the schema, and on a best-effort
    // provider (Pi/Copilot) a miss is re-asked with the schema errors appended, up
    // to STRUCTURED_OUTPUT_MAX_REASKS. This mirrors executeNodeInternal's contract
    // exactly, deliberately — a loop should not be the one node type where a
    // structured miss behaves differently. Exhaustion FAILS the node; it is never
    // treated as "not complete yet", which would be the silent degradation the
    // engine refuses everywhere else.
    //
    // Without `output_format` there is exactly one attempt and this reads as before.
    // State the post-attempt code needs is declared out here; state that must start
    // clean on each attempt is reset at the top of the loop.
    let fullOutput = ''; // raw, for signal detection
    let cleanOutput = ''; // stripped, for platform display
    let iterationIdleTimedOut = false;
    let iterationAbortController = new AbortController();
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
    let backgroundTasks = createBackgroundTaskTracker();
    let iterationCost: number | undefined;
    let iterationTokens: TokenUsage | undefined;
    let iterationNumTurns: number | undefined;
    // Fold the last-seen per-attempt values into the loop totals exactly once per
    // ATTEMPT — called on both the normal exit and the catch path (an SDK-error
    // result still carries the attempt's cost, which the totals reported on the
    // failure return must include, matching the old += behavior). Reaskedattempts
    // each fold their own cost, so an exhausted iteration reports what it spent.
    let iterationUsageFolded = false;
    const foldIterationUsage = (): void => {
      if (iterationUsageFolded) return;
      iterationUsageFolded = true;
      if (iterationCost !== undefined) {
        loopTotalCostUsd = (loopTotalCostUsd ?? 0) + iterationCost;
      }
      if (iterationTokens !== undefined) {
        loopTotalTokens = sumTokenUsage(
          [...(loopTotalTokens !== undefined ? [loopTotalTokens] : []), iterationTokens],
          { nodeId: node.id }
        );
      }
      if (iterationNumTurns !== undefined) {
        loopTotalNumTurns = (loopTotalNumTurns ?? 0) + iterationNumTurns;
      }
    };

    // Structured payload accepted for THIS iteration (validated). Undefined when
    // the node declares no `output_format`.
    let iterationPayload: unknown;
    // Raw structured payload seen on the current attempt, before validation.
    let attemptStructured: unknown;
    let reaskAttempt = 0;
    let reaskErrors: string[] = [];
    const wantsStructured = resolvedOptions?.outputFormat !== undefined;
    const maxReasks =
      wantsStructured &&
      getProviderCapabilities(workflowProvider).structuredOutput === 'best-effort'
        ? STRUCTURED_OUTPUT_MAX_REASKS
        : 0;

    attempts: while (true) {
      // Per-attempt reset. A reask re-runs the stream, so anything the stream
      // accumulates or aborts must start clean or a prior attempt's prose would
      // leak into this one's output and signal detection.
      fullOutput = '';
      cleanOutput = '';
      iterationIdleTimedOut = false;
      streamStopStatus = undefined;
      attemptStructured = undefined;
      iterationAbortController = new AbortController();
      backgroundTasks = createBackgroundTaskTracker();
      lastStreamStatusCheckAt = Date.now();
      iterationCost = undefined;
      iterationTokens = undefined;
      iterationNumTurns = undefined;
      iterationUsageFolded = false;

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
          i === startIteration ? '' : lastIterationOutput,
          { stateDir, inputs: resolveRunInputs(workflowRun) }
        );
        const basePrompt = substituteNodeOutputRefs(substitutedPrompt, nodeOutputs);
        // A reask re-runs this iteration's prompt with the schema errors appended, so
        // the model is told WHAT was wrong rather than silently asked again.
        const finalPrompt =
          reaskAttempt === 0
            ? basePrompt
            : `${basePrompt}\n\n---\n\nYour previous response did not match the required output schema:\n${reaskErrors.map(e => `- ${e}`).join('\n')}\n\nRespond again with output that satisfies the schema exactly.`;

        const iterationOptions: SendQueryOptions | undefined = {
          ...resolvedOptions,
          abortSignal: iterationAbortController.signal,
        };

        // Reask attempts start a FRESH session (mirrors runStreamPass in
        // executeNodeInternal) so an invalid turn is not carried forward as context.
        const generator = aiClient.sendQuery(
          finalPrompt,
          cwd,
          reaskAttempt === 0 ? resumeSessionId : undefined,
          iterationOptions
        );
        const runningTools = new Map<string, RunningTool>();
        let anonymousToolSequence = 0;
        let lastAnonymousToolCallId: string | undefined;

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
            // A terminal result closes every outstanding lifecycle.
            for (const [toolCallId, prevTool] of runningTools) {
              getWorkflowEventEmitter().emit({
                type: 'tool_completed',
                runId: workflowRun.id,
                toolName: prevTool.toolName,
                stepName: node.id,
                durationMs: Date.now() - prevTool.startedAt,
                toolCallId,
                toolOutcome: 'unknown',
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'tool_completed',
                  step_name: stepName,
                  data: {
                    tool_name: prevTool.toolName,
                    duration_ms: Date.now() - prevTool.startedAt,
                    tool_call_id: toolCallId,
                    tool_outcome: 'unknown',
                  },
                })
                .catch((err: Error) => {
                  logEventStoreError(err, i);
                });
              runningTools.delete(toolCallId);
            }
            // Session threading follows attempt 0 ONLY (#2563). A reask deliberately
            // runs in a throwaway session so an invalid turn is not carried forward as
            // context — which makes that session the wrong thing to thread the NEXT
            // iteration from: it holds one repaired turn and none of the run's history,
            // so adopting it would silently discard iterations 1…N and break the
            // `fresh_context: false` contract ("each iteration resumes the prior
            // conversation"). Attempt 0's session is the loop's conversation and stays
            // the thread; the repaired answer still reaches the next iteration through
            // $LOOP_PREV_OUTPUT, which is prompt text rather than session state.
            if (msg.sessionId) {
              if (reaskAttempt === 0) {
                currentSessionId = msg.sessionId;
              } else if (currentSessionId !== msg.sessionId) {
                getLog().debug(
                  {
                    nodeId: node.id,
                    iteration: i,
                    attempt: reaskAttempt,
                    keptSessionId: currentSessionId,
                  },
                  'loop_node.reask_session_not_threaded'
                );
              }
            }
            // Overwrite, don't accumulate — a later result in the same iteration
            // (background-task wait, #2083) carries session-cumulative values.
            if (msg.cost !== undefined) {
              if (Number.isFinite(msg.cost)) {
                iterationCost = msg.cost;
              } else {
                getLog().warn(
                  { nodeId: node.id, iteration: i, costUsd: msg.cost },
                  'loop_node.usage_cost_non_finite_ignored'
                );
              }
            }
            if (msg.tokens !== undefined) {
              iterationTokens = sumTokenUsage([msg.tokens], {
                nodeId: node.id,
                iteration: i,
              });
            }
            if (msg.stopReason !== undefined) loopFinalStopReason = msg.stopReason;
            if (msg.numTurns !== undefined) {
              iterationNumTurns = msg.numTurns;
            }
            // Unconditional, for the same reason as the AI-node path above: a later
            // iteration or result chunk that reports no resolved model must clear the
            // previous one rather than leave it to be recorded as this node's answer.
            loopResolvedModel = msg.resolvedModel;
            if (msg.structuredOutput !== undefined) {
              attemptStructured = msg.structuredOutput;
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
            const toolCallId = msg.toolCallId ?? `anonymous-${String(++anonymousToolSequence)}`;

            // Providers without stable IDs report sequential tool calls. Preserve their
            // legacy boundary while allowing identified calls to overlap.
            const previousTool = lastAnonymousToolCallId
              ? runningTools.get(lastAnonymousToolCallId)
              : undefined;
            if (previousTool && lastAnonymousToolCallId !== undefined) {
              getWorkflowEventEmitter().emit({
                type: 'tool_completed',
                runId: workflowRun.id,
                toolName: previousTool.toolName,
                stepName: node.id,
                durationMs: now - previousTool.startedAt,
                toolCallId: lastAnonymousToolCallId,
                toolOutcome: 'unknown',
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'tool_completed',
                  step_name: stepName,
                  data: {
                    tool_name: previousTool.toolName,
                    duration_ms: now - previousTool.startedAt,
                    tool_call_id: lastAnonymousToolCallId,
                    tool_outcome: 'unknown',
                  },
                })
                .catch((err: Error) => {
                  logEventStoreError(err, i);
                });
              runningTools.delete(lastAnonymousToolCallId);
            }
            runningTools.set(toolCallId, { toolName: msg.toolName, startedAt: now });
            if (!msg.toolCallId) lastAnonymousToolCallId = toolCallId;

            // Emit tool_started for the current tool (fire-and-forget)
            getWorkflowEventEmitter().emit({
              type: 'tool_started',
              runId: workflowRun.id,
              toolName: msg.toolName,
              stepName: node.id,
              toolCallId,
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
                data: {
                  tool_name: msg.toolName,
                  tool_input: toolInput,
                  tool_call_id: toolCallId,
                },
              })
              .catch((err: Error) => {
                logEventStoreError(err, i);
              });
          } else if (msg.type === 'tool_result' && msg.toolName) {
            const now = Date.now();
            const completedTool = findRunningTool(runningTools, msg.toolName, msg.toolCallId);
            if (completedTool) {
              const [completedToolCallId, tool] = completedTool;
              getWorkflowEventEmitter().emit({
                type: 'tool_completed',
                runId: workflowRun.id,
                toolName: tool.toolName,
                stepName: node.id,
                durationMs: now - tool.startedAt,
                toolCallId: completedToolCallId,
                ...(msg.toolOutcome !== undefined ? { toolOutcome: msg.toolOutcome } : {}),
                ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
              });
              deps.store
                .createWorkflowEvent({
                  workflow_run_id: workflowRun.id,
                  event_type: 'tool_completed',
                  step_name: stepName,
                  data: {
                    tool_name: tool.toolName,
                    duration_ms: now - tool.startedAt,
                    tool_call_id: completedToolCallId,
                    ...(msg.toolOutcome !== undefined ? { tool_outcome: msg.toolOutcome } : {}),
                    ...(msg.exitCode !== undefined ? { exit_code: msg.exitCode } : {}),
                  },
                })
                .catch((err: Error) => {
                  logEventStoreError(err, i);
                });
              runningTools.delete(completedToolCallId);
              if (completedToolCallId === lastAnonymousToolCallId) {
                lastAnonymousToolCallId = undefined;
              }
            }
            if (platform.sendStructuredEvent) {
              await platform.sendStructuredEvent(conversationId, msg);
            }
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
      //
      // A structured payload is also exempt (#2563), matching executeNodeInternal's
      // `nodeOutputText === '' && structuredOutput === undefined` guard: with
      // grammar-constrained decoding the assistant prose is routinely EMPTY because
      // the whole answer arrived as the payload. Failing that would make every
      // Claude/Codex structured loop fail on iteration 1.
      if (!iterationIdleTimedOut && fullOutput.trim() === '' && attemptStructured === undefined) {
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

      // ── Structured-output gate for this attempt ───────────────────────────
      // No `output_format` declared: one attempt, nothing to validate.
      if (!wantsStructured) break attempts;

      // An idle timeout or a user abort is a genuine failure, not a validation
      // miss — never spend a reask on it (mirrors executeNodeInternal's canReask).
      const canReask =
        reaskAttempt < maxReasks &&
        !iterationIdleTimedOut &&
        !iterationAbortController.signal.aborted;

      if (attemptStructured !== undefined) {
        // Validate against the declared schema for EVERY provider — an SDK-enforced
        // one still bypasses grammar-constrained decoding on a refusal or a
        // max_tokens truncation. Fail-SAFE on an uncompilable schema, but say so.
        let schemaCompileError: string | undefined;
        const validation = validateStructuredOutput(
          attemptStructured,
          node.output_format ?? {},
          compileMsg => {
            schemaCompileError = compileMsg;
          }
        );
        if (schemaCompileError !== undefined) {
          getLog().warn(
            {
              nodeId: node.id,
              workflowRunId: workflowRun.id,
              iteration: i,
              compileMsg: schemaCompileError,
            },
            'loop_node.structured_output_schema_uncompilable'
          );
          await safeSendMessage(
            platform,
            conversationId,
            `⚠️ Loop \`${node.id}\`: its \`output_format\` schema could not be compiled (${schemaCompileError}), so the iteration output was NOT validated against it. Fix the schema to enforce it.`,
            msgContext
          );
        }
        if (validation.valid) {
          iterationPayload = attemptStructured;
          break attempts;
        }
        getLog().warn(
          {
            nodeId: node.id,
            workflowRunId: workflowRun.id,
            iteration: i,
            attempt: reaskAttempt,
            errors: validation.errors,
          },
          'loop_node.structured_output_invalid'
        );
        if (canReask) {
          reaskAttempt++;
          reaskErrors = validation.errors;
          await safeSendMessage(
            platform,
            conversationId,
            `⚠️ Loop \`${node.id}\` iteration ${String(i)}: structured output failed schema validation, re-asking (${String(reaskAttempt)}/${String(maxReasks)}).`,
            msgContext
          );
          continue attempts;
        }
        return await failLoopNode(
          `Loop node '${node.id}' iteration ${String(i)}: output_format declared but the provider's structured output failed schema validation: ${validation.errors.join('; ')}`,
          {
            output: lastIterationOutput,
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            loopIterations: i,
            data: { iteration: i },
          }
        );
      }

      // No structured payload at all (prose / refusal / parse miss / timeout).
      getLog().warn(
        { nodeId: node.id, workflowRunId: workflowRun.id, iteration: i },
        'loop_node.structured_output_missing'
      );
      if (canReask) {
        reaskAttempt++;
        reaskErrors = ['no JSON object was found in the response'];
        continue attempts;
      }
      // Report the real cause: a timeout produces no payload either, and calling
      // that "the model replied with prose" would send the author down the wrong path.
      return await failLoopNode(
        iterationIdleTimedOut
          ? `Loop node '${node.id}' iteration ${String(i)}: timed out before producing the required structured output.`
          : `Loop node '${node.id}' iteration ${String(i)}: output_format declared but the provider returned no schema-valid structured output. The model likely replied with prose, refused, or emitted unparseable JSON.`,
        {
          output: lastIterationOutput,
          costUsd: loopTotalCostUsd,
          ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
          loopIterations: i,
          data: { iteration: i },
        }
      );
    }

    // The iteration's accepted payload, serialized. With `output_format` this — not
    // the prose — is the node's output, so `$loop.output.field`, `$LOOP_PREV_OUTPUT`
    // and the gate excerpt all read the same validated value (mirrors the AI node).
    let structuredText: string | undefined;
    if (iterationPayload !== undefined) {
      try {
        structuredText = canonicalValueText(iterationPayload);
      } catch (serializeErr) {
        const err = serializeErr as Error;
        return await failLoopNode(
          `Loop node '${node.id}': failed to serialize structured_output to JSON: ${err.message}`,
          {
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            loopIterations: i,
            data: { iteration: i },
          }
        );
      }
      lastIterationStructuredOutput = iterationPayload;
    }

    // Batch mode: send accumulated output
    const batchContent = structuredText ?? cleanOutput;
    if (platform.getStreamingMode() === 'batch' && batchContent) {
      await safeSendMessage(platform, conversationId, batchContent, msgContext);
    }

    const prevIterationOutput = lastIterationOutput;
    lastIterationOutput = structuredText ?? (cleanOutput || fullOutput);

    // ── Completion channels, cheapest first ───────────────────────────────────
    // `until_field` (#2563): the validated payload's declared boolean. Strict
    // identity — no truthiness, no "true", no 1. The load-time rules guarantee the
    // property is declared, required and boolean, so a schema-valid payload always
    // carries a real boolean here and `false` unambiguously means "keep going".
    const fieldComplete =
      loop.until_field !== undefined &&
      iterationPayload !== null &&
      typeof iterationPayload === 'object' &&
      (iterationPayload as Record<string, unknown>)[loop.until_field] === true;

    // Check LLM completion signal — the AI decides whether the user approved.
    // For interactive loops, the AI emits the signal when the user explicitly approves
    // (e.g., "approved", "looks good"). The prompt instructs the AI on when to emit it.
    //
    // `until` is optional (#2563): a loop that declared only `until_bash` has no prose
    // path at all, so never call detectCompletionSignal with an undefined signal — its
    // regexes would be built from the empty string and match anything.
    //
    // Detection reads the prose AND the serialized payload. With grammar-constrained
    // decoding the prose is routinely empty, so a loop declaring both `until:` and
    // `output_format` would otherwise have a signal channel that could never fire —
    // silently, which is the failure mode this issue exists to remove.
    //
    // TWO independent calls, never one concatenated haystack. `detectCompletionSignal`
    // supports a sentinel "at the very end of output", and that pattern is anchored
    // with `$` and NO `m` flag (see executor-shared.ts). Appending the payload moves
    // the end of the string past the prose — and an object payload always ends in
    // `}` — so concatenating silently kills the documented inline end-of-output form
    // for every loop that declares a schema. (The own-line and `<promise>` forms
    // survive it, which is exactly why it is easy to miss.) Checking each haystack
    // separately preserves each one's own anchor.
    const signalDetected =
      loop.until !== undefined &&
      (detectCompletionSignal(fullOutput, loop.until) ||
        (structuredText !== undefined && detectCompletionSignal(structuredText, loop.until)));

    // Check deterministic bash condition (if configured). Skipped once a cheaper
    // channel already completed this iteration: completion is an OR, so the outcome
    // cannot change, and running a side-effecting script an extra time can. This
    // matches executeLoopGroupNode's identical guard — the two variants disagreed
    // until #2563; do not "fix" the asymmetry back.
    let bashComplete = false;
    if (loop.until_bash && !signalDetected && !fieldComplete) {
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
          { shellSafe: true, stateDir }
        );
        const substitutedBash = substituteNodeOutputRefs(
          bashPrompt,
          nodeOutputs,
          true, // escapedForBash
          artifactsDir
        );
        await runSubprocess(execContext, loopBashPath, ['-c', substitutedBash], {
          cwd,
          timeout: SUBPROCESS_DEFAULT_TIMEOUT,
          protectedEnvKeys: config.protectedEnvKeys,
          protectedCredentialValues: config.protectedCredentialValues,
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

    const completionChecks: LoopCompletionCheck[] = [];
    if (loop.until_field !== undefined) {
      completionChecks.push({
        channel: 'until_field',
        field: loop.until_field,
        completed: fieldComplete,
      });
    }
    if (loop.until !== undefined) {
      completionChecks.push({ channel: 'until', signal: loop.until, completed: signalDetected });
    }
    if (loop.until_bash !== undefined) {
      completionChecks.push({ channel: 'until_bash', completed: bashComplete });
    }

    const duration = Date.now() - iterationStart;
    const completionDetected = completionChecks.some(check => check.completed);

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

    // A completion channel fired — exit the loop.
    // For interactive loops: only honor completion when the AI had user input to evaluate
    // (i.e., this is a resume iteration with loopUserInput). On the first iteration of a
    // fresh interactive loop, the user hasn't seen anything yet — always gate first,
    // UNLESS the author opted into autonomous completion via signal_completes (#2074).
    // For non-interactive loops: any declared channel can complete the iteration.
    const interactiveFirstRun = loop.interactive && !isLoopResume;
    const signalCompletes = loop.signal_completes === true;
    if (completionDetected && (!interactiveFirstRun || signalCompletes)) {
      if (currentSessionId !== undefined) {
        await checkpointSession?.(currentSessionId);
      }
      await safeSendMessage(
        platform,
        conversationId,
        `Loop node '${node.id}' completed after ${String(i)} iteration${i > 1 ? 's' : ''}`,
        msgContext
      );
      // Write node_completed event so resume hydration knows this
      // node is done. Without this, a resumed DAG would re-enter the loop node.
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'node_completed',
          step_name: stepName,
          data: {
            duration_ms: Date.now() - iterationStart,
            node_output: lastIterationOutput,
            // The completing iteration's logical payload (#2637) — mirrors the
            // prompt/command emit so cold resume keeps typed field access.
            ...(lastIterationStructuredOutput !== undefined
              ? { structured_output: lastIterationStructuredOutput }
              : {}),
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTotalCostUsd !== undefined ? { cost_usd: loopTotalCostUsd } : {}),
            ...(loopFinalStopReason ? { stop_reason: loopFinalStopReason } : {}),
            ...(loopTotalNumTurns !== undefined ? { num_turns: loopTotalNumTurns } : {}),
            // Requested alias vs the model the provider actually ran (#2314) —
            // mirrors the AI-node path. Omitted entirely when the provider
            // reports no resolved model (e.g. Codex), never faked.
            ...(loopResolvedModel
              ? { model_usage: { requested: resolvedModel, resolved: loopResolvedModel.id } }
              : {}),
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
      // Declared field set, so a downstream `$loop.output.field` gets the same
      // strict contract every other producer enforces: a field not in the schema
      // fails the consumer, a declared-optional absent one resolves to ''. Only
      // present when `output_format` declares an object with `properties` (#2563).
      const loopDeclaredFields = declaredFieldsFromSchema(node.output_format);
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
        ...(loopDeclaredFields !== undefined ? { declaredFields: loopDeclaredFields } : {}),
      };
    }

    // Interactive loop gate — pause after an iteration that did not complete (or, when
    // interactiveFirstRun && !signalCompletes, an iteration that DID complete — the honest
    // status line + persisted completion state (#2074) let a bare approve finalize it).
    // On a non-completing gate, the user's feedback feeds the next iteration, which exits
    // above once any declared completion channel fires.
    if (loop.interactive && loop.gate_message) {
      const honestMessage = buildHonestGateMessage(
        completionChecks,
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
        // null = this pause has no session to restore.
        sessionId: currentSessionId ?? null,
        // Signal state for finalize-on-bare-approve (#2074). The structured payload
        // rides along (#2637) so the finalize attaches it like a natural completion.
        completionSignaled: completionDetected,
        signaledOutput: completionDetected ? lastIterationOutput : null,
        signaledStructuredOutput: completionDetected
          ? (lastIterationStructuredOutput ?? null)
          : null,
        // Cumulative usage consumed through this gate. A resumed loop seeds its
        // totals from these values so later gates and terminal metadata preserve
        // every pre-gate iteration; bare approval uses the same values directly.
        signaledTokens: loopTotalTokens ?? null,
        signaledCostUsd: loopTotalCostUsd ?? null,
        // Read-once resolved template for both prompt- and command-backed loops.
        // Included command-backed loops use their load-time compiled body here, so
        // snapshotting both forms preserves resume determinism after source deletion.
        commandSnapshot: loopPromptTemplate,
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
  const errorMsg = `Loop node '${node.id}' exceeded max iterations (${String(loop.max_iterations)}) ${describeUnmetCompletion(loop)}`;
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
 * Pause the run for a human/system gate — the single persist path for all five
 * suspend sites (`loop_group`, `loop`, `approval`, `workflow:` child, and the
 * container write-back gate). By default, tolerates a lost CAS when the run
 * was externally transitioned while the gate was being raised — e.g. a killed
 * CLI's signal cleanup marked the run failed mid-pause (#1123), or an operator
 * cancelled it from another surface. `pauseWorkflowRun`'s UPDATE only matches
 * status='running'; when it misses, re-read the status: any non-running status
 * means the pause lost a legitimate external race — log, skip the
 * approval_pending emit, and return `false` so the caller's normal
 * completed-shaped output lets the between-layer status check halt the DAG
 * cleanly (the same path a successful pause takes). On a successful pause, the
 * approval_pending live signal is emitted HERE (from the ApprovalContext's own
 * nodeId/message) so no call site can accidentally emit it after a lost CAS. A
 * store error while the run is still 'running' is a genuine pause failure and
 * rethrows.
 *
 * `options.failClosed` inverts the CAS-tolerance for a caller that must never
 * treat a lost pause as anything but a genuine failure — used by the container
 * write-back gate, where a lost pause must never fall through toward the
 * apply/teardown path (throwing is the safe behavior; the H2 teardown-preserve
 * logic keeps the overlay volume for a retry). `options.extraMetadata` is
 * forwarded verbatim to `pauseWorkflowRun`'s third argument (the write-back
 * gate's `pending_writeback` marker, folded into the same atomic write).
 *
 * Returns whether the pause actually persisted (`true`) or was skipped due to
 * a tolerated lost CAS (`false`) — callers with a post-pause side effect (e.g.
 * notifying a user) should gate it on this so a skipped pause stays silent.
 */
async function pauseGateRespectingExternalTransition(
  deps: WorkflowDeps,
  runId: string,
  approvalContext: ApprovalContext,
  options: { extraMetadata?: Record<string, unknown>; failClosed?: boolean } = {}
): Promise<boolean> {
  const { extraMetadata, failClosed = false } = options;
  try {
    await deps.store.pauseWorkflowRun(runId, approvalContext, extraMetadata);
  } catch (pauseErr) {
    if (failClosed) throw pauseErr;
    let status: WorkflowRunStatus | null;
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
    return false;
  }
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId,
    nodeId: approvalContext.nodeId,
    message: approvalContext.message,
  });
  return true;
}

/** Execute a durable wait without holding a subprocess or provider slot. */
interface WaitLoopOwner {
  groupId: string;
  iteration: number;
  sessionId: string | null;
  sessionProvider: string | null;
}

async function executeWaitNode(
  node: WaitNode,
  workflowRun: WorkflowRun,
  deps: WorkflowDeps,
  nodeOutputs: Map<string, NodeOutput>,
  stepNamePrefix = '',
  loopOwner?: WaitLoopOwner
): Promise<NodeOutput> {
  const now = new Date();
  const rawPersisted = workflowRun.metadata?.wait;
  const persisted =
    isWorkflowWaitContext(rawPersisted) &&
    (loopOwner === undefined
      ? rawPersisted.owner === 'node' && rawPersisted.nodeId === node.id
      : rawPersisted.owner === 'loop_group' &&
        rawPersisted.nodeId === loopOwner.groupId &&
        rawPersisted.bodyWaitId === node.id &&
        rawPersisted.iteration === loopOwner.iteration)
      ? rawPersisted
      : undefined;

  const owner =
    loopOwner === undefined
      ? ({ owner: 'node', nodeId: node.id } as const)
      : ({
          owner: 'loop_group',
          nodeId: loopOwner.groupId,
          bodyWaitId: node.id,
          iteration: loopOwner.iteration,
          sessionId: loopOwner.sessionId,
          sessionProvider: loopOwner.sessionProvider,
        } as const);
  const condition = waitCondition(node.wait);
  let context: WorkflowWaitContext;
  if (persisted !== undefined) {
    context = persisted;
  } else if (condition.kind === 'duration') {
    context = {
      ...owner,
      kind: 'time',
      waitingSince: now.toISOString(),
      resumeAt: new Date(now.getTime() + condition.durationMs).toISOString(),
    };
  } else if (condition.kind === 'until') {
    const inputsName = parseWholeInputsRef(condition.timestamp);
    let rawUntil = condition.timestamp;
    if (inputsName !== undefined) {
      const runInputs = resolveRunInputs(workflowRun);
      if (!runInputs || !Object.hasOwn(runInputs, inputsName)) {
        throw new Error(`Wait node '${node.id}' references unknown input '$INPUTS.${inputsName}'`);
      }
      rawUntil = canonicalValueText(runInputs[inputsName]);
    }
    const rendered = substituteNodeOutputRefs(rawUntil, nodeOutputs);
    if (!waitUntilTimestampSchema.safeParse(rendered).success) {
      throw new Error(
        `Wait node '${node.id}' has an invalid 'until' timestamp after substitution: '${rendered}'`
      );
    }
    const resumeAtMs = Date.parse(rendered);
    context = {
      ...owner,
      kind: 'time',
      waitingSince: now.toISOString(),
      resumeAt: new Date(resumeAtMs).toISOString(),
    };
  } else {
    const event = substituteNodeOutputRefs(
      substituteInputRefs(condition.event, resolveRunInputs(workflowRun)),
      nodeOutputs
    ).trim();
    if (event === '') {
      throw new Error(`Wait node '${node.id}' resolved 'event' to an empty string`);
    }
    context = {
      ...owner,
      kind: 'event',
      event,
      waitingSince: now.toISOString(),
      resumeAt: new Date(now.getTime() + condition.deadlineMs).toISOString(),
    };
  }

  const resumeAtMs = Date.parse(context.resumeAt);
  const isSignaled = context.kind === 'event' && context.signaledAt !== undefined;
  const isDue = now.getTime() >= resumeAtMs;
  if (!isSignaled && !isDue) {
    try {
      await deps.store.pauseWorkflowRunForWait(
        workflowRun.id,
        context,
        persisted === undefined
          ? { kind: 'started', stepName: stepNamePrefix + node.id }
          : { kind: 'continued' }
      );
    } catch (pauseError) {
      const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
      if (status === 'running') throw pauseError;
      getLog().warn(
        { workflowRunId: workflowRun.id, nodeId: node.id, status: status ?? 'deleted' },
        'dag.wait_pause_skipped_external_transition'
      );
    }
    return { state: 'completed', output: '' };
  }

  const status = context.kind === 'event' && !isSignaled ? 'expired' : 'satisfied';
  const result = {
    status,
    waited_ms: Math.max(0, now.getTime() - Date.parse(context.waitingSince)),
    ...(context.kind === 'event'
      ? {
          event: context.event,
          ...(context.payload !== undefined ? { payload: context.payload } : {}),
        }
      : {}),
  } as const;
  const output = JSON.stringify(result);
  const stepName = stepNamePrefix + node.id;
  if (persisted !== undefined) {
    const { cleared } = await deps.store.clearWorkflowWaitContext(workflowRun.id, context, {
      stepName,
      result,
    });
    if (!cleared) {
      throw new Error(`Wait node '${node.id}' lost ownership of its persisted wait cursor`);
    }
  } else {
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: status === 'expired' ? 'wait_expired' : 'wait_completed',
      step_name: stepName,
      data: result,
    });
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_completed',
      step_name: stepName,
      data: {
        type: 'wait',
        duration_ms: result.waited_ms,
        node_output: output,
        structured_output: result,
      },
    });
  }
  getWorkflowEventEmitter().emit({
    type: 'node_completed',
    runId: workflowRun.id,
    nodeId: node.id,
    nodeName: node.id,
    duration: result.waited_ms,
  });
  return {
    state: 'completed',
    output,
    structuredOutput: result,
    declaredFields: declaredFieldsFromSchema(WAIT_NODE_OUTPUT_FORMAT),
  };
}

/**
 * Execute an approval node — pauses workflow for human review.
 * On rejection resume (when on_reject is configured): runs the on_reject prompt via AI,
 * then re-pauses at the approval gate. After max_attempts rejections, cancels normally.
 */
async function executeApprovalNode(
  node: GateNode,
  workflowRun: WorkflowRun,
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowProvider: string,
  workflowModel: string | undefined,
  cwd: string,
  artifactsDir: string,
  stateDir: string,
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
  execContext: ExecutionContext = { kind: 'host' },
  /** Forwarded to the synthetic `on_reject` node; see RunLayersContext. */
  workflowSourceRoots?: WorkflowSourceRoots,
  /** Invoked beside the synthetic `on_reject` node's `node_started` write (#1961). */
  chargeWorkUnit?: () => void
): Promise<NodeOutput> {
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;

  // Detect rejection resume — check metadata for rejection_reason set by reject handlers.
  // Strict `=== 'approval'` excludes `undefined`: a pre-#936 run paused before the
  // `type` field existed and rejected-with-rework would stage a rework
  // `rejectWorkflow` treats as equivalent to `type: 'approval'` but this check
  // won't recognize — legacy-only, pre-existing, not touched by #2489.
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

  // On rejection resume with a rework continuation configured: run its prompt via AI
  const rejectDecision = node.decisions.find(d => d.id === 'reject');
  const rework = rejectDecision?.rework;
  if (rejectionReason !== '' && rework) {
    const maxAttempts = rework.maxAttempts ?? 3;
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

    // Run the rework prompt via AI
    const { prompt: substitutedPrompt } = substituteWorkflowVariables(
      rework.prompt,
      workflowRun.id,
      workflowRun.user_message ?? '',
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      undefined, // loopUserInput
      rejectionReason,
      undefined, // loopPrevOutput
      { stateDir, inputs: resolveRunInputs(workflowRun) }
    );

    // Build a synthetic PromptNode to reuse executeNodeInternal.
    // Use a distinct ID so the node_completed event written by executeNodeInternal
    // does not collide with the approval gate's own ID in the resume snapshot.
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
    const syntheticNode: AgentNode = {
      id: `${node.id}:on_reject`,
      kind: 'agent',
      source: { kind: 'inline', prompt: substituteNodeOutputRefs(substitutedPrompt, nodeOutputs) },
      ...(node.depends_on ? { depends_on: node.depends_on } : {}),
      ...(node.idle_timeout ? { idle_timeout: node.idle_timeout } : {}),
    };

    const {
      provider,
      model: resolvedNodeModel,
      options: nodeOptions,
      tier: resolvedTier,
      effort: resolvedEffort,
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
      // Engine-synthesised from `approval.on_reject.prompt` alone — it carries no
      // systemPrompt/agents, so there is no AI-configuration text to resolve.
      text => text,
      // Also carries no `model:`, so it cannot raise a provider conflict to de-duplicate.
      undefined,
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
      stateDir,
      logDir,
      baseBranch,
      docsDir,
      nodeOutputs,
      undefined, // fresh session
      configuredCommandFolder,
      issueContext,
      resolvedNodeModel,
      resolvedTier,
      resolvedEffort,
      stepNamePrefix,
      iteration,
      undefined, // synthetic on_reject node never carries a session checkpoint
      workflowSourceRoots,
      chargeWorkUnit
    );

    if (output.state === 'failed') {
      return output;
    }
    // Fall through to re-pause at the approval gate
  }

  // Standard approval gate — send message and pause.
  // Resolve $nodeId.output[.field] references so the human sees concrete values
  // (parity with prompt/bash/loop/cancel nodes, which all run the same substitution).
  const renderedMessage = substituteNodeOutputRefs(node.message, nodeOutputs);
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
    captureResponse: node.captureResponse,
    onRejectPrompt: rework?.prompt,
    onRejectMaxAttempts: rework?.maxAttempts,
    decisions: node.decisions.map(d => ({
      id: d.id,
      ...(d.label !== undefined ? { label: d.label } : {}),
    })),
    decisionsAuthored: node.decisionsAuthored,
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
/**
 * The child's terminal LOGICAL value for `output_format` validation (#2774): prefer the
 * typed `structuredOutput` (#2637); fall back to parsing the text summary, and treat
 * non-JSON text as a raw string — which then correctly fails an object-typed schema,
 * since a string IS what the child returned.
 */
function subrunLogicalValue(outcome: ChildWorkflowOutcome): unknown {
  if (outcome.structuredOutput !== undefined) return outcome.structuredOutput;
  try {
    return JSON.parse(outcome.output ?? '') as unknown;
  } catch {
    return outcome.output ?? '';
  }
}

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
  const failResult = (
    error: string,
    costUsd?: number,
    tokens?: TokenUsage
  ): NodeExecutionResult => {
    deps.store
      .createWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'node_failed',
        step_name: ctx.stepNamePrefix + node.id,
        data: {
          error,
          type: 'workflow',
          ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
        },
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
    return {
      state: 'failed',
      output: '',
      error,
      // A child that burned tokens and then failed or was cancelled still spent that
      // money, and its own row now records it (#2469) — so carry it up rather than
      // dropping it here. The run-level aggregator reads `costUsd`/`tokens` off the
      // node result with no gate on `state`, and the fan-out sibling has taken these
      // for the same reason since #2224. Cost and tokens are supplied when a settled
      // child outcome is available; failure paths without an outcome omit them.
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
    };
  };

  if (!ctx.runChildWorkflow) {
    // Fail fast: executor.ts MUST inject the closure. A missing one means a caller
    // wired executeDagWorkflow without sub-run support — never silently no-op.
    return failResult(
      "Internal error: 'workflow:' node cannot run — runChildWorkflow closure was not injected."
    );
  }

  // Dynamic fan-out (slice 2, PR-C): a `fan_out:` node expands into N governed child
  // runs over a data-driven item list, joined into one node outcome. This is a
  // distinct execution path from the slice-1 single-child node below — branch here so
  // the 1:1 pause/resume machinery stays untouched for non-fan-out nodes.
  if (node.fan_out) {
    return executeFanOutWorkflowNode(node, ctx, node.fan_out, ctx.runChildWorkflow);
  }

  // This run's named inputs (#2470), resolved once — threaded identically into the
  // `input:` string and every `with:` value below.
  const parentInputs = resolveRunInputs(parentRun);

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
    ctx.issueContext,
    undefined, // loopUserInput
    undefined, // rejectionReason
    undefined, // loopPrevOutput
    // Thread the parent run's inputs so `$INPUTS.<name>` resolves in an `input:` string
    // exactly as it does in the sibling `with:` values below (a nested sub-run forwarding
    // a parent input into a grandchild's $ARGUMENTS). Without this the token would throw
    // "This run has no declared inputs" on a run that DOES have inputs (#2470 parity).
    { stateDir: ctx.stateDir, inputs: parentInputs }
  );
  const input = substituteNodeOutputRefs(substitutedInput, ctx.nodeOutputs);

  // Resolve the node's `with:` map (#2470/#2637) into concrete JSON values: a
  // non-string literal passes through with its logical type; a string that is exactly
  // one whole `$INPUTS.<name>` / `$node.output[.field]` ref resolves to the LOGICAL
  // value; any other string keeps the two-pass text-template path (workflow vars —
  // non-shellSafe: these become the child's `$INPUTS`, not shell source — then
  // `$node.output` refs). The result is persisted to the child's metadata at spawn
  // and reconstituted on cold resume. Throws on a bad ref exactly as the input
  // surface does — caught by the caller's try/catch → fail closed.
  const withResolutionCtx: ShellInputContext = {
    workflowRun: parentRun,
    artifactsDir: ctx.artifactsDir,
    stateDir: ctx.stateDir,
    baseBranch: ctx.baseBranch,
    docsDir: ctx.docsDir,
    issueContext: ctx.issueContext,
    nodeOutputs: ctx.nodeOutputs,
  };
  let resolvedInputs: Record<string, JsonValue> | undefined;
  if (node.with !== undefined) {
    resolvedInputs = {};
    for (const [name, rawValue] of Object.entries(node.with)) {
      resolvedInputs[name] = resolveWorkflowValue(rawValue, withResolutionCtx, parentInputs, false);
    }
  }

  // Producer's declared field set (only when output_format declares object
  // properties) so a downstream `$node.output.field` on a JSON-emitting child
  // resolves declared-optional-absent → '' vs a typo → throw.
  const declaredFields = declaredFieldsFromSchema(node.output_format);
  // Build the completed result AND write the node_completed event. Unlike
  // command/prompt/bash/script nodes (which write their own inside their executor)
  // and unlike approval nodes (written by the approve handler), the workflow node
  // writes node_completed HERE — and ONLY on true completion, never on the paused
  // branch — so the resume snapshot skips a truly-finished sub-run on resume
  // but re-runs one still blocked on its child.
  const asCompleted = (outcome: ChildWorkflowOutcome): NodeExecutionResult => {
    // Declared boundary contract (#2774): when the node declares `output_format`, the
    // child's terminal value must match it — a mismatch fails the node HERE, before any
    // node_completed row exists, so resume re-runs into the same named failure instead
    // of rehydrating an invalid "completed" payload. Mirrors the AI/loop structured-
    // output gates; no reask loop (a child rerun costs a full run and may have side
    // effects), one validation, one hard failure.
    let certifiedLogicalValue: unknown;
    let schemaCompiled = false;
    if (node.output_format) {
      const logicalValue = subrunLogicalValue(outcome);
      let schemaCompileError: string | undefined;
      const validation = validateStructuredOutput(logicalValue, node.output_format, compileMsg => {
        schemaCompileError = compileMsg;
      });
      if (schemaCompileError === undefined) {
        schemaCompiled = true;
        certifiedLogicalValue = logicalValue;
      } else {
        // Fail-safe on an uncompilable schema, same contract as the AI-node gate:
        // surface it loudly but never turn it into a spurious node failure.
        getLog().warn(
          { nodeId: node.id, workflowRunId: parentRun.id, compileMsg: schemaCompileError },
          'workflow.subrun_schema_uncompilable'
        );
        void safeSendMessage(
          platform,
          conversationId,
          `⚠️ Node '${node.id}': its \`output_format\` schema could not be compiled (${schemaCompileError}), so the sub-run '${node.workflow}' output was NOT validated against it. Fix the schema to enforce it.`,
          msgContext
        ).catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: parentRun.id, nodeId: node.id },
            'workflow.subrun_schema_warn_send_failed'
          );
        });
      }
      if (!validation.valid) {
        const errors = (validation.errors ?? ['value does not match the declared schema']).join(
          '; '
        );
        const received =
          logicalValue === null
            ? 'null'
            : Array.isArray(logicalValue)
              ? 'array'
              : typeof logicalValue;
        return failResult(
          `Node '${node.id}': sub-run '${node.workflow}' output does not match its declared output_format: ${errors}. Expected: ${JSON.stringify(node.output_format)}. Received: ${received}.`,
          outcome.costUsd,
          outcome.tokens
        );
      }
    }
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
          // The child's terminal logical value (#2637), so parent cold resume
          // rehydrates typed access to `$<node>.output.field`. When the child
          // carried no typed value but the output_format gate certified a parsed
          // one, persist THAT — otherwise an array-typed certified output would
          // pass its own gate yet stay unreadable downstream (parity with the
          // fan-out join's childElement fallback).
          ...(outcome.structuredOutput !== undefined
            ? { structured_output: outcome.structuredOutput }
            : schemaCompiled && certifiedLogicalValue !== outcome.output
              ? { structured_output: certifiedLogicalValue as JsonValue }
              : {}),
          ...(outcome.costUsd !== undefined ? { cost_usd: outcome.costUsd } : {}),
          // Rolled up from the child run's persisted totals, exactly like cost_usd —
          // tokens are the axis every provider reports (Codex reports no cost at all),
          // so dropping them here while keeping cost would hide the one comparable
          // number. Does not double count WITHIN this run: the child's own per-node
          // rows are filed under `child_run_id`, a different workflow_run_id.
          ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
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
      ...(outcome.structuredOutput !== undefined
        ? { structuredOutput: outcome.structuredOutput }
        : schemaCompiled && certifiedLogicalValue !== outcome.output
          ? { structuredOutput: certifiedLogicalValue }
          : {}),
      ...(declaredFields !== undefined ? { declaredFields } : {}),
    };
  };

  // Pause the PARENT "blocked on child" via the shared pause primitive — mirrors
  // executeApprovalNode's PAUSE primitives: pause, emit, return {completed, ''}
  // WITHOUT node_completed so the node re-runs on the parent's resume (the
  // resume snapshot reads only node_completed). The RESUME side deliberately
  // differs: an approval gate is resolved externally by the approve handler,
  // while this node re-runs and re-inspects its child. Also unlike the
  // approval node, no approval_requested workflow_event row is persisted here
  // — the block reason lives on the run itself (metadata.approval), and there
  // is no human decision to audit for a gate that resolves automatically on
  // child completion.
  const pauseParentOnChild = async (childRunId: string): Promise<NodeExecutionResult> => {
    // KNOWN LIMITATION (#2180): the run has a SINGLE approval-gate slot. If two
    // gate-pausing nodes (two `workflow:` children, or a `workflow:` + an `approval:`)
    // land in the SAME topological layer, the second pause attempt loses the CAS
    // (the first already flipped running→paused) — the shared helper tolerates this
    // the same way it does for every other gate type: skip silently, no message, no
    // node failure. The loser's child is real but unmentioned until a later resume
    // re-pauses on it. A retry can't fix this (there is nowhere to record a second
    // simultaneous block); the real fix is a gate queue or a load-time reject of
    // multiple gate-pausing nodes per layer — tracked in #2180.
    const message =
      `Sub-run \`${node.workflow}\` (run \`${childRunId.slice(0, 8)}\`) is paused awaiting review. ` +
      `Approve it by run id: \`/workflow approve ${childRunId}\``;
    const paused = await pauseGateRespectingExternalTransition(deps, parentRun.id, {
      message,
      nodeId: node.id,
      type: 'child_workflow',
      childRunId,
    });
    if (paused) {
      await safeSendMessage(
        platform,
        conversationId,
        `⏸ **Blocked on sub-run** \`${node.workflow}\`: ${message}`,
        msgContext
      );
    }
    return { state: 'completed', output: '' };
  };

  const interpret = async (outcome: ChildWorkflowOutcome): Promise<NodeExecutionResult> => {
    switch (outcome.status) {
      case 'completed':
        return asCompleted(outcome);
      case 'paused':
        return pauseParentOnChild(outcome.childRunId);
      case 'failed':
        return failResult(
          outcome.error ?? `Sub-run '${node.workflow}' failed`,
          outcome.costUsd,
          outcome.tokens
        );
      case 'cancelled':
        return failResult(
          `Sub-run '${node.workflow}' was cancelled`,
          outcome.costUsd,
          outcome.tokens
        );
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
      c =>
        readSubrunMetadata(c.metadata as Record<string, unknown> | undefined).parentNodeId ===
        node.id
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
    isolation: node.isolation,
    ...(resolvedInputs !== undefined ? { inputs: resolvedInputs } : {}),
  };

  try {
    if (existing === undefined) {
      // One work unit per spawn decision (#1961): the child's own attempts are its
      // own run's ledger; the parent charges the decision to start it.
      await chargeBudgetWorkUnit(ctx, node.id);
      return await interpret(await ctx.runChildWorkflow(childArgs));
    }
    if (existing.status === 'failed') {
      // Resume-through-parent recovery (D5/#1764): re-drive the failed child once.
      await chargeBudgetWorkUnit(ctx, node.id);
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
 * `metadata.cancelled_reason` values the fan-out path stamps on children it cancels
 * ITSELF (so the cancel is attributable and — unlike a user's out-of-band cancel —
 * recoverable on resume). `fan_out_gate`: a child paused at a gate (#2180).
 * `fan_out_orphan`: a child whose `child_index` fell out of range when the item list shrank.
 *
 * `fan_out_sibling` is READ-ONLY legacy. It marked an in-flight sibling cancelled once an
 * earlier revision's fail-fast sealed the node's fate; nothing writes it any more, because a
 * fan-out no longer ends one child's run on account of another's. It stays in the type and
 * in the recoverable set on purpose: a run that was in flight across the upgrade has rows
 * carrying it, and dropping it would make those children read as user-cancelled — terminal,
 * never re-driven, so the parent would fail every resume with no way back. Delete it only
 * once no resumable run can predate the change.
 */
type FanOutCancelReason = 'fan_out_gate' | 'fan_out_sibling' | 'fan_out_orphan';
const FAN_OUT_RECOVERABLE_CANCEL_REASONS: ReadonlySet<string> = new Set<FanOutCancelReason>([
  'fan_out_gate',
  'fan_out_sibling',
  // Every reason above is engine-owned, so every one belongs here — `fan_out_orphan` was
  // missing, which read an orphan the engine cancelled as a USER cancel. Items shrinking
  // and then growing back left those slots permanently cancelled: dead under all_done, and
  // an unrecoverable node failure on every resume under all_success.
  'fan_out_orphan',
]);

/**
 * A `running`/`pending` child found on re-entry is ambiguous: a crash-orphan of a prior
 * pass, or a live execution in another process. Past this idle window (no
 * `last_activity_at` heartbeat — written ≤ every 60s while a child runs) it reads as an
 * orphan; within it, as possibly still live. Only the MESSAGE differs — per CLAUDE.md's
 * "No Autonomous Lifecycle Mutation Across Process Boundaries", NEITHER branch cancels.
 */
const FAN_OUT_CHILD_STALE_MS = 5 * 60_000;

/** The fan-out cancel reason stamped on a child, if any. */
function fanOutCancelReason(run: WorkflowRun): string | undefined {
  const reason = (run.metadata as Record<string, unknown> | undefined)?.cancelled_reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** True when a cancelled child was cancelled BY the fan-out path → recoverable on resume. */
function isFanOutRecoverableCancel(run: WorkflowRun): boolean {
  const reason = fanOutCancelReason(run);
  return reason !== undefined && FAN_OUT_RECOVERABLE_CANCEL_REASONS.has(reason);
}

/** True when a `running`/`pending` child has had no activity within the idle window. */
function isFanOutChildStale(run: WorkflowRun, now = Date.now()): boolean {
  const last = run.last_activity_at ?? run.started_at;
  return last === null || now - last.getTime() > FAN_OUT_CHILD_STALE_MS;
}

/**
 * Cheap, dependency-free content hash (djb2) of a fan-out child's input string, stamped
 * at spawn so resume can detect a non-deterministic items producer (same index, changed
 * content) and WARN (never re-key). Collision-tolerant: a warn-only signal, not identity.
 */
function hashFanOutItem(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i);
  return (h >>> 0).toString(16);
}

/**
 * #2180 pointer: a fan-out child paused at an approval gate. Fan-out children must be
 * autonomous — the parent run has a SINGLE approval-gate slot, so N concurrently-paused
 * children cannot be represented. Names the offending child + index + run id (I4) and
 * points the author at the two supported fixes. Removing the gate then resuming re-drives
 * exactly this child (its cancel is tagged `fan_out_gate` → recoverable).
 */
function fanOutAutonomousGateMessage(
  node: WorkflowNode,
  childRunId: string,
  index: number
): string {
  return (
    `fan_out node '${node.id}': child ${String(index)} (run ${childRunId.slice(0, 8)}) of ` +
    `'${node.workflow}' paused at an approval gate. Fan-out children must run autonomously — ` +
    'the parent run has a single gate slot, so N concurrently-paused children cannot be ' +
    `represented (#2180). Remove the gate from '${node.workflow}' and resume (this child ` +
    "re-drives), or invoke it as a single (non-fan-out) 'workflow:' node."
  );
}

/**
 * A `running`/`pending` fan-out child found on re-entry — ambiguous ownership, so NOT
 * auto-cancelled (CLAUDE.md lifecycle rule). Surfaces the state + a one-click action, with
 * wording keyed to `last_activity_at` staleness (fresh → likely live; stale → likely orphaned).
 */
function fanOutAmbiguousChildMessage(
  node: WorkflowNode,
  child: WorkflowRun,
  index: number,
  stale: boolean
): string {
  const ref = `child ${String(index)} (run ${child.id.slice(0, 8)})`;
  return stale
    ? `fan_out node '${node.id}': ${ref} of '${node.workflow}' is still '${child.status}' with no ` +
        'recent activity — it appears orphaned by an interrupted run. Abandon it (`archon workflow ' +
        `abandon ${child.id}\`) and resume the parent to re-drive it.`
    : `fan_out node '${node.id}': ${ref} of '${node.workflow}' may still be running (recent activity) — ` +
        `wait for it to finish and resume, or abandon it (\`archon workflow abandon ${child.id}\`) if it is stuck.`;
}

/**
 * Concurrent fan-out children sharing the parent checkout collide on the path-exclusive
 * lock (`executor.ts`, guarded by `mutates_checkout !== false`): siblings are deliberately
 * NOT excluded from it, so all but one self-cancel — and a lock-cancelled child is threaded
 * as terminal on re-entry, which makes the failure permanent (#2180 Defect A). The engine
 * cannot infer which way out the author wants, so it names all three and refuses to spend
 * the money finding out.
 */
function fanOutSharedCheckoutMessage(node: WorkflowNode, concurrency: number): string {
  return (
    `fan_out node '${node.id}': up to ${String(concurrency)} children of '${node.workflow}' ` +
    'would run at once in the parent checkout, and that workflow does not declare ' +
    '`mutates_checkout: false`. Concurrent runs on one checkout take a path-exclusive lock, ' +
    'so all but the first would cancel themselves — and a lock-cancelled child is not ' +
    'recoverable by resume (#2180). Choose one: add `mutates_checkout: false` to ' +
    `'${node.workflow}' if it only reads the repo; set \`isolation: worktree\` on '${node.id}' ` +
    'if the children write to it; or set `fan_out.max_parallel: 1` to run them one at a time.'
  );
}

/**
 * Resolve the fan-out target's definition for the shared-checkout preflight, using the
 * same discovery + name resolution `runChildWorkflow` performs at spawn — sub-run targets
 * resolve at spawn time by design (#2200), so this reads the definition the children will
 * actually get rather than one captured at load.
 *
 * Reports WHY it could not resolve rather than collapsing every cause to `undefined`. The
 * preflight it feeds is the only thing standing between a shared-checkout fan-out and a
 * path-lock cascade the engine cannot recover from, so "we could not check" must not read
 * the same as "we checked and it is fine" — that is the silent fallback the engineering
 * principles forbid. An unknown or ambiguous name reaches here without any exception being
 * thrown, so this is not a rare path.
 *
 * The caller still must not report a COLLISION on this branch: the author's actual problem
 * is the unresolvable target, and pointing them at `mutates_checkout` would send them to
 * the wrong file. It fails closed with a message about the resolution instead.
 */
async function resolveFanOutChildDefinition(
  deps: WorkflowDeps,
  cwd: string,
  targetName: string,
  /** Parent run's AUTHORING directory; a fan-out target is a sibling workflow, so it
   *  lives beside the parent there rather than in the target workspace. */
  childSourceRoot?: string
): Promise<{ definition: WorkflowDefinition } | { unresolved: string }> {
  try {
    const { workflows } = await discoverWorkflowsWithConfig(
      cwd,
      deps.loadConfig,
      childSourceRoot === undefined ? undefined : liveSourceRoots(childSourceRoot)
    );
    const definition = resolveWorkflowName(
      targetName,
      workflows.map(w => w.workflow)
    );
    // resolveWorkflowName returns undefined for an unknown name and THROWS only on
    // ambiguity, so the undefined branch is ordinary rather than exceptional.
    return definition
      ? { definition }
      : { unresolved: `no workflow named '${targetName}' was found` };
  } catch (err) {
    return { unresolved: (err as Error).message };
  }
}

/**
 * Σ of defined child `costUsd`. Returns undefined when NO child reported cost so the
 * node's own `costUsd` stays absent (a misleading `0` would look like a free run) —
 * matching the run-level aggregation's "only write when > 0" posture.
 *
 * This is Σ of every child, not only the completed ones: a child persists its usage at
 * its run tail whatever its outcome (#2469), so a failed or cancelled child still
 * contributes what it burned. That matters most here — `all_done` is the default join,
 * which makes a partly-failed fan-out the ordinary case rather than the exceptional one.
 */
function sumFanOutCost(outcomes: readonly ChildWorkflowOutcome[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const o of outcomes) {
    if (o.costUsd !== undefined && Number.isFinite(o.costUsd)) {
      sum += o.costUsd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/**
 * Σ of defined child token usage; undefined when no child reported tokens. Like
 * {@link sumFanOutCost}, this covers every child regardless of outcome.
 */
function sumFanOutTokens(outcomes: readonly ChildWorkflowOutcome[]): TokenUsage | undefined {
  return sumTokenUsage(
    outcomes.flatMap(outcome => (outcome.tokens !== undefined ? [outcome.tokens] : [])),
    { scope: 'fan_out' }
  );
}

/**
 * Execute a fan-out `workflow:` node (#2121 slice 2, PR-C): expand the node into N
 * governed child runs over a data-driven item list, bound by a `max_parallel` sliding
 * window, and reduce the N child outcomes into one node outcome via the declared
 * `join`. This is the slice-1 1:1 sub-run re-entry table generalized to 1:N, keyed by
 * `metadata.child_index`:
 *   - resolve `fan_out.items` → a JSON array (fail closed on non-array/malformed);
 *   - re-inspect existing children (findChildRuns by parent_node_id) by child_index, so
 *     parent resume skips completed instances and re-drives failed ones for free;
 *   - spawn/re-drive the incomplete indices through mapWithLimit(max_parallel); a
 *     fan-out-cancelled (gate/sibling) child is recoverable → re-driven, a user-cancelled
 *     one stays terminal;
 *   - #2180 (Defect A): before ANY child is created, refuse a shared-checkout expansion
 *     that would run >1 child at once over a target not declaring `mutates_checkout: false`
 *     — those siblings would self-cancel on the path lock, unrecoverably;
 *   - #2180 (D5): a fan-out child that PAUSES at a gate FAILS the node (autonomous fan-out
 *     — the single parent gate slot can't hold N children) and is cancelled tagged
 *     `fan_out_gate` (removing the gate + resuming re-drives it). A `running`/`pending`
 *     child found on resume is ambiguous → the node fails WITHOUT auto-cancel (CLAUDE.md
 *     lifecycle rule), surfacing a staleness-keyed wait/abandon action;
 *   - EVERY index is spawned and every child runs to its own terminal state — no child's
 *     outcome ends another's — and only then does the join reduce: `all_success` (any
 *     failed/cancelled child fails the node) / `all_done` (aggregate all terminal;
 *     failed/cancelled entries represented);
 *   - aggregate `$<id>.output` = JSON array in item order; cost/tokens = Σ children.
 *
 * Never throws — every failure returns a failed NodeExecutionResult so a child-store
 * error can't unwind the whole DAG. `node_completed` is written ONLY when the join is
 * satisfied, so a failed fan-out node re-runs and re-inspects its children on resume
 * (resume correctness is sourced from child-run status, not the node's own events).
 */
async function executeFanOutWorkflowNode(
  node: WorkflowNode,
  ctx: RunLayersContext,
  fanOut: FanOutConfig,
  runChild: RunChildWorkflowFn
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, cwd, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };
  const stepName = ctx.stepNamePrefix + node.id;

  // node_failed writer (mirrors executeWorkflowNode.failResult) — a fan-out failure may
  // still carry accumulated cost/tokens so spend over already-run children is tracked.
  const failResult = (
    error: string,
    costUsd?: number,
    tokens?: TokenUsage
  ): NodeExecutionResult => {
    deps.store
      .createWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'node_failed',
        step_name: stepName,
        data: {
          error,
          type: 'workflow',
          ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
        },
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
    return {
      state: 'failed',
      output: '',
      error,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
    };
  };

  // node_completed writer (mirrors executeWorkflowNode.asCompleted) — written ONLY when
  // the join is satisfied, so getCompletedDagNodeOutputs skips a finished fan-out node
  // on resume but re-runs an unfinished one (which re-inspects children by child_index).
  const writeCompleted = (
    output: string,
    costUsd?: number,
    tokens?: TokenUsage,
    structured?: unknown
  ): void => {
    deps.store
      .createWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'node_completed',
        step_name: stepName,
        data: {
          node_output: output,
          type: 'workflow',
          fan_out: true,
          // The logical aggregate array (#2637), so parent cold resume rehydrates
          // it identically to the fresh join.
          ...(structured !== undefined ? { structured_output: structured } : {}),
          ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
          // Both usage keys are what survives resume: getDagResumeSnapshot rebuilds a
          // run's cumulative usage by summing `data.tokens` and `data.cost_usd` off
          // these events, so dropping either here makes every resumed run under-report
          // by exactly the children's usage — silently, since an absent key is skipped
          // without warning.
          ...(tokens !== undefined ? { tokens } : {}),
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
      // The wrapper node has no meaningful duration of its own — child runs carry real
      // timing. Emitted as 0 to satisfy NodeCompletedEvent (mirrors the single path).
      duration: 0,
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  };

  // Notify the platform immediately of a fan-out failure (S3). Every early-failure branch
  // uses this — items resolution, both gate paths, the child-lookup error, the collision
  // preflight and the join — so a fan-out failure never reaches the user through the
  // end-of-run digest alone. safeSendMessage never throws.
  const notify = async (text: string): Promise<void> => {
    await safeSendMessage(platform, conversationId, text, msgContext);
  };

  // Cancel a child the fan-out path OWNS, stamping WHY (C2/I4) so the cancel is
  // attributable AND — unlike a user's out-of-band cancel — recoverable on resume. The
  // reason is written first (a best-effort metadata merge), then the status is flipped;
  // both are best-effort so a store hiccup can't unwind the node.
  const cancelChild = async (childId: string, reason: FanOutCancelReason): Promise<void> => {
    if (!childId) return;
    await deps.store
      .updateWorkflowRun(childId, { metadata: { cancelled_reason: reason } })
      .catch((err: unknown) => {
        getLog().error(
          { err: err as Error, childRunId: childId, reason },
          'workflow.fan_out_cancel_reason_write_failed'
        );
      });
    await deps.store.cancelWorkflowRun(childId).catch((err: unknown) => {
      getLog().error({ err: err as Error, childRunId: childId }, 'workflow.fan_out_cancel_failed');
    });
  };

  // Item → child input/$ARGUMENTS (canonical value text: strings raw, objects JSON).
  // Also the pre-image for the resume item-hash (S2) — identity unchanged by #2637,
  // since canonicalValueText is byte-identical to the previous inline mapping.
  const itemToInput = (item: unknown): string => canonicalValueText(item);

  // 1. Resolve `fan_out.items` → a JSON array. Two-pass substitution (workflow vars,
  //    then $node.output refs) exactly as the input surface uses. A `.field` ref that
  //    can't be honored throws an OutputRefError → caught → fail closed. Never silently
  //    zero items: a resolution that isn't a JSON array fails the node.
  let items: unknown[];
  try {
    const { prompt: itemsVarsResolved } = substituteWorkflowVariables(
      fanOut.items,
      parentRun.id,
      parentRun.user_message ?? '',
      ctx.artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext
    );
    const itemsResolved = substituteNodeOutputRefs(itemsVarsResolved, ctx.nodeOutputs);
    const parsed: unknown = JSON.parse(itemsResolved);
    if (!Array.isArray(parsed)) {
      const msg =
        `fan_out.items on '${node.id}' resolved to ${typeof parsed}, not a JSON array. ` +
        `'${fanOut.items}' must reference a node output that produces a JSON array.`;
      await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
      return failResult(msg);
    }
    items = parsed;
  } catch (err) {
    const msg = `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg);
  }

  // Resolve the node's static `with:` map (#2470) once — the same $INPUTS applied to EVERY
  // fan-out child. Per-item, the `fan_out.as` channel adds `$INPUTS.<as> = <item>` on top
  // (load-time collision-checked so `as` never overwrites a `with:` key). Resolved here
  // rather than per-child because the values don't depend on the item. Same three-tier
  // value resolution as the 1:1 path (#2637): literals typed, whole refs logical,
  // templates text.
  const fanOutStaticInputs: Record<string, JsonValue> = {};
  const parentInputs = resolveRunInputs(parentRun);
  try {
    if (node.with !== undefined) {
      const fanOutResolutionCtx: ShellInputContext = {
        workflowRun: parentRun,
        artifactsDir: ctx.artifactsDir,
        stateDir: ctx.stateDir,
        baseBranch: ctx.baseBranch,
        docsDir: ctx.docsDir,
        issueContext: ctx.issueContext,
        nodeOutputs: ctx.nodeOutputs,
      };
      for (const [name, rawValue] of Object.entries(node.with)) {
        fanOutStaticInputs[name] = resolveWorkflowValue(
          rawValue,
          fanOutResolutionCtx,
          parentInputs,
          false
        );
      }
    }
  } catch (err) {
    const msg = `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg);
  }

  // 2. Empty array → a valid zero-width expansion (#977 acceptance): complete with '[]'.
  if (items.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.fan_out_empty');
    writeCompleted('[]', undefined);
    return { state: 'completed', output: '[]' };
  }

  // 3. Re-entry: find THIS node's existing children (a parent may run several workflow
  //    nodes → filter by parent_node_id) and index them by metadata.child_index. Empty
  //    on the first run; carries the ordered instance set on resume.
  const existingByIndex = new Map<number, WorkflowRun>();
  try {
    const children = (await deps.store.findChildRuns(parentRun.id)).filter(
      c =>
        readSubrunMetadata(c.metadata as Record<string, unknown> | undefined).parentNodeId ===
        node.id
    );
    for (const child of children) {
      const meta = readSubrunMetadata(child.metadata as Record<string, unknown> | undefined);
      const idx = meta.childIndex;
      // A child of THIS node with no `child_index`: it was spawned when the node was a 1:1
      // sub-run (that path stamps `parent_node_id` and no index), and the node has since
      // grown a `fan_out:`. Dropping it silently left a live, billing, untracked child that
      // nothing would ever cancel — so it gets the same treatment as an out-of-range index.
      if (idx === undefined) {
        getLog().warn(
          {
            parentRunId: parentRun.id,
            nodeId: node.id,
            childRunId: child.id,
            status: child.status,
          },
          'workflow.fan_out_child_missing_index'
        );
        if (child.status === 'running' || child.status === 'pending' || child.status === 'paused') {
          await cancelChild(child.id, 'fan_out_orphan');
        }
        continue;
      }
      // I2: a child_index beyond the (now-shorter) item list — the items producer shrank
      // between attempts. Never silently dropped: WARN for visibility, and cancel a
      // still-live orphan (tagged) so it stops billing (a terminal one no-ops).
      if (idx < 0 || idx >= items.length) {
        getLog().warn(
          {
            parentRunId: parentRun.id,
            nodeId: node.id,
            childRunId: child.id,
            childIndex: idx,
            itemCount: items.length,
          },
          'workflow.fan_out_child_index_out_of_range'
        );
        if (child.status === 'running' || child.status === 'pending' || child.status === 'paused') {
          await cancelChild(child.id, 'fan_out_orphan');
        }
        continue;
      }
      // S4: a duplicate child_index (two rows for one index) is anomalous — last write
      // wins (as the 1:1 precedent does), but log it rather than swallow it silently.
      if (existingByIndex.has(idx)) {
        getLog().debug(
          { parentRunId: parentRun.id, nodeId: node.id, childIndex: idx, childRunId: child.id },
          'workflow.fan_out_duplicate_child_index'
        );
      }
      // S2: a non-deterministic items producer may have changed the item at this index
      // between attempts. Resume still re-keys by index (safe under the cached-output
      // invariant), but WARN so the content drift is visible.
      const priorHash = meta.fanOutItemHash;
      if (priorHash !== undefined && priorHash !== hashFanOutItem(itemToInput(items[idx]))) {
        getLog().warn(
          { parentRunId: parentRun.id, nodeId: node.id, childIndex: idx, childRunId: child.id },
          'workflow.fan_out_item_content_changed'
        );
      }
      existingByIndex.set(idx, child);
    }
  } catch (err) {
    // Notify like every other early-failure branch — this one was the odd one out, so a
    // store error was the single fan-out failure that reached the user only via the
    // end-of-run digest.
    const msg = `Failed to look up fan-out child runs for node '${node.id}': ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg);
  }

  // 4. #2180 (D5): a fan-out child cannot hold the single parent gate slot. Split the
  //    non-terminal existing children by how much is actually known:
  //    - `paused` = a gate was genuinely OBSERVED → the designed autonomous-fan-out
  //      rejection: cancel it (tagged `fan_out_gate`, so removing the gate + resuming
  //      re-drives it) and point the author at the gate.
  //    - `running`/`pending` = AMBIGUOUS (a crash-orphan of a prior pass, or a live run in
  //      another process). Per CLAUDE.md's "No Autonomous Lifecycle Mutation Across Process
  //      Boundaries" rule we DO NOT cancel — surface the state + a one-click action, wording
  //      keyed to `last_activity_at` staleness. NEVER the gate message for a non-gate cause.
  const pausedExisting = [...existingByIndex.entries()].filter(([, c]) => c.status === 'paused');
  if (pausedExisting.length > 0) {
    const [index, child] = pausedExisting[0];
    for (const [, c] of pausedExisting) await cancelChild(c.id, 'fan_out_gate');
    const msg = fanOutAutonomousGateMessage(node, child.id, index);
    await notify(`⏸→❌ **Fan-out gate rejected** (node \`${node.id}\`): ${msg}`);
    return failResult(msg);
  }
  const ambiguous = [...existingByIndex.entries()].filter(
    ([, c]) => c.status === 'running' || c.status === 'pending'
  );
  if (ambiguous.length > 0) {
    const [index, child] = ambiguous[0];
    const stale = isFanOutChildStale(child);
    getLog().warn(
      {
        parentRunId: parentRun.id,
        nodeId: node.id,
        childRunId: child.id,
        childIndex: index,
        status: child.status,
        stale,
      },
      'workflow.fan_out_child_nonterminal_on_resume'
    );
    const msg = fanOutAmbiguousChildMessage(node, child, index, stale);
    await notify(`⚠️ **Fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg);
  }

  // 5. Shared-checkout preflight (#2180 Defect A) AND interactive-class preflight (#2707
  //    step 2, issue #2474). Isolation is explicit-only, so a fan-out with no `isolation:
  //    worktree` puts N children in the parent's checkout, where the path lock cancels
  //    every sibling but one — permanently, since resume threads a cancelled child as
  //    terminal. A fan-out target that can pause has a different, unconditional problem:
  //    the parent has a SINGLE approval-gate slot, so N children racing to pause cannot
  //    all be presented — this holds even at `max_parallel: 1` or `isolation: worktree`,
  //    since it is a governance problem, not a checkout problem. Both are caught HERE,
  //    before a single child row exists: the child target (and therefore its
  //    `mutates_checkout`/`interactive`) only resolves at spawn time by design (#2200), so
  //    load time cannot see either.
  //
  //    Resolved ONCE, unconditionally — both checks below share the one resolution rather
  //    than each paying their own discovery scan. #2474's own analysis anticipated walking
  //    the target's node tree for a gate; the class declaration (#2707 step 2) makes that
  //    unnecessary — an unattended-class workflow is GUARANTEED gate-free by the load-time
  //    class-placement check (loader.ts), so "is the target unattended-class" is a
  //    one-field read, cheaper than the tree walk #2474 originally scoped.
  const pendingCount = items.reduce<number>((n, _item, i) => {
    const existing = existingByIndex.get(i);
    if (existing?.status === 'completed') return n;
    if (existing?.status === 'cancelled' && !isFanOutRecoverableCancel(existing)) return n;
    return n + 1;
  }, 0);
  const plannedConcurrency = Math.min(fanOut.max_parallel, pendingCount);
  {
    // The fan-out target is a not-yet-started child, so it resolves from the parent's
    // AUTHORING directory (live) rather than the parent's frozen copy — same rule as a
    // 1:1 `workflow:` child. See resolveChildDiscoveryRoot.
    const resolved = await resolveFanOutChildDefinition(
      deps,
      cwd,
      node.workflow,
      await resolveChildDiscoveryRoot(parentRun.metadata)
    );
    if ('unresolved' in resolved) {
      // Fail CLOSED. Skipping the check here would let either hazard through unguarded on
      // the strength of a lookup that did not happen, and the spawn is about to fail on
      // this same unresolvable target anyway — so the only thing failing open buys is a
      // worse message. Names the resolution problem, not a hazard the author cannot yet act on.
      const msg =
        `fan_out node '${node.id}': cannot verify that the target workflow '${node.workflow}' is ` +
        `safe to fan out to, because it could not be resolved — ${resolved.unresolved}. Fix the ` +
        'target name.';
      getLog().warn(
        {
          parentRunId: parentRun.id,
          nodeId: node.id,
          childWorkflow: node.workflow,
          reason: resolved.unresolved,
        },
        'workflow.fan_out_preflight_unresolved'
      );
      await notify(`❌ **Fan-out blocked** (node \`${node.id}\`): ${msg}`);
      return failResult(msg);
    }
    if (resolved.definition.interactive === true) {
      const msg =
        `fan_out node '${node.id}': target workflow '${node.workflow}' is interactive-class ` +
        "('interactive: true') and may pause for human input — a fan-out has a single " +
        'approval-gate slot for N children, so this is refused before any child is created. ' +
        `Remove the pause capability from '${node.workflow}', or invoke it as a single ` +
        "(non-fan-out) 'workflow:' node instead.";
      getLog().warn(
        { parentRunId: parentRun.id, nodeId: node.id, childWorkflow: node.workflow },
        'workflow.fan_out_interactive_target'
      );
      await notify(`❌ **Fan-out blocked** (node \`${node.id}\`): ${msg}`);
      return failResult(msg);
    }
    if (
      node.isolation !== 'worktree' &&
      plannedConcurrency > 1 &&
      resolved.definition.mutates_checkout !== false
    ) {
      const msg = fanOutSharedCheckoutMessage(node, plannedConcurrency);
      getLog().warn(
        {
          parentRunId: parentRun.id,
          nodeId: node.id,
          childWorkflow: node.workflow,
          plannedConcurrency,
        },
        'workflow.fan_out_shared_checkout_collision'
      );
      await notify(`❌ **Fan-out blocked** (node \`${node.id}\`): ${msg}`);
      return failResult(msg);
    }
  }

  // 6. Execute EVERY index through a bounded sliding window. Classification per index: an
  //    existing completed child threads its recorded outcome (resume skip); an existing
  //    failed OR fan-out-cancelled (recoverable) child is re-driven; a user-cancelled child
  //    stays terminal; a missing index spawns fresh.
  //
  //    No child's outcome terminates another's. Every index is spawned and every child runs
  //    to its OWN terminal state before the join reduces — a fan-out is N independent
  //    governed runs that happen to be siblings, not a competition. An earlier revision
  //    fail-fasted here: the first failure under all_success skipped the remaining spawns
  //    and cancelled in-flight siblings. That saved spend by deciding one child's fate from
  //    another's, which is not the engine's call to make, and it made the outcome of an
  //    interrupted sibling depend on which child happened to finish first.
  //
  //    The cost is real and belongs to the author: a wide fan-out whose first child fails
  //    now runs every remaining child, so worst-case spend is items.length rather than
  //    "until the first failure". `max_parallel` bounds concurrency, not total spend —
  //    a run-tree budget ceiling is #1961.
  // Indices refused for budget (#1961) — see the spawn gate inside the callback.
  const budgetRefusals: BudgetExhaustion[] = [];
  // Children whose work-unit charge could not be persisted — a distinct refusal cause from
  // gate exhaustion, but it must fail the node explicitly under every join mode too.
  let chargeFailures = 0;
  let chargeFailureError: string | undefined;
  const settled = await mapWithLimit(
    items,
    fanOut.max_parallel,
    async (item, i): Promise<ChildWorkflowOutcome> => {
      const existing = existingByIndex.get(i);
      // Existing completed child → thread its outcome without re-spawning (resume skip).
      if (existing?.status === 'completed') return childOutcomeFromRun(existing);
      // A user-cancelled child (no fan-out tag) is terminal — thread it as-is (fails
      // all_success; represented in all_done). A fan-out-tagged cancel is recoverable and
      // falls through to re-drive.
      if (existing?.status === 'cancelled' && !isFanOutRecoverableCancel(existing)) {
        return childOutcomeFromRun(existing);
      }
      // Spawn gate (#1961): a ceiling met before this child starts refuses the spawn
      // explicitly instead of silently truncating the item list — the refusals are
      // turned into an explicit node failure below, after the join settles.
      const spawnExhaustion = checkBudgetExhaustion(ctx.budget, ctx.budgetLedger);
      if (spawnExhaustion !== undefined) {
        budgetRefusals.push(spawnExhaustion);
        return {
          childRunId: '',
          status: 'failed',
          error: `child ${String(i)} not spawned: run budget exhausted — ${describeBudgetExhaustion(spawnExhaustion)}`,
        };
      }
      // One parent work unit per spawned/re-driven child (#1961). If the charge cannot be
      // persisted, refuse this spawn like a gate refusal so the explicit pre-join failure
      // fires under every join mode (`all_done` must not mask it either).
      try {
        await chargeBudgetWorkUnit(ctx, node.id);
      } catch (err) {
        chargeFailures++;
        chargeFailureError ??= (err as Error).message;
        return {
          childRunId: '',
          status: 'failed',
          error:
            `child ${String(i)} not spawned: work-unit charge could not be persisted — ` +
            (err as Error).message,
        };
      }
      const input = itemToInput(item);
      // Per-child $INPUTS (#2470): the static `with:` map plus the per-item `fan_out.as`
      // channel (the item value under `$INPUTS.<as>`). `as` is load-time guaranteed not to
      // collide with a `with:` key, so this spread order is unambiguous. The item travels
      // LOGICALLY under `as` (#2637 — an object item stays an object for the child);
      // `itemToInput`'s text form remains the `$ARGUMENTS`/item-hash channel.
      const childInputs: Record<string, JsonValue> = {
        ...fanOutStaticInputs,
        ...(fanOut.as !== undefined ? { [fanOut.as]: item as JsonValue } : {}),
      };
      // A fan-out-recoverable-cancelled child (gate/sibling) can't be resumed while
      // 'cancelled' (resumeWorkflowRun rejects that status) — clear it to 'failed' first,
      // then re-drive through the failed path. Our own tagged cancel is terminal state we
      // own, so this recovery heuristic is appropriate (CLAUDE.md).
      let resumeChild = existing?.status === 'failed' ? existing : undefined;
      if (existing?.status === 'cancelled' && isFanOutRecoverableCancel(existing)) {
        await deps.store
          .updateWorkflowRun(existing.id, { status: 'failed' })
          .catch((err: unknown) => {
            getLog().error(
              { err: err as Error, childRunId: existing.id },
              'workflow.fan_out_recover_cancel_failed'
            );
          });
        resumeChild = { ...existing, status: 'failed' };
      }
      // Whatever this child returns — completed, failed, cancelled, or paused — it is this
      // child's outcome alone. The join reads them all once every one has settled.
      const outcome = await runChild({
        parentRun,
        nodeId: node.id,
        childWorkflowName: node.workflow,
        input,
        cwd,
        conversationId,
        conversationDbId: parentRun.conversation_id,
        userId: parentRun.user_id ?? undefined,
        codebaseId: parentRun.codebase_id ?? undefined,
        isolation: node.isolation,
        childIndex: i,
        itemHash: hashFanOutItem(input),
        ...(Object.keys(childInputs).length > 0 ? { inputs: childInputs } : {}),
        ...(resumeChild ? { resumeFailedChild: resumeChild } : {}),
      });
      // A paused child is cancelled HERE rather than at the join, and the timing is
      // load-bearing rather than tidiness. A pause is not terminal, and a non-terminal run
      // keeps holding its working path: `getActiveWorkflowRunByPath` counts `paused` as
      // active. On a shared checkout the very next sibling then loses the path lock and
      // self-cancels — with NO reason tag, so it reads as a user cancel, is never re-driven,
      // and the parent fails identically on every resume. Removing the fail-fast is what
      // exposed this: before, a pause sealed the node and no later sibling ever spawned.
      //
      // This is not one child's outcome ending another's — the cancel is decided by the
      // paused child's own state, it is the same cancel the gate path (#2180/#2438) applies
      // at the join a moment later, and every sibling still runs to its own terminal state.
      // All it changes is that the lock is released before the next child starts.
      if (outcome.status === 'paused') await cancelChild(outcome.childRunId, 'fan_out_gate');
      return outcome;
    }
  );

  // mapWithLimit never rejects here (runChild honors the never-throws contract), but be
  // defensive: a rejected slot becomes a synthetic failed outcome.
  const outcomes: ChildWorkflowOutcome[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          childRunId: '',
          status: 'failed',
          error: `fan-out child ${String(i)} threw: ${String(r.reason)}`,
        }
  );

  const totalCostUsd = sumFanOutCost(outcomes);
  const totalTokens = sumFanOutTokens(outcomes);

  // Explicit budget refusal (#1961): children the gate would not spawn fail the node
  // here, naming how many ran vs were planned — never a silent truncation of the item
  // list. Checked before the join modes so `all_done` cannot mask the refusals either.
  // Unpersistable work-unit charges refuse their spawns too — same explicit failure, so a
  // persist blip cannot silently drop items under `all_done` either.
  const refusedCount = budgetRefusals.length + chargeFailures;
  if (refusedCount > 0) {
    const spawned = items.length - refusedCount;
    const msg =
      `fan_out node '${node.id}': ${String(spawned)} of ${String(items.length)} planned children spawned, ` +
      (budgetRefusals.length > 0
        ? `${String(budgetRefusals.length)} refused by the run budget — ${describeBudgetExhaustion(budgetRefusals[0])}`
        : '') +
      (chargeFailures > 0
        ? (budgetRefusals.length > 0 ? '; ' : '') +
          `${String(chargeFailures)} spawn${chargeFailures > 1 ? 's' : ''} refused because the ` +
          `work-unit charge could not be persisted (${chargeFailureError ?? 'unknown error'})`
        : '') +
      '.';
    getLog().warn(
      {
        parentRunId: parentRun.id,
        nodeId: node.id,
        ...(budgetRefusals[0] ?? {}),
        refusals: budgetRefusals.length,
        chargeFailures,
      },
      'workflow.fan_out_budget_exhausted'
    );
    deps.store
      .createWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'budget_exhausted',
        step_name: ctx.stepNamePrefix + node.id,
        data: {
          phase: 'fan_out_spawn',
          ...(budgetRefusals[0] ?? { budget: 'max_work_units', limit: null, current: null }),
          charge_failures: chargeFailures,
          planned_children: items.length,
          spawned_children: spawned,
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: parentRun.id, eventType: 'budget_exhausted' },
          'workflow.event_persist_failed'
        );
      });
    await notify(`⛔ **Fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, totalCostUsd, totalTokens);
  }

  // A completed child's aggregate ELEMENT (#2637): its terminal LOGICAL value —
  // exactly what the #2774 output_format gate above certified via
  // {@link subrunLogicalValue} — so a structured child lands single-encoded
  // (`[{"v":1}]`, never `["{\"v\":1}"]`), a text-only child whose summary happens
  // to be JSON lands parsed like the validator saw it, and any other child stays
  // the exact string it always was.
  // I3: parity with the 1:1 asCompleted path — a completed child with no terminal
  // output is indistinguishable downstream from an intentional empty result, so
  // leave a trace before falling back to ''. A structured child always has text too
  // (the canonical serialization), so this warn still covers every genuinely empty
  // completion.
  const childElement = (o: ChildWorkflowOutcome, index: number): JsonValue => {
    if (o.status === 'completed' && o.output === undefined) {
      getLog().warn(
        { parentRunId: parentRun.id, nodeId: node.id, childRunId: o.childRunId, childIndex: index },
        'workflow.subrun_completed_without_output'
      );
    }
    return o.structuredOutput !== undefined
      ? (o.structuredOutput as JsonValue)
      : (subrunLogicalValue(o) as JsonValue);
  };

  // 7. #2180 (first-run path): a freshly-spawned child that paused at a gate fails the
  //    node. Cancel the paused child(ren) tagged `fan_out_gate` (recoverable once the gate
  //    is removed) and name the offending child (I4).
  //
  //    This is the ONE place a fan-out still cancels a child it did not have to, and it
  //    survives the no-mutual-termination rule deliberately. A pause is not a terminal
  //    state, so "every child runs to its own terminal state" has no answer for it: the
  //    parent has a single approval slot and cannot hand it to N children, so the child
  //    would wait forever for a gate it can never be given. This is an error path (#2438),
  //    not a race: the node is failing either way, and the cancel just stops the run
  //    dangling. A paused child never stops a sibling — everyone still runs to their own
  //    terminal state.
  //
  //    The cancel that actually frees the path lock already fired mid-flight, the moment
  //    the pause was observed. This pass is the idempotent backstop: it covers a paused
  //    outcome that did not come from this attempt's spawn loop (a synthetic outcome from a
  //    rejected slot), and re-cancelling an already-cancelled row is a no-op.
  const pausedIdx = outcomes.findIndex(o => o.status === 'paused');
  if (pausedIdx !== -1) {
    for (const o of outcomes)
      if (o.status === 'paused') await cancelChild(o.childRunId, 'fan_out_gate');
    const msg = fanOutAutonomousGateMessage(node, outcomes[pausedIdx].childRunId, pausedIdx);
    await notify(`⏸→❌ **Fan-out gate rejected** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, totalCostUsd, totalTokens);
  }

  // Declared boundary contract (#2774), fan-out parity with the 1:1 asCompleted path:
  // when the node declares `output_format`, EVERY completed child's terminal value must
  // match it — the join aggregates children, so one invalid element would otherwise be
  // persisted inside a "completed" node_completed row. Fails the node BEFORE any
  // writeCompleted so resume re-runs into the same named failure. An uncompilable
  // schema warn-skips like the 1:1 gate; failed/paused/cancelled children are not
  // validated (they never contribute a payload element).
  if (node.output_format) {
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'completed') continue;
      const logicalValue = subrunLogicalValue(outcome);
      let schemaCompileError: string | undefined;
      const validation = validateStructuredOutput(logicalValue, node.output_format, compileMsg => {
        schemaCompileError = compileMsg;
      });
      if (schemaCompileError !== undefined) {
        getLog().warn(
          { nodeId: node.id, workflowRunId: parentRun.id, compileMsg: schemaCompileError },
          'workflow.subrun_schema_uncompilable'
        );
        await notify(
          `⚠️ Node '${node.id}': its \`output_format\` schema could not be compiled (${schemaCompileError}), so fan-out child ${String(index)} of '${node.workflow}' was NOT validated against it. Fix the schema to enforce it.`
        );
        continue;
      }
      if (!validation.valid) {
        const errors = (validation.errors ?? ['value does not match the declared schema']).join(
          '; '
        );
        const received =
          logicalValue === null
            ? 'null'
            : Array.isArray(logicalValue)
              ? 'array'
              : typeof logicalValue;
        const msg =
          `Node '${node.id}': fan-out child ${String(index)} of sub-run '${node.workflow}' output does not match the node's declared output_format: ${errors}. ` +
          `Expected: ${JSON.stringify(node.output_format)}. Received: ${received}.`;
        await notify(`❌ **Fan-out output_format violation** (node \`${node.id}\`): ${msg}`);
        return failResult(msg, totalCostUsd, totalTokens);
      }
    }
  }

  // 8. Join.
  if (fanOut.join === 'all_success') {
    // Every child ran to its own terminal state, so the lowest-index non-completed outcome
    // IS the causal one — nothing here is a casualty of another child's failure.
    const firstBad = outcomes.findIndex(o => o.status !== 'completed');
    if (firstBad !== -1) {
      const bad = outcomes[firstBad];
      const ref = bad.childRunId ? ` (run ${bad.childRunId.slice(0, 8)})` : '';
      await notify(
        `❌ **Fan-out failed** (node \`${node.id}\`): child ${String(firstBad)}${ref} ${bad.status}` +
          (bad.error ? ` — ${bad.error}` : '')
      );
      return failResult(
        `fan_out node '${node.id}' (join: all_success): child ${String(firstBad)}${ref} ${bad.status}` +
          (bad.error ? `: ${bad.error}` : ''),
        totalCostUsd,
        totalTokens
      );
    }
    // All completed → aggregate the child results in item order: a LOGICAL array
    // (#2637), serialized once for the text channel.
    const elements = outcomes.map((o, i) => childElement(o, i));
    const aggregate = JSON.stringify(elements);
    writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
    return {
      state: 'completed',
      output: aggregate,
      structuredOutput: elements,
      ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
    };
  }

  // join: all_done — node succeeds once all children are terminal; a failed/cancelled
  // entry is represented as a failure-marker object in the aggregate array (so a
  // collector can reconcile partial results). Never fails the node on a partial failure.
  //
  // `archon_failed: true` is the marker's reserved discriminator (#2637): now that a
  // completed structured child's slot is its payload OBJECT, a child whose own schema
  // happens to carry `error` + `status` fields (a natural verifier shape) would be
  // indistinguishable from a failed slot by shape alone. No key can be made literally
  // unproducible through `output_format`, but no schema grows an `archon_failed`
  // field by accident — collectors check `r?.archon_failed === true`, nothing else.
  const elements = outcomes.map((o, i) =>
    o.status === 'completed'
      ? childElement(o, i)
      : { archon_failed: true, error: o.error ?? `child ${o.status}`, status: o.status }
  );
  const aggregate = JSON.stringify(elements);
  writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
  return {
    state: 'completed',
    output: aggregate,
    structuredOutput: elements,
    ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
    ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
  };
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
  /** The workspace nodes ACT on: provider turns, subprocesses, git, output files. */
  cwd: string;
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
  /**
   * Awaited after a complete layer has been aggregated and before lifecycle status is
   * observed. The top-level DAG uses this to durably capture authored run state at
   * the first point it exists; loop_group bodies have no run-level hook.
   */
  afterLayer?: () => Promise<void>;
  /** Resume cache: node ids that completed in a prior run (top-level only; undefined for body). */
  priorCompletedNodes?: Map<string, PersistedNodeOutput>;
  /**
   * Private provider session handles produced by completed top-level nodes. Undefined
   * inside loop_group bodies because repeated local IDs have no addressable lineage
   * contract yet.
   */
  nodeSessionHandles?: Map<string, SequentialSessionCursor>;
  /** Top-level node IDs whose sessions are named by at least one downstream consumer. */
  namedResumeSourceIds?: ReadonlySet<string>;
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
  totalCostUsd: number;
  totalTokens: TokenUsage | undefined;
  totalLoopIterations: number;
  /** Run-wide budget policy (#1961); undefined = the workflow declares no budget. */
  budget?: WorkflowBudgetPolicy;
  /**
   * Shared budget ledger (#1961). Created once per executeDagWorkflow and passed
   * BY REFERENCE into loop-group body contexts, so body attempts count toward
   * the same ceilings. `spendUsd` is only aggregated at top level (stepNamePrefix
   * '') — body spend arrives via the loop-group node's rolled-up costUsd instead,
   * so body cost is never counted twice.
   */
  budgetLedger?: RunBudgetLedger;
  /** Prefix prepended to every persisted `step_name` ('' for top-level, '{groupId}.' for a loop_group body). */
  stepNamePrefix: string;
  /** Complete runtime loop_group lineage for typed body artifacts; empty at top level. */
  loopGroupPath: NodeArtifactLoopFrame[];
  /**
   * Per-iteration `$LOOP_USER_INPUT` free-text for loop_group body `exec:` nodes, delivered
   * into the subprocess as an env var (#2115, #2725). `script:` nodes never splice this into
   * source (unsafe for TS/Python) and rely on this env var exclusively. `bash:` nodes get it
   * as a second channel alongside `applyLoopPrevToBodyNode`'s pre-existing shell-quoted
   * splice of the literal `$LOOP_USER_INPUT` token — this env var is what covers an indirect
   * read (`${LOOP_USER_INPUT}`, `printenv`, `env`) that splice can't reach. Only non-empty on
   * the first resumed iteration of an interactive group; undefined for the top-level DAG
   * (top-level exec nodes have no loop user input).
   */
  bodyLoopUserInput?: string;
}

/**
 * Return the IDs of `node`'s dependencies whose current `nodeOutputs` value no
 * longer matches their cached `priorCompletedNodes` snapshot (#2402). A
 * downstream consumer that is being considered for a prior-success skip is
 * stale — it was last computed against the prior snapshot, not against the
 * current `nodeOutputs` — when any of its deps is in this set. The set is
 * built by comparing text output AND structured output so consumers using
 * `$node.output.field` (the #2637 logical-value surface) are also invalidated
 * when only the structured form changed.
 *
 * A dep currently in `state: 'failed'` is always stale, checked first and
 * unconditionally — regardless of whether it had a prior cached success. Every
 * failure arm in the executor returns `output: ''`, so comparing a fresh
 * failure's value against a prior success's value (cases 2/3 below) can find
 * them equal and silently miss the failure; a dependency that failed on THIS
 * resume must never be judged by value equality.
 *
 * Past that, three cases surface a dep as "ran fresh this resume":
 *
 * 1. The dep was never in `priorCompletedNodes` at all (never completed in the
 *    prior run, or never reached) and is now `completed` in `nodeOutputs` — it
 *    re-ran this resume with no prior cache to honour. `'skipped'` is
 *    intentionally left out: its `output: ''` is semantically equivalent to
 *    the absent prior, so honouring the cache is safe.
 * 2. The dep's `prior.output` differs from `nodeOutputs.get(dep).output` —
 *    either an `always_run` upstream that re-executed, or any dep the engine
 *    re-ran with new content. The per-layer aggregation is the only writer of
 *    `nodeOutputs[dep].output` other than the pre-population loop, so a diff is
 *    proof of fresh execution.
 * 3. The dep's `prior.structuredOutput` differs from the current one — a
 *    subtler staleness that only matters for `$dep.output.field` consumers,
 *    covered here so a fresh structured value can't slip past a text-stable
 *    cache. JSON.stringify is sufficient: structured outputs are persisted to
 *    JSONB and therefore JSON-serializable; for `undefined` vs absent values,
 *    `JSON.stringify` normalises both to a missing key.
 *
 * Note: the value-equality comparison (cases 2/3) is conservative in one
 * direction — a dep that re-ran with text- and structured-identical output
 * will NOT be flagged. The cached downstream is therefore semantically
 * equivalent to a fresh execution in that case, which is the safe direction
 * to err in (over-run vs. stale success is the bug we're closing). The
 * failed-state check above is not subject to this leniency: a failure is
 * never treated as equivalent to the prior success it's compared against.
 */
function getStaleCachedDependencies(
  node: DagNode,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput>
): string[] {
  const deps = node.depends_on ?? [];
  if (deps.length === 0) return [];
  const stale: string[] = [];
  for (const depId of deps) {
    const prior = priorCompletedNodes.get(depId);
    const current = nodeOutputs.get(depId);
    // A dep that failed fresh this resume is always stale, checked before — and
    // independently of — the prior-cache lookup below. See the docstring above.
    if (current?.state === 'failed') {
      stale.push(depId);
      continue;
    }
    // Case 1: dep was never cached; if it is now complete it ran fresh this resume.
    // Missing-current (the dep is still pending or running) is intentionally left out:
    // pending/running cannot reach this helper via the resume-skip arm in
    // executeDagWorkflow (`priorCompletedNodes?.has(node.id)` only fires when the
    // CONSUMER itself was cached, but its dep would be addressed by case 2/3 once it
    // finishes).
    if (prior === undefined) {
      if (current?.state === 'completed') {
        stale.push(depId);
      }
      continue;
    }
    // Case 2: dep's text output differs from the prior snapshot.
    if (current?.output !== prior.output) {
      stale.push(depId);
      continue;
    }
    // Case 3: dep's structured value differs even though text did not — only matters
    // for `$dep.output.field` consumers, but those are exactly the surfaces that would
    // silently read stale structured data through the cached downstream.
    const priorStructured = prior.structuredOutput;
    const currentStructured =
      current !== undefined && 'structuredOutput' in current ? current.structuredOutput : undefined;
    if (!structuredOutputsEqual(priorStructured, currentStructured)) {
      stale.push(depId);
    }
  }
  return stale;
}

/**
 * `true` when two structured-output payloads are semantically equal for the
 * purposes of cache invalidation. JSON.stringify is the comparison because
 * structured outputs are persisted as JSONB — they are guaranteed JSON-shaped
 * (objects/arrays/primitives, no cycles, no functions). `undefined` is treated
 * as the absent payload; an explicit `null` is a real value and is distinct
 * from absent.
 */
function structuredOutputsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Await thunks one at a time, collecting outcomes in `Promise.allSettled` shape so the
 * caller's result handling is identical for the sequential and concurrent paths.
 */
async function settleSequentially(
  thunks: readonly (() => Promise<LayerNodeResult>)[]
): Promise<PromiseSettledResult<LayerNodeResult>[]> {
  const settled: PromiseSettledResult<LayerNodeResult>[] = [];
  for (const thunk of thunks) {
    try {
      settled.push({ status: 'fulfilled', value: await thunk() });
    } catch (reason) {
      settled.push({ status: 'rejected', reason });
    }
  }
  return settled;
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
    stateDir,
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
    loopGroupPath,
  } = ctx;
  // Lifecycle events expose only the immediate enclosing iteration; artifact
  // identity retains the complete outermost-to-innermost lineage.
  const iteration = loopGroupPath.at(-1)?.iteration;
  // nodeOutputs + accumulators + lastSequentialSession are mutated in place on `ctx`.
  // Charges one work unit per started node attempt (#1961) — invoked beside each
  // node_started write by the node executors.
  const chargeWorkUnit = (): void => {
    if (ctx.budgetLedger !== undefined) ctx.budgetLedger.workUnits++;
  };

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
    }

    // Build a thunk per node so the layer can run either concurrently or, when any
    // node guards its checkout, strictly sequentially: the `mutates_checkout: false`
    // assertion snapshots before and asserts after a node's own execution, so a
    // concurrent sibling's write landing inside that window would be falsely
    // attributed to the guarded node. Serializing the whole layer keeps that window
    // exclusive — including loop/loop_group/workflow siblings whose internal
    // execution would otherwise overlap it.
    const nodeThunks = layer.map(
      (node): (() => Promise<LayerNodeResult>) =>
        async (): Promise<LayerNodeResult> => {
          try {
            // Include nodes are expanded away at discovery time (include-expander.ts): one
            // must never reach the executor. This guard is FIRST in the per-node body — before
            // resume-skip, `when:`, and trigger-rule handling — so an unexpanded include node
            // cannot slip through by matching a prior-completed entry, a false `when:`, or a
            // failing trigger rule. If one gets here, discovery was bypassed; fail loud rather
            // than silently accepting an invalid runtime DAG.
            if (isIncludeDirective(node)) {
              throw new Error(
                `Internal error: include node '${node.id}' reached the executor unexpanded. ` +
                  'Include nodes must be resolved by expandWorkflowIncludes() during discovery.'
              );
            }

            const checkpointSessionForProvider = (
              provider: string
            ): SessionCheckpoint | undefined => {
              const handles = ctx.nodeSessionHandles;
              if (handles === undefined || ctx.namedResumeSourceIds?.has(node.id) !== true) {
                return undefined;
              }
              return async (sessionId: string): Promise<void> => {
                await deps.store.upsertWorkflowRunNodeSession({
                  workflow_run_id: workflowRun.id,
                  node_id: node.id,
                  provider,
                  provider_session_id: sessionId,
                });
              };
            };

            // `systemPrompt:` and `agents.*` go straight to the provider, so they get the
            // same two substitution passes a `prompt:` does (#2476). Inside a loop_group
            // body this reads the body's scoped `nodeOutputs`, matching every other surface.
            const resolveAiConfigText = (text: string): string =>
              substituteNodeOutputRefs(
                substituteWorkflowVariables(
                  text,
                  workflowRun.id,
                  workflowRun.user_message,
                  artifactsDir,
                  baseBranch,
                  docsDir,
                  issueContext,
                  undefined,
                  undefined,
                  undefined,
                  { stateDir, inputs: resolveRunInputs(workflowRun) }
                ).prompt,
                ctx.nodeOutputs
              );

            // A prior success is reusable only while every enclosing include is still active.
            // Unlike ordinary node-local rules, a composed boundary governs the whole block,
            // so resume must not let a stale completed descendant cross a newly-false gate.
            const isCachedPriorSuccess =
              priorCompletedNodes?.has(node.id) === true && !node.always_run;
            const composedBoundaryDecision = checkComposedBlockBoundaries(
              node,
              ctx.nodeOutputs,
              resolveRunInputs(workflowRun),
              isCachedPriorSuccess
            );

            // 0. Skip if this node completed successfully in a prior run (resume path),
            // unless its composed boundary is now inactive. `always_run: true` opts the
            // node out of resume caching and re-executes it.
            if (priorCompletedNodes?.has(node.id)) {
              // Three sites below (always_run reset, cache invalidation, and the
              // prior-success skip re-emit) all persist THIS node's prior output through
              // the same bounded-preview+spill helper, keyed by its own step_name (#2726)
              // — captured once here rather than repeating the lookup at each call site.
              const formatThisNodesPriorOutput = (
                stepName: string
              ): ReturnType<typeof formatPersistedNodeOutput> =>
                formatPersistedNodeOutput(
                  priorCompletedNodes.get(node.id)?.output ?? '',
                  artifactsDir,
                  stepName
                );
              if (node.always_run) {
                getLog().info({ nodeId: node.id }, 'dag.node_always_run_resume_forced');
                const alwaysRunStepName = stepNamePrefix + node.id;
                // The prior value being reset can be arbitrarily large — getDagResumeSnapshot
                // prefers the full spilled text over the bounded preview (#2726), so this
                // audit row must go through the same bounded-preview+spill helper as the
                // primary node_completed/node_skipped_prior_success writers, not the raw text.
                const alwaysRunPriorOutput = formatThisNodesPriorOutput(alwaysRunStepName);
                deps.store
                  .createWorkflowEvent({
                    workflow_run_id: workflowRun.id,
                    event_type: 'node_always_run_reset',
                    step_name: alwaysRunStepName,
                    data: persistedOutputEventFields(alwaysRunPriorOutput, 'prior_output'),
                  })
                  .catch((err: Error) => {
                    getLog().error(
                      { err, workflowRunId: workflowRun.id, eventType: 'node_always_run_reset' },
                      'workflow_event_persist_failed'
                    );
                  });
                // falls through to re-execute the node
              } else if (composedBoundaryDecision === 'run') {
                // #2402 — a cached prior-success skip is only safe when every
                // dependency's current value still matches the prior snapshot.
                // If any dep re-ran during this resume (e.g. an `always_run: true`
                // upstream forced a re-execution, or any dep produced fresh
                // output), the cached value reflects the OLD dep output and would
                // otherwise report success over stale synthesis. Invalidate and
                // fall through to a fresh execution instead.
                const staleDeps = getStaleCachedDependencies(
                  node,
                  ctx.nodeOutputs,
                  priorCompletedNodes
                );
                if (staleDeps.length > 0) {
                  const invalidatedStepName = stepNamePrefix + node.id;
                  // Same rationale as the always_run reset above: prior.output can now be
                  // the full spilled text, so this audit row needs the same bounding (#2726).
                  const invalidatedPriorOutput = formatThisNodesPriorOutput(invalidatedStepName);
                  getLog().info(
                    { nodeId: node.id, invalidatingDeps: staleDeps },
                    'dag.node_prior_cache_invalidated'
                  );
                  deps.store
                    .createWorkflowEvent({
                      workflow_run_id: workflowRun.id,
                      event_type: 'node_prior_cache_invalidated',
                      step_name: invalidatedStepName,
                      data: {
                        reason: 'stale_dependency',
                        invalidating_deps: staleDeps,
                        ...persistedOutputEventFields(invalidatedPriorOutput, 'prior_output'),
                        // Carry the cached logical value too so the audit log shows
                        // exactly what was thrown away, matching the text channel
                        // (#2637).
                        ...(priorCompletedNodes.get(node.id)?.structuredOutput !== undefined
                          ? {
                              prior_structured_output: priorCompletedNodes.get(node.id)
                                ?.structuredOutput,
                            }
                          : {}),
                      },
                    })
                    .catch((err: Error) => {
                      getLog().error(
                        {
                          err,
                          workflowRunId: workflowRun.id,
                          eventType: 'node_prior_cache_invalidated',
                        },
                        'workflow_event_persist_failed'
                      );
                    });
                  // falls through to re-execute the node with fresh dep output
                } else {
                  getLog().info({ nodeId: node.id }, 'dag.node_skipped_prior_success');
                  await logNodeSkip(logDir, workflowRun.id, node.id, 'prior_success').catch(
                    (err: Error) => {
                      getLog().warn({ err, nodeId: node.id }, 'dag.node_skip_log_write_failed');
                    }
                  );
                  const skipStepName = stepNamePrefix + node.id;
                  // Copy the logical value forward (#2637) so a SECOND resume's snapshot
                  // still sees it — this re-emit is that resume's source. `prior.output` is
                  // already the FULL value (getDagResumeSnapshot prefers the spill over the
                  // truncated preview when one exists, #2726), so it must go back through the
                  // same bounded-preview+spill helper here or this row would re-introduce an
                  // unbounded write on every subsequent resume pass.
                  const priorSkipOutput = formatThisNodesPriorOutput(skipStepName);
                  deps.store
                    .createWorkflowEvent({
                      workflow_run_id: workflowRun.id,
                      event_type: 'node_skipped_prior_success',
                      step_name: skipStepName,
                      data: {
                        reason: 'prior_success',
                        ...persistedOutputEventFields(priorSkipOutput, 'node_output'),
                        ...(priorCompletedNodes.get(node.id)?.structuredOutput !== undefined
                          ? {
                              structured_output: priorCompletedNodes.get(node.id)?.structuredOutput,
                            }
                          : {}),
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
                    nodeName: nodeDisplayName(node),
                    reason: 'prior_success',
                  });
                  // Return the pre-populated output (already in nodeOutputs)
                  return {
                    nodeId: node.id,
                    output: ctx.nodeOutputs.get(node.id) ?? {
                      state: 'skipped' as const,
                      output: '',
                    },
                  };
                }
              }
            }

            // 1. Enforce every enclosing include boundary before this node's local rule.
            const triggerDecision =
              composedBoundaryDecision === 'skip'
                ? 'skip'
                : checkTriggerRule(node, ctx.nodeOutputs);
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
                nodeName: nodeDisplayName(node),
                reason: 'trigger_rule',
              });
              return { nodeId: node.id, output: { state: 'skipped' as const, output: '' } };
            }

            // 2. Evaluate when: condition
            if (node.when !== undefined) {
              // This run's named inputs are threaded in so `when: "$INPUTS.mode == 'fast'"`
              // branches on a caller's `with:` value. Without it a sub-run child could READ
              // `$INPUTS.mode` in a prompt but never branch on it — the ref parsed as a node
              // called `INPUTS` and failed the node (#2453 defect 1).
              const { result: conditionPasses, parsed: conditionParsed } = evaluateCondition(
                node.when,
                ctx.nodeOutputs,
                resolveRunInputs(workflowRun)
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
                  nodeName: nodeDisplayName(node),
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
                  nodeName: nodeDisplayName(node),
                  reason: 'when_condition',
                });
                return {
                  nodeId: node.id,
                  output: { state: 'skipped' as const, output: '' },
                };
              }
            }

            // 2.5 Run-wide budget gate (#1961): refuse to START this node when either
            // ceiling is already met. Placed after skip/trigger/when handling so cached
            // and skipped nodes never trip it, and before dispatch so refusal costs
            // nothing. Nodes already in flight when a ceiling is crossed finish —
            // overshoot is bounded by one layer.
            {
              const budgetExhaustion = checkBudgetExhaustion(ctx.budget, ctx.budgetLedger);
              if (budgetExhaustion !== undefined) {
                const budgetMsg = `Node '${node.id}' refused: run budget exhausted — ${describeBudgetExhaustion(budgetExhaustion)}`;
                getLog().warn(
                  {
                    workflowRunId: workflowRun.id,
                    nodeId: node.id,
                    ...budgetExhaustion,
                  },
                  'dag.budget_exhausted_node_refused'
                );
                deps.store
                  .createWorkflowEvent({
                    workflow_run_id: workflowRun.id,
                    event_type: 'budget_exhausted',
                    step_name: stepNamePrefix + node.id,
                    data: { phase: 'pre_dispatch', ...budgetExhaustion },
                  })
                  .catch((err: Error) => {
                    getLog().error(
                      { err, workflowRunId: workflowRun.id, eventType: 'budget_exhausted' },
                      'workflow_event_persist_failed'
                    );
                  });
                getWorkflowEventEmitter().emit({
                  type: 'node_failed',
                  runId: workflowRun.id,
                  nodeId: node.id,
                  nodeName: nodeDisplayName(node),
                  error: budgetMsg,
                });
                await safeSendMessage(platform, conversationId, `⛔ ${budgetMsg}`, {
                  workflowId: workflowRun.id,
                  nodeName: node.id,
                });
                return {
                  nodeId: node.id,
                  output: { state: 'failed' as const, output: '', error: budgetMsg },
                };
              }
            }

            // 3. Non-agent node dispatch. A real `switch (node.kind)` (not a chain of
            // `isXNode` guards) so the compiler enforces exhaustiveness: the `default`
            // branch's `never` assignment fails to compile the moment a new `DagNode`
            // kind is added without a matching `case` here (AC1). Every case below
            // returns except `'agent'`, which `break`s to fall through to the shared
            // agent-handling code that follows — `node` narrows to `AgentNode` there.
            switch (node.kind) {
              case 'exec': {
                // Bash/script dispatch — no AI, no session. Opt-in retry only: a
                // deterministic node retries solely when it declares an explicit
                // `retry:` block (single attempt otherwise), so side-effectful scripts
                // aren't silently re-run (#2088).
                //
                // `executeBashNode`/`executeScriptNode` stay two separate functions
                // rather than one `executeExecNode(node.runtime)` — deliberate, not an
                // oversight (#2718). See the rationale on `execNodeSchema` in
                // schemas/dag-node.ts.
                if (node.runtime === 'sh') {
                  const excludes = checkoutSnapshotExcludes(artifactsDir, stateDir, logDir);
                  const treeBefore =
                    node.mutates_checkout === false
                      ? await snapshotCheckout(cwd, excludes)
                      : undefined;
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
                        stateDir,
                        logDir,
                        baseBranch,
                        docsDir,
                        ctx.nodeOutputs,
                        issueContext,
                        config.envVars,
                        config.protectedEnvKeys,
                        config.protectedCredentialValues,
                        stepNamePrefix,
                        iteration,
                        ctx.bodyLoopUserInput ?? '',
                        execContext,
                        chargeWorkUnit
                      )
                  );
                  return {
                    nodeId: node.id,
                    output: await assertCheckoutUntouched(
                      node,
                      cwd,
                      excludes,
                      treeBefore,
                      output,
                      deps,
                      workflowRun.id,
                      stepNamePrefix + node.id
                    ),
                  };
                }
                // Script dispatch — runs via bun or uv. Same opt-in retry rule as bash
                // (#2088): retries solely when an explicit `retry:` block is declared.
                const excludes = checkoutSnapshotExcludes(artifactsDir, stateDir, logDir);
                const treeBefore =
                  node.mutates_checkout === false
                    ? await snapshotCheckout(cwd, excludes)
                    : undefined;
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
                      stateDir,
                      logDir,
                      baseBranch,
                      docsDir,
                      ctx.nodeOutputs,
                      issueContext,
                      config.envVars,
                      config.protectedEnvKeys,
                      config.protectedCredentialValues,
                      stepNamePrefix,
                      iteration,
                      ctx.bodyLoopUserInput ?? '',
                      execContext,
                      ctx.workflowSourceRoots,
                      chargeWorkUnit
                    )
                );
                return {
                  nodeId: node.id,
                  output: await assertCheckoutUntouched(
                    node,
                    cwd,
                    excludes,
                    treeBefore,
                    output,
                    deps,
                    workflowRun.id,
                    stepNamePrefix + node.id
                  ),
                };
              }

              case 'loop': {
                // Loop node dispatch — manages its own AI sessions and iteration
                const {
                  provider: loopProvider,
                  options: loopOptions,
                  model: resolvedLoopModel,
                  tier: resolvedLoopTier,
                  effort: resolvedLoopEffort,
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
                  resolveAiConfigText,
                  ctx.warnedProviderConflicts,
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
                  stateDir,
                  logDir,
                  baseBranch,
                  docsDir,
                  ctx.nodeOutputs,
                  config,
                  issueContext,
                  configuredCommandFolder,
                  stepNamePrefix,
                  execContext,
                  resolvedLoopModel,
                  resolvedLoopTier,
                  resolvedLoopEffort,
                  checkpointSessionForProvider(loopProvider),
                  ctx.workflowSourceRoots,
                  chargeWorkUnit
                );
                // Loop nodes run every iteration on the same resolved provider, so the
                // result session (if any) is attributable to loopProvider — tag it so a
                // downstream sequential node on a different provider starts fresh (#1992).
                return { nodeId: node.id, output, sessionProvider: loopProvider };
              }

              case 'loop_group': {
                // Loop-group node dispatch — manages its own subgraph iteration
                // (body is a sealed sub-DAG re-executed per iteration; the loop is
                // encapsulated inside this one node, keeping the outer DAG acyclic).
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
                  resolveAiConfigText,
                  ctx.warnedProviderConflicts,
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
                  stateDir,
                  logDir,
                  baseBranch,
                  docsDir,
                  ctx.nodeOutputs,
                  config,
                  ctx.warnedProviderConflicts,
                  ctx.loopGroupPath,
                  issueContext,
                  stepNamePrefix,
                  execContext,
                  ctx.runChildWorkflow,
                  ctx.workflowSourceRoots,
                  ctx.budget,
                  ctx.budgetLedger
                );
                return { nodeId: node.id, output };
              }

              case 'gate': {
                // Approval node dispatch — pauses workflow for human review
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
                  stateDir,
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
                  execContext,
                  ctx.workflowSourceRoots,
                  () => {
                    if (ctx.budgetLedger !== undefined) ctx.budgetLedger.workUnits++;
                  }
                );
                return { nodeId: node.id, output };
              }

              case 'wait': {
                const loopFrame = loopGroupPath.at(-1);
                const output = await executeWaitNode(
                  node,
                  workflowRun,
                  deps,
                  ctx.nodeOutputs,
                  stepNamePrefix,
                  loopFrame === undefined
                    ? undefined
                    : {
                        groupId: loopFrame.groupId,
                        iteration: loopFrame.iteration,
                        sessionId: ctx.lastSequentialSession?.sessionId ?? null,
                        sessionProvider: ctx.lastSequentialSession?.provider ?? null,
                      }
                );
                return { nodeId: node.id, output };
              }

              case 'halt': {
                // Cancel node dispatch — terminates the workflow run
                const reason = substituteNodeOutputRefs(node.reason, ctx.nodeOutputs);
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

              case 'workflow': {
                // Workflow (sub-run) node dispatch — starts/re-inspects a child run
                // (#2121 Phase 2). Makes no direct provider call; the closure captured on
                // ctx.runChildWorkflow drives the child's own executeWorkflow. The
                // output_type sidecar is handled by the shared completed-node path;
                // node_completed is written inline by executeWorkflowNode itself (see
                // asCompleted — only on true completion, never on the paused branch).
                const output = await executeWorkflowNode(node, ctx);
                return { nodeId: node.id, output };
              }

              case 'agent':
                break;

              default: {
                const unreachable: never = node;
                throw new Error(
                  `unreachable: node '${(unreachable as { id: string }).id}' matched no dispatch branch`
                );
              }
            }

            // 4. Resolve per-node provider/model/options
            const {
              provider,
              model: resolvedNodeModel,
              options: nodeOptions,
              tier: resolvedTier,
              effort: resolvedEffort,
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
              resolveAiConfigText,
              ctx.warnedProviderConflicts,
              execContext
            );

            // 5. Determine session. An explicit named ancestor has first priority and
            // is independent of the ambient sequential cursor and parallel-layer reset.
            const namedResumeSourceNodeId = isNodeContextResume(node.context)
              ? node.context.resume
              : undefined;
            const hasNamedSessionResume = namedResumeSourceNodeId !== undefined;
            let resumeSessionId: string | undefined;
            if (hasNamedSessionResume) {
              const sourceNodeId = namedResumeSourceNodeId;
              const sourceHandle = ctx.nodeSessionHandles?.get(sourceNodeId);
              if (sourceHandle === undefined) {
                throw new Error(
                  `Node '${node.id}' cannot resume '${sourceNodeId}': the completed source has no available provider session.`
                );
              }
              if (sourceHandle.sessionId.trim() === '') {
                throw new Error(
                  `Node '${node.id}' cannot resume '${sourceNodeId}': the completed source has no available provider session.`
                );
              }
              if (sourceHandle.provider !== provider) {
                throw new Error(
                  `Node '${node.id}' cannot resume '${sourceNodeId}': source provider '${sourceHandle.provider}' does not match resolved provider '${provider}'.`
                );
              }
              const caps = deps.getAgentProvider(provider).getCapabilities();
              if (!caps.sessionResume || caps.sessionFork !== true) {
                throw new Error(
                  `Node '${node.id}' cannot resume '${sourceNodeId}': resolved provider '${provider}' does not support immutable session forks.`
                );
              }
              resumeSessionId = sourceHandle.sessionId;
            }

            // Legacy scalar/default selection — parallel or context:fresh → always fresh.
            // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
            // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
            // isFreshSequential controls in-run threading (lastSequentialSession).
            // Cross-provider guard (#1992): a session id can only be resumed by the provider
            // that created it, so the cursor is threaded only into nodes that resolve to the
            // SAME provider — on a provider change the node starts fresh instead of failing
            // (Claude) or silently cold-falling-back (Codex) on a foreign session id.
            //
            // A composed workflow's ENTRY node is the third fresh case (#1764). Standalone,
            // that node runs first and has no cursor to inherit; composed, it would silently
            // pick up the session of whatever the parent ran before it — the same file
            // behaving differently depending on who composed it. The boundary is where a
            // different file's history begins, so the cursor is cleared for the same reason
            // a parallel layer clears it. `context: 'shared'` is the individual opt-out for
            // an author who genuinely wants the parent's thread to continue into the block.
            const composedBlockEntry =
              readComposedMeta(node)?.blockEntry === true && node.context !== 'shared';
            const isFreshSequential =
              isParallelLayer || node.context === 'fresh' || composedBlockEntry;
            const cursor = ctx.lastSequentialSession;
            if (!hasNamedSessionResume) {
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
              if (persistScopeKey && !hasNamedSessionResume) {
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
            // `mutates_checkout: false` (#2771) is asserted OUTSIDE the retry loop:
            // the snapshot covers every attempt, and a violation fails the node
            // without offering retry another chance to mutate.
            const checkoutExcludes = checkoutSnapshotExcludes(artifactsDir, stateDir, logDir);
            const treeBefore =
              node.mutates_checkout === false
                ? await snapshotCheckout(cwd, checkoutExcludes)
                : undefined;
            const retriedOutput = await runNodeRetryLoop(
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
                  stateDir,
                  logDir,
                  baseBranch,
                  docsDir,
                  ctx.nodeOutputs,
                  // Always pass the prior session ID. executeNodeInternal requests a fork,
                  // but legacy resume-only providers may continue in place; named resume
                  // separately capability-gates and verifies an exact fork.
                  resumeSessionId,
                  configuredCommandFolder,
                  issueContext,
                  resolvedNodeModel,
                  resolvedTier,
                  resolvedEffort,
                  stepNamePrefix,
                  iteration,
                  checkpointSessionForProvider(provider),
                  ctx.workflowSourceRoots,
                  chargeWorkUnit
                ),
              { state: 'failed', output: '', error: 'Node did not execute' } as NodeExecutionResult
            );
            const output = await assertCheckoutUntouched(
              node,
              cwd,
              checkoutExcludes,
              treeBefore,
              retriedOutput,
              deps,
              workflowRun.id,
              stepNamePrefix + node.id
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
              !hasNamedSessionResume &&
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
                data: {
                  error: err.message,
                  ...(isNodeContextResume(node.context)
                    ? { session_source_node_id: node.context.resume }
                    : {}),
                },
              })
              .catch((dbErr: Error) => {
                getLog().error({ err: dbErr, nodeId: node.id }, 'workflow_event_persist_failed');
              });
            getWorkflowEventEmitter().emit({
              type: 'node_failed',
              runId: workflowRun.id,
              nodeId: node.id,
              nodeName: nodeDisplayName(node),
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
        }
    );
    // A guarded node in the layer forces fully sequential execution (see the thunk
    // comment above); an unguarded layer keeps the concurrent `allSettled` path.
    const layerResults = layer.some(node => node.mutates_checkout === false)
      ? await settleSequentially(nodeThunks)
      : await Promise.allSettled(nodeThunks.map(thunk => thunk()));

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
        if (output.costUsd !== undefined) {
          // Same guard as tokens below, and for the same reason: cost comes from
          // providers (incl. community ones), and one NaN poisons the run total for
          // every other node — NaN > 0 is false, so the cost is dropped from the run
          // row and telemetry with no trace. Exactly the silent loss #2469 exists to
          // remove. Guarded here, at the single aggregation point, so one bad node
          // costs only its own contribution.
          if (Number.isFinite(output.costUsd)) {
            ctx.totalCostUsd += output.costUsd;
            // Budget-ledger mirror (#1961), top level only: a loop-group body shares the
            // ledger by reference, so aggregating there too would double-count body spend
            // (the outer rollup of the group's costUsd already carries it).
            if (ctx.budgetLedger !== undefined && ctx.stepNamePrefix === '') {
              ctx.budgetLedger.spendUsd += output.costUsd;
            }
          } else {
            getLog().warn({ nodeId, costUsd: output.costUsd }, 'dag.usage_cost_non_finite_ignored');
          }
        }
        if (output.tokens !== undefined) {
          ctx.totalTokens = sumTokenUsage(
            [...(ctx.totalTokens !== undefined ? [ctx.totalTokens] : []), output.tokens],
            { nodeId }
          );
        }
        if (output.loopIterations !== undefined) ctx.totalLoopIterations += output.loopIterations;
        ctx.nodeOutputs.set(nodeId, output);
        if (
          ctx.nodeSessionHandles !== undefined &&
          ctx.namedResumeSourceIds?.has(nodeId) === true &&
          output.state === 'completed' &&
          output.sessionId !== undefined &&
          sessionProvider !== undefined
        ) {
          ctx.nodeSessionHandles.set(nodeId, {
            sessionId: output.sessionId,
            provider: sessionProvider,
          });
        }
        // Typed artifact: when a node declares `output_type`, persist its output
        // as a typed sidecar so other nodes and later runs can locate it by type.
        // The writer keeps top-level node paths stable and qualifies loop body
        // paths with ctx.loopGroupPath. Best-effort — a metadata write must never
        // fail an otherwise-successful node.
        const completedNode = nodeById.get(nodeId);
        if (output.state === 'completed' && completedNode?.output_type) {
          const meta = {
            nodeId,
            outputType: completedNode.output_type,
            runId: workflowRun.id,
            producedAt: new Date().toISOString(),
            ...(loopGroupPath.length > 0 ? { loopGroupPath } : {}),
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

    await ctx.afterLayer?.();

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
  const visit = (ns: readonly (DagNode | IncludeDirective)[]): void => {
    for (const node of ns) {
      if (isIncludeDirective(node) || isExecNode(node) || isHaltNode(node)) continue;
      if (isLoopGroupNode(node)) {
        check(resolveNodeProviderForPreflight(node, workflowProvider, aiProfile));
        visit(node.loop_group.nodes);
        continue;
      }
      if (isGateNode(node)) {
        if (node.decisions.some(d => d.rework !== undefined)) {
          check(resolveNodeProviderForPreflight(node, workflowProvider, aiProfile));
        }
        continue;
      }
      // agent / loop → AI node
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
  // run is paused-for-writeback without the resume marker (M3): pass it via the shared
  // pause helper's `extraMetadata`, one merged write. `failClosed: true` preserves this
  // gate's existing fail-closed contract — a lost pause here must never fall through
  // toward the apply/teardown path (throwing is the safe behavior, and the H2
  // teardown-preserve logic keeps the overlay volume for a retry), so it rethrows
  // instead of tolerating the CAS miss the way the other four gate types do. This also
  // emits the `approval_pending` live pause signal on success (same event the approval
  // node emits, so the existing pause UI shows approve/reject) — the lifecycle event
  // below now fires just after it instead of just before; both are best-effort,
  // fire-and-forget emits with no ordering contract.
  await pauseGateRespectingExternalTransition(
    deps,
    runId,
    { nodeId: WRITEBACK_GATE_NODE_ID, message, type: 'writeback' },
    {
      extraMetadata: {
        pending_writeback: { envId: containerCtx.envId, ...(summary ? { summary } : {}) },
      },
      failClosed: true,
    }
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
    /** Run-wide work/spend ceilings (#1961) — enforced at dispatch time. */
    budget?: WorkflowBudgetPolicy;
    /** Declared `returns:` node id (#2470) — rebinds a CHILD run's terminal output. */
    returns?: string;
    /** Required boolean property on `returns:` that authors the durable run outcome. */
    outcome_field?: string;
  } & WorkflowLevelOptions,
  workflowRun: WorkflowRun,
  workflowProvider: string,
  workflowModel: string | undefined,
  artifactsDir: string,
  stateDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  config: WorkflowConfig,
  configuredCommandFolder?: string,
  issueContext?: string,
  priorCompletedNodes?: Map<string, PersistedNodeOutput>,
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
  runChildWorkflow?: RunChildWorkflowFn,
  /** Cumulative usage restored on resume, from prior completion AND failure events. */
  priorUsage?: PriorRunUsage,
  /** Private run-scoped handles restored before a cold resume transitions to running. */
  priorNodeSessions?: readonly WorkflowRunNodeSession[],
  /**
   * Roots this run's commands and scripts are read from. Undefined here means the caller
   * has no capture (an in-process caller with a hand-built definition); the boundary below
   * normalizes it to live roots ONCE so nothing downstream has to.
   */
  workflowSourceRoots?: WorkflowSourceRoots
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

  // Run-wide budget ledger (#1961). One shared, mutated-in-place record of what this
  // run has consumed, seeded from prior usage so a cold resume continues the same
  // accounting rather than starting a fresh allowance.
  const budgetLedger: RunBudgetLedger | undefined = workflow.budget
    ? {
        spendUsd: priorUsage?.costUsd ?? 0,
        workUnits: priorUsage?.workUnits ?? 0,
      }
    : undefined;

  // Pre-start refusal (#1961): a resumed run whose ledger already meets a ceiling
  // fails explicitly here — before any node dispatch, container churn, or fresh
  // spend — instead of cold-resuming into silent new work. A fresh run's ledger is
  // zeroed, so this can only fire on resume.
  {
    const exhaustion = checkBudgetExhaustion(workflow.budget, budgetLedger);
    if (exhaustion !== undefined && workflow.budget !== undefined) {
      const reason = describeBudgetExhaustion(exhaustion);
      const failMsg =
        `DAG workflow '${workflow.name}' refused: ${reason} ` +
        '(no further nodes will start; resume after raising the budget or cancel the run).';
      getLog().warn(
        { workflowRunId: workflowRun.id, ...exhaustion },
        'dag.budget_exhausted_pre_start'
      );
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'budget_exhausted',
        step_name: 'budget',
        data: { phase: 'pre_start', ...exhaustion },
      });
      await deps.store.failWorkflowRun(workflowRun.id, failMsg).catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id },
          'dag.budget_refusal_fail_failed'
        );
      });
      await logWorkflowError(logDir, workflowRun.id, failMsg).catch((logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      });
      const emitterForBudget = getWorkflowEventEmitter();
      emitterForBudget.emit({
        type: 'workflow_failed',
        runId: workflowRun.id,
        workflowName: workflow.name,
        error: failMsg,
      });
      emitterForBudget.unregisterRun(workflowRun.id);
      await safeSendMessage(platform, conversationId, `\u26D4 ${failMsg}`, {
        workflowId: workflowRun.id,
      });
      return undefined;
    }
  }

  const workflowTier = workflow.model && isTierName(workflow.model) ? workflow.model : undefined;
  const workflowLevelOptions = {
    effort: workflow.effort,
    thinking: workflow.thinking,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
    webSearchMode: workflow.webSearchMode,
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
    for (const [nodeId, prior] of priorCompletedNodes) {
      const node = nodesById.get(nodeId);
      // Nodes flagged always_run re-execute on resume — leave them for fresh output.
      if (node?.always_run) continue;
      // Re-derive a schema-capable producer's declared field set from the loaded
      // definition so its strict `$node.output.field` contract survives resume (#2091).
      // A loop_group is the exception: its output_format is ignored, so it never gets
      // declaredFields — but its persisted terminal payload (below) still rehydrates,
      // matching fresh completion since #2637.
      const declaredFields =
        node !== undefined && !isLoopGroupNode(node)
          ? declaredFieldsFromSchema(node.output_format)
          : undefined;
      nodeOutputs.set(nodeId, {
        state: 'completed',
        output: prior.output,
        // The persisted logical value (#2637): downstream whole-value and `.field`
        // consumers observe exactly what fresh execution exposed. Absent for rows
        // persisted before the key existed — those keep the text-parse fallback.
        ...(prior.structuredOutput !== undefined
          ? { structuredOutput: prior.structuredOutput }
          : {}),
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
  const namedResumeSourceIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (isNodeContextResume(node.context)) namedResumeSourceIds.add(node.context.resume);
  }
  const nodeSessionHandles = new Map<string, SequentialSessionCursor>();
  for (const row of priorNodeSessions ?? []) {
    // The completed-output snapshot is the authority for which nodes actually
    // survived the previous pass. Never resurrect a handle without its completion.
    if (namedResumeSourceIds.has(row.node_id) && nodeOutputs.has(row.node_id)) {
      nodeSessionHandles.set(row.node_id, {
        sessionId: row.provider_session_id,
        provider: row.provider,
      });
    }
  }

  // Persist the authored verdict as soon as the selected result is available,
  // independently from every lifecycle branch below (#2618). The initial call
  // covers a selected node rehydrated from node_completed events on resume; the
  // awaited per-layer hook captures a fresh result before later work can pause or
  // fail; and the unwind backstop covers a fatal throw while aggregating that layer.
  // A same-value write is skipped, but a genuine re-execution may replace the
  // prior verdict.
  let persistedOutcome: WorkflowRunOutcome | null = workflowRun.outcome;
  const persistAuthoredOutcome = async (): Promise<void> => {
    const field = workflow.outcome_field;
    const returns = workflow.returns;
    if (field === undefined || returns === undefined) return;
    const selectedOutput = nodeOutputs.get(returns);
    if (selectedOutput?.state !== 'completed') return;

    const resolution = resolveNodeOutputField(selectedOutput, returns, field);
    if (resolution.kind !== 'value' || typeof resolution.value !== 'boolean') {
      throw new Error(
        `Workflow outcome_field '${field}' on returns node '${returns}' did not resolve to a boolean`
      );
    }
    const outcome: WorkflowRunOutcome = resolution.value ? 'succeeded' : 'failed';
    if (outcome === persistedOutcome) return;
    await deps.store.updateWorkflowRun(workflowRun.id, { outcome });
    persistedOutcome = outcome;
  };

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
    // Normalized once, here. Everything below takes concrete roots.
    workflowSourceRoots: workflowSourceRoots ?? liveSourceRoots(cwd),
    config,
    workflowProvider,
    workflowModel,
    workflowLevelOptions,
    aiProfile,
    workflowPreset,
    artifactsDir,
    stateDir,
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
    afterLayer: persistAuthoredOutcome,
    priorCompletedNodes,
    nodeSessionHandles,
    namedResumeSourceIds,
    lastSequentialSession: undefined,
    warnedProviderConflicts: new Set<string>(),
    totalCostUsd: priorUsage?.costUsd ?? 0,
    totalTokens: priorUsage?.tokens,
    totalLoopIterations: 0,
    budget: workflow.budget,
    budgetLedger,
    stepNamePrefix: '',
    loopGroupPath: [],
  };

  /**
   * Persist what this run spent, whatever becomes of it (#2469).
   *
   * Usage used to be written in exactly one place — the metadata argument of
   * `completeWorkflowRun` below — which tied the record to a single outcome. A run
   * that burned tokens and then failed, was cancelled out of band, or paused at a
   * gate recorded no spend at all, and since `childOutcomeFromRun` reads cost and
   * tokens straight off the child's row, a fan-out aggregate silently became Σ of
   * *completed* children. With `all_done` the default join, that made partial failure
   * — the ordinary case — under-report with no warning.
   *
   * Every disposition below (container pause, external cancel/pause, the two failure
   * branches, the evidence gate, the write-back gate, completion) is reached from the
   * one point where the accumulators are settled and identical, so the write belongs
   * HERE rather than in each of them. It goes through `updateWorkflowRun`, not the
   * terminal writers, because that merge carries no `WHERE status = 'running'` guard
   * and so still lands on a row another process has already flipped to `cancelled`.
   * Same ordering as the evidence gate: metadata first, terminal status after.
   *
   * Best-effort by design — a bookkeeping write must not fail an otherwise-fine run —
   * but never silent: the whole defect was a number quietly going missing.
   */
  const persistRunUsage = async (): Promise<void> => {
    const usage = {
      // No usage stays absent: a bash-only workflow must not read as a free AI run.
      ...(runCtx.totalCostUsd > 0 ? { total_cost_usd: runCtx.totalCostUsd } : {}),
      ...(runCtx.totalTokens !== undefined
        ? {
            total_tokens_in: runCtx.totalTokens.input,
            total_tokens_out: runCtx.totalTokens.output,
            ...(runCtx.totalTokens.cacheRead !== undefined
              ? { total_cache_read_tokens: runCtx.totalTokens.cacheRead }
              : {}),
            ...(runCtx.totalTokens.cacheWrite !== undefined
              ? { total_cache_write_tokens: runCtx.totalTokens.cacheWrite }
              : {}),
            // Marks the two cache totals above as a floor rather than an exact figure.
            ...(runCtx.totalTokens.cachePartial ? { total_cache_partial: true } : {}),
          }
        : {}),
    };
    if (Object.keys(usage).length === 0) return;
    await deps.store
      .updateWorkflowRun(workflowRun.id, { metadata: usage })
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id },
          'dag.run_usage_persist_failed'
        );
      });
  };

  const scheduleQuotaResume = async (): Promise<ScheduledWorkflowResume | undefined> => {
    const policy = config.workflows;
    if (policy?.autoResumeOnQuotaReset !== true) return undefined;
    if (execContext.kind === 'container') {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'quota_resume_skipped',
        data: { reason: 'container_unsupported' },
      });
      return undefined;
    }
    const prior = isScheduledWorkflowResume(workflowRun.metadata?.scheduled_resume)
      ? workflowRun.metadata.scheduled_resume
      : undefined;
    const quotaFailure = [...runCtx.nodeOutputs.values()].find(
      (output): output is Extract<NodeOutput, { state: 'failed' }> =>
        output.state === 'failed' && isQuotaExhaustionError(output.error)
    );
    if (quotaFailure === undefined) return undefined;
    const now = new Date();
    const maxAttempts = policy.quotaMaxAttempts;
    const attempt = (prior?.attempt ?? 0) + 1;
    const deadlineMs = policy.quotaDeadlineMs;
    const deadlineAt = prior?.deadlineAt ?? new Date(now.getTime() + deadlineMs).toISOString();
    if (attempt > maxAttempts) {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'quota_resume_exhausted',
        data: { attempt, max_attempts: maxAttempts },
      });
      return undefined;
    }

    let resumeAt = extractQuotaResetAt(quotaFailure.error, now);
    if (resumeAt === null || resumeAt.getTime() <= now.getTime()) {
      const fallback = policy.quotaFallbackDelayMs;
      resumeAt = fallback !== undefined ? new Date(now.getTime() + fallback) : null;
    }
    if (resumeAt === null) {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'quota_resume_skipped',
        data: { reason: 'reset_unavailable' },
      });
      return undefined;
    }
    if (resumeAt.getTime() > Date.parse(deadlineAt)) {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'quota_resume_exhausted',
        data: { reason: 'deadline', deadline_at: deadlineAt },
      });
      return undefined;
    }

    const scheduled: ScheduledWorkflowResume = {
      reason: 'quota',
      resumeAt: resumeAt.toISOString(),
      deadlineAt,
      attempt,
      maxAttempts,
    };
    return scheduled;
  };

  await persistAuthoredOutcome();
  try {
    await runLayers(runCtx);
  } catch (error) {
    // runLayers guards almost everything, but a FATAL platform error can escape its
    // allSettled rejection branch. Persist both durable facts before rethrowing that
    // exact value (including an exotic `throw undefined`). Usage is best-effort. An
    // outcome write failure is secondary here: record it, but never let it mask the
    // execution error already in flight.
    await persistRunUsage();
    try {
      await persistAuthoredOutcome();
    } catch (outcomeError) {
      getLog().error(
        { err: outcomeError as Error, workflowRunId: workflowRun.id },
        'dag.authored_outcome_persist_failed_during_unwind'
      );
    }
    throw error;
  }

  // Normal return has no primary error to preserve, so a verdict persistence failure
  // remains visible to the caller. These two small calls intentionally mirror the
  // unwind path above; extracting a policy flag would hide which error owns the throw.
  await persistRunUsage();
  await persistAuthoredOutcome();
  // Pull the mutated accumulators back into local scope for the terminal tally below.
  const totalCostUsd = runCtx.totalCostUsd;
  const totalTokens = runCtx.totalTokens;
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
    tokens: totalTokens,
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
    // Frontend guards with isValidNodeCounts so missing node_counts is safe. (Usage IS
    // stored: persistRunUsage wrote it at the run tail, before this branch — #2469.)
    const scheduledResume = await scheduleQuotaResume().catch((dbErr: Error) => {
      getLog().error({ err: dbErr, workflowRunId: workflowRun.id }, 'dag.quota_resume_plan_failed');
      return undefined;
    });
    await deps.store
      .failWorkflowRun(workflowRun.id, failMsg, scheduledResume)
      .catch((dbErr: Error) => {
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
    const scheduledResume = await scheduleQuotaResume().catch((dbErr: Error) => {
      getLog().error({ err: dbErr, workflowRunId: workflowRun.id }, 'dag.quota_resume_plan_failed');
      return undefined;
    });
    await deps.store
      .failWorkflowRun(workflowRun.id, failMsg, scheduledResume)
      .catch((dbErr: Error) => {
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

  // Terminal output (the run's "summary"). Computed BEFORE completeWorkflowRun so a
  // sub-run can persist it into its own metadata: a `workflow:` parent re-reads it from
  // there on auto-resume (the child's executeWorkflow return value is discarded across the
  // human gate).
  //
  // #2470: when a CHILD run's workflow declares `returns:`, its terminal output is THAT
  // node's output — even a non-sink — instead of the positional first-sink scan. Gated on
  // parent_run_id: a top-level run's summary stays the sink-scan chat/CLI affordance, not a
  // caller contract. A `returns` node that didn't complete / produced blank output threads
  // '' with a WARN and does NOT fall through to the sink scan (that would resurrect the
  // positional accident under a new name). The loop_group per-iteration terminal scan
  // (~executeLoopGroupNode) is byte-identical and DELIBERATELY unchanged — its result is
  // the iteration's, never a caller's.
  let terminalOutput: string | undefined;
  // The selected terminal node's structured payload (#2637), stamped beside the text
  // summary as `metadata.summary_value` so a parent `workflow:` node threads the
  // LOGICAL value back (fan-out aggregation and `.field` access keep the type).
  let terminalStructuredOutput: unknown;
  if (workflow.returns !== undefined && workflowRun.parent_run_id) {
    const returnsOutput = nodeOutputs.get(workflow.returns);
    const value = returnsOutput?.state === 'completed' ? returnsOutput.output : undefined;
    if (value !== undefined && value.trim().length > 0) {
      terminalOutput = value;
      terminalStructuredOutput =
        returnsOutput !== undefined && 'structuredOutput' in returnsOutput
          ? returnsOutput.structuredOutput
          : undefined;
    } else {
      getLog().warn(
        { workflowRunId: workflowRun.id, returns: workflow.returns },
        'workflow.returns_node_blank_output'
      );
      terminalOutput = '';
    }
  } else {
    const allDependencies = new Set(workflow.nodes.flatMap(n => n.depends_on ?? []));
    const terminalSink = workflow.nodes
      .filter(n => !allDependencies.has(n.id))
      .map(n => nodeOutputs.get(n.id))
      .find(o => o?.state === 'completed' && o.output.trim().length > 0);
    terminalOutput = terminalSink?.output;
    terminalStructuredOutput =
      terminalSink !== undefined && 'structuredOutput' in terminalSink
        ? terminalSink.structuredOutput
        : undefined;
  }

  // Update DB and emit completion
  try {
    await deps.store.completeWorkflowRun(workflowRun.id, {
      node_counts: nodeCounts,
      // Cost and token totals are NOT written here — `persistRunUsage` already wrote
      // them at the run tail, before this branch was chosen (#2469). Keeping a second
      // copy here would be two writers of the same three keys, free to drift.
      // A sub-run persists its terminal summary so the parent can thread it as
      // `$<node>.output` on re-entry. Gated on parent_run_id to bound metadata
      // growth to child runs only (top-level runs return the summary directly).
      // `summary_value` is the additive logical sibling (#2637): old binaries keep
      // reading `summary`, new parents prefer the typed value when present.
      ...(workflowRun.parent_run_id && terminalOutput ? { summary: terminalOutput } : {}),
      ...(workflowRun.parent_run_id && terminalOutput && terminalStructuredOutput !== undefined
        ? { [SUBRUN_METADATA_KEYS.summaryValue]: terminalStructuredOutput }
        : {}),
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
  await logWorkflowComplete(logDir, workflowRun.id, {
    // `> 0` rather than `!== undefined`, mirroring persistRunUsage above: the accumulator
    // is a plain number seeded at 0, so zero is the only way it can say "no AI usage" —
    // and a bash-only run must not read as a free AI run on the transcript either.
    ...(totalCostUsd > 0 ? { cost_usd: totalCostUsd } : {}),
    ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
  });
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
