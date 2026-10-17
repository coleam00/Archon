import { runSubprocess, isSubprocessTimeout, type RawSubprocessRejection } from './subprocess';
export { containerCommandName, buildSubprocessDockerArgs } from './subprocess';
import { gateReworkNode } from './gate-rework';
import { createRunToolCallAttention } from './tool-call-attention';
import { DEFAULT_TOOL_CALL_ATTENTION_MS } from './schemas/run-config';
import { type ProviderRegistry, requireProvider } from '@archon/provider-contract';
import { randomUUID } from 'node:crypto';
import { foldDagResumeSnapshot } from './dag-resume-snapshot';
import { nodeInvocationKey } from './node-record-reader';
import {
  startNodeExecution,
  finishNodeExecution,
  newNodeInvocation,
  describeExecutionNode,
  executionMetadata,
} from './node-execution';
import {
  serializeNodeEmitter,
  serializeNodeStateRecord,
  serializeDeferredNodeUsage,
  serializeNodeTranscript,
  serializeNodeOutput,
  persistedOutputContract,
  type NodeExecutionResult,
} from './node-record-serialization';
import {
  nodeExecutionMetadataSchema,
  type NodeExecutionRecord,
  type NodeFailureKind,
  type NodeInvocation,
  type McpUnavailable,
} from './schemas/node-execution';
import type { CheckoutObservation } from './schemas/checkout-observation';
import { observeCheckout } from './checkout-observation';
/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import {
  NodeEventWriteError,
  persistNodeEvent,
  recordDerivedNodeState,
  recordDerivedExecution,
  recordNodeState,
} from './node-event-write';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { join as joinPath, resolve as resolvePath } from 'path';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { isEffortRung } from '@archon/provider-contract';
import { redactCredentialValues } from '@archon/paths/credential-redaction';
import { discoverScriptsForCwd } from './script-discovery';
import { discoverWorkflowsWithConfig, resolveWorkflowCommandContents } from './workflow-discovery';
import { findWorkflowLoadError } from './schemas/workflow';
import {
  assertWorkflowSourceIntegrity,
  capturedSourceReadGuard,
  assertCapturedFilesPresent,
  isSourceReadFailure,
  isSystemError,
  liveSourceRoots,
  WorkflowSourceIntegrityError,
  WorkflowSourceUnavailableError,
  type WorkflowSourceRoots,
} from './workflow-source';
import { resolveWorkflowName } from './router';
import type {
  IWorkflowPlatform,
  WorkflowConfig,
  WorkflowDeps,
  WorkflowCommandSurface,
} from './deps';
import { attentionAnswerLines, sourceReleaseNotice, spellWorkflowCommand } from './deps';
import type {
  SendQueryOptions,
  NodeConfig,
  ProviderCapabilities,
  TokenUsage,
  ResolvedModel,
  MessageChunk,
  ExecutionContext,
} from '@archon/provider-contract';
import type { OverlayChangeSummary } from './container-context';
import { mcpServerMap, mergeTokenUsage } from '@archon/provider-contract';
import { sessionPreview, type ProviderFailure } from '@archon/provider-contract';
import type { ContainerRunContext } from './container-context';
import {
  approvalContextSchema,
  attentionForm,
  attentionOccurrence,
  attentionOptions,
  gateOccurrence,
  type WorkflowAttentionWaitContext,
} from './schemas/workflow-run';
import { attentionOptionsSchema, waitOutputFormat, type AttentionOption } from './schemas/dag-node';
import { WRITEBACK_GATE_NODE_ID } from './container-context';
import { findStrictSchemaIssues, type StrictSchemaIssue } from '@archon/provider-contract';
import { validateStructuredOutput } from './structured-output';
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
  ComposeFanOutNode,
  FanOutConfig,
  NodeOutput,
  SkipCause,
  TriggerRule,
  WorkflowRun,
  EffortLevel,
  SandboxSettings,
  WebSearchMode,
  GraphPlan,
  ResolvedWorkflow,
  LoopGateRunMetadata,
  ApprovalContext,
  WorkflowRunOutcome,
  NodeArtifactLoopFrame,
  WorkflowRunNodeSession,
  WorkflowNodeSession,
  WorkflowRunStatus,
  WorkflowWaitContext,
  WorkflowUsageLimitWaitContext,
  NodeMcp,
} from './schemas';
import {
  bodySessionCursorsSchema,
  bodySessionCursorAncestrySchema,
  type BodySessionCursorAncestry,
  type SessionCursor,
} from './schemas';
import {
  isExecNode,
  isAgentNode,
  isLoopGroupNode,
  definedOutputPaths,
  loopGroupOutputNodes,
  loopGroupSoleTerminalSink,
  isGateNode,
  isWorkflowWaitContext,
  isHaltNode,
  isIncludeDirective,
  isOutputFormatEnforced,
  isWaitNode,
  nodeUsesPersistedScope,
  persistedSessionHandling,
  runMayPersistSessions,
  readSubrunMetadata,
  isApprovalContext,
  isTerminalRunStatus,
  inputEnvKey,
  isNodeContextResume,
  mcpDeclaration,
  isBindingDirective,
  SUBRUN_METADATA_KEYS,
  waitUntilTimestampSchema,
  waitCondition,
  persistScopeKey,
} from './schemas';
import type { BindingDirective } from './schemas';
import {
  buildAiNodeEnvironment,
  buildExecNodeEnvironment,
  type ExecNodeEnvironmentContext,
} from './exec-environment';
import { planGraph, resolvedBodyNodes } from './graph-plan';
import type { RunExitReason } from './schemas/run-terminal-reason';
import {
  CONTINUATION_RETRY_MS,
  executionClaim,
  FAN_OUT_CANCEL_REASONS,
  waitCompletionEvents,
  WorkflowRunPauseConflictError,
} from './store';
import type {
  DagResumeSnapshot,
  FanOutCancelReason,
  GatePauseEventInput,
  PersistedNodeOutput,
} from './store';
import {
  RUN_BUDGET_REFUSED_EVENT_TYPE,
  RunBudgetRefusedError,
  admitRunBudgetAttempt,
  createRunBudgetLedger,
  describeRunBudgetRefusal,
  runBudgetRefusalEventData,
  runBudgetStartRefusal,
  runBudgetWorkUnitEvent,
  settleRunBudgetAttempt,
  type RunBudgetLedger,
  type RunBudgetRefusal,
} from './run-budget';
import {
  createAttemptEventSequence,
  createProviderEventHandler,
  type ProviderEventHandler,
} from './provider-events';
import { createLogger, isPathInside, RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import {
  WORKTREE_DISPOSITION_METADATA_KEY,
  type WorktreeDisposition,
} from './schemas/terminal-record';
import { getWorkflowEventEmitter } from './event-emitter';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';
import { evaluateCondition } from './condition-evaluator';
import {
  declaredOutputPathsFromSchema,
  rootOutputFields,
  outputRefText,
  type DeclaredOutputPaths,
  resolveNodeOutputField,
  assertProducerNotFailed,
  OutputRefError,
  similarNodeIds,
  canonicalValueText,
  parseWholeOutputRef,
  parseWholeExecutionCheckoutRef,
  resolveExecutionCheckoutStart,
  parseWholeInputsRef,
  inputRefToken,
  substituteTemplate,
  templateToken,
  PRIOR_OUTPUT_PATH_SOURCE,
  CURRENT_OUTPUT_PATH_SOURCE,
  assertSupportedOutputRefs,
  type JsonValue,
  type TemplateToken,
} from './output-ref';
import { resolveMcpPath, missingMcpConfigMessage, type McpPathResolution } from './mcp-path';
import { buildTruncationMarker } from './utils/output-truncation';
import { writeNodeArtifact, readNodeArtifacts, writeNodeArtifactsListing } from './artifacts-index';
import { validateArtifactPointers } from './artifact-pointer';
import {
  COMPILED_LOOP_COMMAND,
  readComposedBindings,
  readHomeMcpDirectory,
  resolveIncludeOutputAliases,
  readComposedMeta,
  type LoopWithCompiledCommand,
  type IncludeCommandContent,
  isIncludeCommandReadError,
} from './compiled-command';
import {
  assistantModelDefaults,
  resolveNodeModel,
  resolveNodeModelScope,
} from './node-model-resolution';
import {
  logNodeComplete,
  logWorkflowComplete,
  logWorkflowError,
  logWorkflowEvent,
  createWatchdogResetRecorder,
  type WorkflowUsage,
} from './logger';
import { withIdleTimeout, STEP_IDLE_TIMEOUT_MS } from './utils/idle-timeout';
import { mapWithHeldSlots, mapWithLimit } from './utils/map-with-limit';
import { collectComposedSuspensionPaths, instantiateResolvedInclude } from './include-expander';
import { buildInstanceSnapshots, composeFanOutScopeSegment } from './fan-out-identity';
import {
  nodeFailureKindOf,
  retryClassOf,
  type RetryClass,
  currentAdoptedRunDir,
  getRetryDelayMs,
  effectiveRetryMaxRetries,
  providerLimitResumeAt,
  isProviderLimit,
  type ProviderLimitFailure,
  aggregateProviderFailure,
  loadCommandPrompt,
  substituteWorkflowVariables,
  buildPromptWithContext,
  type TemplateReferences,
  detectCompletionSignal,
  describeUnmetCompletion,
  stripCompletionTags,
  isInlineScript,
  formatSubprocessFailure,
  safeSendMessage,
  type SendMessageContext,
} from './executor-shared';
import {
  isTierName,
  resolvePresetEffort,
  type ModelAliasPreset,
  type PresetEffortRejection,
  type ResolvedAiProfile,
  type TierName,
} from './model-validation';

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
  loopBodyScopes: readonly LoopBodyScope[];
}

/**
 * Env-var bag delivering named inputs to a node shell as `INPUTS_<UPPER_SNAKE>`.
 *
 * Sources, in precedence order:
 *   - the RUN's own inputs (#2470) — a `workflow:` sub-run child carries them in metadata.
 *   - the node's COMPOSED inputs (#1764) — the contract-resolved `inputs:` of the workflow
 *     this node was authored in, stamped at expansion when it arrived through `include:`.
 *     These win: a node's own file is the nearer contract. This bag is their only channel
 *     into a shell or script: the include `$INPUTS` macro rewrites a bash body to a quoted
 *     reference to it and refuses an inline script body (#2115).
 *   - node-local `with:` bindings on script nodes (#2637), the nearest contract.
 *
 * A composed value resolves like a `workflow:` node's `with:` template — workflow variables
 * (NOT shell-safe: these become env values, never shell source) and `$node.output` refs —
 * resolved here rather than at load because a value may hold
 * `$ARTIFACTS_DIR` or a ref that only exists at run time. Values are never shell-escaped:
 * the env bag is itself the injection-safe channel (#2115), which is why they never touch
 * the script source.
 *
 * `runInputs` is explicit for the same reason as in {@link resolveNodeBindings}: the
 * dry-run simulator builds the bag with this function and passes its effective input map,
 * so the preview cannot drift from the real run.
 */
export function inputEnvVars(
  node: DagNode,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined = resolveRunInputs(ctx.workflowRun)
): NodeJS.ProcessEnv {
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
        ? resolveValueTemplate(value, ctx, runInputs)
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

/** Project env cannot shadow inputs or engine-owned delivery keys (#2115). */
function buildNodeShellEnvironment(
  node: DagNode,
  ctx: ShellInputContext,
  envVars: NodeJS.ProcessEnv | undefined,
  executionContext: ExecNodeEnvironmentContext
): NodeJS.ProcessEnv {
  return {
    ...envVars,
    ...inputEnvVars(node, ctx),
    ...buildExecNodeEnvironment(executionContext),
  };
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
  field: string | undefined,
  reference: string
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
  const resolution = resolveNodeOutputField(producer, nodeId, field, reference);
  return resolution.kind === 'empty' ? '' : (resolution.value as JsonValue);
}

/**
 * Resolve one `with:` value to its logical JSON value (#2637).
 *
 * Three tiers, in order:
 *  - a non-string literal (boolean/number/null/array/object) passes through as-is;
 *  - a string that is EXACTLY one whole `$INPUTS.<name>` or `$node.output[.field]`
 *    reference resolves to the LOGICAL value (type preserved);
 *  - any other string is a template: text substitution (workflow vars and
 *    `$node.output` refs), exactly as `input:` resolves.
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
      return wholeRefLogicalValue(producer, wholeRef.nodeId, wholeRef.field, rawValue.trim());
    }
    if (wholeRef.field !== undefined) {
      throw new OutputRefError(wholeRef.nodeId, wholeRef.field, 'unknown-node', {
        reference: rawValue.trim(),
        candidates: similarNodeIds(wholeRef.nodeId, ctx.nodeOutputs.keys()),
      });
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
  return resolveValueTemplate(rawValue, ctx, runInputs);
}

/**
 * Resolve a value template (a `with:` value, a composed input) to text: workflow variables
 * — never shell-safe, a value is delivered as data, not shell source — and `$node.output`
 * references, in one pass.
 */
function resolveValueTemplate(
  template: string,
  ctx: ShellInputContext,
  runInputs: Record<string, JsonValue> | undefined
): string {
  return substituteWorkflowVariables(
    template,
    ctx.workflowRun.id,
    ctx.workflowRun.user_message,
    ctx.artifactsDir,
    ctx.baseBranch,
    ctx.docsDir,
    ctx.issueContext,
    undefined,
    undefined,
    undefined,
    {
      stateDir: ctx.stateDir,
      inputs: runInputs,
      references: nodeTemplateReferences(template, ctx),
    }
  ).prompt;
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
    const checkoutProducer =
      typeof rawValue === 'string' ? parseWholeExecutionCheckoutRef(rawValue) : undefined;
    resolved[name] =
      checkoutProducer !== undefined
        ? resolveExecutionCheckoutStart(ctx.nodeOutputs.get(checkoutProducer), checkoutProducer)
        : resolveWorkflowValue(rawValue, ctx, runInputs, true);
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
    if (Object.hasOwn(directive, 'if_skipped')) {
      const fallback = directive.if_skipped as JsonValue;
      return typeof fallback === 'string'
        ? substituteLoopBodyText(fallback, ctx.loopBodyScopes)
        : fallback;
    }
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
  return wholeRefLogicalValue(producer, ref.nodeId, ref.field, directive.from.trim());
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.dag-executor');
  return cachedLog;
}

interface WatchdogReset {
  type: MessageChunk['type'];
  at: number;
}

function formatWatchdogResetDiagnostic(lastReset: WatchdogReset | undefined): string {
  return lastReset
    ? ` Last watchdog reset: ${new Date(lastReset.at).toISOString()} from chunk type '${lastReset.type}'.`
    : ' No provider chunk reset the watchdog after the stream opened.';
}

function applyPresetOptions(
  providers: ProviderRegistry,
  provider: string,
  preset: ModelAliasPreset | undefined,
  node: DagNode,
  declaredEffort: EffortLevel | undefined,
  nodeConfig: NodeConfig
): PresetEffortRejection | undefined {
  if (!preset) return;

  // An effort declared on the node or workflow outranks the preset's. Passed in
  // rather than re-derived so this cannot disagree with the chain that builds
  // `nodeConfig.effort` below — the two disagreeing is exactly what made an
  // explicit `effort:` on a Codex node suppress its tier's effort and apply
  // nothing at all (#2556).
  if (preset.effort === undefined || declaredEffort !== undefined) return;

  // Shared with the chat orchestrator's `applyPresetToRequestOptions`, so the
  // same tier cannot mean one depth in a workflow and another in chat. The
  // classifier returns the reason; each caller keeps its own event namespace.
  const decision = resolvePresetEffort(providers, provider, preset.effort);
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
    return decision;
  }
  nodeConfig.effort = preset.effort;
  return undefined;
}

/** The provider diagnoses invalid selected JSON; inspection only supplies filtering names. */
function parseMcpServerNames(raw: string, fullPath: string): string[] | undefined {
  try {
    const serverMap = mcpServerMap(JSON.parse(raw));
    if (serverMap.ok) return Object.keys(serverMap.servers);
    getLog().debug({ error: serverMap.error, fullPath }, 'dag.mcp_config_read_failed');
  } catch (err) {
    getLog().debug({ err, fullPath }, 'dag.mcp_config_read_failed');
  }
  return undefined;
}

/** What a node's `mcp:` declaration hands its provider for one attempt. */
export type NodeMcpResolution =
  | Extract<McpPathResolution, { kind: 'read_error' }>
  | { kind: 'none' }
  /** The provider loads `path`; `servers` are the names the file declares, if readable. */
  | { kind: 'load'; path: string; servers: Set<string> }
  | { kind: 'missing'; path: string; servers: Set<string>; diagnostic: string }
  /** An optional declaration the node runs without. */
  | { kind: 'unavailable'; fullPath: string; record: McpUnavailable; diagnostic?: string };

/**
 * Decide whether a node's MCP servers reach its provider. Missing required files and
 * readable invalid JSON still reach the provider for diagnosis; I/O errors retain their
 * cause for the executor. An optional declaration is withheld when the provider cannot
 * load MCP servers, or when its config file does not exist.
 */
export async function resolveNodeMcp(
  mcp: NodeMcp | undefined,
  capabilities: ProviderCapabilities,
  cwd: string,
  homeYamlDirectory?: string,
  verifiedFiles?: ReadonlySet<string>
): Promise<NodeMcpResolution> {
  const declaration = mcpDeclaration(mcp);
  if (declaration === undefined) return { kind: 'none' };
  const { path, optional } = declaration;
  const selected = await resolveMcpPath(
    path,
    cwd,
    homeYamlDirectory,
    capturedSourceReadGuard(verifiedFiles)
  );
  const fullPath = selected.kind === 'missing' ? selected.attemptedPaths[0] : selected.path;
  const servers =
    selected.kind === 'found' ? parseMcpServerNames(selected.content, fullPath) : undefined;
  if (optional && !capabilities.mcp) {
    return {
      kind: 'unavailable',
      fullPath,
      record: { path, reason: 'provider_unsupported', ...(servers ? { servers } : {}) },
    };
  }
  if (selected.kind === 'read_error') return selected;
  if (selected.kind === 'missing') {
    const diagnostic = missingMcpConfigMessage(path, selected.attemptedPaths);
    if (optional) {
      return {
        kind: 'unavailable',
        fullPath,
        record: { path, reason: 'config_missing' },
        diagnostic,
      };
    }
    return { kind: 'missing', path: fullPath, servers: new Set(), diagnostic };
  }
  return { kind: 'load', path: fullPath, servers: new Set(servers) };
}

/** Workflow-level provider options. The provider options have node-level
 *  counterparts and are resolved as `node.X ?? workflowLevelOptions.X`. Two do
 *  not: `webSearchMode`, absent from `dagNodeSchema` so a workflow-level value
 *  is the only value, and `workflowTier`, which is not an author-facing field at
 *  all — it carries the workflow's resolved tier keyword for annotation. */
interface WorkflowLevelOptions {
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
 * node completion, failure and deferred-usage events by `getDagResumeSnapshot`. Both axes travel
 * together because they are one concept — what this run has spent so far — and seeding
 * only one of them is how cost came to under-report every resumed run while tokens did
 * not (#2469).
 */
export interface PriorRunUsage {
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
  costUsd: number;
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
  /**
   * Field paths the child's selected `returns:` node declared (#2453), read from the
   * run's subrun metadata. This is what authorizes a parent's `$<node>.output.a.b`: the
   * child owns the contract, and a `workflow:` node cannot declare one of its own.
   * Absent for schemaless children and pre-#2453 rows — those carry no contract at all.
   */
  declaredOutputPaths?: DeclaredOutputPaths;
  /** Child run's total cost, rolled up into the parent node's costUsd (D8). */
  costUsd?: number;
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
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
  /** Present only when re-driving an existing child on parent resume. */
  resumeChild?:
    | { kind: 'failed'; run: WorkflowRun }
    | { kind: 'fan-out-cancelled'; run: WorkflowRun };
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
  const { summaryValue, summaryDeclaredOutputPaths } = readSubrunMetadata(md);
  return {
    childRunId: run.id,
    status: run.status,
    output: typeof md.summary === 'string' ? md.summary : undefined,
    ...(summaryValue !== undefined ? { structuredOutput: summaryValue } : {}),
    // The child's own field contract (#2453) — read from the row so the synchronous
    // path and the parent re-entry/resume path stay one source, exactly like the
    // summary and usage above.
    ...(summaryDeclaredOutputPaths !== undefined
      ? { declaredOutputPaths: summaryDeclaredOutputPaths }
      : {}),
    costUsd: typeof md.total_cost_usd === 'number' ? md.total_cost_usd : undefined,
    ...(md.total_tokens_unknown === true ? { tokensUnknown: true } : { tokens }),
    error: typeof md.error === 'string' ? md.error : undefined,
  };
}

type SequentialSessionCursor = SessionCursor;
type SessionResumeIntent = 'ordinary' | 'source-fork' | 'owner-continuation';

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

async function waitForNodeRetry(
  store: Pick<WorkflowDeps['store'], 'getWorkflowRunStatus'>,
  runId: string,
  nodeId: string,
  delayMs: number
): Promise<void> {
  for (let remaining = delayMs; remaining > 0; ) {
    // A failed status read is not a stop signal: keep waiting, as the streaming check does.
    try {
      if (!shouldContinueStreamingForStatus(await store.getWorkflowRunStatus(runId))) return;
    } catch (statusErr) {
      getLog().warn(
        { err: statusErr as Error, workflowRunId: runId, nodeId },
        'dag.status_check_failed'
      );
    }
    const sliceMs = Math.min(remaining, CANCEL_CHECK_INTERVAL_MS);
    await new Promise(resolve => setTimeout(resolve, sliceMs));
    remaining -= sliceMs;
  }
}

// A subprocess has no message stream to piggyback a check on, so it polls on its own timer,
// short enough that a cancel stops its tree within about a second.
const SUBPROCESS_STOP_CHECK_INTERVAL_MS = 1_000;

/**
 * `runSubprocess` for a node of `runId`, ending its tree when that run stops; the
 * rejection is then marked `cancelled`. Only this run's status aborts it, so another
 * run's subprocess is never signalled.
 */
async function runSubprocessUntilRunStops(
  store: Pick<WorkflowDeps['store'], 'getWorkflowRunStatus'>,
  runId: string,
  nodeId: string,
  ...[execContext, cmd, args, options]: Parameters<typeof runSubprocess>
): ReturnType<typeof runSubprocess> {
  const controller = new AbortController();
  let reading = false;
  const poll = setInterval(() => {
    if (reading) return;
    reading = true;
    store
      .getWorkflowRunStatus(runId)
      .then(status => {
        if (controller.signal.aborted || shouldContinueStreamingForStatus(status)) return;
        clearInterval(poll);
        getLog().info(
          { workflowRunId: runId, nodeId, status },
          'dag.stop_detected_during_subprocess'
        );
        controller.abort();
      })
      // A failed status read is not a stop signal: keep polling, as the streaming check does.
      .catch((statusErr: unknown) => {
        getLog().warn(
          { err: statusErr as Error, workflowRunId: runId, nodeId },
          'dag.status_check_failed'
        );
      })
      .finally(() => {
        reading = false;
      });
  }, SUBPROCESS_STOP_CHECK_INTERVAL_MS);
  try {
    return await runSubprocess(execContext, cmd, args, {
      ...options,
      abortSignal: controller.signal,
    });
  } finally {
    clearInterval(poll);
  }
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
 * The session one structured-output pass resumes, and whether the session it ends in
 * becomes the node's thread. A reask runs in a fresh throwaway session so an invalid
 * turn is never carried forward. That session holds one repaired turn and none of the
 * node's work, so it never becomes the thread: attempt 0's session stays the one the
 * next iteration, the next node, and the node record continue (#2563, #3584). A named
 * `context: resume` is the exception: every pass forks the declared source itself and
 * must prove that fork on its own, so each pass ends in a real fork of the source.
 */
function structuredOutputPass(
  reaskAttempt: number,
  resumeSessionId: string | undefined,
  forksNamedSource: boolean
): { resumeSessionId: string | undefined; threadsSession: boolean } {
  const threadsSession = forksNamedSource || reaskAttempt === 0;
  return { resumeSessionId: threadsSession ? resumeSessionId : undefined, threadsSession };
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
 * The retry class of a failed node output that warrants another attempt, or
 * `undefined` when it does not.
 *
 * Shared by {@link runNodeRetryLoop} for every node type so the retry decision
 * cannot drift. The class comes from {@link retryClassOf}: the kind recorded where
 * the node failed decides, never its error text. Fatal failures (credentials, quota
 * and spend windows, config errors, cancellation) are never retried, even when
 * `on_error: all`; `unknown` is retried only under `on_error: all`.
 */
function retryableFailureClass(
  output: NodeOutput,
  onError: 'transient' | 'all'
): RetryClass | undefined {
  // Only failed outputs carry `error` (discriminated union); a non-failed output
  // is never retried. Callers already guard on `state === 'failed'`, but narrow
  // here too so `output.error` type-checks and the helper is safe standalone.
  if (output.state !== 'failed') return undefined;
  // A producer that diagnosed its own output (an exec contract failure, #2453) says so
  // in the type: its stdout is deterministically wrong, so no class re-runs it.
  if (output.retryable === false) return undefined;
  const retryClass = retryClassOf(output.failureKind);
  if (retryClass === 'fatal') return undefined;
  if (retryClass === 'unknown' && onError !== 'all') return undefined;
  return retryClass;
}

/**
 * Run one governed attempt under the run budget: admit and reserve a work unit, write
 * its durable record, run the attempt, then charge its spend. The executor reserves
 * after source preparation and before recording its attempt. Admission is synchronous
 * so parallel siblings cannot share the last unit.
 */
async function runBudgetedAttempt(
  ctx: RunLayersContext,
  node: AgentNode | ExecNode,
  attempt: (reserve: () => Promise<void>) => Promise<NodeExecutionResult>
): Promise<NodeExecutionResult> {
  const ledger = ctx.runBudget;
  if (ledger === undefined) return attempt(async () => undefined);
  const path = ctx.stepNamePrefix + node.id;
  const reserve = async (): Promise<void> => {
    const refusal = admitRunBudgetAttempt(ledger, path);
    if (refusal !== undefined) throw new RunBudgetRefusedError(refusal);
    await persistNodeEvent(ctx.deps.store, runBudgetWorkUnitEvent(ctx.workflowRun.id, path));
  };
  const executionBefore = ctx.currentExecution;
  let result: NodeExecutionResult;
  try {
    result = await attempt(reserve);
  } catch (error) {
    // An agent attempt that started and then threw never reported its cost. One that
    // threw before starting made no provider call.
    if (node.kind === 'agent' && ctx.currentExecution !== executionBefore) {
      ledger.usage.costUnavailable ??= { path, reason: 'interrupted' };
    }
    throw error;
  }
  const settlement = settleRunBudgetAttempt(ledger, node.kind, path, result.execution);
  if (settlement !== undefined) throw new RunBudgetRefusedError(settlement);
  return result;
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
  store: Pick<WorkflowDeps['store'], 'createWorkflowEvent' | 'getWorkflowRunStatus'>,
  stepName: string,
  retryConfig: { maxRetries: number; delayMs: number; onError: 'transient' | 'all' },
  run: () => Promise<NodeExecutionResult>,
  initialOutput: NodeExecutionResult,
  iteration?: number
): Promise<NodeExecutionResult> {
  let output = initialOutput;
  let accumulatedCostUsd: number | undefined;
  let accumulatedTokens: TokenUsage | undefined;
  let accumulatedTokensUnknown = false;
  // Once a rate-limited failure is seen, the budget widens to RATE_LIMIT_MAX_RETRIES
  // for the rest of the loop (#2706): load-shedding windows are minutes-scale, so the
  // node's own short maxRetries would exhaust before the provider recovers.
  let sawRateLimit = false;
  let attempt = 0;
  while (true) {
    if (attempt > 0) {
      const status = await store.getWorkflowRunStatus(workflowRun.id);
      if (!shouldContinueStreamingForStatus(status)) {
        output = {
          state: 'failed',
          output: '',
          error: `Workflow ${status ?? 'deleted'}`,
          failureKind: 'cancelled',
        };
        break;
      }
    }
    output = await run();
    if (output.costUsd !== undefined) {
      accumulatedCostUsd = (accumulatedCostUsd ?? 0) + output.costUsd;
    }
    accumulatedTokensUnknown ||= output.tokensUnknown === true;
    if (accumulatedTokensUnknown) {
      accumulatedTokens = undefined;
    } else if (output.tokens !== undefined) {
      accumulatedTokens = sumTokenUsage(
        [...(accumulatedTokens !== undefined ? [accumulatedTokens] : []), output.tokens],
        { nodeId: node.id }
      );
    }
    if (output.state !== 'failed') break;

    const retryClass = retryableFailureClass(output, retryConfig.onError);
    if (retryClass === 'rate_limited') sawRateLimit = true;
    const effectiveMaxRetries = effectiveRetryMaxRetries(
      retryConfig.maxRetries,
      retryClass,
      sawRateLimit
    );
    if (retryClass === undefined || attempt >= effectiveMaxRetries) break;

    const delayMs = getRetryDelayMs(retryClass, attempt, retryConfig.delayMs);
    getLog().warn(
      {
        nodeId: node.id,
        attempt: attempt + 1,
        maxRetries: effectiveMaxRetries,
        retryClass,
        delayMs,
        error: output.error,
      },
      'dag_node_transient_retry'
    );

    const errorKind =
      retryClass === 'overloaded'
        ? 'provider capacity error'
        : retryClass === 'unknown'
          ? 'error'
          : 'transient error';
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Node \`${node.id}\` failed with ${errorKind} (attempt ${String(attempt + 1)}/${String(effectiveMaxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
      { workflowId: workflowRun.id, nodeName: node.id }
    );

    await store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_retry_scheduled',
      step_name: stepName,
      data: {
        nodeId: node.id,
        retry_class: retryClass,
        retry_attempt: attempt + 1,
        max_retries: effectiveMaxRetries,
        delay_ms: delayMs,
        ...(iteration !== undefined ? { iteration } : {}),
      },
    });
    await waitForNodeRetry(store, workflowRun.id, node.id, delayMs);
    attempt++;
  }
  output.costUsd = accumulatedCostUsd;
  output.tokens = accumulatedTokens;
  output.tokensUnknown = accumulatedTokensUnknown;
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
  store: Pick<WorkflowDeps['store'], 'createWorkflowEvent' | 'getWorkflowRunStatus'>,
  stepName: string,
  run: () => Promise<NodeExecutionResult>,
  iteration?: number
): Promise<NodeExecutionResult> {
  const retryConfig = getExplicitNodeRetryConfig(node);
  // No explicit retry: preserve the single-attempt deterministic-node default.
  if (!retryConfig) {
    return run();
  }
  return runNodeRetryLoop(
    node,
    platform,
    conversationId,
    workflowRun,
    store,
    stepName,
    retryConfig,
    run,
    {
      state: 'failed',
      output: '',
      error: 'Node did not execute',
    },
    iteration
  );
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
  return dirs.some(d => isPathInside(d, absPath, { includeRoot: true, lexical: true }));
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
 * Take a `mutates_checkout: false` node's pre-run snapshot and record it in its
 * concurrent layer's snapshot set, so a sibling's violation can name it. Returns
 * `undefined` for an undeclared node: nothing to assert.
 */
async function snapshotGuardedNode(
  ctx: Pick<RunLayersContext, 'cwd' | 'guardedLayerSnapshots'>,
  node: DagNode,
  excludeDirs: readonly string[]
): Promise<string | undefined> {
  if (node.mutates_checkout !== false) return undefined;
  ctx.guardedLayerSnapshots?.add(node.id);
  return snapshotCheckout(ctx.cwd, excludeDirs);
}

/**
 * A node whose `mutates_checkout: false` the engine enforces: exec and agent nodes.
 * Every other node may write to the checkout as far as layer scheduling knows.
 */
function isCheckoutGuarded(node: DagNode): boolean {
  return node.mutates_checkout === false && (isExecNode(node) || isAgentNode(node));
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
  logDir: string,
  guardedLayerSnapshots: ReadonlySet<string> | undefined
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
  const concurrentGuardedSiblings = [...(guardedLayerSnapshots ?? [])].filter(id => id !== node.id);
  const error =
    concurrentGuardedSiblings.length === 0
      ? `Node \`${node.id}\` declared \`mutates_checkout: false\` but modified the working tree: ${changedPaths}`
      : `Node \`${node.id}\` declared \`mutates_checkout: false\`, and the working tree changed; the guarded siblings ${concurrentGuardedSiblings.map(id => `\`${id}\``).join(', ')} also ran in this parallel layer, so the change may not be this node's alone: ${changedPaths}`;
  getLog().error({ nodeId: node.id, changed: changedPaths }, 'dag_mutates_checkout_violation');
  if (result.execution === undefined) {
    throw new Error(`Node '${node.id}' completed without its execution record`);
  }
  // This amends an already-recorded attempt. Keep its facts without charging its spend twice.
  const amended = await recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      { ...result.execution, accounting: 'amendment' },
      { status: 'failed', error, failureKind: 'output_contract' },
      {
        output: {
          text: result.output,
          structured: result.structuredOutput,
          declaredOutputPaths: result.declaredOutputPaths,
        },
      }
    )
  );
  // Retry accounting is the accumulated cost of all attempts, not only the amended last one.
  return {
    ...amended,
    costUsd: result.costUsd,
    tokens: result.tokens,
    tokensUnknown: result.tokensUnknown,
  };
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
    const spillDir = joinPath(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'node-output-spills');
    const filename = field ? `${nodeId}.${field}.nodeoutput` : `${nodeId}.nodeoutput`;
    const filePath = writeSpillFile(spillDir, filename, value);
    if (filePath) return `$(cat ${shellQuote(filePath)})`;
    return shellQuote(value); // fallback: inline (pre-file-spill behavior)
  }
  return shellQuote(value);
}

interface RequiredOutputRefContext {
  consumerId: string;
  field: 'loop.until_bash' | 'loop_group.until_bash';
}

function requiredOutputRefError(
  context: RequiredOutputRefContext,
  ref: string,
  detail: string
): Error {
  return new Error(
    `Node '${context.consumerId}' field '${context.field}' cannot resolve '${ref}': ${detail}`
  );
}

/**
 * The `$node_id.output[.field]` reference, resolved against `nodeOutputs`.
 *
 * @param escapedForBash - When true, wraps substituted values in single quotes so
 *   they are safe to embed in bash scripts passed to `bash -c`. Set true only for
 *   bash node script substitution; AI/command prompt substitution should use false.
 * @param requiredContext - Makes unavailable whole-output refs fail with the owning
 *   decision surface named. Used by `until_bash`; other callers keep the legacy empty
 *   fallback. Field refs remain strict in either mode.
 */
function nodeOutputRefToken(
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash: boolean,
  artifactsDir?: string,
  requiredContext?: RequiredOutputRefContext
): TemplateToken {
  return templateToken(CURRENT_OUTPUT_PATH_SOURCE, groups => {
    const [match, nodeId] = groups;
    // An optional group that did not match is undefined, whatever RegExpExecArray says.
    const field: string | undefined = groups[2];
    const nodeOutput = nodeOutputs.get(nodeId);
    if (!nodeOutput) {
      // A `.field` ref that resolves to no output (for example, a programmatically
      // constructed definition that bypassed discovery, or a real producer whose
      // output is unavailable on this execution path) fails the consuming node loudly,
      // matching the strict
      // no-silent-drop posture for known-producer field access below. The whole-text
      // `$id.output` form stays lenient ('') by default as a long-documented surface.
      // `until_bash` opts into requiredContext because empty text would become an
      // input to a completion decision rather than merely missing display text.
      if (field) {
        const error = new OutputRefError(nodeId, field, 'unknown-node', {
          reference: match,
          candidates: similarNodeIds(nodeId, nodeOutputs.keys()),
        });
        throw requiredContext
          ? requiredOutputRefError(requiredContext, match, error.message)
          : error;
      }
      if (requiredContext) {
        const candidates = similarNodeIds(nodeId, nodeOutputs.keys());
        const hint =
          candidates.length > 0
            ? ` Did you mean: ${candidates.map(candidate => `'${candidate}'`).join(', ')}?`
            : '';
        throw requiredOutputRefError(
          requiredContext,
          match,
          `node '${nodeId}' has not produced output at this point.${hint} Fix the id, or ensure '${nodeId}' runs before this check.`
        );
      }
      getLog().warn({ nodeId, match }, 'dag_node_output_ref_unknown_node');
      return escapedForBash ? "''" : '';
    }
    if (!field) {
      if (requiredContext && (nodeOutput.state === 'skipped' || nodeOutput.state === 'pending')) {
        throw requiredOutputRefError(
          requiredContext,
          match,
          `node '${nodeId}' did not run (skipped or pending), so it has no output to read. Fix the dependency or guard the consuming loop.`
        );
      }
      if (requiredContext && nodeOutput.state === 'failed') {
        throw requiredOutputRefError(
          requiredContext,
          match,
          `node '${nodeId}' failed (${nodeOutput.error}), so its output cannot be trusted. Fix the failure or guard the consuming loop.`
        );
      }
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
    let resolution: ReturnType<typeof resolveNodeOutputField>;
    try {
      resolution = resolveNodeOutputField(nodeOutput, nodeId, field, match);
    } catch (error) {
      if (requiredContext && error instanceof OutputRefError) {
        throw requiredOutputRefError(requiredContext, match, error.message);
      }
      throw error;
    }
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
  });
}

/** What a node's template resolves against besides its workflow variables. */
interface TemplateSources {
  nodeOutputs: Map<string, NodeOutput>;
  /** One per enclosing loop_group iteration, outermost first; empty outside a body. */
  loopBodyScopes: readonly LoopBodyScope[];
}

/**
 * How a template's resolved values are embedded: `prompt` raw; `shell` shell-quoted, for
 * bash bodies and `until_bash`; `script` raw, with user-controlled free text left to env
 * delivery (#2115).
 */
export type TextSurface = 'prompt' | 'shell' | 'script';

/**
 * The reference grammars a node's own template resolves in the same pass as its workflow
 * variables (#4046): every enclosing loop_group scope, outermost first, then `$node.output`.
 * Unsupported output paths are rejected on the template itself, never on a value
 * substituted into it.
 */
export function nodeTemplateReferences(
  template: string,
  sources: TemplateSources,
  surface: TextSurface = 'prompt',
  options: { artifactsDir?: string; requiredContext?: RequiredOutputRefContext } = {}
): TemplateReferences {
  assertSupportedOutputRefs(template);
  return {
    before: sources.loopBodyScopes.flatMap(scope => loopScopeTokens(scope, surface)),
    after: [
      nodeOutputRefToken(
        sources.nodeOutputs,
        surface === 'shell',
        options.artifactsDir,
        options.requiredContext
      ),
    ],
  };
}

/**
 * Substitute $node_id.output and $node_id.output.field references, and the enclosing
 * loop_group scopes' references, in text that carries no workflow variables (a gate
 * message, a cancel reason, a wait timestamp). See {@link nodeOutputRefToken}.
 */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  loopBodyScopes: readonly LoopBodyScope[],
  escapedForBash = false,
  artifactsDir?: string,
  requiredContext?: RequiredOutputRefContext
): string {
  const { before, after } = nodeTemplateReferences(
    prompt,
    { nodeOutputs, loopBodyScopes },
    escapedForBash ? 'shell' : 'prompt',
    { artifactsDir, requiredContext }
  );
  return substituteTemplate(prompt, [...before, ...after]);
}

/**
 * Substitute an attention wait's message: node outputs, enclosing loop scopes and
 * `$INPUTS`, and no other workflow variable. The dry run renders the same field through
 * this function so its preview cannot drift from what the operator receives.
 */
export function substituteWaitMessage(
  text: string,
  sources: TemplateSources,
  inputs: Record<string, JsonValue> | undefined
): string {
  const { before, after } = nodeTemplateReferences(text, sources);
  return substituteTemplate(text, [...before, inputRefToken(inputs), ...after]);
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
 * outer granularity — see {@link loopPrevRefToken}). Including descendants keeps
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
 * The `$LOOP_PREV.<nodeId>.output[.field]` reference, resolved against one loop_group
 * scope's *prior-iteration* node outputs.
 *
 * Cross-iteration analog of {@link nodeOutputRefToken}: where `$nodeId.output` reads
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
 * Two static id sets from the scope (both via {@link collectLoopBodyNodeIds} / its
 * immediate-ids counterpart) drive the absent-output branch. `knownBodyIds` is the
 * TRANSITIVE set (this group's body plus every nested descendant); `directBodyIds` is only
 * THIS group's immediate body ids. When output is absent, the id is classified:
 *   - not in `knownBodyIds` → a typo that matches no body node anywhere. A `.field` ref
 *     throws `OutputRefError('unknown-node')` (loud, with a did-you-mean) — the loop_group
 *     analog of the same fix at the `$node.output.field` seam (#2135/#2142); a whole-text
 *     `$LOOP_PREV.<id>.output` ref stays lenient ('').
 *   - in `knownBodyIds` but not in `directBodyIds` → the id belongs to a NESTED loop_group,
 *     not this group's own body. The token declines the reference so the inner
 *     loop_group's scope, later in the same pass, resolves it against its OWN
 *     prior-iteration snapshot. The outer scope must not consume it, or the inner loop
 *     could never see its own prior iteration.
 *   - in `directBodyIds` with no prior output → legitimate iteration-1 / skipped absence → ''.
 *
 * When `knownBodyIds` is undefined (a scope with no static set) the seam stays fully
 * lenient — every absent ref resolves to '', preserving the pre-#2142 behavior.
 */
function loopPrevRefToken(scope: LoopBodyScope, escapedForBash: boolean): TemplateToken {
  const { loopPrevOutputs, outputFileDir, knownBodyIds, directBodyIds } = scope;
  return templateToken(PRIOR_OUTPUT_PATH_SOURCE, groups => {
    const [match, nodeId] = groups;
    // An optional group that did not match is undefined, whatever RegExpExecArray says.
    const field: string | undefined = groups[2];
    const nodeOutput = loopPrevOutputs?.get(nodeId);
    if (!nodeOutput || nodeOutput.state === 'skipped' || nodeOutput.state === 'pending') {
      if (knownBodyIds) {
        if (!knownBodyIds.has(nodeId)) {
          // Typo: id matches NO body node anywhere in the enclosing loop_group (a typo
          // the loader can't see — it never scans `$LOOP_PREV.*` refs). A `.field` ref
          // fails the consuming node loudly, mirroring nodeOutputRefToken /
          // resolveOutputRef; a whole-text ref stays lenient ('' below). The static set
          // is required: the runtime `loopPrevOutputs` map is empty on iteration 1, so it
          // alone cannot tell a typo from a legitimate first-pass absence.
          if (field) {
            throw new OutputRefError(nodeId, field, 'unknown-node', {
              reference: match,
              candidates: similarNodeIds(nodeId, knownBodyIds),
            });
          }
        } else if (directBodyIds && !directBodyIds.has(nodeId)) {
          // Known id owned by a NESTED loop_group, not this group's own body. Decline it so
          // the inner loop_group's scope resolves it against its OWN prior-iteration
          // snapshot — this scope must not consume it, or the inner loop could never
          // reference its own previous iteration.
          return undefined;
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
    const resolution = resolveNodeOutputField(nodeOutput, nodeId, field, match);
    if (resolution.kind === 'empty') return escapedForBash ? "''" : '';
    const value = resolution.value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const text = canonicalValueText(value);
    return escapedForBash ? shellQuoteOrFile(text, nodeId, field, outputFileDir) : text;
  });
}

/**
 * One loop_group scope's references: `$LOOP_PREV.*` and, when the scope carries a reply,
 * `$LOOP_USER_INPUT`. A `shell` surface shell-quotes both (spilling large `$LOOP_PREV`
 * values to a file, as {@link nodeOutputRefToken} does). A `script` surface leaves
 * `$LOOP_USER_INPUT` literal: free text cannot be safely quoted into TS/Python source, so
 * the script reads it from its env (#2115). `$LOOP_PREV.*` stays raw there (bounded
 * producer contract).
 */
function loopScopeTokens(scope: LoopBodyScope, surface: TextSurface): TemplateToken[] {
  const tokens = [loopPrevRefToken(scope, surface === 'shell')];
  const { loopUserInput } = scope;
  if (loopUserInput !== undefined && surface !== 'script') {
    tokens.push(
      templateToken(String.raw`\$LOOP_USER_INPUT`, () =>
        surface === 'shell' ? shellQuote(loopUserInput) : loopUserInput
      )
    );
  }
  return tokens;
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
  providers: ProviderRegistry,
  node: DagNode,
  workflowProvider: string | undefined,
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
  effort?: EffortLevel;
  preset?: ModelAliasPreset;
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

  const descriptor = requireProvider(providers, provider);

  // Get provider capabilities for capability warnings (static lookup, no instantiation)
  const caps = descriptor.capabilities;

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

  // Keep the container capability check at dispatch as well as preflight: every
  // actual turn must honour the requested execution context.
  if (execContext.kind === 'container' && !caps.containerExec) {
    throw new Error(
      `Provider '${provider}' cannot run inside a container yet (containerExec ` +
        'capability). Use provider claude, or run without --container.'
    );
  }

  // Re-check scoped capabilities at the actual dispatch boundary.
  const unscoped = unsupportedScopedCapabilities(node, caps);
  if (unscoped.length > 0) {
    throw new Error(
      scopedCapabilityMismatchMessage([{ nodeId: node.id, provider, capabilities: unscoped }])
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
    ['agents', 'agents', node.agents !== undefined],
    ['effort', 'effortControl', declaredEffort !== undefined],
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
  baseOptions.userCredentialEnvKeys = config.userCredentialEnvKeys;
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
    // `mcp` is set per attempt by `executeNodeInternal`, which decides whether an
    // optional declaration reaches the provider.
    hooks: node.hooks,
    skills: node.skills,
    plugins: node.plugins,
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
  const presetEffortRejection = applyPresetOptions(
    providers,
    provider,
    effectivePreset,
    node,
    declaredEffort,
    nodeConfig
  );
  if (presetEffortRejection?.reason === 'unsupported') {
    unsupported.push('effort');
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
  // Providers clamp a rung their SDK lacks (`ultra` → `max` on Claude/Pi or `xhigh` on Copilot),
  // and this reports the declared rung rather than the clamped one — consistent
  // across providers, and no longer able to name a field the provider ignored,
  // which was the #2395 failure mode.
  const assistantEffort = isEffortRung(assistantConfig.modelReasoningEffort)
    ? assistantConfig.modelReasoningEffort
    : undefined;
  const resolvedEffort: EffortLevel | undefined = nodeConfig.effort ?? assistantEffort;

  const options: SendQueryOptions = {
    ...baseOptions,
    nodeConfig,
    assistantConfig,
  };

  // `node.model` is the original ref (e.g. "large"); `model` is the resolved
  // string (e.g. "opus"). Surface `tier` when the ref was a tier keyword — from
  // the node's own `model`, or (when the node inherits the workflow-level model)
  // from the workflow tier, mirroring the effectivePreset inheritance condition.
  return {
    provider,
    model,
    options,
    tier: resolution.tier,
    effort: resolvedEffort,
    preset: effectivePreset,
  };
}

export type TriggerRuleDecision = { decision: 'run' } | { decision: 'skip'; cause: SkipCause };

interface TriggerRuleUpstream {
  id: string;
  output: NodeOutput;
}

function triggerSkipCause(upstreams: readonly TriggerRuleUpstream[]): SkipCause {
  for (const upstream of upstreams) {
    if (upstream.output.state === 'failed') {
      return { kind: 'upstream_failed', origin: upstream.id };
    }
    if (upstream.output.state === 'skipped' && upstream.output.cause.kind === 'upstream_failed') {
      return { kind: 'upstream_failed', origin: upstream.output.cause.origin };
    }
  }

  const skipped = upstreams.find(upstream => upstream.output.state === 'skipped');
  if (skipped?.output.state === 'skipped') {
    return {
      kind: 'upstream_skipped',
      origin:
        skipped.output.cause.kind === 'upstream_skipped' ? skipped.output.cause.origin : skipped.id,
    };
  }

  const unsettled = upstreams[0];
  if (unsettled === undefined) {
    throw new Error('Cannot determine a skip cause without a blocking dependency');
  }
  return { kind: 'upstream_skipped', origin: unsettled.id };
}

/** Evaluate trigger rule for a node given its upstream states. */
export function checkTriggerRule(
  node: DagNode,
  nodeOutputs: Map<string, NodeOutput>
): TriggerRuleDecision {
  const nodeDeps = node.depends_on ?? [];
  return checkTriggerRuleForDependencies(nodeDeps, node.trigger_rule ?? 'all_success', nodeOutputs);
}

function checkTriggerRuleForDependencies(
  nodeDeps: readonly string[],
  rule: TriggerRule,
  nodeOutputs: Map<string, NodeOutput>
): TriggerRuleDecision {
  if (nodeDeps.length === 0) return { decision: 'run' };

  const upstreams = nodeDeps.map(id => ({
    id,
    output: nodeOutputs.get(id) ?? {
      state: 'failed',
      output: '',
      error: `upstream '${id}' missing from outputs`,
    },
  }));
  let blocking: TriggerRuleUpstream[];
  switch (rule) {
    case 'all_success':
      blocking = upstreams.filter(upstream => upstream.output.state !== 'completed');
      break;
    case 'one_success':
      blocking = upstreams.some(upstream => upstream.output.state === 'completed') ? [] : upstreams;
      break;
    case 'none_failed_min_one_success': {
      const failed = upstreams.filter(
        upstream =>
          upstream.output.state === 'failed' ||
          (upstream.output.state === 'skipped' && upstream.output.cause.kind === 'upstream_failed')
      );
      const anySucceeded = upstreams.some(upstream => upstream.output.state === 'completed');
      blocking = failed.length > 0 ? failed : anySucceeded ? [] : upstreams;
      break;
    }
    case 'all_done':
      blocking = upstreams.filter(
        upstream => upstream.output.state === 'pending' || upstream.output.state === 'running'
      );
      break;
  }

  return blocking.length === 0
    ? { decision: 'run' }
    : { decision: 'skip', cause: triggerSkipCause(blocking) };
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
): TriggerRuleDecision {
  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    if (boundary.isEntry && !evaluateEntryBoundary) continue;

    const triggerRules =
      boundary.isEntry && evaluateEntryBoundary
        ? [boundary.entryTriggerRule]
        : boundary.entryTriggerRules;
    const triggerDecisions = triggerRules.map(rule =>
      checkTriggerRuleForDependencies(boundary.dependsOn, rule, nodeOutputs)
    );
    if (!triggerDecisions.some(decision => decision.decision === 'run')) {
      return triggerDecisions[0];
    }

    if (boundary.when !== undefined) {
      try {
        const condition = evaluateCondition(boundary.when, nodeOutputs, inputs);
        if (!condition.parsed) {
          return {
            decision: 'skip',
            cause: { kind: 'condition_parse_error', expr: boundary.when },
          };
        }
        if (!condition.result) {
          return { decision: 'skip', cause: { kind: 'condition', expr: boundary.when } };
        }
      } catch (error) {
        if (boundary.isEntry && evaluateEntryBoundary) throw error;
        // Entry nodes own the actionable missing-ref error. Descendants only need to stay
        // inside the failed boundary, without repeating the same failure for every node.
        return {
          decision: 'skip',
          cause: { kind: 'condition_parse_error', expr: boundary.when },
        };
      }
    }
  }
  return { decision: 'run' };
}

/**
 * Capture immutable attribution before one execution attempt starts.
 *
 * `checkoutStart` is this attempt's checkout sample. The first sample also becomes the
 * invocation's, and the dispatch context keeps that invocation, so a retry or a resumed
 * continuation is compared with where the invocation began rather than where it paused.
 */
function beginExecution(
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
function observeNodeCheckout(ctx: RunLayersContext): Promise<CheckoutObservation> {
  return observeCheckout(ctx.cwd, ctx.execContext, {
    runId: ctx.workflowRun.id,
    artifactsDir: ctx.artifactsDir,
  });
}

function aiNodeEnvironment(
  ctx: RunLayersContext,
  execution: NodeExecutionRecord
): Record<string, string> {
  return buildAiNodeEnvironment(
    execution,
    ctx.execContext.kind === 'host' ? process.env.ARCHON_CLI_COMMAND : undefined
  );
}

async function executeNodeInternal(
  ctx: RunLayersContext,
  node: AgentNode,
  reserveBudget: () => Promise<void>,
  provider: string,
  nodeOptions: SendQueryOptions | undefined,
  resumeSessionId: string | undefined,
  resolvedModel?: string,
  resolvedTier?: TierName,
  resolvedEffort?: EffortLevel,
  stepNamePrefix = '',
  iteration?: number,
  checkpointSession?: SessionCheckpoint,
  typedArtifactsFile?: string,
  resumeIntent: SessionResumeIntent = 'ordinary',
  /** `$REJECTION_REASON` for an approval gate's rework prompt; undefined elsewhere. */
  rejectionReason?: string
): Promise<NodeExecutionResult> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    issueContext,
    workflowSourceRoots,
  } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Command file name when this agent node is command-sourced, undefined for an
  // inline prompt — replaces the old `node.command` field access throughout.
  const commandName =
    node.source.kind === 'command'
      ? substituteLoopBodyText(node.source.name, ctx.loopBodyScopes)
      : undefined;
  // Include expansion compiles a command body into an inline prompt and moves the node's
  // `with:` map to the engine-private payload, so a composed node binds exactly as the
  // same node does standalone (#2964).
  const nodeWith = node.source.kind === 'command' ? node.source.with : readComposedBindings(node);
  // Persisted step_name is namespaced ('<groupId>.' prefix) for loop_group bodies;
  // '' for the top-level DAG → identical to node.id. The in-process emitter payloads
  // below stay raw (node.id) — live SSE/CLI consumers key off those. See #2090.
  const stepName = stepNamePrefix + node.id;
  // Only present inside a loop_group body — tags lifecycle rows with the iteration so
  // multi-iteration runs are disaggregatable in the event log.
  const namedResumeSourceNodeId = isNodeContextResume(node.context)
    ? node.context.resume
    : undefined;
  const commandPrompt =
    commandName === undefined ? undefined : await loadNodeCommandPrompt(ctx, commandName, stepName);
  const homeMcpDirectory = readHomeMcpDirectory(node);
  const verifiedMcpFiles =
    homeMcpDirectory !== undefined
      ? await assertNodeSourceReadable(workflowSourceRoots, stepName)
      : undefined;
  const capabilities = requireProvider(deps.providers, provider).capabilities;
  const nodeMcp = await resolveNodeMcp(
    node.mcp,
    capabilities,
    cwd,
    homeMcpDirectory,
    verifiedMcpFiles
  );
  if (nodeMcp.kind === 'read_error') {
    const sourceRoot =
      workflowSourceRoots.kind === 'captured'
        ? workflowSourceRoots.anchor.root
        : workflowSourceRoots.globalWorkflows;
    if (
      homeMcpDirectory !== undefined &&
      isInsideAny(nodeMcp.path, [sourceRoot]) &&
      isSourceReadFailure(nodeMcp.error, verifiedMcpFiles)
    ) {
      throw new RunSourceUnreadableError(stepName, nodeMcp.error);
    }
    throw nodeMcp.error;
  }
  await reserveBudget();
  const aiClient = deps.getAgentProvider(provider);
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, {
      provider,
      model: resolvedModel,
      tier: resolvedTier,
      effort: resolvedEffort,
      sessionId: resumeSessionId,
      capabilities,
      checkoutStart: await observeNodeCheckout(ctx),
    }),
    diagnostics: {
      ...(iteration !== undefined ? { iteration } : {}),
      ...(namedResumeSourceNodeId !== undefined
        ? {
            sessionSourceNodeId: namedResumeSourceNodeId,
            sessionForkRequested: resumeIntent !== 'owner-continuation',
          }
        : {}),
      ...(nodeMcp.kind === 'unavailable' ? { mcpUnavailable: nodeMcp.record } : {}),
    },
  };
  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await recordNodeState({ store: deps.store, logDir }, execution);
  if (nodeMcp.kind === 'unavailable') {
    const { record, fullPath } = nodeMcp;
    getLog().warn(
      { nodeId: node.id, path: record.path, fullPath, reason: record.reason },
      'dag.mcp_optional_unavailable'
    );
    const why =
      record.reason === 'provider_unsupported'
        ? `provider '${provider}' cannot load MCP servers`
        : (nodeMcp.diagnostic ?? `config file not found at ${fullPath}`);
    await safeSendMessage(
      platform,
      conversationId,
      `Node '${node.id}' runs without its optional MCP servers (${record.path}): ${why}.`,
      nodeContext
    );
  }
  // Every stream pass of this attempt (a structured-output reask is a second pass)
  // numbers its provider events from one sequence.
  const attemptEvents = createAttemptEventSequence(execution.attempt.id);

  let nodeTokens: TokenUsage | undefined;
  let nodeTokensUnknown = false;
  let nodeCostUsd: number | undefined;
  // Attempt-wide: some stream pass ended without a result, or a result without a
  // finite cost, so `nodeCostUsd` is at most a floor of what the attempt spent.
  let costReportMissing = false;
  let passSawResult = false;
  let nodeStopReason: string | undefined;
  let nodeNumTurns: number | undefined;
  let nodeResolvedModel: ResolvedModel | undefined;
  // Declared before `failAgentNode`, which records it and can run before the stream starts.
  let newSessionId: string | undefined;
  const nodeKey = `${workflowRun.id}:${node.id}`;

  const failAgentNode = async (
    error: string,
    failureKind: NodeFailureKind,
    extras: { output?: string; providerFailure?: ProviderFailure; providerNotCalled?: boolean } = {}
  ): Promise<NodeExecutionResult> => {
    const result = await recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error,
          failureKind,
          ...(extras.providerFailure !== undefined
            ? { providerFailure: extras.providerFailure }
            : {}),
        },
        {
          output: { text: extras.output ?? '' },
          tokens: nodeTokens,
          tokensUnknown: nodeTokensUnknown,
          costUsd: nodeCostUsd,
          costPartial: costReportMissing,
          stopReason: nodeStopReason,
          numTurns: nodeNumTurns,
          resolvedModel: nodeResolvedModel?.id,
          sessionId: newSessionId,
          providerNotCalled: extras.providerNotCalled,
        }
      )
    );
    lastNodeCancelCheck.delete(nodeKey);
    lastNodeActivityUpdate.delete(nodeKey);
    return result;
  };
  // The provider is bound but was never called, so the attempt records no spend rather
  // than unreported spend that would refuse a spend-limited run.
  const failBeforeProviderCall = (error: string): Promise<NodeExecutionResult> =>
    failAgentNode(error, 'config', { providerNotCalled: true });

  // Load prompt
  let rawPrompt: string;
  if (commandName !== undefined) {
    const promptResult = commandPrompt;
    if (promptResult === undefined) throw new Error(`Missing prepared command for '${stepName}'`);
    if (!promptResult.success) {
      const errMsg = promptResult.message;
      getLog().error({ nodeId: node.id, error: errMsg }, 'dag_node_command_load_failed');
      return failBeforeProviderCall(errMsg);
    }
    rawPrompt = resolveIncludeOutputAliases(node, promptResult.content);
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

  let finalPrompt: string;
  try {
    // Node-local bindings (#2637): a command node's `with:` map resolves against
    // upstream outputs and merges OVER the run's inputs into the `$INPUTS` bag —
    // nearest-wins, the same precedence the shell env channel documents. A binding
    // that cannot be satisfied throws here and fails the node via the catch below.
    const runInputs = resolveRunInputs(workflowRun);
    const nodeBindings =
      nodeWith !== undefined ? resolveNodeBindings(node.id, nodeWith, ctx, runInputs) : undefined;
    const promptInputs =
      nodeBindings !== undefined ? { ...(runInputs ?? {}), ...nodeBindings } : runInputs;
    // An inline prompt and a command file loaded only now resolve alike: variables,
    // enclosing loop_group scopes and upstream outputs in one pass.
    finalPrompt = buildPromptWithContext(
      rawPrompt,
      workflowRun.id,
      workflowRun.user_message,
      artifactsDir,
      baseBranch,
      docsDir,
      issueContext,
      `dag node '${node.id}' prompt`,
      {
        stateDir,
        inputs: promptInputs,
        typedArtifactsFile,
        rejectionReason,
        references: nodeTemplateReferences(rawPrompt, ctx),
      }
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ nodeId: node.id, error: err.message }, 'dag.node_prompt_substitution_failed');
    const result = await failBeforeProviderCall(err.message);
    await safeSendMessage(
      platform,
      conversationId,
      `Node '${node.id}' failed: ${err.message}`,
      nodeContext
    );
    return result;
  }

  const streamingMode = platform.getStreamingMode();

  let nodeOutputText = ''; // Always accumulate regardless of streaming mode
  let structuredOutput: unknown;
  let nodeResumed: boolean | undefined;
  const batchMessages: string[] = [];

  // Create per-node abort controller for idle timeout cleanup
  const nodeAbortController = new AbortController();
  const shouldForkSession = resumeSessionId !== undefined && resumeIntent !== 'owner-continuation';
  const nodeOptionsWithAbort: SendQueryOptions | undefined = {
    ...nodeOptions,
    env: { ...nodeOptions?.env, ...aiNodeEnvironment(ctx, execution) },
    ...(nodeMcp.kind === 'load' || nodeMcp.kind === 'missing'
      ? { nodeConfig: { ...nodeOptions?.nodeConfig, mcp: nodeMcp.path } }
      : {}),
    abortSignal: nodeAbortController.signal,
    ...(resumeIntent === 'owner-continuation'
      ? { forkSession: false }
      : shouldForkSession
        ? { forkSession: true }
        : {}),
  };
  let nodeIdleTimedOut = false;
  let lastWatchdogReset: WatchdogReset | undefined;
  let watchdogResets = createWatchdogResetRecorder(logDir, workflowRun.id, node.id);
  const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;
  // Task ids still live when the stream ended abnormally (idle timeout /
  // subprocess death) — recorded on the node_completed event so an incomplete
  // node never masquerades as a clean success (#2083).
  let backgroundTasksIncomplete: string[] = [];
  // Whether the last stream pass ended on the provider's `settled`. Output without it
  // means the turn was cut off, not finished.
  let streamSettled = false;

  // Best-effort providers (Pi/Copilot) get a bounded validate-and-reask loop: on a
  // structured-output validation miss, re-run the stream with the schema errors
  // appended. Enforced providers and non-output_format nodes get 0 reasks.
  const maxReasks =
    capabilities.structuredOutput === 'best-effort' && nodeOptions?.outputFormat
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
    pass: ReturnType<typeof structuredOutputPass>
  ): Promise<void> => {
    nodeOutputText = '';
    structuredOutput = undefined;
    if (pass.threadsSession) {
      newSessionId = undefined;
      nodeResumed = undefined;
    }
    batchMessages.length = 0; // else a failed attempt's prose flushes during reask
    nodeCostUsd = undefined;
    passSawResult = false;
    nodeTokens = undefined;
    nodeIdleTimedOut = false;
    streamSettled = false;
    lastWatchdogReset = undefined;
    watchdogResets = createWatchdogResetRecorder(logDir, workflowRun.id, node.id);
    backgroundTasksIncomplete = [];
    const providerEvents = createProviderEventHandler({
      toolAttention: ctx.toolAttention.createStream({
        nodeId: stepName,
        reportedBackgroundWork: capabilities.backgroundWork === 'reported',
        provider: provider,
        thresholdMs: ctx.config.workflows?.toolCallAttentionMs ?? DEFAULT_TOOL_CALL_ATTENTION_MS,
        env: {
          ...(ctx.execContext.kind === 'host' ? process.env : {}),
          ...nodeOptionsWithAbort.env,
        },
        protectedEnvKeys: ctx.config.protectedEnvKeys,
        protectedCredentialValues: ctx.config.protectedCredentialValues,
      }),
      store: deps.store,
      platform,
      conversationId,
      messageContext: nodeContext,
      logDir,
      runId: workflowRun.id,
      nodeId: node.id,
      stepName,
      attempt: attemptEvents,
      configuredMcpServers: nodeMcp.kind === 'load' ? nodeMcp.servers : new Set(),
      onMessageText: async text => {
        nodeOutputText += text; // ALWAYS capture for $node_id.output
        if (streamingMode === 'stream') {
          await safeSendMessage(platform, conversationId, text, nodeContext);
        } else {
          batchMessages.push(text);
        }
      },
      // A warning goes out at once (a Pi extension's review URL must reach the user
      // before the node blocks), so the batched reply before it goes out first. A
      // structured-output node is left alone: its batch is replaced by the parsed output.
      beforeWarning: async () => {
        if (batchMessages.length === 0 || nodeOptions?.outputFormat) return;
        await safeSendMessage(platform, conversationId, batchMessages.join('\n\n'), nodeContext);
        batchMessages.length = 0;
      },
    });
    const shouldStopStream = async (): Promise<boolean> => {
      await ctx.toolAttention.refresh();
      await providerEvents.refreshAttention();
      const tickNow = Date.now();
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
            return true;
          }
        } catch (cancelCheckErr) {
          getLog().warn(
            { err: cancelCheckErr as Error, workflowRunId: workflowRun.id, nodeId: node.id },
            'dag.status_check_failed'
          );
        }
      }

      return false;
    };
    try {
      for await (const msg of withIdleTimeout(
        aiClient.sendQuery(attemptPrompt, cwd, pass.resumeSessionId, nodeOptionsWithAbort),
        effectiveIdleTimeout,
        () => {
          nodeIdleTimedOut = true;
          getLog().warn(
            {
              nodeId: node.id,
              timeoutMs: effectiveIdleTimeout,
              ...(lastWatchdogReset
                ? {
                    lastResetType: lastWatchdogReset.type,
                    lastResetAt: new Date(lastWatchdogReset.at).toISOString(),
                  }
                : {}),
            },
            'dag_node_idle_timeout_reached'
          );
          nodeAbortController.abort();
        },
        (msg, resetAt) => {
          const type = msg.type;
          lastWatchdogReset = { type, at: resetAt };
          watchdogResets.observe(type, resetAt);
        },
        () =>
          providerEvents.hasOpenTools() ||
          (capabilities.backgroundWork === 'reported' &&
            providerEvents.liveSubtaskIds().length > 0),
        shouldStopStream
      )) {
        const tickNow = Date.now();

        if (await shouldStopStream()) break;

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

        if (msg.type === 'result') {
          if (pass.threadsSession) {
            newSessionId = msg.sessionId;
            if (msg.resumed !== undefined) nodeResumed = msg.resumed;
          }
          nodeTokensUnknown ||= msg.tokensUnknown === true;
          if (nodeTokensUnknown) {
            nodeTokens = undefined;
          } else if (msg.tokens !== undefined) {
            nodeTokens = sumTokenUsage([...(nodeTokens ? [nodeTokens] : []), msg.tokens], {
              nodeId: node.id,
            });
          }
          passSawResult = true;
          if (msg.cost === undefined || !Number.isFinite(msg.cost)) costReportMissing = true;
          if (msg.cost !== undefined) {
            if (Number.isFinite(msg.cost)) {
              nodeCostUsd = (nodeCostUsd ?? 0) + msg.cost;
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
          if (msg.text !== undefined) {
            nodeOutputText = msg.text;
            batchMessages.splice(0, batchMessages.length, msg.text);
          }
          structuredOutput = msg.structuredOutput;
          if (msg.failure !== undefined) {
            throw providerReportedFailure(
              `Node '${node.id}'`,
              msg.failure,
              nodeOptions?.maxBudgetUsd,
              {
                nodeId: node.id,
                durationMs: Date.now() - nodeStartTime,
              }
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
                ...(msg.sessionId ? { sessionIdPreview: sessionPreview(msg.sessionId) } : {}),
                stopReason: msg.stopReason,
                durationMs: Date.now() - nodeStartTime,
              },
              'dag.node_sdk_error_result'
            );
            throw new Error(`Node '${node.id}' failed: SDK returned ${subtype}${errorsDetail}`);
          }
        } else if (msg.type === 'settled') {
          streamSettled =
            capabilities.backgroundWork !== 'reported' ||
            providerEvents.liveSubtaskIds().length === 0;
          break;
        } else {
          await providerEvents.handle(msg);
        }
      }
    } finally {
      await providerEvents.clearAttention();
    }

    // Stream ended with subtasks still live: the SDK subprocess died or the idle
    // timeout fired mid-wait, so the tasks' artifacts may be missing (#2083).
    // Record them for the audit trail. The operator hears about it once, from the
    // node's failure: a stream that produced output and never settled fails the node
    // and names these tasks (see unsettledTurnError).
    if (providerEvents.liveSubtaskIds().length > 0) {
      backgroundTasksIncomplete = providerEvents.liveSubtaskIds();
      getLog().warn(
        {
          nodeId: node.id,
          taskIds: backgroundTasksIncomplete,
          idleTimedOut: nodeIdleTimedOut,
          cancelled: nodeAbortController.signal.aborted && !nodeIdleTimedOut,
        },
        'dag.node_stream_ended_with_live_background_tasks'
      );
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

  const runWorkload = async (): Promise<
    | (NodeExecutionResult & { state: 'completed' })
    | { state: 'failed'; output: string; error: string; failureKind: NodeFailureKind }
  > => {
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
      try {
        await runStreamPass(
          reaskPrompt,
          structuredOutputPass(reaskAttempt, resumeSessionId, resumeIntent === 'source-fork')
        );
      } finally {
        await watchdogResets.flush();
        if (!passSawResult) costReportMissing = true;
        if (nodeCostUsd !== undefined) {
          accumulatedCostUsd = (accumulatedCostUsd ?? 0) + nodeCostUsd;
        }
        if (nodeTokensUnknown) {
          accumulatedTokens = undefined;
        } else if (nodeTokens !== undefined) {
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
        // truncation. An uncompilable schema FAILS the node (#2453): the loader
        // compiles every declared `output_format`, so reaching this branch means a
        // definition bypassed the loader — continuing would let a declared contract
        // cross the boundary unenforced, after the turn was already paid for.
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
          throw new NodeFailure(
            'config',
            `Node '${node.id}': its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`
          );
        }
        if (validation.valid) {
          try {
            nodeOutputText = canonicalValueText(structuredOutput);
          } catch (serializeErr) {
            const err = serializeErr as Error;
            throw new NodeFailure(
              'output_contract',
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
        throw new NodeFailure(
          'output_contract',
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
        throw new NodeFailure(
          'timeout',
          `Node '${node.id}': timed out (no output for ${String(effectiveIdleTimeout / 60000)} min) before producing the required structured output.${formatWatchdogResetDiagnostic(lastWatchdogReset)}`
        );
      }
      throw new NodeFailure(
        'output_contract',
        `Node '${node.id}': output_format declared but the provider returned no schema-valid structured output. ` +
          'The model likely replied with prose, refused, or emitted unparseable JSON.'
      );
    }

    // Every provider ends a turn with `settled`. Output without it means the stream was
    // cut off (idle timeout, a provider that died or broke the contract), so the node
    // fails rather than completing on a turn that may not be done. Zero output falls
    // through to the empty-output guard below; cancellation is handled just after.
    const cancelledMidStream = nodeAbortController.signal.aborted && !nodeIdleTimedOut;
    if (
      !streamSettled &&
      !cancelledMidStream &&
      (nodeOutputText.trim() !== '' || structuredOutput !== undefined)
    ) {
      throw new NodeFailure(
        nodeIdleTimedOut ? 'timeout' : 'unknown',
        `Node '${node.id}' failed: ${unsettledTurnError(
          nodeIdleTimedOut ? effectiveIdleTimeout : undefined,
          lastWatchdogReset,
          backgroundTasksIncomplete
        )}`
      );
    }

    // If cancelled during streaming (not idle timeout), return as failed with cancel reason
    if (nodeAbortController.signal.aborted && !nodeIdleTimedOut) {
      const duration = Date.now() - nodeStartTime;
      getLog().info(
        { nodeId: node.id, durationMs: duration },
        'dag_node_cancelled_during_streaming'
      );
      return {
        state: 'failed',
        output: nodeOutputText,
        error: 'Cancelled by user',
        failureKind: 'cancelled',
      };
    }

    if (streamingMode === 'batch' && batchMessages.length > 0) {
      const batchContent =
        structuredOutput !== undefined && nodeOptions?.outputFormat
          ? nodeOutputText
          : batchMessages.join('\n\n');
      await safeSendMessage(platform, conversationId, batchContent, nodeContext);
    }

    // Fail for zero output: covers both silent non-timeout exits AND idle-timeout before first token (time-to-first-token exceeded the window).
    if (nodeOutputText.trim() === '' && structuredOutput === undefined) {
      const duration = Date.now() - nodeStartTime;
      const emptyError = nodeIdleTimedOut
        ? `Node '${node.id}' timed out with no output (idle for ${String(effectiveIdleTimeout / 60000)} min).${formatWatchdogResetDiagnostic(lastWatchdogReset)} Consider increasing idle_timeout or reducing prompt size.`
        : `Node '${node.id}' produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.`;
      getLog().error({ nodeId: node.id, durationMs: duration }, 'dag.node_empty_output');
      return {
        state: 'failed',
        output: '',
        error: emptyError,
        failureKind: nodeIdleTimedOut ? 'timeout' : 'transient',
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
          `Node '${node.id}' resumed '${namedResumeSourceNodeId}' but the provider returned no branch session ID.`
        );
      }
      if (resumeIntent === 'owner-continuation' && newSessionId !== resumeSessionId) {
        throw new Error(
          `Node '${node.id}' did not continue its private owner session: the provider replaced the session ID.`
        );
      }
      if (resumeIntent !== 'owner-continuation' && newSessionId === resumeSessionId) {
        throw new Error(
          `Node '${node.id}' did not create an immutable fork of '${namedResumeSourceNodeId}': the provider reused the source session ID.`
        );
      }
    }

    if (newSessionId !== undefined) {
      await checkpointSession?.(newSessionId);
    }

    // Artifact pointers are validated here, before any node_completed row exists, so a
    // result naming a file it may not address fails this node instead of handing a
    // downstream consumer a location the engine never checked (#2453).
    if (structuredOutput !== undefined) {
      const badPointer = await rejectedArtifactPointer(workflowRun, structuredOutput);
      if (badPointer !== null) {
        throw new NodeFailure('output_contract', `Node '${node.id}': ${badPointer}.`);
      }
    }

    // Capture the producer's declared field set so downstream `$node.output.field`
    // refs can tell a declared-optional-absent field ('') from a typo (throws).
    // Only present when output_format declares an object with `properties`.
    const declaredOutputPaths = declaredOutputPathsFromSchema(node.output_format);

    return {
      state: 'completed',
      output: nodeOutputText,
      sessionId: newSessionId,
      costUsd: nodeCostUsd,
      ...(nodeTokens !== undefined ? { tokens: nodeTokens } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
      ...(nodeResumed !== undefined ? { resumed: nodeResumed } : {}),
    };
  };
  let result: Awaited<ReturnType<typeof runWorkload>>;
  try {
    result = await runWorkload();
  } catch (error) {
    const err = error as Error;

    const cancelled = nodeAbortController.signal.aborted && !nodeIdleTimedOut;
    const failureMessage = cancelled
      ? 'Cancelled by user'
      : nodeMcp.kind === 'missing'
        ? `${err.message}\n${nodeMcp.diagnostic}`
        : err.message;
    if (cancelled) {
      getLog().info({ nodeId: node.id }, 'dag_node_cancelled_via_abort');
    } else {
      getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    }
    const failureKind: NodeFailureKind = cancelled
      ? 'cancelled'
      : err instanceof NodeFailure
        ? err.kind
        : 'unknown';
    const providerFailure =
      !cancelled && err instanceof NodeFailure ? err.providerFailure : undefined;
    return failAgentNode(failureMessage, failureKind, {
      ...(providerFailure !== undefined ? { providerFailure } : {}),
    });
  }
  if (result.state === 'failed') {
    return failAgentNode(result.error, result.failureKind, { output: result.output });
  }
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const completed = await recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      execution,
      { status: 'completed' },
      {
        output: {
          text: result.output,
          structured: result.structuredOutput,
          declaredOutputPaths: result.declaredOutputPaths,
        },
        tokens: nodeTokens,
        tokensUnknown: nodeTokensUnknown,
        costUsd: nodeCostUsd,
        costPartial: costReportMissing,
        stopReason: nodeStopReason,
        numTurns: nodeNumTurns,
        resolvedModel: nodeResolvedModel?.id,
        sessionId: result.sessionId,
        resumed: result.resumed,
        durationMs: duration,
        diagnostics: {
          ...execution.diagnostics,
          ...(node.output_type !== undefined ? { outputType: node.output_type } : {}),
          ...(namedResumeSourceNodeId !== undefined
            ? { sessionForked: resumeIntent !== 'owner-continuation' }
            : {}),
          ...(backgroundTasksIncomplete.length > 0 ? { backgroundTasksIncomplete } : {}),
        },
      }
    ),
    { resumed: result.resumed }
  );

  // Clean up throttle entries on completion
  lastNodeCancelCheck.delete(`${workflowRun.id}:${node.id}`);
  lastNodeActivityUpdate.delete(`${workflowRun.id}:${node.id}`);

  return completed;
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
 * Because the spill filename is reused, `foldDagResumeSnapshot` (dag-resume-snapshot.ts)
 * checks its byte length against the row's `originalBytes`. A later execution can
 * overwrite the file before its event commits; a length mismatch exposes that stale
 * pairing. The check cannot distinguish different contents of the same length.
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

  const spillDir = joinPath(
    artifactsDir,
    RUN_ARTIFACTS_ENGINE_SUBDIR,
    'node-output-spills',
    'persisted'
  );
  const spillPath = writeSpillFile(spillDir, `${spillKey}.nodeoutput`, output);

  return {
    nodeOutput: outputBytes.subarray(0, headEnd).toString('utf8') + marker,
    truncated: true,
    originalBytes: outputBytes.byteLength,
    ...(spillPath ? { spillPath } : {}),
  };
}

/** Carry the bounded persistence preview separately from the complete runtime text. */
function persistedExecutionOutput(
  persistedOutput: ReturnType<typeof formatPersistedNodeOutput>,
  text = persistedOutput.nodeOutput
): import('./schemas/node-execution').ExecutionOutput {
  return {
    text,
    persisted: {
      text: persistedOutput.nodeOutput,
      truncated: persistedOutput.truncated,
      ...(persistedOutput.originalBytes !== undefined
        ? { originalBytes: persistedOutput.originalBytes }
        : {}),
      ...(persistedOutput.spillPath !== undefined ? { spillPath: persistedOutput.spillPath } : {}),
    },
  };
}

/**
 * Prove every reserved artifact pointer in a value the engine is about to persist (#2453).
 *
 * Called ONLY where a value is PRODUCED — an AI node, a loop iteration, a certified
 * `bash:`/`script:` stdout — and validated against that producer's own run. A `workflow:`
 * parent and a fan-out aggregate relay a child's value as-is: the child already proved it
 * against the only run a pointer may name. A value carrying no pointer costs one walk and
 * no I/O, so the check is unconditional rather than gated on a declared `output_format`:
 * the `archon_artifact` discriminator is reserved everywhere, not only inside a contract.
 *
 * Returns the rejection reason, phrased to complete `Node '<id>': <reason>.`, or `null`.
 */
async function rejectedArtifactPointer(run: WorkflowRun, value: unknown): Promise<string | null> {
  return validateArtifactPointers(value, run);
}

/**
 * A deterministic producer's stdout did not satisfy the contract it declared.
 *
 * Its own class so the exec catch blocks report Archon's diagnosis verbatim instead of
 * running it through `formatSubprocessFailure` — which would re-label it as a subprocess
 * diagnostic and, worse, read a stdout excerpt containing "timed out" as a timeout.
 */
class ExecOutputContractError extends Error {}

/**
 * Why a turn that produced output is not finished: its provider never sent `settled`.
 * An idle timeout says how long the stream was silent; otherwise the stream simply ended.
 * The caller names the node or iteration in front of it.
 */
function unsettledTurnError(
  idleTimeoutMs: number | undefined,
  lastWatchdogReset: WatchdogReset | undefined,
  liveTaskIds: readonly string[]
): string {
  const cause =
    idleTimeoutMs !== undefined
      ? `timed out after ${String(idleTimeoutMs / 60000)} min without an event, before the provider signalled that its turn settled.${formatWatchdogResetDiagnostic(lastWatchdogReset)}`
      : 'the provider stream ended without signalling that its turn settled.';
  const tasks =
    liveTaskIds.length > 0 ? ` Subtask(s) still running: ${liveTaskIds.join(', ')}.` : '';
  return `${cause}${tasks} Its work may be incomplete.`;
}

/**
 * This host could not read the run's frozen source for a node (`isSourceReadFailure`).
 * Not a node outcome: it leaves the layer join like a budget refusal, and
 * `executeDagWorkflow` releases the run to be continued by a host that can read it.
 */
class RunSourceUnreadableError extends Error {
  readonly path?: string;
  constructor(
    /** The node's persisted step name. */
    readonly nodeId: string,
    cause: unknown
  ) {
    const path =
      cause instanceof WorkflowSourceUnavailableError
        ? cause.path
        : isSystemError(cause) && typeof cause.path === 'string'
          ? cause.path
          : undefined;
    super(
      `This host could not read the run's source for node '${nodeId}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
    this.name = 'RunSourceUnreadableError';
    this.path = path;
  }
}

/** Verify the run's frozen source before a node reads it; a read failure releases the run. */
async function assertNodeSourceReadable(
  roots: WorkflowSourceRoots,
  stepName: string
): Promise<ReadonlySet<string> | undefined> {
  try {
    return await assertWorkflowSourceIntegrity(roots);
  } catch (error) {
    if (isSourceReadFailure(error)) throw new RunSourceUnreadableError(stepName, error);
    throw error;
  }
}

async function loadNodeCommandPrompt(
  ctx: RunLayersContext,
  command: string,
  stepName: string
): Promise<Awaited<ReturnType<typeof loadCommandPrompt>>> {
  const verifiedFiles = await assertNodeSourceReadable(ctx.workflowSourceRoots, stepName);
  try {
    const result = await loadCommandPrompt(
      ctx.deps,
      ctx.cwd,
      command,
      ctx.configuredCommandFolder,
      ctx.workflowSourceRoots,
      verifiedFiles
    );
    if (!result.success && isSourceReadFailure(result.cause, verifiedFiles)) {
      // Packaged commands resolve by path, so ENOENT can also mean an authored command
      // never existed. Only a file in the verified capture was lost on this host.
      if (
        result.reason === 'not_found' &&
        !(
          isSystemError(result.cause) &&
          typeof result.cause.path === 'string' &&
          verifiedFiles?.has(result.cause.path)
        )
      )
        return result;
      throw result.cause;
    }
    return result;
  } catch (error) {
    if (isSourceReadFailure(error, verifiedFiles))
      throw new RunSourceUnreadableError(stepName, error);
    throw error;
  }
}

/** A node failure whose cause the engine detected itself, carried to the failure record. */
class NodeFailure extends Error {
  constructor(
    readonly kind: NodeFailureKind,
    message: string,
    /** The provider's typed failure, recorded unchanged on the failed node. */
    readonly providerFailure?: ProviderFailure
  ) {
    super(message);
  }
}

/**
 * A provider's typed failure on its result chunk. The kind comes from the class, so retry
 * never reads the evidence text, which stays in the message for the operator.
 */
function providerReportedFailure(
  subject: string,
  failure: ProviderFailure,
  maxBudgetUsd: number | undefined,
  logContext: Record<string, unknown>
): NodeFailure {
  let message: string;
  switch (failure.class) {
    case 'budget_exceeded':
      getLog().warn({ ...logContext, maxBudgetUsd }, 'dag.node_budget_cap_exceeded');
      message = `${subject} exceeded cost cap${maxBudgetUsd !== undefined ? ` of $${maxBudgetUsd.toFixed(2)}` : ''}.`;
      break;
    case 'misconfigured':
      message = `${subject} failed: the provider's configuration must be fixed before it can run; retrying will not help: ${failure.evidence}`;
      break;
    case 'quota_exhausted':
      // With a reported reset the run usually waits for it and continues by itself, so the
      // text gives no resume advice: resuming before the reset spends a provider call.
      message =
        failure.resetAt !== undefined
          ? `${subject} failed: the provider's usage or credit limit is used up until ${failure.resetAt}: ${failure.evidence}`
          : `${subject} failed: the provider's usage or credit limit is used up. Resume the run once it reopens: ${failure.evidence}`;
      break;
    default:
      message = `${subject} failed: provider reported ${failure.class}: ${failure.evidence}`;
  }
  return new NodeFailure(nodeFailureKindOf(failure), message, failure);
}

async function recordExecTimeoutSkip(
  ctx: RunLayersContext,
  execution: NodeExecutionRecord
): Promise<NodeExecutionResult> {
  const cause: SkipCause = { kind: 'timeout' };
  getLog().info({ nodeId: execution.node.id }, 'dag_node_skipped_timeout');
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(execution, { status: 'skipped', reason: 'timeout', cause })
  );
}

/** How much of the offending stdout a contract failure quotes back to the author. */
const EXEC_CONTRACT_STDOUT_PREVIEW = 200;

function execStdoutPreview(stdout: string, credentialValues: readonly string[]): string {
  // Redact BEFORE slicing: the preview lands in `node_failed.data.error`, and a credential
  // that straddles the cut would otherwise leak its head. Retention (#2967) already applies
  // the same set to the tails; the quoted excerpt must not be the one unredacted copy.
  const redacted = redactCredentialValues(stdout, credentialValues);
  const head = redacted.slice(0, EXEC_CONTRACT_STDOUT_PREVIEW);
  return `${JSON.stringify(head)}${redacted.length > head.length ? ' …[truncated]' : ''}`;
}

/**
 * Certify a `bash:`/`script:` node's stdout against the schema it declared (#2453).
 *
 * A deterministic producer that declares `output_format` owns a result contract exactly
 * like an AI producer does: its stdout must parse as ONE strict JSON document, satisfy the
 * shared ajv gate, and become the same logical-value + canonical-text + declared-fields
 * triple `executeAgentNode` returns. There is no fence stripping, no `jsonrepair` tier and
 * no reask — those exist because a model improvises; stdout that does not match the script's
 * own declaration is a bug in the script, and retrying it would only cost time.
 *
 * A node with no `output_format` returns its stdout byte-for-byte, as it always has.
 *
 * @throws ExecOutputContractError when stdout is not JSON, or fails the declared schema.
 */
export function certifyExecOutput(
  node: ExecNode,
  stdout: string,
  credentialValues: readonly string[]
): {
  output: string;
  structuredOutput?: JsonValue;
  declaredOutputPaths?: DeclaredOutputPaths;
} {
  if (node.output_format === undefined) return { output: stdout };

  const label = `${node.runtime === 'sh' ? 'Bash' : 'Script'} node '${node.id}'`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (parseErr) {
    throw new ExecOutputContractError(
      `${label} declares an output_format, so its stdout must be a single JSON document, but it did not parse: ${(parseErr as Error).message}. stdout began: ${execStdoutPreview(stdout, credentialValues)}`
    );
  }
  // `JSON.parse` can only yield a JsonValue — no undefined, no non-finite number, no
  // exotic prototype — so the value satisfies the logical domain by construction.
  const value = parsed as JsonValue;

  let schemaCompileError: string | undefined;
  const validation = validateStructuredOutput(value, node.output_format, compileMsg => {
    schemaCompileError = compileMsg;
  });
  if (schemaCompileError !== undefined) {
    // Same posture as the AI gate: the loader compiles every declared schema, so reaching
    // this branch means a definition bypassed it and the contract cannot be enforced.
    throw new ExecOutputContractError(
      `${label}: its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`
    );
  }
  if (!validation.valid) {
    throw new ExecOutputContractError(
      `${label}: stdout did not satisfy its declared output_format: ${validation.errors.join('; ')}. stdout began: ${execStdoutPreview(stdout, credentialValues)}`
    );
  }

  // Same projection an AI producer captures: it lets a downstream `.field` ref tell a
  // declared-but-absent optional field ('') from a typo (throws).
  const declaredOutputPaths = declaredOutputPathsFromSchema(node.output_format);
  return {
    output: canonicalValueText(value),
    structuredOutput: value,
    ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
  };
}

/**
 * Artifact-pointer gate for a certified exec value (#2453).
 *
 * Raised as an {@link ExecOutputContractError} for the same reason a parse or schema
 * failure is: both exec catches inspect the message to tell Archon's own diagnosis from a
 * subprocess diagnostic, and a rejected pointer is a statement about the script's declared
 * result, not about how the subprocess exited.
 *
 * @throws ExecOutputContractError when the stdout value names an artifact it cannot address.
 */
async function assertExecArtifactPointers(
  workflowRun: WorkflowRun,
  node: ExecNode,
  value: JsonValue | undefined
): Promise<void> {
  if (value === undefined) return;
  const badPointer = await rejectedArtifactPointer(workflowRun, value);
  if (badPointer === null) return;
  const label = `${node.runtime === 'sh' ? 'Bash' : 'Script'} node '${node.id}'`;
  throw new ExecOutputContractError(`${label}: ${badPointer}.`);
}

/**
 * Execute a bash (shell script) DAG node.
 * Runs the script via `bash -c`, captures stdout as node output.
 * No AI session is created — bash nodes are free/deterministic.
 */
async function executeBashNode(
  ctx: RunLayersContext,
  node: ExecNode,
  envVars?: Record<string, string>,
  protectedEnvKeys?: readonly string[],
  protectedCredentialValues?: readonly string[],
  stepNamePrefix = '',
  iteration?: number,
  // Per-iteration $LOOP_USER_INPUT free-text for loop_group body bash nodes, delivered via
  // env (#2725). This is bash's SECOND delivery channel — the literal "$LOOP_USER_INPUT"
  // token is shell-quoted into the script source from the enclosing loop scope
  // (ctx.loopBodyScopes); this env var is what a script that
  // reads the variable indirectly (${LOOP_USER_INPUT}, printenv, env) actually sees. ''
  // for top-level bash nodes and non-first iterations.
  loopUserInput = ''
): Promise<NodeExecutionResult> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    issueContext,
    execContext,
  } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, { checkoutStart: await observeNodeCheckout(ctx) }),
    diagnostics: { ...(iteration !== undefined ? { iteration } : {}) },
  };

  getLog().info({ nodeId: node.id, type: 'bash' }, 'dag_node_started');

  await recordNodeState({ store: deps.store, logDir }, execution);

  // Fresh per call: executeBashNode runs once per retry attempt, so each attempt
  // observes the artifacts published before IT. A materialization failure propagates
  // to the retry/dispatch boundary as an explicit node provisioning error.
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  const { prompt: finalScript } = substituteWorkflowVariables(
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
    {
      shellSafe: true,
      stateDir,
      typedArtifactsFile,
      references: nodeTemplateReferences(node.script, ctx, 'shell', { artifactsDir }),
    }
  );

  // Archon-managed env only — runSubprocess adds the host env for host runs and
  // delivers ONLY this bag into the container (host process.env never crosses).
  const subprocessEnv: NodeJS.ProcessEnv = buildNodeShellEnvironment(node, ctx, envVars, {
    artifactsDir,
    stateDir,
    logDir,
    workflowId: workflowRun.id,
    baseBranch,
    userMessage: workflowRun.user_message,
    loopUserInput,
    loopPrevOutput: '',
    rejectionReason: '',
    issueContext,
    adoptedRunDir: currentAdoptedRunDir(),
    typedArtifactsFile,
    nodeExecution: execution,
  });

  const bashPath = resolveBashPath();
  let certified: ReturnType<typeof certifyExecOutput>;
  try {
    const { stdout, stderr, credentialValues } = await runSubprocessUntilRunStops(
      deps.store,
      workflowRun.id,
      node.id,
      execContext,
      bashPath,
      ['-c', finalScript],
      {
        cwd,
        timeout: node.timeout,
        endTreeOnTimeout: true,
        env: subprocessEnv,
        protectedEnvKeys,
        protectedCredentialValues,
        retention: {
          logDir,
          workflowRunId: workflowRun.id,
          nodeId: node.id,
          label: '<bash>',
        },
      }
    );

    // Trim trailing newline from stdout (common shell behavior)
    const trimmedStdout = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'bash_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Bash node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    // A declared output_format makes this node's stdout a contract: parse it, validate it,
    // and hand downstream consumers the canonical document instead of raw text (#2453).
    // Runs AFTER the stderr relay so a contract failure never swallows the script's own
    // diagnostics; it throws an ExecOutputContractError, handled by this function's catch.
    certified = certifyExecOutput(node, trimmedStdout, credentialValues);
    await assertExecArtifactPointers(workflowRun, node, certified.structuredOutput);
  } catch (error) {
    const err = error as RawSubprocessRejection;
    // A contract failure (#2453) is Archon's own diagnosis of stdout, not a subprocess
    // rejection. Report it verbatim and keep it outside subprocess classification.
    const contractFailure = error instanceof ExecOutputContractError;
    const isTimeout = !contractFailure && isSubprocessTimeout(err);
    if (isTimeout && node.on_timeout === 'skip') {
      return recordExecTimeoutSkip(ctx, execution);
    }
    const label = `Bash node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in — the timeout message also contains the
    // full `Command failed: bash -c <body>` line and would otherwise leak.
    const formatted = formatSubprocessFailure(err, label);
    let errorMsg: string;
    if (contractFailure) {
      errorMsg = err.message;
    } else if (isTimeout) {
      errorMsg = `${label} timed out after ${String(node.timeout)}ms`;
    } else if (err.treeSurvived) {
      errorMsg = `${label} failed: ${err.message}`;
    } else if (err.cancelled) {
      errorMsg = `${label} cancelled`;
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

    return recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error: errorMsg,
          failureKind: contractFailure
            ? 'output_contract'
            : err.cancelled
              ? 'cancelled'
              : isTimeout
                ? 'timeout'
                : 'exec_failed',
          ...(contractFailure ? { retryable: false as const } : {}),
        },
        { output: { text: '' } }
      )
    );
  }

  const output = certified.output;
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const persistedOutput = formatPersistedNodeOutput(output, artifactsDir, stepName);

  return recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      execution,
      { status: 'completed' },
      {
        durationMs: duration,
        output: {
          text: output,
          structured: certified.structuredOutput,
          declaredOutputPaths: certified.declaredOutputPaths,
          persisted: {
            text: persistedOutput.nodeOutput,
            truncated: persistedOutput.truncated,
            originalBytes: persistedOutput.originalBytes,
            spillPath: persistedOutput.spillPath,
          },
        },
      }
    )
  );
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
 * release before the refs are removed. `script` is the author's raw template, so a
 * substituted `$nodeId.output` value can't false-positive.
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
  ctx: RunLayersContext,
  node: ExecNode,
  reserveBudget: () => Promise<void>,
  envVars?: Record<string, string>,
  protectedEnvKeys?: readonly string[],
  protectedCredentialValues?: readonly string[],
  stepNamePrefix = '',
  iteration?: number,
  // Per-iteration $LOOP_USER_INPUT free-text for loop_group body scripts, delivered via
  // env (never spliced into source — #2115). '' for top-level scripts and non-first
  // iterations. This is script's ONLY delivery channel; executeBashNode also uses this
  // same env-var parameter (#2725), but additionally has the literal "$LOOP_USER_INPUT"
  // token shell-quoted into its script source from the enclosing loop scope — a channel
  // script deliberately has no equivalent of.
  loopUserInput = ''
): Promise<NodeExecutionResult> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    issueContext,
    execContext,
    workflowSourceRoots,
  } = ctx;
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  // Resolve before deciding whether this is inline or filesystem-backed: substitutions
  // can turn the authored field into either form. A named source is checked outside the
  // deterministic retry classifier, so an integrity failure cannot consume retries.
  // User-controlled variables stay in subprocess env instead of being spliced into
  // TS/Python source; strict node-output references keep raw substitution (#2115).
  // Fresh per call, same as executeBashNode: one attempt, one observation.
  const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
  const { prompt: finalScript } = substituteWorkflowVariables(
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
    {
      shellSafe: true,
      stateDir,
      typedArtifactsFile,
      references: nodeTemplateReferences(node.script, ctx, 'script'),
    }
  );
  const verifiedScriptFiles = !isInlineScript(finalScript)
    ? await assertNodeSourceReadable(workflowSourceRoots, stepName)
    : undefined;
  const namedScripts = isInlineScript(finalScript)
    ? undefined
    : await discoverScriptsForCwd(
        cwd,
        workflowSourceRoots,
        new Set([finalScript]),
        capturedSourceReadGuard(verifiedScriptFiles)
      )
        .then(async scripts => {
          await assertCapturedFilesPresent(verifiedScriptFiles);
          const selected = scripts.get(finalScript);
          if (selected) await readFile(selected.path);
          return scripts;
        })
        .catch(error => {
          if (isSourceReadFailure(error, verifiedScriptFiles))
            throw new RunSourceUnreadableError(stepName, error);
          return error instanceof Error ? error : new Error(String(error));
        });
  await reserveBudget();
  const execution: NodeExecutionRecord = {
    ...beginExecution(ctx, node, { checkoutStart: await observeNodeCheckout(ctx) }),
    diagnostics: { ...(iteration !== undefined ? { iteration } : {}) },
  };

  getLog().info({ nodeId: node.id, type: 'script', runtime: node.runtime }, 'dag_node_started');

  await recordNodeState({ store: deps.store, logDir }, execution);

  // One-release migration warn for any literal user-controlled var ref that no
  // longer substitutes now that delivery moved to env vars (#2115).
  await warnOnLiteralUserVars(node, node.script, platform, conversationId, nodeContext);

  // Archon-managed env only — runSubprocess adds the host env for host runs and
  // delivers ONLY this bag into the container (host process.env never crosses).
  // User-controlled values ride env vars (never spliced into source) — the
  // sanctioned injection-safe channel, matching executeBashNode (#2115).
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...buildNodeShellEnvironment(node, ctx, envVars, {
      artifactsDir,
      stateDir,
      logDir,
      workflowId: workflowRun.id,
      baseBranch,
      userMessage: workflowRun.user_message,
      loopUserInput,
      loopPrevOutput: '',
      rejectionReason: '',
      issueContext,
      adoptedRunDir: currentAdoptedRunDir(),
      typedArtifactsFile,
      nodeExecution: execution,
    }),
    // Named Python scripts run from the frozen capture, and CPython writes bytecode
    // caches beside any module it imports. A cache landing in the capture would change
    // it under the run and fail the next integrity check with a misleading message.
    // Inline scripts have no siblings, so the flag costs them nothing.
    PYTHONDONTWRITEBYTECODE: '1',
  };

  // Build the command and args based on runtime and inline vs named
  let cmd = '';
  let args: string[] = [];

  const nodeDeps = node.deps ?? [];

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
    if (namedScripts instanceof Error) {
      const err = namedScripts;
      const errorMsg = `Script node '${node.id}': failed to discover scripts — ${err.message}`;
      getLog().error({ err, nodeId: node.id, cwd }, 'script_discovery_failed');
      await safeSendMessage(platform, conversationId, errorMsg, nodeContext);

      return recordNodeState(
        { store: deps.store, logDir },
        finishNodeExecution(
          execution,
          { status: 'failed', error: errorMsg, failureKind: 'config' },
          { output: { text: '' } }
        )
      );
    }
    const scriptDef = namedScripts?.get(finalScript);

    if (!scriptDef) {
      const errorMsg = `Script node '${node.id}': named script '${finalScript}' not found in .archon/scripts/ or ~/.archon/scripts/`;
      getLog().error({ nodeId: node.id, scriptName: finalScript }, 'script_not_found');
      await safeSendMessage(platform, conversationId, errorMsg, nodeContext);

      return recordNodeState(
        { store: deps.store, logDir },
        finishNodeExecution(
          execution,
          { status: 'failed', error: errorMsg, failureKind: 'config' },
          { output: { text: '' } }
        )
      );
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

  // After dispatch, a rejection may follow user side effects; source recovery must not
  // replace that outcome. Recheck while execution is still known not to have started.
  const selected = namedScripts instanceof Map ? namedScripts.get(finalScript) : undefined;
  if (selected) {
    try {
      await Promise.all([...(verifiedScriptFiles ?? [selected.path])].map(path => readFile(path)));
    } catch (error) {
      if (isSourceReadFailure(error, verifiedScriptFiles))
        throw new RunSourceUnreadableError(stepName, error);
      throw error;
    }
  }

  let certified: ReturnType<typeof certifyExecOutput>;
  try {
    const { stdout, stderr, credentialValues } = await runSubprocessUntilRunStops(
      deps.store,
      workflowRun.id,
      node.id,
      execContext,
      cmd,
      args,
      {
        cwd,
        timeout: node.timeout,
        endTreeOnTimeout: true,
        env: subprocessEnv,
        protectedEnvKeys,
        protectedCredentialValues,
        retention: {
          logDir,
          workflowRunId: workflowRun.id,
          nodeId: node.id,
          label: '<script>',
        },
      }
    );

    // Trim trailing newline from stdout (common shell behavior)
    const trimmedStdout = stdout.replace(/\n$/, '');

    if (stderr.trim()) {
      getLog().warn({ nodeId: node.id, stderr: stderr.trim() }, 'script_node_stderr');
      await safeSendMessage(
        platform,
        conversationId,
        `Script node '${node.id}' stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\``,
        nodeContext
      );
    }

    // Identical certification to executeBashNode (#2453): a declared output_format makes
    // this node's stdout a contract, and the canonical document replaces the raw text.
    certified = certifyExecOutput(node, trimmedStdout, credentialValues);
    await assertExecArtifactPointers(workflowRun, node, certified.structuredOutput);
  } catch (error) {
    if (error instanceof RunSourceUnreadableError) throw error;
    const err = error as RawSubprocessRejection;
    // See executeBashNode: a contract failure (#2453) stays outside subprocess classification.
    const contractFailure = error instanceof ExecOutputContractError;
    const isTimeout = !contractFailure && isSubprocessTimeout(err);
    if (isTimeout && node.on_timeout === 'skip') {
      return recordExecTimeoutSkip(ctx, execution);
    }
    const label = `Script node '${node.id}'`;
    // Always run the formatter so logs get sanitized fields regardless of which
    // user-facing branch we end up in — the timeout message also contains the
    // full `Command failed: bun -e <body>` line and would otherwise leak.
    const formatted = formatSubprocessFailure(err, label);
    let errorMsg: string;
    if (contractFailure) {
      errorMsg = err.message;
    } else if (isTimeout) {
      errorMsg = `${label} timed out after ${String(node.timeout)}ms`;
    } else if (err.treeSurvived) {
      errorMsg = `${label} failed: ${err.message}`;
    } else if (err.cancelled) {
      errorMsg = `${label} cancelled`;
    } else if (execContext.kind === 'host' && err.code === 'ENOENT') {
      errorMsg = `${label} failed: '${cmd}' executable not found in PATH`;
    } else if (execContext.kind === 'host' && err.code === 'EACCES') {
      errorMsg = `${label} failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = formatted.userMessage;
    }

    getLog().error(
      { ...formatted.logFields, nodeId: node.id, nodeType: 'script', isTimeout },
      'dag_node_failed'
    );

    return recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error: errorMsg,
          failureKind: contractFailure
            ? 'output_contract'
            : err.cancelled
              ? 'cancelled'
              : isTimeout
                ? 'timeout'
                : 'exec_failed',
          ...(contractFailure ? { retryable: false as const } : {}),
        },
        { output: { text: '' } }
      )
    );
  }

  const output = certified.output;
  const duration = Date.now() - nodeStartTime;
  getLog().info({ nodeId: node.id, durationMs: duration }, 'dag_node_completed');

  const persistedOutput = formatPersistedNodeOutput(output, artifactsDir, stepName);

  return recordNodeState(
    { store: deps.store, logDir },
    finishNodeExecution(
      execution,
      { status: 'completed' },
      {
        durationMs: duration,
        output: {
          text: output,
          structured: certified.structuredOutput,
          declaredOutputPaths: certified.declaredOutputPaths,
          persisted: {
            text: persistedOutput.nodeOutput,
            truncated: persistedOutput.truncated,
            originalBytes: persistedOutput.originalBytes,
            spillPath: persistedOutput.spillPath,
          },
        },
      }
    )
  );
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

/** Complete a signaled loop without another provider call, retaining its paused observations. */
async function finalizeLoopFromSignal(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRun: WorkflowRun,
  node: LoopNode | LoopGroupNode,
  stepName: string,
  nodeLabel: string,
  finalizeOutput: string,
  finalizeUsage: { costUsd?: number; tokens?: TokenUsage } | undefined,
  finalizeStructuredOutput: unknown,
  logDir: string,
  execution?: NodeExecutionRecord,
  sessionId?: string
): Promise<NodeExecutionResult> {
  const nodeId = node.id;
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
  const output = {
    text: finalizeOutput,
    structured: finalizeStructuredOutput,
    declaredOutputPaths: declaredOutputPathsFromSchema(node.output_format),
  };
  if (execution !== undefined) {
    return recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output,
          ...finalizeUsage,
          sessionId,
          // Approval does no execution work. Keep the duration observed before pause.
          durationMs: execution.timing.durationMs,
        }
      )
    );
  }
  // Older paused loop gates may lack execution identity and observed start time.
  // Preserve their completion without inventing historical execution metadata.
  const event: import('./store').NodeStateEventInput = {
    workflow_run_id: workflowRun.id,
    event_type: 'node_completed',
    step_name: stepName,
    data: {
      node_output: finalizeOutput,
      ...(finalizeStructuredOutput !== undefined
        ? { structured_output: finalizeStructuredOutput }
        : {}),
      ...(output.declaredOutputPaths !== undefined
        ? persistedOutputContract(output.declaredOutputPaths)
        : {}),
      ...(finalizeUsage?.costUsd !== undefined ? { cost_usd: finalizeUsage.costUsd } : {}),
      ...(finalizeUsage?.tokens !== undefined ? { tokens: finalizeUsage.tokens } : {}),
    },
  };
  await persistNodeEvent(deps.store, event);
  await recordDerivedNodeState({ logDir }, node, event);
  return {
    state: 'completed',
    output: finalizeOutput,
    ...(finalizeStructuredOutput !== undefined
      ? { structuredOutput: finalizeStructuredOutput }
      : {}),
    ...(output.declaredOutputPaths !== undefined
      ? { declaredOutputPaths: output.declaredOutputPaths }
      : {}),
    ...finalizeUsage,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * Only a sole terminal gate or wait can resume through its enclosing group.
 * The loader rejects other placements, which have no unambiguous owner.
 */
function findLoopGroupTerminalSuspendNode(
  bodyNodes: readonly DagNode[]
): GateNode | WaitNode | undefined {
  const sink = loopGroupSoleTerminalSink(bodyNodes);
  return sink !== undefined && (isGateNode(sink) || sink.kind === 'wait') ? sink : undefined;
}

/** An iteration's output: the first completed, non-empty one among its output nodes. */
function loopGroupIterationOutput(
  bodyNodes: readonly DagNode[],
  outputs: ReadonlyMap<string, NodeOutput>
): NodeOutput | undefined {
  return loopGroupOutputNodes(bodyNodes)
    .map(n => outputs.get(n.id))
    .find(o => o?.state === 'completed' && o.output.trim().length > 0);
}

/**
 * Execute a loop-group node — runs a multi-node sub-DAG body repeatedly until a
 * completion condition (`until` signal in the iteration's output, and/or
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
 * `$groupId.output` (visible to the outer DAG) = the final iteration's output, chosen by
 * {@link loopGroupIterationOutput}.
 *
 * Key behaviors:
 * - Returns NodeExecutionResult (not void) — the outer DAG executor owns run lifecycle
 * - Loop is encapsulated inside this one node; the outer DAG stays acyclic
 * - Usage (cost/tokens) is summed across iterations and returned on the final result,
 *   so the outer `runLayers` aggregates the group as one node's worth of usage
 */
async function executeLoopGroupNode(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  workflowProvider: string | undefined,
  workflowModel: string | undefined,
  workflowTier: TierName | undefined,
  workflowPreset: ModelAliasPreset | undefined,
  stepNamePrefix = ''
): Promise<NodeExecutionResult> {
  const execution = beginExecution(ctx, node);
  await recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    {
      ...execution,
      lifecycle: { status: 'started' },
    }
  );
  const usage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'> = {};
  let result: LoopGroupBodyResult;
  try {
    result = await executeLoopGroupBody(
      ctx,
      node,
      execution,
      usage,
      workflowProvider,
      workflowModel,
      workflowTier,
      workflowPreset,
      stepNamePrefix
    );
  } catch (error) {
    // Durable-write rejection and an unreadable source belong to run recovery, not a
    // failed node outcome.
    if (
      error instanceof TerminalStatusWriteError ||
      error instanceof NodeEventWriteError ||
      error instanceof RunSourceUnreadableError
    )
      throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    getLog().error({ err, nodeId: node.id }, 'loop_group_node.execution_failed');
    result = {
      state: 'failed',
      output: '',
      error: err.message,
      failureKind: 'unknown',
      ...usage,
    };
    await safeSendMessage(
      ctx.platform,
      ctx.conversationId,
      `Loop-group node '${node.id}' failed: ${err.message}`,
      { workflowId: ctx.workflowRun.id, nodeName: node.id }
    );
  }
  if (result.execution?.lifecycle.status === 'suspended') return result;
  let lifecycle: NodeExecutionRecord['lifecycle'];
  if (result.state === 'failed') {
    lifecycle = {
      status: 'failed',
      error: result.error,
      ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
      ...(result.providerFailure !== undefined ? { providerFailure: result.providerFailure } : {}),
    };
  } else if (result.state === 'running') {
    const suspensionPoint = result.suspensionPoint;
    // A deferred body gate or terminal wait leaves the group running; keep the spend its
    // iterations already made.
    if (suspensionPoint === undefined)
      return {
        ...serializeNodeOutput(execution),
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.tokensUnknown ? { tokensUnknown: true } : {}),
      };
    lifecycle = { status: 'suspended', point: suspensionPoint };
  } else {
    lifecycle = { status: 'completed' };
  }
  return recordNodeState(
    { store: ctx.deps.store, logDir: ctx.logDir },
    finishNodeExecution(execution, lifecycle, {
      output: {
        text: result.output,
        ...('structuredOutput' in result ? { structured: result.structuredOutput } : {}),
      },
      costUsd: result.costUsd,
      tokens: result.tokens,
      tokensUnknown: result.tokensUnknown,
      diagnostics: { loopIterations: result.loopIterations },
    })
  );
}

type LoopGroupBodyResult = NodeExecutionResult & {
  suspensionPoint?: 'approval' | 'wait';
};

async function executeLoopGroupBody(
  ctx: RunLayersContext,
  node: LoopGroupNode,
  execution: NodeExecutionRecord,
  usage: Pick<NodeExecutionResult, 'costUsd' | 'tokens' | 'tokensUnknown'>,
  workflowProvider: string | undefined,
  workflowModel: string | undefined,
  workflowTier: TierName | undefined,
  workflowPreset: ModelAliasPreset | undefined,
  stepNamePrefix = ''
): Promise<LoopGroupBodyResult> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    nodeOutputs: outerNodeOutputs,
    config,
    issueContext,
    execContext,
  } = ctx;
  const group = node.loop_group;
  const bodyNodes = resolvedBodyNodes(group);
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

  // THIS group's immediate body ids: the resume snapshot is keyed by them, and until_bash
  // resolves `$LOOP_PREV` against them (#2142).
  const directBodyIds = new Set(bodyNodes.map(n => n.id));

  // Detect loop resume (mirrors executeLoopNode). Two shapes recognized:
  //  - the ORIGINAL interactive_loop gate (group.interactive + gate_message).
  //  - a body terminal gate paused under THIS group, with bodyGateId naming
  //    the leaf gate. `$LOOP_USER_INPUT`
  //    does not apply to this shape — the human's text flows via the ordinary
  //    $LOOP_PREV.<gateId>.output.text channel instead, like any other body
  //    node's output — so `loopUserInput` below stays scoped to the legacy shape.
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const rawWait = workflowRun.metadata?.wait;
  const loopWaitMeta = isWorkflowWaitContext(rawWait) ? rawWait : undefined;
  const loopOwnedWaitMeta = loopWaitMeta?.owner === 'loop_group' ? loopWaitMeta : undefined;
  const ownerInvocationKey = nodeInvocationKey(stepName, ctx.loopGroupPath);
  const rawAncestry =
    loopGateMeta?.bodySessionCursorAncestry ?? loopOwnedWaitMeta?.bodySessionCursorAncestry;
  const restoredAncestry =
    rawAncestry === undefined ? undefined : bodySessionCursorAncestrySchema.parse(rawAncestry);
  const matchesOwnerInvocation =
    restoredAncestry === undefined || Object.hasOwn(restoredAncestry, ownerInvocationKey);
  const isLegacyInteractiveLoopResume =
    matchesOwnerInvocation &&
    loopGateMeta?.type === 'interactive_loop' &&
    loopGateMeta.nodeId === node.id;
  const isEscalatedGateResume =
    matchesOwnerInvocation &&
    loopGateMeta?.type === 'approval' &&
    loopGateMeta.nodeId === node.id &&
    loopGateMeta.bodyGateId !== undefined;
  const isEscalatedWaitResume = matchesOwnerInvocation && loopOwnedWaitMeta?.nodeId === node.id;
  const isLoopResume =
    isLegacyInteractiveLoopResume || isEscalatedGateResume || isEscalatedWaitResume;
  const ownerIds = new Set(bodyNodes.filter(n => isNodeContextResume(n.context)).map(n => n.id));
  const bodySessionCursors = ownerIds.size === 0 ? undefined : new Map<string, SessionCursor>();
  const rawLoopWait =
    typeof rawWait === 'object' &&
    rawWait !== null &&
    'nodeId' in rawWait &&
    rawWait.nodeId === node.id;
  if (bodySessionCursors !== undefined && rawLoopWait && !isEscalatedWaitResume) {
    throw new Error(
      `Loop group '${node.id}' cannot restore named owner sessions: invalid loop wait state.`
    );
  }
  const pauseLoopPath = loopGateMeta?.execution?.invocation.loopPath;
  const pauseFrame = pauseLoopPath?.[ctx.loopGroupPath.length];
  const enclosingPauseFrame =
    pauseFrame?.groupId === node.id &&
    nodeInvocationKey(stepName, pauseLoopPath?.slice(0, ctx.loopGroupPath.length) ?? []) ===
      ownerInvocationKey
      ? pauseFrame
      : undefined;
  const restoredOwnerCursors = restoredAncestry?.[ownerInvocationKey];
  if (
    bodySessionCursors !== undefined &&
    (isLoopResume || restoredOwnerCursors !== undefined || enclosingPauseFrame !== undefined)
  ) {
    const rawCursors =
      restoredOwnerCursors ??
      (isLoopResume && restoredAncestry === undefined
        ? isEscalatedWaitResume
          ? loopOwnedWaitMeta?.bodySessionCursors
          : loopGateMeta?.bodySessionCursors
        : undefined);
    const parsed = bodySessionCursorsSchema.safeParse(rawCursors);
    if (!parsed.success) {
      throw new Error(
        `Loop group '${node.id}' cannot restore named owner sessions: missing or invalid bodySessionCursors.`
      );
    }
    for (const [id, cursor] of Object.entries(parsed.data)) {
      if (!ownerIds.has(id))
        throw new Error(`Loop group '${node.id}' has an unknown restored session owner '${id}'.`);
      bodySessionCursors.set(id, cursor);
    }
  }
  const bodySessionCursorAncestry = new Map(ctx.bodySessionCursorAncestry);
  if (bodySessionCursors !== undefined || bodySessionCursorAncestry.size > 0) {
    bodySessionCursorAncestry.set(ownerInvocationKey, bodySessionCursors ?? new Map());
  }
  const resumeIteration = loopGateMeta?.iteration ?? loopOwnedWaitMeta?.iteration ?? 0;
  const startIteration = isLoopResume
    ? resumeIteration + 1
    : restoredAncestry !== undefined
      ? (enclosingPauseFrame?.iteration ?? 1)
      : 1;
  const loopGateRunMeta = (workflowRun.metadata ?? {}) as LoopGateRunMetadata;
  const feedbackGiven = loopGateRunMeta.loop_feedback_given === true;
  // max_iterations bounds autonomous work. An explicit answer authorizes one fresh iteration
  // even after that bound: resuming an attention wait (which did no work while paused), or
  // feedback on this group's interactive gate. A bare approve on that gate does not.
  const iterationLimit =
    (isEscalatedWaitResume && loopOwnedWaitMeta?.kind === 'attention') ||
    (isLegacyInteractiveLoopResume && feedbackGiven)
      ? Math.max(group.max_iterations, startIteration)
      : group.max_iterations;
  const loopUserInput = isLegacyInteractiveLoopResume
    ? (loopGateRunMeta.loop_user_input ?? '')
    : '';

  // Finalize-on-approve (#2074): mirrors executeLoopNode — a completion-bearing gate
  // resumed WITHOUT feedback completes the group from the persisted output instead
  // of re-running the body.
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    // The signaled iteration's structured payload (#2637): attaching it keeps this
    // route's `$group.output.field` tier IDENTICAL to natural completion (tier-2
    // lenient) — without it the same absent optional field would throw here and
    // resolve to '' there. null/absent (pre-#2637 gates) → text-only, as before.
    const finalizeStructured = loopGateMeta.signaledStructuredOutput ?? null;
    await safeSendMessage(
      platform,
      conversationId,
      `Loop-group node '${node.id}' accepted after a completion condition was met (no re-run)`,
      { workflowId: workflowRun.id, nodeName: node.id }
    );
    return {
      state: 'completed',
      output: finalizeOutput,
      ...(finalizeStructured !== null ? { structuredOutput: finalizeStructured } : {}),
    };
  }

  if (isEscalatedWaitResume) {
    const terminalNode = findLoopGroupTerminalSuspendNode(bodyNodes);
    if (terminalNode?.kind !== 'wait') {
      throw new Error(`Loop group '${node.id}' resumed with wait state but has no terminal wait`);
    }
    const waitOutput = await executeWaitNode(
      {
        ...ctx,
        stepNamePrefix: bodyStepNamePrefix,
        nodeInvocation: undefined,
        loopGroupPath: [...ctx.loopGroupPath, { groupId: node.id, iteration: resumeIteration }],
      },
      terminalNode,
      {
        groupId: node.id,
        iteration: resumeIteration,
        sessionId: loopOwnedWaitMeta?.sessionId ?? null,
        sessionProvider: loopOwnedWaitMeta?.sessionProvider ?? null,
        ...(bodySessionCursors !== undefined
          ? { bodySessionCursors: Object.fromEntries(bodySessionCursors) }
          : {}),
        ...snapshotBodySessionCursorAncestry(bodySessionCursorAncestry),
      }
    );
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === 'paused') {
      return {
        state: 'running',
        output: '',
        loopIterations: resumeIteration,
        suspensionPoint: 'wait',
      };
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
  // the loop scope finds them exactly as it would mid-loop.
  if (isLoopResume) {
    const restoredLoopPrevOutputs = new Map<string, NodeOutput>();
    const bodyNodesById = new Map(bodyNodes.map(n => [n.id, n]));
    for (const id of directBodyIds) {
      const prior = outerNodeOutputs.get(bodyStepNamePrefix + id);
      if (!prior) continue;
      // Same rule as executeDagWorkflow's resume loop: the body node's OWN current
      // definition owns its contract — the source a live iteration uses — so a resumed
      // $LOOP_PREV.<id>.output.<path> ref keeps the same strictness, and a row an older
      // binary wrote (top-level fields only) cannot narrow it. The persisted row supplies
      // only a contract the definition cannot state: a body `workflow:` node's
      // child-owned projection (#2453).
      const bodyNodeDef = bodyNodesById.get(id);
      const declaredOutputPaths =
        (bodyNodeDef !== undefined ? definedOutputPaths(bodyNodeDef) : undefined) ??
        ('declaredOutputPaths' in prior ? prior.declaredOutputPaths : undefined);
      restoredLoopPrevOutputs.set(id, {
        ...prior,
        ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
      });
    }
    // Kept as an empty-map guard for clarity only — loopPrevRefToken reads via
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
    const terminalNode = findLoopGroupTerminalSuspendNode(bodyNodes);
    if (terminalNode !== undefined && loopPrevOutputs.has(terminalNode.id)) {
      const resumedResult = loopGroupIterationOutput(bodyNodes, loopPrevOutputs);
      const resumedIteration = resumeIteration;
      const rawIterationOutput = resumedResult?.output ?? '';
      const resumedSignalDetected =
        group.until !== undefined && detectCompletionSignal(rawIterationOutput, group.until);
      let resumedBashComplete = false;
      if (group.until_bash && !resumedSignalDetected) {
        // Fresh observation for this resumed iteration's condition.
        const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
        // No $LOOP_PREV history survives a resume beyond the single reconstructed
        // iteration above — #2748 restores only the LATEST persisted body outputs,
        // not a full history — so an until_bash referencing $LOOP_PREV from the
        // iteration BEFORE this one resolves empty here, same as a fresh
        // iteration 1. Not expected to matter in practice: Design A's canonical
        // pattern reads only $<gateId>.output inside until_bash, never $LOOP_PREV.
        // Merge outer-DAG outputs underneath the reconstructed body outputs —
        // mirrors how a normal (non-resumed) iteration seeds scopedNodeOutputs
        // (`new Map(outerNodeOutputs)`, then overwritten by this iteration's own
        // body results) — so an until_bash combining an outer-scope ref with the
        // gate's own decision resolves the outer ref correctly on resume too,
        // not just mid-loop. outerNodeOutputs is already an in-scope parameter;
        // no new reconstruction needed.
        const resumedScope = new Map([...outerNodeOutputs, ...loopPrevOutputs]);
        const { prompt: resumedSubstitutedBash } = substituteWorkflowVariables(
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
          {
            shellSafe: true,
            stateDir,
            typedArtifactsFile,
            references: nodeTemplateReferences(
              group.until_bash,
              { nodeOutputs: resumedScope, loopBodyScopes: ctx.loopBodyScopes },
              'shell',
              {
                artifactsDir,
                requiredContext: { consumerId: node.id, field: 'loop_group.until_bash' },
              }
            ),
          }
        );
        const resumedBashPath = resolveBashPath();
        try {
          await runSubprocessUntilRunStops(
            deps.store,
            workflowRun.id,
            node.id,
            execContext,
            resumedBashPath,
            ['-c', resumedSubstitutedBash],
            {
              cwd,
              timeout: node.timeout,
              protectedEnvKeys: config.protectedEnvKeys,
              protectedCredentialValues: config.protectedCredentialValues,
              retention: {
                logDir,
                workflowRunId: workflowRun.id,
                nodeId: `${node.id}-iteration-${String(resumedIteration)}`,
                label: '<until_bash>',
              },
              env: buildNodeShellEnvironment(node, ctx, config.envVars, {
                artifactsDir,
                stateDir,
                logDir,
                workflowId: workflowRun.id,
                baseBranch,
                userMessage: workflowRun.user_message,
                loopUserInput: '',
                loopPrevOutput: '',
                rejectionReason: '',
                issueContext,
                adoptedRunDir: currentAdoptedRunDir(),
                typedArtifactsFile,
                nodeExecution: ctx.currentExecution ?? null,
              }),
            }
          );
          resumedBashComplete = true;
        } catch (e) {
          const bashErr = e as RawSubprocessRejection;
          if (bashErr.cancelled) {
            return {
              state: 'failed',
              output: '',
              error: bashErr.message,
              failureKind: 'cancelled',
              ...usage,
            };
          }
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
          resumedResult !== undefined && 'structuredOutput' in resumedResult
            ? resumedResult.structuredOutput
            : undefined;
        await safeSendMessage(
          platform,
          conversationId,
          `Loop-group node '${node.id}' completed after ${String(resumedIteration)} iteration${resumedIteration > 1 ? 's' : ''}`,
          msgContext
        );
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

  for (let i = startIteration; i <= iterationLimit; i++) {
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
      return {
        state: 'failed',
        output: '',
        error: `Workflow ${effectiveStatus}`,
        failureKind: 'cancelled',
        ...usage,
      };
    }

    // Emit iteration started.
    getWorkflowEventEmitter().emit({
      type: 'loop_iteration_started',
      runId: workflowRun.id,
      nodeId: node.id,
      iteration: i,
      maxIterations: iterationLimit,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_started',
        step_name: stepName,
        data: { iteration: i, maxIterations: iterationLimit, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // This iteration's $LOOP_PREV.* outputs and $LOOP_USER_INPUT reply, which every body
    // node resolves through iterCtx.loopBodyScopes. On iteration 1 loopPrevOutputs is
    // undefined → $LOOP_PREV refs resolve to ''; $LOOP_USER_INPUT is '' except on the first
    // resumed iteration of an interactive loop.
    const prevSnapshot = loopPrevOutputs;
    const userInputForIter = isLoopResume && i === startIteration ? loopUserInput : '';
    const iterScope = loopBodyScope(bodyNodes, prevSnapshot, userInputForIter, artifactsDir);
    const iterBodyLayers = planGraph(bodyNodes).layers;

    // Fresh scoped output map per iteration. Seed it read-only with the outer DAG's
    // upstream outputs so body nodes can reference outer context via $nodeId.output if
    // needed (the body is sealed against depends_on, but prompt refs remain valid).
    const scopedNodeOutputs = new Map<string, NodeOutput>(outerNodeOutputs);

    const terminalSuspendNode = findLoopGroupTerminalSuspendNode(bodyNodes);
    const iterCtx: RunLayersContext = {
      toolAttention: ctx.toolAttention,
      bodyGateOwner:
        terminalSuspendNode && isGateNode(terminalSuspendNode)
          ? { nodeId: node.id, bodyGateId: terminalSuspendNode.id, iteration: i }
          : undefined,
      unfinishedInvocations: ctx.unfinishedInvocations,
      deps: ctx.deps,
      platform: ctx.platform,
      conversationId: ctx.conversationId,
      cwd: ctx.cwd,
      // Forwarded for completeness — a `workflow:` node inside a loop_group body is
      // rejected at load time, so this closure is never actually invoked here.
      runChildWorkflow: ctx.runChildWorkflow,
      workflowRun: ctx.workflowRun,
      workflowName: node.id,
      // A body node's commands and scripts come from the same frozen source as the
      // enclosing run's — the group is part of one workflow, not a separate one. The
      // enclosing context already normalized these at the DAG boundary.
      workflowSourceRoots: ctx.workflowSourceRoots,
      config: ctx.config,
      workflowProvider,
      // The group's own resolved provider and model become the body's defaults, the
      // pair the schema documents. `workflowModel` already carries the group's model
      // when it declared one and the enclosing workflow's otherwise, so body AI nodes
      // resolve aliases and defaults the same way top-level nodes do, and a per-node
      // `model:` in the body still wins over both.
      workflowModel,
      // The tier and preset travel WITH the model. A tier ref resolves to a provider,
      // a model and an effort as one unit; forwarding the model while leaving the
      // enclosing tier and preset in place would run the group's model, attribute it to
      // the workflow's tier, and apply the workflow preset's effort to it.
      workflowLevelOptions: { ...ctx.workflowLevelOptions, workflowTier },
      aiProfile: ctx.aiProfile,
      workflowPreset,
      artifactsDir: ctx.artifactsDir,
      stateDir: ctx.stateDir,
      logDir: ctx.logDir,
      baseBranch: ctx.baseBranch,
      docsDir: ctx.docsDir,
      configuredCommandFolder: undefined,
      issueContext: ctx.issueContext,
      // Body nodes inherit the group's execution context so bash/script/AI inside
      // a loop_group body exec in the same place (host, or the container in Phase B)
      // — without this a loop_group body would be a host-escape hole.
      execContext: ctx.execContext,
      // persist_session across iterations is out of v1 scope (body sessions reset per
      // iteration, governed by fresh_context). Pass undefined/false so body nodes don't
      // participate in cross-run session persistence inside the loop — and therefore
      // no scope-artifact mirroring either.
      persistScope: undefined,
      workflowPersistSessions: false,
      scopeArtifactsDir: undefined,
      layers: iterBodyLayers,
      nodeOutputs: scopedNodeOutputs,
      priorCompletedNodes: undefined, // body re-runs in full each iteration (v1)
      claimedWorkPausePolicy: ctx.claimedWorkPausePolicy,
      // Thread the loop-level session cursor: fresh_context (or the loop's true first
      // iteration) starts fresh; otherwise carry the prior iteration's last sequential
      // session forward so a body AI node resumes the prior iteration's conversation.
      // Gate on the literal i === 1 (not startIteration): on interactive resume the
      // first processed iteration must continue the restored pre-pause session.
      nodeSessionHandles: new Map(ctx.nodeSessionHandles),
      namedResumeSourceIds: ctx.namedResumeSourceIds,
      bodySessionCursors,
      bodySessionCursorAncestry,
      lastSequentialSession: group.fresh_context || i === 1 ? undefined : loopLastSequentialSession,
      warnedProviderConflicts: ctx.warnedProviderConflicts,
      totalCostUsd: undefined,
      totalTokens: undefined,
      totalTokensUnknown: false,
      stepNamePrefix: bodyStepNamePrefix,
      loopGroupPath: [...ctx.loopGroupPath, { groupId: node.id, iteration: i }],
      // Deliver this iteration's approval-gate free-text to body exec: nodes via env
      // (#2115, #2725). Script bodies use this as their ONLY channel (their loop scope leaves
      // the literal token alone, unsafe to splice into TS/Python source). Bash bodies get
      // it as a SECOND channel — their loop scope shell-quotes the literal
      // "$LOOP_USER_INPUT" token into the script source; this env var covers indirect reads
      // (${LOOP_USER_INPUT}, printenv, env) that splice can't reach.
      bodyLoopUserInput: userInputForIter,
      loopPrevOutputs: prevSnapshot ?? new Map(),
      loopBodyScopes: [...ctx.loopBodyScopes, iterScope],
    };
    await runLayers(iterCtx);

    // Accumulate usage across iterations (charged on the failure path below too).
    if (iterCtx.totalCostUsd !== undefined) {
      usage.costUsd = (usage.costUsd ?? 0) + iterCtx.totalCostUsd;
    }
    usage.tokensUnknown ||= iterCtx.totalTokensUnknown;
    if (usage.tokensUnknown) {
      usage.tokens = undefined;
    } else if (iterCtx.totalTokens !== undefined) {
      usage.tokens = sumTokenUsage(
        [...(usage.tokens !== undefined ? [usage.tokens] : []), iterCtx.totalTokens],
        { nodeId: node.id, iteration: i }
      );
    }

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
      return {
        state: 'failed',
        output: lastIterationOutput,
        error: `Workflow ${effectiveStatus}`,
        failureKind: 'cancelled',
        ...usage,
      };
    }
    // Carry the body's final sequential session into the next iteration (unless
    // fresh_context forces a reset, handled above by seeding undefined). Taken
    // before handling the terminal gate below: its pause persists this
    // cursor, and a cursor from before the paused iteration would resume without
    // that iteration's turns (#3532).
    loopLastSequentialSession = iterCtx.lastSequentialSession;

    // A failed body node fails the group immediately — mirrors the top-level DAG
    // (any failed node fails the run) and executeLoopNode (an iteration failure stops
    // the loop). Silently re-running the body would burn AI cost every remaining
    // iteration and bury the root cause under a generic max-iterations error.
    const failedBodyOutputs = bodyNodes.flatMap(n => {
      const o = scopedNodeOutputs.get(n.id);
      return o?.state === 'failed' ? [{ id: n.id, output: o }] : [];
    });
    if (failedBodyOutputs.length > 0) {
      const failedBodyNodes = failedBodyOutputs.map(({ id, output }) => `'${id}': ${output.error}`);
      const providerFailure = aggregateProviderFailure(
        failedBodyOutputs.map(({ output }) => output.providerFailure),
        Date.now()
      );
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
        failureKind: 'child_failed',
        ...(providerFailure !== undefined ? { providerFailure } : {}),
        ...usage,
        loopIterations: i,
      };
    }

    if (terminalSuspendNode && postBodyStatus === 'paused') {
      const suspendOutput = scopedNodeOutputs.get(terminalSuspendNode.id);
      // Still running means the terminal gate or wait either suspended this group or was
      // deferred behind a sibling that holds the paused slot. Either way the iteration
      // stops here; only a suspension this group owns is marked as one.
      if (suspendOutput === undefined || suspendOutput.state === 'running') {
        let suspensionPoint: 'approval' | 'wait' | undefined;
        if (isGateNode(terminalSuspendNode)) {
          if (suspendOutput?.execution?.lifecycle.status === 'suspended') {
            suspensionPoint = 'approval';
          }
        } else {
          const freshRun = await deps.store.getWorkflowRun(workflowRun.id);
          const freshWait = freshRun?.metadata?.wait;
          if (
            isWorkflowWaitContext(freshWait) &&
            freshWait.owner === 'loop_group' &&
            freshWait.nodeId === node.id &&
            freshWait.bodyWaitId === terminalSuspendNode.id &&
            freshWait.iteration === i
          ) {
            suspensionPoint = 'wait';
          }
        }
        return {
          state: 'running',
          output: lastIterationOutput,
          ...usage,
          loopIterations: i,
          ...(suspensionPoint !== undefined ? { suspensionPoint } : {}),
        };
      }
    }

    if (
      postBodyStatus === 'paused' &&
      bodySessionCursorAncestry.size > 0 &&
      bodyNodes.some(
        n => n.kind === 'loop_group' && scopedNodeOutputs.get(n.id)?.state === 'running'
      )
    ) {
      return {
        state: 'running',
        output: lastIterationOutput,
        ...usage,
        loopIterations: i,
      };
    }

    // Carry prior-iteration snapshot forward for $LOOP_PREV.* on the next iteration.
    loopPrevOutputs = new Map(scopedNodeOutputs);

    // DELIBERATELY NOT `returns:`-aware (#2470): a loop_group's per-iteration output is
    // the iteration's own result, not a caller contract — `returns:` selects a WORKFLOW's
    // result and only rebinds a child run's terminal output (see executeDagWorkflow). Leave
    // this positional scan as-is; do not "fix" the inconsistency.
    const iterationResult = loopGroupIterationOutput(bodyNodes, scopedNodeOutputs);
    const iterationOutput = iterationResult?.output ?? '';
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
      iterationResult !== undefined && 'structuredOutput' in iterationResult
        ? iterationResult.structuredOutput
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
      // Observed after the body ran, so the condition sees the typed artifacts this
      // iteration published. Outside the try: a materialization fault is a
      // provisioning error, not an unreachable bash binary.
      const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);
      try {
        // Resolve this group's own cross-iteration refs against the snapshot captured
        // before its body ran. `loopPrevOutputs` now contains the CURRENT iteration, so
        // using it here would collapse `$LOOP_PREV` into `$node.output` semantics. Only
        // direct body ids belong to this scope; refs owned by an enclosing group resolve
        // through that group's scope ahead of this one, and descendant ids are not
        // present in this group's per-iteration output map.
        const ownScope: LoopBodyScope = {
          loopPrevOutputs: prevSnapshot,
          outputFileDir: logDir,
          knownBodyIds: directBodyIds,
          directBodyIds,
        };
        const { prompt: substitutedBash } = substituteWorkflowVariables(
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
          {
            shellSafe: true,
            stateDir,
            typedArtifactsFile,
            references: nodeTemplateReferences(
              group.until_bash,
              {
                nodeOutputs: scopedNodeOutputs,
                loopBodyScopes: [...ctx.loopBodyScopes, ownScope],
              },
              'shell',
              {
                artifactsDir,
                requiredContext: { consumerId: node.id, field: 'loop_group.until_bash' },
              }
            ),
          }
        );
        await runSubprocessUntilRunStops(
          deps.store,
          workflowRun.id,
          node.id,
          execContext,
          groupBashPath,
          ['-c', substitutedBash],
          {
            cwd,
            timeout: node.timeout,
            protectedEnvKeys: config.protectedEnvKeys,
            protectedCredentialValues: config.protectedCredentialValues,
            retention: {
              logDir,
              workflowRunId: workflowRun.id,
              nodeId: `${node.id}-iteration-${String(i)}`,
              label: '<until_bash>',
            },
            env: buildNodeShellEnvironment(node, ctx, config.envVars, {
              artifactsDir,
              stateDir,
              logDir,
              workflowId: workflowRun.id,
              baseBranch,
              userMessage: workflowRun.user_message,
              loopUserInput: i === startIteration ? (loopUserInput ?? '') : '',
              loopPrevOutput: prevIterationOutput,
              rejectionReason: '',
              issueContext,
              adoptedRunDir: currentAdoptedRunDir(),
              typedArtifactsFile,
              nodeExecution: ctx.currentExecution ?? null,
            }),
          }
        );
        bashComplete = true;
      } catch (e) {
        const bashErr = e as RawSubprocessRejection;
        if (bashErr.cancelled) {
          return {
            state: 'failed',
            output: '',
            error: bashErr.message,
            failureKind: 'cancelled',
            ...usage,
          };
        }
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
      return {
        state: 'completed',
        output: lastIterationOutput,
        ...usage,
        loopIterations: i,
        // The final iteration's sink payload, so downstream `$group.output.field`
        // resolves from the logical value (#2637). No declaredOutputPaths: a group's
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
      const suspended = finishNodeExecution(
        execution,
        { status: 'suspended', point: 'interactive_loop' },
        {
          output: { text: lastIterationOutput, structured: lastIterationStructuredOutput },
          ...usage,
          diagnostics: { loopIterations: i },
        }
      );
      const approvalContext: ApprovalContext = {
        execution: executionMetadata(suspended),
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
        ...(bodySessionCursors !== undefined
          ? { bodySessionCursors: Object.fromEntries(bodySessionCursors) }
          : {}),
        ...snapshotBodySessionCursorAncestry(bodySessionCursorAncestry),
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
      };
      const paused = await pauseGateRespectingExternalTransition(
        deps,
        workflowRun.id,
        approvalContext,
        { event: serializeNodeStateRecord(suspended) }
      );
      if (!paused)
        return {
          state: 'running',
          output: lastIterationOutput,
          ...usage,
          loopIterations: i,
        };
      await recordDerivedExecution({ logDir }, suspended);
      const gateMsg =
        `⏸ **Input required** (loop_group \`${node.id}\`, iteration ${String(i)}): ${honestMessage}\n\n` +
        `Run ID: \`${workflowRun.id}\`\n` +
        `Respond: \`${spellWorkflowCommand(platform, `approve ${workflowRun.id} <your feedback>`)}\` | ` +
        `Cancel: \`${spellWorkflowCommand(platform, `reject ${workflowRun.id}`)}\``;
      await sendPauseNotice(
        deps,
        platform,
        conversationId,
        workflowRun.id,
        node.id,
        gateOccurrence(paused),
        stepName,
        gateMsg
      );
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

      return serializeNodeOutput(suspended);
    }
  }

  // Max iterations exceeded.
  const errorMsg = `Loop-group node '${node.id}' exceeded max iterations (${String(iterationLimit)}) ${describeUnmetCompletion(group)}`;
  getLog().warn(
    { nodeId: node.id, maxIterations: iterationLimit, signal: group.until },
    'loop_group_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return {
    state: 'failed',
    output: lastIterationOutput,
    error: errorMsg,
    failureKind: 'max_iterations',
    ...usage,
    // A bare approve past the cap resumes beyond iterationLimit and runs nothing.
    loopIterations: Math.max(iterationLimit, startIteration - 1),
  };
}

/**
 * What one loop_group iteration resolves in its body's text: the prior-iteration outputs
 * `$LOOP_PREV.*` reads, the `$LOOP_USER_INPUT` reply, and the static id sets
 * {@link loopPrevRefToken} classifies absent refs with. Built once per iteration by
 * {@link loopBodyScope}. A body node resolves its templates against one scope per enclosing
 * group ({@link RunLayersContext.loopBodyScopes}) in the same pass as its workflow variables
 * and `$node.output` references, so a reply or a previous output is never read as template
 * syntax (#4046).
 */
export interface LoopBodyScope {
  loopPrevOutputs: Map<string, NodeOutput> | undefined;
  /** Undefined leaves `$LOOP_USER_INPUT` to an enclosing scope or the run-level variable. */
  loopUserInput?: string;
  outputFileDir?: string;
  knownBodyIds?: ReadonlySet<string>;
  directBodyIds?: ReadonlySet<string>;
}

/**
 * `knownBodyIds` is TRANSITIVE (this group's body + every nested descendant) — an id absent
 * from it is a typo (`.field` ref → loud failure). `directBodyIds` is only THIS group's
 * immediate ids — an id in knownBodyIds but not directBodyIds belongs to a nested group and
 * is left to that inner group's own scope (#2142).
 */
export function loopBodyScope(
  bodyNodes: readonly DagNode[],
  loopPrevOutputs: Map<string, NodeOutput> | undefined,
  loopUserInput: string,
  outputFileDir: string
): LoopBodyScope {
  return {
    loopPrevOutputs,
    loopUserInput,
    outputFileDir,
    knownBodyIds: collectLoopBodyNodeIds(bodyNodes),
    directBodyIds: new Set(bodyNodes.map(n => n.id)),
  };
}

/**
 * Resolve only the loop_group scopes' references in `text`, for text that is not a
 * template of its own: a body command node's file name, a binding's `if_skipped` default.
 */
export function substituteLoopBodyText(
  text: string,
  scopes: readonly LoopBodyScope[],
  surface: TextSurface = 'prompt'
): string {
  assertSupportedOutputRefs(text);
  return substituteTemplate(
    text,
    scopes.flatMap(scope => loopScopeTokens(scope, surface))
  );
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
  ctx: RunLayersContext,
  node: LoopNode,
  workflowProvider: string,
  resolvedOptions: SendQueryOptions | undefined,
  stepNamePrefix = '',
  resolvedModel?: string,
  resolvedTier?: TierName,
  resolvedEffort?: EffortLevel,
  checkpointSession?: SessionCheckpoint
): Promise<NodeExecutionResult> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflowRun,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    config,
    issueContext,
    execContext,
  } = ctx;
  const loop = node.loop;
  const retryConfig = getEffectiveNodeRetryConfig(node);
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name when this loop node runs inside a loop_group body
  // ('' → node.id at top level, #2090). The loop's own per-iteration number lives in
  // each event's data (`iteration`), so no separate iteration param is threaded here.
  const stepName = stepNamePrefix + node.id;

  // A bare approval completes the captured execution without starting another attempt.
  // Feedback continues the invocation with a new attempt and the currently resolved binding.
  getLog().info({ nodeId: node.id, type: 'loop' }, 'loop_node.started');

  const newExecution = beginExecution(ctx, node, {
    provider: workflowProvider,
    model: resolvedModel,
    tier: resolvedTier,
    effort: resolvedEffort,
  });
  const savedApproval = workflowRun.metadata?.approval;
  const saved =
    isApprovalContext(savedApproval) &&
    savedApproval.type === 'interactive_loop' &&
    savedApproval.nodeId === node.id
      ? savedApproval.execution
      : undefined;
  const savedExecution = saved === undefined ? undefined : nodeExecutionMetadataSchema.parse(saved);
  if (
    savedExecution !== undefined &&
    (savedExecution.runId !== workflowRun.id ||
      savedExecution.path !== stepName ||
      savedExecution.node.kind !== 'loop')
  ) {
    throw new Error(
      `Loop execution identity does not match '${stepName}' in run ${workflowRun.id}`
    );
  }
  let execution = savedExecution ?? newExecution;
  let loopFinalStopReason: string | undefined =
    execution.spend.stopReason.source === 'provider' ? execution.spend.stopReason.value : undefined;
  let loopTotalNumTurns: number | undefined =
    execution.spend.numTurns.source === 'provider' ? execution.spend.numTurns.value : undefined;
  let loopResolvedModel: ResolvedModel | undefined;
  const failLoopNode = async (
    error: string,
    extras: {
      failureKind: NodeFailureKind;
      providerFailure?: ProviderFailure;
      output?: string;
      costUsd?: number;
      tokens?: TokenUsage;
      tokensUnknown?: boolean;
      loopIterations?: number;
      data?: Pick<
        NonNullable<NodeExecutionRecord['diagnostics']>,
        'command' | 'iteration' | 'status' | 'maxIterations'
      >;
    }
  ): Promise<NodeExecutionResult> => {
    getLog().error({ nodeId: node.id, error, ...extras.data }, 'loop_node.failed');
    return recordNodeState(
      { store: deps.store, logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error,
          failureKind: extras.failureKind,
          ...(extras.providerFailure !== undefined
            ? { providerFailure: extras.providerFailure }
            : {}),
        },
        {
          output: { text: extras.output ?? '' },
          tokens: extras.tokens,
          tokensUnknown:
            (execution.spend.tokens.source === 'unavailable' &&
              execution.spend.tokens.reason === 'incomplete') ||
            extras.tokensUnknown,
          costUsd: extras.costUsd,
          stopReason: loopFinalStopReason,
          numTurns: loopTotalNumTurns,
          resolvedModel: loopResolvedModel?.id,
          sessionId: currentSessionId,
          diagnostics: { ...extras.data, loopIterations: extras.loopIterations },
        }
      )
    );
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
  // Like a loop group: feedback on this node's gate authorizes one fresh iteration past the
  // autonomous bound; a bare approve does not.
  const iterationLimit =
    isLoopResume && feedbackGiven
      ? Math.max(loop.max_iterations, startIteration)
      : loop.max_iterations;
  if (isLoopResume && loopGateMeta?.completionSignaled === true && !feedbackGiven) {
    const finalizeOutput = loopGateMeta.signaledOutput ?? '';
    // The signaled iteration's structured payload (#2637) — attached below so this
    // route matches natural completion's NodeOutput exactly. null/absent
    // (pre-#2637 gates) → text-only, as before.
    const finalizeStructured = loopGateMeta.signaledStructuredOutput ?? null;
    if (currentSessionId !== undefined) {
      await checkpointSession?.(currentSessionId);
    }
    return finalizeLoopFromSignal(
      deps,
      platform,
      conversationId,
      workflowRun,
      node,
      stepName,
      'Loop node',
      finalizeOutput,
      {
        ...(persistedLoopCostUsd !== undefined ? { costUsd: persistedLoopCostUsd } : {}),
        ...(persistedLoopTokens !== undefined ? { tokens: persistedLoopTokens } : {}),
      },
      finalizeStructured ?? undefined,
      logDir,
      savedExecution,
      currentSessionId
    );
  }

  // Resolve AI client — fail fast with descriptive error
  let aiClient: ReturnType<typeof deps.getAgentProvider>;
  let capabilities: ProviderCapabilities;
  try {
    capabilities = requireProvider(deps.providers, workflowProvider).capabilities;
    aiClient = deps.getAgentProvider(workflowProvider);
  } catch (error) {
    const err = error as Error;
    const errorMsg = `Invalid provider '${workflowProvider}' for loop node '${node.id}'. Check workflow YAML or .archon/config.yaml. Original: ${err.message}`;
    getLog().error(
      { err, nodeId: node.id, provider: workflowProvider },
      'loop_node.provider_failed'
    );
    return failLoopNode(errorMsg, { failureKind: 'config' });
  }

  // A continuation after an interactive gate is the same invocation: it keeps the
  // invocation (and its checkout start) the paused attempt recorded.
  if (savedExecution !== undefined) ctx.nodeInvocation = savedExecution.invocation;
  execution = beginExecution(ctx, node, {
    provider: workflowProvider,
    model: resolvedModel,
    tier: resolvedTier,
    effort: resolvedEffort,
    capabilities,
    checkoutStart: await observeNodeCheckout(ctx),
  });
  if (savedExecution !== undefined) {
    execution.timing.startedAt = savedExecution.timing.startedAt;
    if (
      savedExecution.spend.tokens.source === 'unavailable' &&
      savedExecution.spend.tokens.reason === 'incomplete'
    ) {
      execution.spend.tokens = savedExecution.spend.tokens;
    }
  }
  ctx.currentExecution = execution;
  const iterationEnv = { ...resolvedOptions?.env, ...aiNodeEnvironment(ctx, execution) };
  loopFinalStopReason = undefined;
  // Iterations share the loop's attempt, so they share its provider-event sequence.
  const attemptEvents = createAttemptEventSequence(execution.attempt.id);
  await recordNodeState(
    { store: deps.store, logDir },
    {
      ...execution,
      lifecycle: { status: 'started' },
    }
  );

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
      return failLoopNode(compiled.error, {
        failureKind: 'config',
        data: { command: loop.command },
      });
    }
    if (hasCompiledPrompt && !hasCompiledError) {
      loopPromptTemplate = compiled.prompt;
    } else if (compiled !== undefined) {
      const errorMsg = `Loop node '${node.id}' has malformed compiled command metadata for '${loop.command}' — expected exactly one string prompt or error.`;
      getLog().error(
        { nodeId: node.id, command: loop.command, compiled },
        'loop_node.command_compilation_metadata_invalid'
      );
      return failLoopNode(errorMsg, { failureKind: 'config', data: { command: loop.command } });
    } else {
      const promptResult = await loadNodeCommandPrompt(ctx, loop.command, stepName);
      if (!promptResult.success) {
        getLog().error(
          { nodeId: node.id, command: loop.command, error: promptResult.message },
          'loop_node.command_load_failed'
        );
        return failLoopNode(promptResult.message, {
          failureKind: 'config',
          data: { command: loop.command },
        });
      }
      loopPromptTemplate = resolveIncludeOutputAliases(node, promptResult.content);
    }
  } else if (typeof loop.prompt === 'string') {
    loopPromptTemplate = loop.prompt;
  } else {
    // Unreachable: superRefine on loopNodeConfigSchema enforces exactly-one.
    throw new Error(
      `Loop node '${node.id}' has neither 'loop.prompt' nor 'loop.command' — schema invariant violated`
    );
  }

  let lastIterationOutput = '';
  let lastIterationStructuredOutput: unknown;
  let loopTotalCostUsd: number | undefined = persistedLoopCostUsd;
  let loopTotalTokens: TokenUsage | undefined = persistedLoopTokens;
  let loopTokensUnknown =
    savedExecution?.spend.tokens.source === 'unavailable' &&
    savedExecution.spend.tokens.reason === 'incomplete';
  // Concrete model the provider resolved to (#2314). Last-seen wins, like
  // loopFinalStopReason: every iteration runs on the same resolved provider and
  // model, so the final iteration's report is the node's report.
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

  for (let i = startIteration; i <= iterationLimit; i++) {
    const iterationStart = Date.now();
    // Fresh per iteration: this iteration's prompt and until_bash observe the
    // artifacts published before it. Materialization failure is an explicit node
    // provisioning error and propagates to the dispatch boundary.
    const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);

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
        failureKind: 'cancelled',
        costUsd: loopTotalCostUsd,
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
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
      maxIterations: iterationLimit,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'loop_iteration_started',
        step_name: stepName,
        data: { iteration: i, maxIterations: iterationLimit, nodeId: node.id },
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
    // Transient-retry state that post-attempt code (signal detection, completion
    // channels, payload serialization) still reads — declared per-iteration but OUTSIDE
    // the attempt loop below, whose passes reassign them.
    let fullOutput = ''; // raw, for signal detection
    let cleanOutput = ''; // stripped, for platform display
    let iterationIdleTimedOut = false;
    // Whether this attempt's stream ended on the provider's `settled` (see the AI-node
    // path's streamSettled).
    let iterationSettled = false;
    let lastWatchdogReset: WatchdogReset | undefined;
    let iterationPayload: unknown;
    // The session this iteration reported, for its own `loop_iteration_completed` row.
    let iterationSessionId: string | undefined;

    // Per-attempt transient retry for AI-loop iterations (#2706): a plain AI node's
    // failure goes through runNodeRetryLoop; an iteration used to die on its first
    // TRANSIENT error (rate limit, silent stream death) and fail the whole node. Same
    // classification and delay policy, same widened rate-limit budget.
    let iterSawRateLimit = false;
    const tryIterationTransientRetry = async (
      failure: { failureKind: NodeFailureKind; error: string },
      attempt: number
    ): Promise<boolean> => {
      const retryClass = retryClassOf(failure.failureKind);
      if (retryClass === 'rate_limited') iterSawRateLimit = true;
      if (
        retryClass !== 'transient' &&
        retryClass !== 'rate_limited' &&
        retryClass !== 'overloaded'
      )
        return false;
      const message = failure.error;
      const maxRetries = effectiveRetryMaxRetries(
        retryConfig.maxRetries,
        retryClass,
        iterSawRateLimit
      );
      if (attempt >= maxRetries) return false;
      const delayMs = getRetryDelayMs(retryClass, attempt, retryConfig.delayMs);
      getLog().warn(
        {
          nodeId: node.id,
          iteration: i,
          attempt: attempt + 1,
          maxRetries,
          retryClass,
          delayMs,
          error: message,
        },
        'loop_node.iteration_transient_retry'
      );
      await safeSendMessage(
        platform,
        conversationId,
        `⚠️ Loop \`${node.id}\` iteration ${String(i)} failed with ${retryClass === 'overloaded' ? 'a provider capacity error' : 'a transient error'} (attempt ${String(attempt + 1)}/${String(maxRetries + 1)}). Retrying in ${String(Math.round(delayMs / 1000))}s...`,
        msgContext
      );
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_retry_scheduled',
        step_name: stepName,
        data: {
          nodeId: node.id,
          iteration: i,
          retry_class: retryClass,
          retry_attempt: attempt + 1,
          max_retries: maxRetries,
          delay_ms: delayMs,
        },
      });
      await waitForNodeRetry(deps.store, workflowRun.id, node.id, delayMs);
      return true;
    };

    iterationAttempt: for (let iterRetry = 0; ; iterRetry++) {
      if (iterRetry > 0) {
        const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
        if (!shouldContinueStreamingForStatus(status)) {
          return failLoopNode(`Workflow ${status ?? 'deleted'}`, {
            failureKind: 'cancelled',
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
            loopIterations: i - 1,
            data: { status: status ?? 'deleted', iteration: i },
          });
        }
      }
      // A failed attempt's session is not the one the iteration completed in.
      iterationSessionId = undefined;
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

      const createIterationProviderEvents = (): ProviderEventHandler =>
        createProviderEventHandler({
          toolAttention: ctx.toolAttention.createStream({
            nodeId: stepName,
            reportedBackgroundWork: capabilities.backgroundWork === 'reported',
            provider: workflowProvider,
            thresholdMs:
              ctx.config.workflows?.toolCallAttentionMs ?? DEFAULT_TOOL_CALL_ATTENTION_MS,
            env: {
              ...(ctx.execContext.kind === 'host' ? process.env : {}),
              ...iterationEnv,
            },
            protectedEnvKeys: ctx.config.protectedEnvKeys,
            protectedCredentialValues: ctx.config.protectedCredentialValues,
          }),
          store: deps.store,
          platform,
          conversationId,
          messageContext: msgContext,
          logDir,
          runId: workflowRun.id,
          nodeId: node.id,
          stepName,
          attempt: attemptEvents,
          // A loop node takes no `mcp:` file, so no MCP failure is the workflow's own.
          configuredMcpServers: new Set(),
          onMessageText: async text => {
            fullOutput += text;
            const cleaned = stripCompletionTags(text, loop.until);
            cleanOutput += cleaned;
            if (platform.getStreamingMode() === 'stream' && cleaned) {
              await safeSendMessage(platform, conversationId, cleaned, msgContext);
            }
          },
        });
      let providerEvents = createIterationProviderEvents();
      let iterationCost: number | undefined;
      let iterationTokens: TokenUsage | undefined;
      let iterationNumTurns: number | undefined;
      // Fold the summed per-attempt usage into the loop totals exactly once per
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
        if (!loopTokensUnknown && iterationTokens !== undefined) {
          loopTotalTokens = sumTokenUsage(
            [...(loopTotalTokens !== undefined ? [loopTotalTokens] : []), iterationTokens],
            { nodeId: node.id }
          );
        }
        if (iterationNumTurns !== undefined) {
          loopTotalNumTurns = (loopTotalNumTurns ?? 0) + iterationNumTurns;
        }
      };

      // Structured payload accepted for THIS iteration (validated); hoisted above so it
      // survives past the attempt loop.
      // Raw structured payload seen on the current attempt, before validation.
      let attemptStructured: unknown;
      let reaskAttempt = 0;
      let reaskErrors: string[] = [];
      const wantsStructured = resolvedOptions?.outputFormat !== undefined;
      const maxReasks =
        wantsStructured && capabilities.structuredOutput === 'best-effort'
          ? STRUCTURED_OUTPUT_MAX_REASKS
          : 0;

      attempts: while (true) {
        // Per-attempt reset. A reask re-runs the stream, so anything the stream
        // accumulates or aborts must start clean or a prior attempt's prose would
        // leak into this one's output and signal detection.
        fullOutput = '';
        cleanOutput = '';
        iterationIdleTimedOut = false;
        iterationSettled = false;
        lastWatchdogReset = undefined;
        streamStopStatus = undefined;
        attemptStructured = undefined;
        iterationAbortController = new AbortController();
        providerEvents = createIterationProviderEvents();
        lastStreamStatusCheckAt = Date.now();
        iterationCost = undefined;
        iterationTokens = undefined;
        iterationNumTurns = undefined;
        iterationUsageFolded = false;
        const watchdogResets = createWatchdogResetRecorder(
          logDir,
          workflowRun.id,
          `${node.id}-iteration-${String(i)}`
        );

        try {
          // Build prompt — substituteWorkflowVariables throws if $BASE_BRANCH referenced but empty
          // Pass loopUserInput on the first resumed iteration; '' on all others (non-interactive
          // or subsequent iterations) so $LOOP_USER_INPUT substitutes to empty string explicitly.
          // $LOOP_PREV_OUTPUT carries the previous iteration's cleaned output and is empty on
          // the first iteration (no prior output exists). Across an interactive resume, the
          // executor starts a fresh `lastIterationOutput` variable, so the first iteration of
          // the resume also receives an empty $LOOP_PREV_OUTPUT.
          const { prompt: basePrompt } = substituteWorkflowVariables(
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
            {
              stateDir,
              inputs: resolveRunInputs(workflowRun),
              typedArtifactsFile,
              references: nodeTemplateReferences(loopPromptTemplate, ctx),
            }
          );
          // A reask re-runs this iteration's prompt with the schema errors appended, so
          // the model is told WHAT was wrong rather than silently asked again.
          const finalPrompt =
            reaskAttempt === 0
              ? basePrompt
              : `${basePrompt}\n\n---\n\nYour previous response did not match the required output schema:\n${reaskErrors.map(e => `- ${e}`).join('\n')}\n\nRespond again with output that satisfies the schema exactly.`;

          const iterationOptions: SendQueryOptions | undefined = {
            ...resolvedOptions,
            env: iterationEnv,
            abortSignal: iterationAbortController.signal,
          };

          const pass = structuredOutputPass(reaskAttempt, resumeSessionId, false);
          const generator = aiClient.sendQuery(
            finalPrompt,
            cwd,
            pass.resumeSessionId,
            iterationOptions
          );
          const effectiveIdleTimeout = node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS;

          const shouldStopStream = async (): Promise<boolean> => {
            await ctx.toolAttention.refresh();
            await providerEvents.refreshAttention();
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
                  return true;
                }
              } catch (statusErr) {
                getLog().warn(
                  { err: statusErr as Error, workflowRunId: workflowRun.id, nodeId: node.id },
                  'loop_node.status_check_failed'
                );
              }
            }

            return false;
          };
          try {
            for await (const msg of withIdleTimeout(
              generator,
              effectiveIdleTimeout,
              () => {
                iterationIdleTimedOut = true;
                getLog().warn(
                  {
                    nodeId: node.id,
                    iteration: i,
                    timeoutMs: effectiveIdleTimeout,
                    ...(lastWatchdogReset
                      ? {
                          lastResetType: lastWatchdogReset.type,
                          lastResetAt: new Date(lastWatchdogReset.at).toISOString(),
                        }
                      : {}),
                  },
                  'loop_node.idle_timeout_reached'
                );
                iterationAbortController.abort();
              },
              (msg, resetAt) => {
                const type = msg.type;
                lastWatchdogReset = { type, at: resetAt };
                watchdogResets.observe(type, resetAt);
              },
              () =>
                providerEvents.hasOpenTools() ||
                (capabilities.backgroundWork === 'reported' &&
                  providerEvents.liveSubtaskIds().length > 0),
              shouldStopStream
            )) {
              if (await shouldStopStream()) break;

              if (msg.type === 'result') {
                // A reask's throwaway session is not the thread (structuredOutputPass):
                // adopting it would silently discard iterations 1…N and break the
                // `fresh_context: false` contract ("each iteration resumes the prior
                // conversation"). The repaired answer still reaches the next iteration
                // through $LOOP_PREV_OUTPUT, which is prompt text rather than session state.
                if (pass.threadsSession) {
                  currentSessionId = msg.sessionId;
                  iterationSessionId = msg.sessionId;
                } else if (msg.sessionId && currentSessionId !== msg.sessionId) {
                  getLog().debug(
                    {
                      nodeId: node.id,
                      iteration: i,
                      attempt: reaskAttempt,
                      ...(currentSessionId !== undefined
                        ? { keptSessionIdPreview: sessionPreview(currentSessionId) }
                        : {}),
                    },
                    'loop_node.reask_session_not_threaded'
                  );
                }
                if (msg.cost !== undefined) {
                  if (Number.isFinite(msg.cost)) {
                    iterationCost = (iterationCost ?? 0) + msg.cost;
                  } else {
                    getLog().warn(
                      { nodeId: node.id, iteration: i, costUsd: msg.cost },
                      'loop_node.usage_cost_non_finite_ignored'
                    );
                  }
                }
                loopTokensUnknown ||= msg.tokensUnknown === true;
                if (loopTokensUnknown) {
                  iterationTokens = undefined;
                  loopTotalTokens = undefined;
                } else if (msg.tokens !== undefined) {
                  iterationTokens = sumTokenUsage(
                    [...(iterationTokens ? [iterationTokens] : []), msg.tokens],
                    {
                      nodeId: node.id,
                      iteration: i,
                    }
                  );
                }
                if (msg.stopReason !== undefined) loopFinalStopReason = msg.stopReason;
                if (msg.numTurns !== undefined) {
                  iterationNumTurns = msg.numTurns;
                }
                // Unconditional, for the same reason as the AI-node path above: a later
                // iteration or result chunk that reports no resolved model must clear the
                // previous one rather than leave it to be recorded as this node's answer.
                loopResolvedModel = msg.resolvedModel;
                if (msg.text !== undefined) {
                  fullOutput = msg.text;
                  cleanOutput = stripCompletionTags(msg.text, loop.until);
                }
                attemptStructured = msg.structuredOutput;
                if (msg.failure !== undefined) {
                  throw providerReportedFailure(
                    `Loop '${node.id}' iteration ${String(i)}`,
                    msg.failure,
                    resolvedOptions?.maxBudgetUsd,
                    { nodeId: node.id, iteration: i }
                  );
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
                      ...(msg.sessionId ? { sessionIdPreview: sessionPreview(msg.sessionId) } : {}),
                      stopReason: msg.stopReason,
                    },
                    'loop_node.iteration_sdk_error'
                  );
                  throw new Error(
                    `Loop '${node.id}' iteration ${String(i)} failed: SDK returned ${subtype}${errorsDetail}`
                  );
                }
                // A result is not the end of the iteration; `settled` is. See the
                // AI-node stream loop for the full rationale.
              } else if (msg.type === 'settled') {
                iterationSettled =
                  capabilities.backgroundWork !== 'reported' ||
                  providerEvents.liveSubtaskIds().length === 0;
                break;
              } else {
                await providerEvents.handle(msg);
              }
            }
          } finally {
            await providerEvents.clearAttention();
          }
          foldIterationUsage();

          // Stream ended with background tasks still live (idle timeout mid-wait or
          // subprocess death): their artifacts may be missing (#2083). Record them for
          // the audit trail whatever ended the stream; the operator hears about it
          // once, from the iteration's unsettled failure, which names these tasks.
          const danglingTaskIds = providerEvents.liveSubtaskIds();
          if (danglingTaskIds.length > 0) {
            for (const id of danglingTaskIds) loopBackgroundTasksIncomplete.add(id);
            getLog().warn(
              {
                nodeId: node.id,
                iteration: i,
                taskIds: danglingTaskIds,
                idleTimedOut: iterationIdleTimedOut,
                cancelled: iterationAbortController.signal.aborted && !iterationIdleTimedOut,
              },
              'loop_node.iteration_stream_ended_with_live_background_tasks'
            );
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
          const failureKind: NodeFailureKind = err instanceof NodeFailure ? err.kind : 'unknown';
          if (await tryIterationTransientRetry({ failureKind, error: err.message }, iterRetry)) {
            continue iterationAttempt;
          }
          return await failLoopNode(`Loop iteration ${String(i)} failed: ${err.message}`, {
            failureKind,
            ...(err instanceof NodeFailure && err.providerFailure !== undefined
              ? { providerFailure: err.providerFailure }
              : {}),
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
            loopIterations: i,
            data: { iteration: i },
          });
        } finally {
          await watchdogResets.flush();
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
          return failLoopNode(`Workflow ${effectiveStatus}`, {
            failureKind: 'cancelled',
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
            loopIterations: i,
            data: { status: effectiveStatus, iteration: i },
          });
        }

        // Empty assistant output is an iteration failure for AI loops — same
        // contract as the single-shot AI-node guard in executeNodeInternal. A
        // provider stream that closed cleanly with zero content typically means
        // a silent rejection or interruption; left unchecked, an interactive
        // loop would pause with a blank gate or burn the full max_iterations
        // budget producing nothing. A timeout before any output is the same
        // failure as on a single-shot AI node, so it enters the transient retry
        // path instead of consuming an iteration.
        //
        // A structured payload is also exempt (#2563), matching executeNodeInternal's
        // `nodeOutputText === '' && structuredOutput === undefined` guard: with
        // grammar-constrained decoding the assistant prose is routinely EMPTY because
        // the whole answer arrived as the payload. Failing that would make every
        // Claude/Codex structured loop fail on iteration 1.
        //
        // A timed-out `output_format` iteration is exempt too: the structured branch
        // below owns it, naming the contract that failed and failing on the first
        // attempt. That mirrors executeNodeInternal, where this generic guard is
        // unreachable once `output_format` is set, and mirrors canReask's own
        // idle-timeout exclusion — a retry would spend another full idle_timeout
        // window per attempt for the same answer.
        const structuredTimeout = wantsStructured && iterationIdleTimedOut;
        if (!structuredTimeout && fullOutput.trim() === '' && attemptStructured === undefined) {
          const iterationDuration = Date.now() - iterationStart;
          const emptyError = iterationIdleTimedOut
            ? `Loop node '${node.id}' iteration ${String(i)} timed out with no output (idle for ${String((node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS) / 60000)} min).${formatWatchdogResetDiagnostic(lastWatchdogReset)} Consider increasing idle_timeout or reducing prompt size.`
            : 'Loop iteration produced no assistant output. The provider stream closed without yielding content — likely a silent provider rejection or stream interruption.';
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
          const failureKind: NodeFailureKind = iterationIdleTimedOut ? 'timeout' : 'transient';
          if (await tryIterationTransientRetry({ failureKind, error: emptyError }, iterRetry)) {
            continue iterationAttempt;
          }
          return failLoopNode(`Loop iteration ${String(i)} failed: ${emptyError}`, {
            failureKind,
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
            loopIterations: i,
            data: { iteration: i },
          });
        }

        // Output without `settled` means the iteration's stream was cut off, not
        // finished (see executeNodeInternal). A timed-out `output_format` iteration is
        // left to the structured branch below, as for empty output above.
        if (!iterationSettled && !structuredTimeout) {
          const unsettledError = unsettledTurnError(
            iterationIdleTimedOut ? (node.idle_timeout ?? STEP_IDLE_TIMEOUT_MS) : undefined,
            lastWatchdogReset,
            providerEvents.liveSubtaskIds()
          );
          getLog().error({ nodeId: node.id, iteration: i }, 'loop_node.iteration_unsettled');
          getWorkflowEventEmitter().emit({
            type: 'loop_iteration_failed',
            runId: workflowRun.id,
            nodeId: node.id,
            iteration: i,
            error: unsettledError,
          });
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'loop_iteration_failed',
              step_name: stepName,
              data: {
                iteration: i,
                error: unsettledError,
                duration: Date.now() - iterationStart,
                nodeId: node.id,
              },
            })
            .catch((evtErr: Error) => {
              logEventStoreError(evtErr, i);
            });
          const failureKind: NodeFailureKind = iterationIdleTimedOut ? 'timeout' : 'unknown';
          if (await tryIterationTransientRetry({ failureKind, error: unsettledError }, iterRetry)) {
            continue iterationAttempt;
          }
          return failLoopNode(`Loop iteration ${String(i)} failed: ${unsettledError}`, {
            failureKind,
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
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
          // max_tokens truncation. An uncompilable schema FAILS the node (#2453),
          // same contract as the ordinary AI gate: the loader already rejects one,
          // so continuing here would enforce nothing after paying for the iteration.
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
            return await failLoopNode(
              `Loop node '${node.id}' iteration ${String(i)}: its output_format schema cannot be compiled (${schemaCompileError}), so its declared contract cannot be enforced. Fix the schema.`,
              {
                failureKind: 'config',
                output: lastIterationOutput,
                costUsd: loopTotalCostUsd,
                ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
                ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
                loopIterations: i,
                data: { iteration: i },
              }
            );
          }
          if (validation.valid) {
            // Same gate the ordinary AI node applies before its value is persisted:
            // an unaddressable artifact pointer fails the node rather than riding
            // into this iteration's payload (#2453).
            const badPointer = await rejectedArtifactPointer(workflowRun, attemptStructured);
            if (badPointer !== null) {
              return await failLoopNode(
                `Loop node '${node.id}' iteration ${String(i)}: ${badPointer}.`,
                {
                  failureKind: 'output_contract',
                  output: lastIterationOutput,
                  costUsd: loopTotalCostUsd,
                  ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
                  ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
                  loopIterations: i,
                  data: { iteration: i },
                }
              );
            }
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
              failureKind: 'output_contract',
              output: lastIterationOutput,
              costUsd: loopTotalCostUsd,
              ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
              ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
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
            ? `Loop node '${node.id}' iteration ${String(i)}: timed out before producing the required structured output.${formatWatchdogResetDiagnostic(lastWatchdogReset)}`
            : `Loop node '${node.id}' iteration ${String(i)}: output_format declared but the provider returned no schema-valid structured output. The model likely replied with prose, refused, or emitted unparseable JSON.`,
          {
            failureKind: iterationIdleTimedOut ? 'timeout' : 'output_contract',
            output: lastIterationOutput,
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
            loopIterations: i,
            data: { iteration: i },
          }
        );
      }
      break;
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
            failureKind: 'output_contract',
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
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
    // supports a sentinel on the final standalone line, and that pattern is anchored
    // with `$` (see executor-shared.ts). Appending the payload moves the end of the
    // string past the prose, so concatenating would hide a final standalone signal
    // line for every loop that declares a schema. Checking each haystack separately
    // preserves each one's own anchor.
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
        const { prompt: substitutedBash } = substituteWorkflowVariables(
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
          {
            shellSafe: true,
            stateDir,
            typedArtifactsFile,
            references: nodeTemplateReferences(loop.until_bash, ctx, 'shell', {
              artifactsDir,
              requiredContext: { consumerId: node.id, field: 'loop.until_bash' },
            }),
          }
        );
        await runSubprocessUntilRunStops(
          deps.store,
          workflowRun.id,
          node.id,
          execContext,
          loopBashPath,
          ['-c', substitutedBash],
          {
            cwd,
            timeout: node.timeout,
            protectedEnvKeys: config.protectedEnvKeys,
            protectedCredentialValues: config.protectedCredentialValues,
            retention: {
              logDir,
              workflowRunId: workflowRun.id,
              nodeId: `${node.id}-iteration-${String(i)}`,
              label: '<until_bash>',
            },
            env: buildNodeShellEnvironment(node, ctx, config.envVars, {
              artifactsDir,
              stateDir,
              logDir,
              workflowId: workflowRun.id,
              baseBranch,
              userMessage: workflowRun.user_message,
              loopUserInput: i === startIteration ? (loopUserInput ?? '') : '',
              loopPrevOutput: prevIterationOutput,
              rejectionReason: '',
              issueContext,
              adoptedRunDir: currentAdoptedRunDir(),
              typedArtifactsFile,
              nodeExecution: execution,
            }),
          }
        );
        bashComplete = true; // exit 0 = complete
      } catch (e) {
        const bashErr = e as RawSubprocessRejection;
        if (bashErr.cancelled) {
          return failLoopNode(bashErr.message, {
            failureKind: 'cancelled',
            costUsd: loopTotalCostUsd,
            ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
            ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
            loopIterations: i,
            data: { iteration: i },
          });
        }
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
        data: {
          iteration: i,
          duration,
          completionDetected,
          nodeId: node.id,
          // The durable row is the only home for the full id; the emitter event above
          // and the transcript line below stay without it.
          ...(iterationSessionId !== undefined ? { session_id: iterationSessionId } : {}),
        },
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
      return recordNodeState(
        { store: deps.store, logDir },
        finishNodeExecution(
          execution,
          { status: 'completed' },
          {
            output: {
              text: lastIterationOutput,
              structured: lastIterationStructuredOutput,
              declaredOutputPaths: declaredOutputPathsFromSchema(node.output_format),
            },
            tokens: loopTotalTokens,
            tokensUnknown: loopTokensUnknown,
            costUsd: loopTotalCostUsd,
            stopReason: loopFinalStopReason,
            numTurns: loopTotalNumTurns,
            resolvedModel: loopResolvedModel?.id,
            sessionId: currentSessionId,
            diagnostics: {
              loopIterations: i,
              ...(loopBackgroundTasksIncomplete.size > 0
                ? { backgroundTasksIncomplete: [...loopBackgroundTasksIncomplete] }
                : {}),
            },
          }
        )
      );
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
      const suspended = finishNodeExecution(
        execution,
        { status: 'suspended', point: 'interactive_loop' },
        {
          output: { text: lastIterationOutput, structured: lastIterationStructuredOutput },
          tokens: loopTotalTokens,
          tokensUnknown: loopTokensUnknown,
          costUsd: loopTotalCostUsd,
          stopReason: loopFinalStopReason,
          numTurns: loopTotalNumTurns,
          resolvedModel: loopResolvedModel?.id,
          sessionId: currentSessionId,
          diagnostics: { loopIterations: i },
        }
      );
      const approvalContext: ApprovalContext = {
        execution: executionMetadata(suspended),
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
      };
      const deferredLoopOutput: NodeExecutionResult = {
        ...serializeNodeOutput(execution),
        ...(loopTotalCostUsd !== undefined ? { costUsd: loopTotalCostUsd } : {}),
        ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
        ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
      };
      const paused = await pauseGateRespectingExternalTransition(
        deps,
        workflowRun.id,
        approvalContext,
        { event: serializeNodeStateRecord(suspended) }
      );
      if (!paused) {
        if (loopTotalCostUsd !== undefined || loopTotalTokens !== undefined || loopTokensUnknown) {
          await persistNodeEvent(deps.store, serializeDeferredNodeUsage(suspended));
        }
        return deferredLoopOutput;
      }
      await recordDerivedExecution({ logDir }, suspended);
      const gateMsg =
        `\u23f8 **Input required** (loop \`${node.id}\`, iteration ${String(i)}): ${honestMessage}\n\n` +
        `Run ID: \`${workflowRun.id}\`\n` +
        `Respond: \`${spellWorkflowCommand(platform, `approve ${workflowRun.id} <your feedback>`)}\` | ` +
        `Cancel: \`${spellWorkflowCommand(platform, `reject ${workflowRun.id}`)}\``;
      await sendPauseNotice(
        deps,
        platform,
        conversationId,
        workflowRun.id,
        node.id,
        gateOccurrence(paused),
        stepName,
        gateMsg
      );
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

      return serializeNodeOutput(suspended);
    }
  }

  // Max iterations exceeded
  const errorMsg = `Loop node '${node.id}' exceeded max iterations (${String(iterationLimit)}) ${describeUnmetCompletion(loop)}`;
  getLog().warn(
    { nodeId: node.id, maxIterations: iterationLimit, signal: loop.until },
    'loop_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return failLoopNode(errorMsg, {
    failureKind: 'max_iterations',
    output: lastIterationOutput,
    costUsd: loopTotalCostUsd,
    ...(loopTotalTokens !== undefined ? { tokens: loopTotalTokens } : {}),
    ...(loopTokensUnknown ? { tokensUnknown: true } : {}),
    // A bare approve past the cap resumes beyond iterationLimit and runs nothing.
    loopIterations: Math.max(iterationLimit, startIteration - 1),
    data: { maxIterations: iterationLimit },
  });
}

/**
 * Send a paused run's inline notice. The durable pause is the record and the attention
 * queue is where it is answered, so a notice the platform cannot deliver leaves the run
 * paused. The failure is persisted on the run as `pause_notice_undelivered` (beside the
 * `platform_message_send_failed` log `safeSendMessage` writes), so a reader of the run
 * can see that nobody was told. It names the pause `occurrence` so the push router can
 * treat that pause as unannounced and notify the owner itself.
 */
async function sendPauseNotice(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflowRunId: string,
  nodeId: string,
  occurrence: string,
  stepName: string,
  notice: string
): Promise<void> {
  if (
    await safeSendMessage(platform, conversationId, notice, {
      workflowId: workflowRunId,
      nodeName: nodeId,
    })
  )
    return;
  await deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'pause_notice_undelivered',
      step_name: stepName,
      data: { nodeId, occurrence, platform: platform.getPlatformType() },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId, eventType: 'pause_notice_undelivered' },
        'workflow.event_persist_failed'
      );
    });
}

/**
 * A same-run gate that loses the running-to-paused CAS stays unfinished for resume.
 * External stops retain ownership of terminal state; other store failures propagate.
 * Write-back requires a successful pause before its apply/teardown path can proceed.
 * `event` commits with the pause, so every gate pause reaches the event feed the
 * attention watch follows. Returns the persisted context, including its minted
 * `pauseId`; undefined when the gate did not pause.
 */
async function pauseGateRespectingExternalTransition(
  deps: WorkflowDeps,
  runId: string,
  approvalContext: ApprovalContext,
  options: {
    event: GatePauseEventInput;
    extraMetadata?: Record<string, unknown>;
    failClosed?: boolean;
  }
): Promise<ApprovalContext | undefined> {
  const { extraMetadata, failClosed = false } = options;
  approvalContext = { ...approvalContext, pauseId: randomUUID() };
  try {
    await deps.store.pauseWorkflowRun(runId, approvalContext, extraMetadata, options.event);
  } catch (pauseErr) {
    if (failClosed || !(pauseErr instanceof WorkflowRunPauseConflictError)) throw pauseErr;
    let status: WorkflowRunStatus | null;
    try {
      status = await deps.store.getWorkflowRunStatus(runId);
    } catch {
      // Status unknowable — surface the original pause failure.
      throw pauseErr;
    }
    if (status === 'running' || status === 'pending') throw pauseErr;
    if (status === 'paused') {
      const run = await deps.store.getWorkflowRun(runId);
      const active = run?.metadata?.approval;
      const wait = run?.metadata?.wait;
      if (isWorkflowWaitContext(wait)) {
        getLog().info(
          { workflowRunId: runId, nodeId: approvalContext.nodeId, activeNodeId: wait.nodeId },
          'dag.gate_deferred'
        );
        return undefined;
      }
      if (
        !isApprovalContext(active) ||
        (active.nodeId === approvalContext.nodeId &&
          active.bodyGateId === approvalContext.bodyGateId)
      )
        throw pauseErr;
      getLog().info(
        { workflowRunId: runId, nodeId: approvalContext.nodeId, activeNodeId: active.nodeId },
        'dag.gate_deferred'
      );
      return undefined;
    }
    getLog().warn(
      { workflowRunId: runId, status, err: pauseErr as Error },
      'dag.gate_pause_skipped_external_transition'
    );
    return undefined;
  }
  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId,
    nodeId: approvalContext.nodeId,
    message: approvalContext.message,
    decisions: approvalContext.decisions,
    pauseId: approvalContext.pauseId,
  });
  return approvalContext;
}

function snapshotBodySessionCursorAncestry(
  ancestry: RunLayersContext['bodySessionCursorAncestry']
): { bodySessionCursorAncestry?: BodySessionCursorAncestry } {
  return ancestry === undefined || ancestry.size === 0
    ? {}
    : {
        bodySessionCursorAncestry: Object.fromEntries(
          [...ancestry].map(([key, cursors]) => [key, Object.fromEntries(cursors)])
        ),
      };
}

interface WaitLoopOwner {
  groupId: string;
  iteration: number;
  sessionId: string | null;
  sessionProvider: string | null;
  bodySessionCursors?: Record<string, SessionCursor>;
  bodySessionCursorAncestry?: BodySessionCursorAncestry;
}

/** Execute a durable wait without holding a subprocess or provider slot. */
async function executeWaitNode(
  ctx: RunLayersContext,
  node: WaitNode,
  loopOwner?: WaitLoopOwner
): Promise<NodeExecutionResult> {
  const { workflowRun, deps, platform, conversationId, nodeOutputs, stepNamePrefix, logDir } = ctx;
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

  const execution =
    ctx.unfinishedInvocations?.get(
      nodeInvocationKey(stepNamePrefix + node.id, ctx.loopGroupPath)
    ) ?? (persisted === undefined ? beginExecution(ctx, node) : undefined);
  if (execution !== undefined && persisted === undefined) {
    await recordNodeState({ store: deps.store, logDir }, execution);
  }

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
          ...(loopOwner.bodySessionCursors !== undefined
            ? { bodySessionCursors: loopOwner.bodySessionCursors }
            : {}),
          ...(loopOwner.bodySessionCursorAncestry !== undefined
            ? { bodySessionCursorAncestry: loopOwner.bodySessionCursorAncestry }
            : {}),
        } as const);
  const condition = waitCondition(node.wait);
  const resolveEventText = (text: string): string =>
    substituteWaitMessage(text, ctx, resolveRunInputs(workflowRun));
  let context: WorkflowWaitContext;
  if (persisted !== undefined) {
    context = persisted;
  } else if (condition.kind === 'duration') {
    context = {
      ...owner,
      kind: 'time',
      pauseId: randomUUID(),
      waitingSince: now.toISOString(),
      resumeAt: new Date(now.getTime() + condition.durationMs).toISOString(),
    };
  } else if (condition.kind === 'until') {
    const inputsName = parseWholeInputsRef(condition.timestamp);
    let rendered: string;
    if (inputsName !== undefined) {
      const runInputs = resolveRunInputs(workflowRun);
      if (!runInputs || !Object.hasOwn(runInputs, inputsName)) {
        throw new Error(`Wait node '${node.id}' references unknown input '$INPUTS.${inputsName}'`);
      }
      rendered = canonicalValueText(runInputs[inputsName]);
    } else {
      rendered = substituteNodeOutputRefs(condition.timestamp, nodeOutputs, ctx.loopBodyScopes);
    }
    if (!waitUntilTimestampSchema.safeParse(rendered).success) {
      throw new Error(
        `Wait node '${node.id}' has an invalid 'until' timestamp after substitution: '${rendered}'`
      );
    }
    const resumeAtMs = Date.parse(rendered);
    context = {
      ...owner,
      kind: 'time',
      pauseId: randomUUID(),
      waitingSince: now.toISOString(),
      resumeAt: new Date(resumeAtMs).toISOString(),
    };
  } else if (condition.kind === 'event') {
    const event = resolveEventText(condition.event).trim();
    if (event === '') {
      throw new Error(`Wait node '${node.id}' resolved 'event' to an empty string`);
    }
    context = {
      ...owner,
      kind: 'event',
      pauseId: randomUUID(),
      event,
      waitingSince: now.toISOString(),
      resumeAt: new Date(now.getTime() + condition.deadlineMs).toISOString(),
    };
  } else {
    const message = resolveEventText(condition.message).trim();
    if (message === '') {
      throw new Error(`Wait node '${node.id}' resolved 'attention' to an empty message`);
    }
    const options = resolveAttentionOptions(node.id, condition.options, ctx.nodeOutputs);
    const labels =
      condition.labels === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(condition.labels).map(([key, value]) => [key, resolveEventText(value)])
          );
    context = {
      ...owner,
      kind: 'attention',
      waitingSince: now.toISOString(),
      message,
      pauseId: randomUUID(),
      form: condition.form,
      ...(options !== undefined ? { options } : {}),
      ...(labels !== undefined ? { labels } : {}),
    };
  }

  const resumeAtMs = context.kind === 'attention' ? undefined : Date.parse(context.resumeAt);
  const isSignaled = context.kind === 'event' && context.signaledAt !== undefined;
  const isDue = resumeAtMs !== undefined && now.getTime() >= resumeAtMs;
  // An answered attention wait completes with its answer. A bare `resume` completes only a
  // message-form wait, with empty text, which keeps waits paused before answers existed
  // continuable; any other form pauses again until it is answered.
  const isAttentionResume =
    context.kind === 'attention' &&
    persisted !== undefined &&
    (context.answer !== undefined || attentionForm(context) === 'message');
  if (!isSignaled && !isDue && !isAttentionResume) {
    let paused = false;
    try {
      await deps.store.pauseWorkflowRunForWait(
        workflowRun.id,
        context,
        persisted === undefined
          ? { kind: 'started', stepName: stepNamePrefix + node.id }
          : { kind: 'continued' }
      );
      paused = true;
    } catch (pauseError) {
      const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
      if (status === 'running') throw pauseError;
      getLog().warn(
        { workflowRunId: workflowRun.id, nodeId: node.id, status: status ?? 'deleted' },
        'dag.wait_pause_skipped_external_transition'
      );
    }
    if (paused && context.kind === 'attention') {
      await sendPauseNotice(
        deps,
        platform,
        conversationId,
        workflowRun.id,
        node.id,
        attentionOccurrence(context),
        stepNamePrefix + node.id,
        attentionNotification(platform, workflowRun.id, context)
      );
    }
    return execution === undefined
      ? { state: 'running', output: '' }
      : !paused
        ? serializeNodeOutput(execution)
        : recordNodeState(
            { store: deps.store, logDir },
            finishNodeExecution(
              execution,
              { status: 'suspended', point: 'wait' },
              { output: { text: '' } }
            )
          );
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
  // An attention wait's node output is its answer; the wait outcome row keeps `result`.
  const answer = context.kind === 'attention' ? (context.answer ?? { text: '' }) : undefined;
  const nodeValue = answer ?? result;
  const output = JSON.stringify(nodeValue);
  const declaredOutputPaths = declaredOutputPathsFromSchema(waitOutputFormat(node.wait));
  const stepName = stepNamePrefix + node.id;
  const completed =
    execution === undefined
      ? undefined
      : finishNodeExecution(
          execution,
          { status: 'completed' },
          {
            durationMs: result.waited_ms,
            output: { text: output, structured: nodeValue, declaredOutputPaths },
          }
        );
  if (persisted !== undefined) {
    const outcome = await deps.store.clearWorkflowWaitContext(workflowRun.id, context, {
      stepName,
      result,
      ...(answer !== undefined ? { answer } : {}),
      execution: completed,
    });
    if (!outcome.cleared) {
      throw new Error(`Wait node '${node.id}' lost ownership of its persisted wait cursor`);
    }
    // The store wrote the node_completed row inside the cursor-clearing transaction and
    // handed it back; the transcript and emitter derive from that row, not a rebuilt one.
    await recordDerivedNodeState({ logDir }, node, outcome.nodeEvent);
  } else {
    const rows = waitCompletionEvents(workflowRun.id, {
      stepName,
      result,
      ...(answer !== undefined ? { answer } : {}),
      execution: completed,
    });
    await deps.store.createWorkflowEvent(rows.outcome);
    await persistNodeEvent(deps.store, rows.node);
    await recordDerivedNodeState({ logDir }, node, rows.node);
  }
  if (completed !== undefined) return serializeNodeOutput(completed);
  return { state: 'completed', output, structuredOutput: nodeValue, declaredOutputPaths };
}

/**
 * Resolve an attention wait's options when it pauses. A whole `$node.output.<field>`
 * reference is read here and must pass the same rules as literal options; the node fails,
 * naming the producer, rather than pausing with options nobody can answer.
 */
export function resolveAttentionOptions(
  nodeId: string,
  options: AttentionOption[] | string | undefined,
  nodeOutputs: ReadonlyMap<string, NodeOutput>
): AttentionOption[] | undefined {
  if (typeof options !== 'string') return options;
  const ref = parseWholeOutputRef(options);
  const producer = ref === undefined ? undefined : nodeOutputs.get(ref.nodeId);
  if (ref === undefined || producer === undefined) {
    throw new Error(
      `Wait node '${nodeId}' options '${options}' name no node that has produced output`
    );
  }
  const parsed = attentionOptionsSchema.safeParse(
    wholeRefLogicalValue(producer, ref.nodeId, ref.field, options.trim())
  );
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
      .join('; ');
    throw new Error(
      `Wait node '${nodeId}' options '${options}' from '${ref.nodeId}' are not a valid option list ` +
        `(an array of { id, label? } with unique kebab-case ids and at least one entry): ${problems}`
    );
  }
  return parsed.data;
}

/** The message an attention wait sends when it pauses: the question and how to answer it. */
function attentionNotification(
  surface: IWorkflowPlatform,
  runId: string,
  wait: WorkflowAttentionWaitContext
): string {
  const answer = attentionAnswerLines(surface, {
    runId,
    form: attentionForm(wait),
    options: [...attentionOptions(wait)],
    occurrence: attentionOccurrence(wait),
  });
  return [
    `⏸️ **Workflow run \`${runId}\` needs attention**`,
    wait.message,
    [...answer, `Abandon: \`${spellWorkflowCommand(surface, `abandon ${runId}`)}\``].join('\n'),
  ].join('\n\n');
}

/**
 * Execute an approval node — pauses workflow for human review.
 * On rejection resume (when on_reject is configured): runs the on_reject prompt via AI,
 * then re-pauses at the approval gate. After max_attempts rejections, cancels normally.
 */
async function executeApprovalNode(
  ctx: RunLayersContext,
  node: GateNode,
  stepNamePrefix = '',
  iteration?: number
): Promise<NodeOutput> {
  const {
    workflowRun,
    deps,
    platform,
    conversationId,
    workflowProvider,
    workflowModel,
    cwd,
    artifactsDir,
    nodeOutputs,
    config,
    workflowLevelOptions,
    aiProfile,
    workflowPreset,
    execContext,
  } = ctx;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };
  // Namespaced persisted step_name for loop_group bodies ('' → node.id at top level, #2090).
  const stepName = stepNamePrefix + node.id;
  const execution = beginExecution(ctx, node);
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);

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
      const reason = `max_attempts (${String(maxAttempts)}) exhausted`;
      await requireTerminalStatusWrite(
        deps.store.cancelWorkflowRun(workflowRun.id, {
          step_name: stepName,
          reason,
          cancel_reason: 'approval_rejected',
        }),
        { workflowRunId: workflowRun.id, site: 'dag.approval_exhausted_cancel' }
      );
      getWorkflowEventEmitter().emit({
        type: 'workflow_cancelled',
        runId: workflowRun.id,
        nodeId: node.id,
        reason,
      });
      const cancelMsg = `❌ Approval node \`${node.id}\` cancelled after ${String(maxAttempts)} rejections.`;
      await safeSendMessage(platform, conversationId, cancelMsg, msgContext);
      return { state: 'completed' as const, output: '' };
    }

    // Materialize the listing before substitution so a rework prompt may reference
    // $TYPED_ARTIFACTS_FILE. Fresh per rework attempt: the approval's rework node is an
    // ordinary agent invocation, so it observes artifacts published before this attempt.
    const typedArtifactsFile = await writeNodeArtifactsListing(artifactsDir, workflowRun.id);

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
    //
    // The synthetic node carries the rework TEMPLATE: executeNodeInternal resolves it, with
    // the rejection reason, in the one pass every agent prompt gets.
    const syntheticNode = gateReworkNode(node, rework.prompt);

    const {
      provider,
      model: resolvedNodeModel,
      options: nodeOptions,
      tier: resolvedTier,
      effort: resolvedEffort,
    } = await resolveNodeProviderAndModel(
      ctx.deps.providers,
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

    const output = await runBudgetedAttempt(ctx, syntheticNode, reserve =>
      executeNodeInternal(
        ctx,
        syntheticNode,
        reserve,
        provider,
        nodeOptions,
        undefined, // fresh session
        resolvedNodeModel,
        resolvedTier,
        resolvedEffort,
        stepNamePrefix,
        iteration,
        undefined, // synthetic on_reject node never carries a session checkpoint
        typedArtifactsFile,
        'ordinary',
        rejectionReason
      )
    );

    if (output.state === 'failed') {
      return output;
    }
    // Fall through to re-pause at the approval gate
  }

  // Resolve $nodeId.output[.field] references so the human sees concrete values
  // (parity with prompt/bash/loop/cancel nodes, which all run the same substitution).
  const renderedMessage = substituteNodeOutputRefs(node.message, nodeOutputs, ctx.loopBodyScopes);
  const choices = node.decisions.map(decision => {
    const label =
      decision.label ??
      (decision.id === 'approve' ? 'Approve' : decision.id === 'reject' ? 'Reject' : decision.id);
    const display = decision.label ? `${label} (${decision.id})` : label;
    const command =
      decision.id === 'approve' || decision.id === 'reject'
        ? `${decision.id} ${workflowRun.id}`
        : `respond ${workflowRun.id} ${decision.id} [text]`;
    return `${display}: \`${spellWorkflowCommand(platform, command)}\``;
  });
  const suspended = finishNodeExecution(
    execution,
    { status: 'suspended', point: 'approval' },
    {
      output: { text: '' },
      diagnostics: { iteration },
    }
  );
  const bodyGateOwner = ctx.bodyGateOwner?.bodyGateId === node.id ? ctx.bodyGateOwner : undefined;
  const approvalContext = approvalContextSchema.parse({
    execution: executionMetadata(suspended),
    message: renderedMessage,
    nodeId: bodyGateOwner?.nodeId ?? node.id,
    ...(bodyGateOwner
      ? {
          bodyGateId: bodyGateOwner.bodyGateId,
          iteration: bodyGateOwner.iteration,
          sessionId: ctx.lastSequentialSession?.sessionId ?? null,
          sessionProvider: ctx.lastSequentialSession?.provider ?? null,
          ...(ctx.bodySessionCursors !== undefined
            ? { bodySessionCursors: Object.fromEntries(ctx.bodySessionCursors) }
            : {}),
          ...snapshotBodySessionCursorAncestry(ctx.bodySessionCursorAncestry),
        }
      : {}),
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
  const paused = await pauseGateRespectingExternalTransition(
    deps,
    workflowRun.id,
    approvalContext,
    { event: serializeNodeStateRecord(suspended) }
  );
  if (!paused) return serializeNodeOutput(execution);
  await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
  const approvalMsg =
    `⏸ **Approval required**: ${renderedMessage}\n\n` +
    `Run ID: \`${workflowRun.id}\`\n` +
    choices.join(' | ');
  await sendPauseNotice(
    deps,
    platform,
    conversationId,
    workflowRun.id,
    node.id,
    gateOccurrence(paused),
    stepName,
    approvalMsg
  );

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

  return serializeNodeOutput(suspended);
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
 * The child's terminal LOGICAL value as a fan-out aggregate element: prefer the typed
 * `structuredOutput` (#2637); fall back to parsing the text summary, and keep non-JSON
 * text as the raw string, since a string IS what the child returned.
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
  const executionNodeId = ctx.stepNamePrefix + node.id;
  const execution = beginExecution(ctx, node);
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);

  // Build the failed result AND persist a node_failed event with the reason. Unlike
  // command/prompt/bash/script nodes (which write their own node_failed inside their
  // executor), the workflow node returns a failed NodeExecutionResult that runLayers
  // does NOT turn into an event — so without this the sub-run failure reason (cycle,
  // unknown target, cancelled child, …) would be swallowed into the run-level DAG
  // summary and never auditable per-node.
  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    tokensUnknown?: boolean
  ): Promise<NodeExecutionResult> => {
    // A settled child can fail after spending money. Keep those measurements on the
    // failed node so the run-level accumulator includes the work already performed.
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'failed', error, failureKind },
        {
          output: { text: '' },
          costUsd,
          tokens,
          tokensUnknown,
        }
      )
    );
  };

  if (!ctx.runChildWorkflow) {
    // Fail fast: executor.ts MUST inject the closure. A missing one means a caller
    // wired executeDagWorkflow without sub-run support — never silently no-op.
    return failResult(
      "Internal error: 'workflow:' node cannot run — runChildWorkflow closure was not injected.",
      'config'
    );
  }

  // Dynamic fan-out (slice 2, PR-C): a `fan_out:` node expands into N governed child
  // runs over a data-driven item list, joined into one node outcome. This is a
  // distinct execution path from the slice-1 single-child node below — branch here so
  // the 1:1 pause/resume machinery stays untouched for non-fan-out nodes.
  if (node.fan_out) {
    return executeFanOutWorkflowNode(node, ctx, node.fan_out, ctx.runChildWorkflow, execution);
  }

  // This run's named inputs (#2470), resolved once — threaded identically into the
  // `input:` string and every `with:` value below.
  const parentInputs = resolveRunInputs(parentRun);

  // Resolve the input data string (workflow vars + $node.output refs), exactly as
  // prompt/bash nodes resolve their text surface.
  const rawInput = node.input ?? '';
  const { prompt: input } = substituteWorkflowVariables(
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
    {
      stateDir: ctx.stateDir,
      inputs: parentInputs,
      references: nodeTemplateReferences(rawInput, ctx),
    }
  );

  // Resolve the node's `with:` map (#2470/#2637) into concrete JSON values: a
  // non-string literal passes through with its logical type; a string that is exactly
  // one whole `$INPUTS.<name>` / `$node.output[.field]` ref resolves to the LOGICAL
  // value; any other string keeps the text-template path (workflow vars —
  // non-shellSafe: these become the child's `$INPUTS`, not shell source — and
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
    loopBodyScopes: ctx.loopBodyScopes,
  };
  let resolvedInputs: Record<string, JsonValue> | undefined;
  if (node.with !== undefined) {
    resolvedInputs = {};
    for (const [name, rawValue] of Object.entries(node.with)) {
      resolvedInputs[name] = resolveWorkflowValue(rawValue, withResolutionCtx, parentInputs, false);
    }
  }

  // Build the completed result AND write the node_completed event. Unlike
  // command/prompt/bash/script nodes (which write their own inside their executor)
  // and unlike approval nodes (written by the approve handler), the workflow node
  // writes node_completed HERE — and ONLY on true completion, never on the paused
  // branch — so the resume snapshot skips a truly-finished sub-run on resume
  // but re-runs one still blocked on its child.
  const asCompleted = async (outcome: ChildWorkflowOutcome): Promise<NodeExecutionResult> => {
    // The contract this node completes under is the CHILD's (#2453): its `returns:` node
    // certified the value and stamped the field projection beside it. Nothing is
    // re-validated here — a `workflow:` node cannot declare a schema of its own (that is
    // a load error), so there is no caller side to check against.
    const declaredOutputPaths = outcome.declaredOutputPaths;
    // The same holds for an artifact pointer in the child's value (#2453): the child's
    // producer proved it against the child's own run, and this node relays it unchanged.
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
    // The parent's terminal record and resume snapshot require this committed result.
    // Storage rejection fails the parent run without reclassifying the completed child.
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: {
            text: output,
            ...(outcome.structuredOutput !== undefined
              ? { structured: outcome.structuredOutput }
              : {}),
            ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
          },
          costUsd: outcome.costUsd,
          tokens: outcome.tokens,
          tokensUnknown: outcome.tokensUnknown,
          diagnostics: { childRunId: outcome.childRunId },
        }
      )
    );
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
    const blocked = `Sub-run \`${node.workflow}\` (run \`${childRunId.slice(0, 8)}\`) is paused awaiting review. `;
    // The persisted gate message is read on every surface (web, CLI status, chat), so it
    // keeps the surface-neutral chat grammar; the notice below goes to this platform only.
    const approveChild = (surface: WorkflowCommandSurface): string =>
      `${blocked}Approve it by run id: \`${spellWorkflowCommand(surface, `approve ${childRunId}`)}\``;
    const suspended = finishNodeExecution(
      execution,
      { status: 'suspended', point: 'child_workflow' },
      { output: { text: '' }, diagnostics: { childRunId } }
    );
    const paused = await pauseGateRespectingExternalTransition(
      deps,
      parentRun.id,
      { message: approveChild({}), nodeId: executionNodeId, type: 'child_workflow', childRunId },
      { event: serializeNodeStateRecord(suspended) }
    );
    if (!paused) return serializeNodeOutput(execution);
    await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
    await safeSendMessage(
      platform,
      conversationId,
      `⏸ **Blocked on sub-run** \`${node.workflow}\`: ${approveChild(platform)}`,
      msgContext
    );
    return serializeNodeOutput(suspended);
  };

  const interpret = async (outcome: ChildWorkflowOutcome): Promise<NodeExecutionResult> => {
    switch (outcome.status) {
      case 'completed':
        return await asCompleted(outcome);
      case 'paused':
        return pauseParentOnChild(outcome.childRunId);
      case 'failed':
        return failResult(
          outcome.error ?? `Sub-run '${node.workflow}' failed`,
          'child_failed',
          outcome.costUsd,
          outcome.tokens,
          outcome.tokensUnknown
        );
      case 'cancelled':
        return failResult(
          `Sub-run '${node.workflow}' was cancelled`,
          'cancelled',
          outcome.costUsd,
          outcome.tokens,
          outcome.tokensUnknown
        );
      default: {
        // Compile-time exhaustiveness + runtime fail-loud: without this, a status
        // outside the union would silently return `undefined` into runLayers.
        const unreachable: never = outcome.status;
        return failResult(
          `Sub-run '${node.workflow}' returned unexpected status '${String(unreachable)}'`,
          'unknown'
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
        executionNodeId
    );
    existing = children.length > 0 ? children[children.length - 1] : undefined;
  } catch (err) {
    return failResult(
      `Failed to look up child runs for node '${node.id}': ${(err as Error).message}`,
      'unknown'
    );
  }

  const childArgs = {
    parentRun,
    nodeId: executionNodeId,
    childWorkflowName: node.workflow,
    input,
    cwd,
    conversationId,
    userId: parentRun.user_id ?? undefined,
    codebaseId: parentRun.codebase_id ?? undefined,
    isolation: node.isolation,
    ...(resolvedInputs !== undefined ? { inputs: resolvedInputs } : {}),
  };

  try {
    if (existing === undefined) {
      return await interpret(await ctx.runChildWorkflow(childArgs));
    }
    if (existing.status === 'failed') {
      // Resume-through-parent recovery (D5/#1764): re-drive the failed child once.
      return await interpret(
        await ctx.runChildWorkflow({ ...childArgs, resumeChild: { kind: 'failed', run: existing } })
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
    if (err instanceof TerminalStatusWriteError || err instanceof NodeEventWriteError) throw err;

    // Only a read of the parent's source releases the parent; a child's fault stays the
    // child's, so the launch types those reads (see runChildWorkflow).
    if (err instanceof WorkflowSourceUnavailableError)
      throw new RunSourceUnreadableError(executionNodeId, err);

    return failResult(
      `Sub-run '${node.workflow}' errored: ${(err as Error).message}`,
      'child_failed'
    );
  }
}

/**
 * `metadata.cancelled_reason` values the fan-out path stamps on children it cancels
 * ITSELF (so the cancel is attributable and — unlike a user's out-of-band cancel —
 * recoverable on resume). `fan_out_orphan`: a child whose `child_index` fell out of range
 * when the item list shrank. `fan_out_checkout_check`: a child whose path-lock or
 * checkout-sharing store access failed before it ran any node (executor.ts).
 *
 * `fan_out_sibling` and `fan_out_gate` are READ-ONLY legacy. `fan_out_sibling` marked an
 * in-flight sibling cancelled once an earlier revision's fail-fast sealed the node's fate;
 * `fan_out_gate` marked a child cancelled because it paused, before a paused child could
 * wait as its own run (#4044). Nothing writes either any more. They stay in the type and
 * in the recoverable set on purpose: a run from before the upgrade has rows carrying
 * them, and dropping them would make those children read as user-cancelled — terminal,
 * never re-driven, so the parent would fail every resume with no way back. Delete them
 * only once no resumable run can predate the change.
 */
const FAN_OUT_RECOVERABLE_CANCEL_REASONS: ReadonlySet<string> = new Set(FAN_OUT_CANCEL_REASONS);

/**
 * A `running`/`pending` child found on re-entry is ambiguous: a crash-orphan of a prior
 * pass, or a live execution in another process. Past this idle window (no
 * `last_activity_at` heartbeat — written ≤ every 60s while a child runs) it reads as an
 * orphan; within it, as possibly still live. Only the MESSAGE differs — per AGENTS.md
 * "Do not guess lifecycle ownership", NEITHER branch cancels.
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
 * A `running`/`pending` fan-out child found on re-entry — ambiguous ownership, so NOT
 * auto-cancelled (AGENTS.md "Do not guess lifecycle ownership"). Names the state and the
 * run to act on, with wording keyed to `last_activity_at` staleness (fresh → likely live;
 * stale → likely orphaned). This text is persisted as the node failure and read on every surface, so it
 * names the run in full and leaves the abandon command to whichever surface renders it.
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
        'recent activity — it appears orphaned by an interrupted run. Abandon run ' +
        `${child.id}, then resume the parent to re-drive it.`
    : `fan_out node '${node.id}': ${ref} of '${node.workflow}' may still be running (recent activity) — ` +
        `wait for it to finish and resume, or abandon run ${child.id} if it is stuck.`;
}

/**
 * Resolve a composed fan-out's `include:` target at run time. The body may be a support
 * workflow of its own installed pack.
 */
export async function resolveFanOutChildDefinition(
  deps: WorkflowDeps,
  cwd: string,
  targetName: string,
  /** Frozen source roots owned by composed execution. */
  source?: WorkflowSourceRoots
): Promise<
  | {
      definition: ResolvedWorkflow;
      definitions: ResolvedWorkflow[];
      commandContents: ReadonlyMap<string, IncludeCommandContent>;
    }
  | { unresolved: string }
> {
  const sourceRoots = source ?? liveSourceRoots(cwd);
  let verifiedFiles: ReadonlySet<string> | undefined;
  try {
    // Verified first, so a capture this host cannot read throws a typed error rather
    // than surfacing as a discovery error string.
    verifiedFiles = await assertWorkflowSourceIntegrity(sourceRoots);
    const { workflows, support, errors } = await discoverWorkflowsWithConfig(
      cwd,
      deps.loadConfig,
      deps.providers,
      sourceRoots
    );
    // Discovery qualified a pack's composed targets to that pack, so a support workflow
    // is reachable here only by the composition that names it.
    const definitions = [...workflows, ...(support ?? [])].map(w => w.workflow);
    const definition = resolveWorkflowName(targetName, definitions);
    // resolveWorkflowName returns undefined for an unknown name and THROWS only on
    // ambiguity, so the undefined branch is ordinary rather than exceptional.
    if (!definition) {
      const relevantError =
        findWorkflowLoadError(errors, targetName) ??
        errors.find(
          error =>
            error.workflowName === undefined && isSourceReadFailure(error.cause, verifiedFiles)
        );
      if (relevantError !== undefined && isSourceReadFailure(relevantError.cause, verifiedFiles)) {
        throw relevantError.cause;
      }
      return {
        unresolved: relevantError?.error ?? `no workflow named '${targetName}' was found`,
      };
    }
    const commandContents = await resolveWorkflowCommandContents(
      sourceRoots,
      [definition],
      verifiedFiles
    );
    for (const content of commandContents.values()) {
      if (isIncludeCommandReadError(content) && isSourceReadFailure(content.cause, verifiedFiles)) {
        throw content.cause;
      }
    }
    return { definition, definitions, commandContents };
  } catch (err) {
    if (err instanceof WorkflowSourceIntegrityError || isSourceReadFailure(err)) throw err;
    if (isSourceReadFailure(err, verifiedFiles)) {
      throw new WorkflowSourceUnavailableError(
        sourceRoots.kind === 'captured' ? sourceRoots.anchor.root : cwd,
        err
      );
    }
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
function sumFanOutCost(outcomes: readonly { costUsd?: number }[]): number | undefined {
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
 * Σ of defined child token usage; unavailable if any child explicitly cannot count
 * its tokens, or if no child reported tokens. Like
 * {@link sumFanOutCost}, this covers every child regardless of outcome.
 */
function sumFanOutTokens(
  outcomes: readonly { tokens?: TokenUsage; tokensUnknown?: boolean }[]
): TokenUsage | undefined {
  if (outcomes.some(outcome => outcome.tokensUnknown)) return undefined;
  return sumTokenUsage(
    outcomes.flatMap(outcome => (outcome.tokens !== undefined ? [outcome.tokens] : [])),
    { scope: 'fan_out' }
  );
}

async function findFanOutChildRuns(
  store: WorkflowDeps['store'],
  parentRunId: string,
  nodePath: string
): Promise<WorkflowRun[]> {
  return (await store.findChildRuns(parentRunId)).filter(
    child => readSubrunMetadata(child.metadata).parentNodeId === nodePath
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
 *     re-entry skips completed instances. A recovery (resuming a failed node) re-drives
 *     failed and fan-out-cancelled children; a continuation (re-entry after this node
 *     paused on its children) threads every settled child as it is;
 *   - spawn/re-drive the unsettled indices through a `max_parallel` window in which a
 *     paused child keeps its slot (mapWithHeldSlots);
 *   - a child that PAUSES stays paused as its own run and queue item (#4044). While any
 *     child is unfinished, the parent pauses on a `fan_out` gate listing them, and
 *     re-enters here when they finish. A `running`/`pending` child found on a recovery is
 *     ambiguous → the node fails WITHOUT auto-cancel (AGENTS.md "Do not guess lifecycle
 *     ownership"), surfacing a staleness-keyed wait/abandon action;
 *   - EVERY index is spawned and every child runs to its own terminal state — no child's
 *     outcome ends another's — and only then does the join reduce: `all_success` (any
 *     failed/cancelled child fails the node) / `all_done` (aggregate all terminal if a
 *     child run exists; failed/cancelled entries represented);
 *   - aggregate `$<id>.output` = JSON array in item order; cost/tokens = Σ children.
 *
 * Execution failures return a failed NodeExecutionResult; lifecycle persistence
 * rejection escapes to the run failure boundary. `node_completed` is written ONLY when the join is
 * satisfied, so a paused or failed fan-out node re-runs and re-inspects its children on
 * re-entry against the durable child-run rows.
 */
async function executeFanOutWorkflowNode(
  node: WorkflowNode,
  ctx: RunLayersContext,
  fanOut: FanOutConfig,
  runChild: RunChildWorkflowFn,
  execution: NodeExecutionRecord
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, cwd, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };
  const stepName = ctx.stepNamePrefix + node.id;
  let tokensUnknown = false;

  // node_failed writer (mirrors executeWorkflowNode.failResult) — a fan-out failure may
  // still carry accumulated cost/tokens so spend over already-run children is tracked.
  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    blockedOnChildRunId?: string
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'failed', error, failureKind },
        {
          output: { text: '' },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: {
            fanOut: true,
            ...(blockedOnChildRunId !== undefined ? { blockedOnChildRunId } : {}),
          },
        }
      )
    );
  };

  // node_completed writer (mirrors executeWorkflowNode.asCompleted) — written ONLY when
  // the join is satisfied, so getCompletedDagNodeOutputs skips a finished fan-out node
  // on resume but re-runs an unfinished one (which re-inspects children by child_index).
  const writeCompleted = async (
    output: string,
    costUsd?: number,
    tokens?: TokenUsage,
    structured?: unknown
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: { text: output, ...(structured !== undefined ? { structured } : {}) },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { fanOut: true },
        }
      )
    );
  };

  // Notify the platform immediately of a fan-out failure or pause (S3). Every early-failure
  // branch uses this — items resolution, the child-lookup errors, the ambiguous-child
  // check and the join — so a fan-out failure never reaches the user through the
  // end-of-run digest alone.
  const notify = async (text: string): Promise<void> => {
    await safeSendMessage(platform, conversationId, text, msgContext);
  };

  // Cancel a child the fan-out path OWNS, stamping WHY (C2/I4) so the cancel is
  // attributable AND — unlike a user's out-of-band cancel — recoverable on resume.
  let childCancellationFailure: TerminalStatusWriteError | undefined;
  const cancelChild = async (childId: string, reason: FanOutCancelReason): Promise<void> => {
    if (!childId) return;
    try {
      await requireTerminalStatusWrite(deps.store.cancelFanOutRun(childId, reason), {
        workflowRunId: childId,
        site: 'dag.fan_out_cancel',
      });
    } catch (error) {
      if (error instanceof TerminalStatusWriteError) childCancellationFailure = error;
      throw error;
    }
  };

  // Item → child input/$ARGUMENTS (canonical value text: strings raw, objects JSON).
  // Also the pre-image for the resume item-hash (S2) — identity unchanged by #2637,
  // since canonicalValueText is byte-identical to the previous inline mapping.
  const itemToInput = (item: unknown): string => canonicalValueText(item);

  // 1. Resolve `fan_out.items` → a JSON array. Workflow vars and $node.output refs,
  //    exactly as the input surface resolves them. A `.field` ref that
  //    can't be honored throws an OutputRefError → caught → fail closed. Never silently
  //    zero items: a resolution that isn't a JSON array fails the node.
  let parsedItems: unknown;
  try {
    const { prompt: itemsResolved } = substituteWorkflowVariables(
      fanOut.items,
      parentRun.id,
      parentRun.user_message ?? '',
      ctx.artifactsDir,
      ctx.baseBranch,
      ctx.docsDir,
      ctx.issueContext,
      undefined,
      undefined,
      undefined,
      { references: nodeTemplateReferences(fanOut.items, ctx) }
    );
    parsedItems = JSON.parse(itemsResolved);
  } catch (err) {
    const msg = `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }

  if (!Array.isArray(parsedItems)) {
    const msg =
      `fan_out.items on '${node.id}' resolved to ${typeof parsedItems}, not a JSON array. ` +
      `'${fanOut.items}' must reference a node output that produces a JSON array.`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }
  const items: unknown[] = parsedItems;

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
        loopBodyScopes: ctx.loopBodyScopes,
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
    return failResult(msg, 'config');
  }

  // 2. Empty array → a valid zero-width expansion (#977 acceptance): complete with '[]'.
  if (items.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.fan_out_empty');
    return writeCompleted('[]', undefined, undefined, []);
  }

  // 3. Re-entry: find THIS node's existing children (a parent may run several workflow
  //    nodes → filter by parent_node_id) and index them by metadata.child_index. Empty
  //    on the first run; carries the ordered instance set on resume.
  const existingByIndex = new Map<number, WorkflowRun>();
  try {
    const children = await findFanOutChildRuns(deps.store, parentRun.id, stepName);
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
    if (err instanceof TerminalStatusWriteError) throw err;
    // Notify like every other early-failure branch — this one was the odd one out, so a
    // store error was the single fan-out failure that reached the user only via the
    // end-of-run digest.
    const msg = `Failed to look up fan-out child runs for node '${node.id}': ${(err as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
  }

  // 4. Classify the existing children (#4044 D3). The node's own latest lifecycle record
  //    tells a CONTINUATION — this node paused on its children, and one of them finished —
  //    from a RECOVERY: an operator resuming a failed node, a crash, or a first run.
  //    A continuation threads every settled child as it is, so a sibling that failed in
  //    the first pass gets no free re-drive because another child paused. A recovery
  //    re-drives failed and fan-out-cancelled children, as resume-through-parent always did.
  //    A paused child is HELD in either mode: it keeps waiting for its own answer and keeps
  //    its `max_parallel` slot. A `running`/`pending` child is held in a continuation (the
  //    continuation host may be driving it after an answer), but is ambiguous in a
  //    recovery — a crash-orphan or a live run in another process. Per AGENTS.md "Do not
  //    guess lifecycle ownership" the node then fails WITHOUT cancelling it.
  const prior = ctx.unfinishedInvocations?.get(
    nodeInvocationKey(stepName, ctx.loopGroupPath)
  )?.lifecycle;
  const continuing = prior?.status === 'suspended' && prior.point === 'fan_out';
  if (!continuing) {
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
      await notify(
        `⚠️ **Fan-out blocked** (node \`${node.id}\`): ${msg} ` +
          `Abandon: \`${spellWorkflowCommand(platform, `abandon ${child.id}`)}\``
      );
      return failResult(msg, 'unknown', undefined, undefined, child.id);
    }
  }

  const settledByIndex = new Map<number, ChildWorkflowOutcome>();
  /** Child run id of every held (non-terminal) child, by item index. */
  const heldByIndex = new Map<number, string>();
  for (const [index, child] of existingByIndex) {
    switch (child.status) {
      case 'paused':
      case 'running':
      case 'pending':
        heldByIndex.set(index, child.id);
        break;
      case 'completed':
        settledByIndex.set(index, childOutcomeFromRun(child));
        break;
      case 'failed':
        if (continuing) settledByIndex.set(index, childOutcomeFromRun(child));
        break;
      case 'cancelled':
        // A user-cancelled child (no fan-out tag) is terminal in either mode — it fails
        // all_success and is represented in all_done.
        if (continuing || !isFanOutRecoverableCancel(child)) {
          settledByIndex.set(index, childOutcomeFromRun(child));
        }
        break;
    }
  }

  if (ctx.priorCompletedNodes !== undefined && existingByIndex.size === 0) {
    await notify(
      `Re-driving fan_out node '${node.id}': no child run rows exist for its ${String(items.length)} children. ` +
        'Resume uses the captured parent source; changes to that source require a fresh launch.'
    );
  }

  // 5. Spawn or re-drive every unsettled index through a `max_parallel` window. A failed
  //    or fan-out-cancelled existing child is re-driven in a recovery; a missing index
  //    spawns fresh.
  //
  //    No child's outcome terminates another's. Every child runs to its OWN terminal state
  //    before the join reduces — a fan-out is N independent governed runs that happen to
  //    be siblings, not a competition. An earlier revision fail-fasted here, deciding one
  //    child's fate from another's, which is not the engine's call to make.
  //
  //    The window bounds UNFINISHED children, not only executing ones: a child that pauses
  //    keeps its slot (#4044 D2), because it may hold half-done edits in a shared checkout,
  //    and `max_parallel: 1` promises the children run one at a time. Items past a full
  //    window get no run row until a held child finishes and the parent continues.
  //
  //    `max_parallel` bounds concurrency, not total spend — a wide fan-out whose first
  //    child fails still runs every remaining child. The workflow `budget:` does not cover
  //    fan-out yet; a budgeted workflow rejects it at load (#2815).
  const spawn = async (i: number): Promise<ChildWorkflowOutcome> => {
    // A rolled-back cancellation has not released the child's working-path lock.
    // Let claimed siblings settle, but do not start another child against that lock.
    if (childCancellationFailure) throw childCancellationFailure;
    const item = items[i];
    const existing = existingByIndex.get(i);
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
    const resumeChild =
      existing?.status === 'failed'
        ? ({ kind: 'failed', run: existing } as const)
        : existing?.status === 'cancelled'
          ? ({ kind: 'fan-out-cancelled', run: existing } as const)
          : undefined;
    return runChild({
      parentRun,
      nodeId: stepName,
      childWorkflowName: node.workflow,
      input,
      cwd,
      conversationId,
      userId: parentRun.user_id ?? undefined,
      codebaseId: parentRun.codebase_id ?? undefined,
      isolation: node.isolation,
      childIndex: i,
      itemHash: hashFanOutItem(input),
      ...(Object.keys(childInputs).length > 0 ? { inputs: childInputs } : {}),
      ...(resumeChild ? { resumeChild } : {}),
    }).catch((error: unknown) => {
      if (error instanceof WorkflowSourceUnavailableError)
        throw new RunSourceUnreadableError(stepName, error);
      if (error instanceof TerminalStatusWriteError) childCancellationFailure = error;
      throw error;
    });
  };

  const unclaimed = (): number[] =>
    items.flatMap((_, i) => (settledByIndex.has(i) || heldByIndex.has(i) ? [] : [i]));
  for (
    let waiting = unclaimed();
    waiting.length > 0 && heldByIndex.size < fanOut.max_parallel;
    waiting = unclaimed()
  ) {
    const settled = await mapWithHeldSlots(
      waiting,
      fanOut.max_parallel - heldByIndex.size,
      spawn,
      outcome => outcome.status === 'paused'
    );
    const claimed = settled.flatMap((result, k) =>
      result === undefined ? [] : [{ index: waiting[k], result }]
    );
    const outcomes = settledValuesOrThrow(
      claimed.map(c => c.result),
      parentRun.id
    );
    claimed.forEach(({ index }, k) => {
      const outcome = outcomes[k];
      if (outcome.status === 'paused') heldByIndex.set(index, outcome.childRunId);
      else settledByIndex.set(index, outcome);
    });

    // A held child may have finished while this pass ran (answered and continued in
    // another process). Take its row's outcome so its slot frees for the next round.
    if (heldByIndex.size === 0) break;
    let rows: WorkflowRun[];
    try {
      rows = await findFanOutChildRuns(deps.store, parentRun.id, stepName);
    } catch (error) {
      const msg = `Failed to look up fan-out child runs for node '${node.id}': ${(error as Error).message}`;
      await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
      return failResult(msg, 'unknown');
    }
    for (const [index, childRunId] of heldByIndex) {
      const row = rows.find(r => r.id === childRunId);
      if (row !== undefined && isTerminalRunStatus(row.status)) {
        settledByIndex.set(index, childOutcomeFromRun(row));
        heldByIndex.delete(index);
      }
    }
  }

  // 6. Some children are unfinished: pause the parent on them. Each child is its own run
  //    and queue item, answered by its own run id; the engine never ends one for pausing.
  //    The parent continues through `maybeResumeParentRun` once `isFanOutBlockReleased`
  //    holds, re-enters here as a continuation, and joins when no child is held.
  if (heldByIndex.size > 0) {
    const held = [...heldByIndex.entries()].sort(([a], [b]) => a - b);
    const unspawnedItems = unclaimed().length;
    const message =
      `fan_out node '${node.id}' is waiting on ${String(held.length)} unfinished sub-run(s) of ` +
      `'${node.workflow}': ${held.map(([i, id]) => `item ${String(i)}: run ${id}`).join(', ')}` +
      (unspawnedItems > 0 ? `; ${String(unspawnedItems)} item(s) not started yet` : '') +
      '. Answer each paused sub-run by its own run id; this run continues when they finish.';
    const suspended = finishNodeExecution(
      execution,
      { status: 'suspended', point: 'fan_out' },
      { output: { text: '' }, diagnostics: { fanOut: true } }
    );
    const paused = await pauseGateRespectingExternalTransition(
      deps,
      parentRun.id,
      {
        type: 'fan_out',
        nodeId: stepName,
        message,
        childRunIds: held.map(([, id]) => id),
        unspawnedItems,
      },
      { event: serializeNodeStateRecord(suspended) }
    );
    if (!paused) return serializeNodeOutput(execution);
    await recordDerivedExecution({ logDir: ctx.logDir }, suspended);
    await notify(
      `⏸ **Waiting on sub-runs** (node \`${node.id}\`): ${message} ` +
        `See them with \`${spellWorkflowCommand(platform, 'status')}\`.`
    );
    return serializeNodeOutput(suspended);
  }

  const outcomes = items.map((_, i) => {
    const outcome = settledByIndex.get(i);
    if (outcome === undefined) {
      throw new Error(`fan_out node '${node.id}': item ${String(i)} has no settled outcome`);
    }
    return outcome;
  });

  const totalCostUsd = sumFanOutCost(outcomes);
  const totalTokens = sumFanOutTokens(outcomes);
  tokensUnknown = outcomes.some(outcome => outcome.tokensUnknown === true);

  // A completed child's aggregate ELEMENT (#2637): its terminal LOGICAL value via
  // {@link subrunLogicalValue}, so a structured child lands single-encoded
  // (`[{"v":1}]`, never `["{\"v\":1}"]`), a text-only child whose summary happens
  // to be JSON lands parsed, and any other child stays the exact string it always was.
  // Each child certified its own element against its own `returns:` contract (#2453);
  // the aggregate is engine-owned and asserts nothing further.
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

  // 7. Join.
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
        'child_failed',
        totalCostUsd,
        totalTokens
      );
    }
    // All completed → aggregate the child results in item order: a LOGICAL array
    // (#2637), serialized once for the text channel.
    const elements = outcomes.map((o, i) => childElement(o, i));
    const aggregate = JSON.stringify(elements);
    return writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
  }

  let children: WorkflowRun[];
  try {
    children = await findFanOutChildRuns(deps.store, parentRun.id, stepName);
  } catch (error) {
    const msg = `Failed to look up settled fan-out child runs for node '${node.id}': ${(error as Error).message}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown', totalCostUsd, totalTokens);
  }
  const anyChildStarted = children.some(child => {
    const index = readSubrunMetadata(child.metadata).childIndex;
    return index !== undefined && index >= 0 && index < items.length;
  });
  if (!anyChildStarted) {
    const reason = outcomes[0].error ?? `child ${outcomes[0].status}`;
    const msg = `fan_out node '${node.id}' refused all ${String(items.length)} children at spawn: ${reason}`;
    await notify(`❌ **Fan-out failed** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'child_failed', totalCostUsd, totalTokens);
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
  return writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
}

/**
 * Instantiate ONE composed fan-out item through the same narrow primitive used by a
 * static include. The target closure was already resolved and validated at load time;
 * only input materialization and instance namespacing vary per item.
 */
function expandComposeInstance(
  node: ComposeFanOutNode,
  identity: string,
  inputs: Record<string, JsonValue>,
  definition: ResolvedWorkflow,
  commandContents: ReadonlyMap<string, IncludeCommandContent>
): { nodes: DagNode[]; primarySink: string } | { error: string } {
  const directiveId = `${node.id}__${identity}`;
  const directive: IncludeDirective = {
    id: directiveId,
    kind: 'include',
    include: node.include,
    ...(Object.keys(inputs).length > 0 ? { with: inputs } : {}),
  };
  const expanded = instantiateResolvedInclude(directive, definition, commandContents);
  const primarySink = expanded.primarySink;
  if (primarySink === '') {
    return { error: `composed block '${definition.name}' has no sink node` };
  }
  return { nodes: expanded.namespaced, primarySink };
}

/** One settled composed fan-out instance, reduced into the aggregate (#2512). */
interface ComposeInstanceOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  output: string;
  structuredOutput?: unknown;
  error?: string;
  /** The failed instance's typed provider failure, from {@link aggregateProviderFailure}. */
  providerFailure?: ProviderFailure;
  costUsd?: number;
  tokens?: TokenUsage;
  tokensUnknown?: boolean;
}

/**
 * Execute a composed fan-out (`include:` + `fan_out:`) node (#2512): resolve the item
 * list at run time, then execute the statically named composed body ONCE PER ITEM inside
 * THIS run — one workflow_runs row, events under the parent's run id under instance-
 * qualified step names, bounded by `max_parallel`, aggregated in input order. No child
 * run rows are created; cancellation propagates through the parent's own lifecycle.
 *
 * Resume keys on CONTENT-hash identity (`fan-out-identity.ts`) from the first durable
 * ordered snapshot. Completed instance outcomes and completed inner nodes are threaded;
 * a started instance with no terminal row is ambiguous and never replayed automatically.
 */
async function executeComposeFanOutNode(
  node: ComposeFanOutNode,
  ctx: RunLayersContext,
  fanOut: ComposeFanOutNode['fan_out']
): Promise<NodeExecutionResult> {
  const { deps, platform, conversationId, cwd, workflowRun: parentRun } = ctx;
  const msgContext = { workflowId: parentRun.id, nodeName: node.id };
  const execution = beginExecution(ctx, node);
  let tokensUnknown = false;
  await recordNodeState({ store: deps.store, logDir: ctx.logDir }, execution);

  const failResult = async (
    error: string,
    failureKind: NodeFailureKind,
    costUsd?: number,
    tokens?: TokenUsage,
    providerFailure?: ProviderFailure
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        {
          status: 'failed',
          error,
          failureKind,
          ...(providerFailure !== undefined ? { providerFailure } : {}),
        },
        {
          output: { text: '' },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { fanOut: true },
        }
      )
    );
  };

  // Written ONLY when the join is satisfied, mirroring executeFanOutWorkflowNode — so
  // cold resume skips a finished fan-out but re-runs an unfinished one.
  const writeCompleted = async (
    output: string,
    costUsd?: number,
    tokens?: TokenUsage,
    structured?: unknown
  ): Promise<NodeExecutionResult> => {
    return recordNodeState(
      { store: deps.store, logDir: ctx.logDir },
      finishNodeExecution(
        execution,
        { status: 'completed' },
        {
          output: { text: output, ...(structured !== undefined ? { structured } : {}) },
          costUsd,
          tokens,
          tokensUnknown,
          diagnostics: { fanOut: true },
        }
      )
    );
  };

  const notify = async (text: string): Promise<void> => {
    await safeSendMessage(platform, conversationId, text, msgContext);
  };

  // Load the durable plan before touching the live item producer. Once a plan exists,
  // it owns the instance set; current output is only a best-effort drift diagnostic.
  const fanOutScopeName =
    ctx.stepNamePrefix + composeFanOutScopeSegment(node.id, ctx.loopGroupPath);
  let resumeSnapshot: DagResumeSnapshot;
  try {
    resumeSnapshot = await deps.store.getDagResumeSnapshot(parentRun.id);
  } catch (err) {
    const msg =
      `composed fan-out node '${node.id}' could not load durable resume state: ` +
      (err as Error).message;
    getLog().error(
      { err: err as Error, parentRunId: parentRun.id, nodeId: node.id },
      'workflow.compose_fan_out_resume_snapshot_failed'
    );
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
  }
  const priorOutputs = resumeSnapshot.completedNodeOutputs;
  const persistedSnapshots = resumeSnapshot.fanOutSnapshots.get(fanOutScopeName);

  const resolveCurrentItems = (): { items: JsonValue[] } | { error: string } => {
    try {
      const { prompt: itemsResolved } = substituteWorkflowVariables(
        fanOut.items,
        parentRun.id,
        parentRun.user_message ?? '',
        ctx.artifactsDir,
        ctx.baseBranch,
        ctx.docsDir,
        ctx.issueContext,
        undefined,
        undefined,
        undefined,
        { references: nodeTemplateReferences(fanOut.items, ctx) }
      );
      const parsed: unknown = JSON.parse(itemsResolved);
      if (!Array.isArray(parsed)) {
        return {
          error:
            `fan_out.items on '${node.id}' resolved to ${typeof parsed}, not a JSON array. ` +
            `'${fanOut.items}' must reference a node output that produces a JSON array.`,
        };
      }
      return { items: parsed };
    } catch (err) {
      return {
        error: `fan_out.items on '${node.id}' could not be resolved to a JSON array: ${(err as Error).message}`,
      };
    }
  };

  const currentItems = resolveCurrentItems();
  if ('error' in currentItems && persistedSnapshots === undefined) {
    await notify(`❌ **Composed fan-out failed** (node \`${node.id}\`): ${currentItems.error}`);
    return failResult(currentItems.error, 'config');
  }
  if ('error' in currentItems) {
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id, error: currentItems.error },
      'workflow.compose_fan_out_item_drift_unreadable'
    );
  }

  // Preflight BEFORE any instance spend: the target must still resolve (it may have been
  // renamed or deleted since load), and its complete closure must remain suspension-free.
  let resolved: Awaited<ReturnType<typeof resolveFanOutChildDefinition>>;
  try {
    resolved = await resolveFanOutChildDefinition(deps, cwd, node.include, ctx.workflowSourceRoots);
  } catch (error) {
    if (isSourceReadFailure(error))
      throw new RunSourceUnreadableError(ctx.stepNamePrefix + node.id, error);
    throw error;
  }
  if ('unresolved' in resolved) {
    const msg =
      `composed fan-out node '${node.id}': cannot resolve the composed block '${node.include}' — ` +
      `${resolved.unresolved}. Fix the include target name.`;
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }
  const bodySuspensions = collectComposedSuspensionPaths(resolved.definition, resolved.definitions);
  if (bodySuspensions.length > 0) {
    const names = bodySuspensions.map(entry => `'${entry.id}' (${entry.reason})`).join(', ');
    const msg =
      `composed fan-out node '${node.id}': the composed block '${node.include}' contains ` +
      `suspension-capable path${bodySuspensions.length === 1 ? '' : 's'} ${names}. An in-parent ` +
      'fan-out has no per-instance pause cursor, so it cannot safely resume a partly completed ' +
      "body. Remove the suspension path, or invoke the block once through 'include:' or 'workflow:'.";
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id, include: node.include },
      'workflow.compose_fan_out_suspension_rejected'
    );
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'config');
  }

  let computedSnapshots: ReturnType<typeof buildInstanceSnapshots>;
  if (persistedSnapshots === undefined) {
    // Freeze every resolved binding together with the item before any instance starts.
    // A resumed run must never combine completed work from the old bindings with a
    // retried instance resolved from changed upstream output.
    let staticInputs: Record<string, JsonValue> = {};
    const parentInputs = resolveRunInputs(parentRun);
    try {
      if (node.with !== undefined) {
        const resolutionCtx: ShellInputContext = {
          workflowRun: parentRun,
          artifactsDir: ctx.artifactsDir,
          stateDir: ctx.stateDir,
          baseBranch: ctx.baseBranch,
          docsDir: ctx.docsDir,
          issueContext: ctx.issueContext,
          nodeOutputs: ctx.nodeOutputs,
          loopBodyScopes: ctx.loopBodyScopes,
        };
        staticInputs = Object.fromEntries(
          Object.entries(node.with).map(([name, rawValue]) => [
            name,
            resolveWorkflowValue(rawValue, resolutionCtx, parentInputs, false),
          ])
        );
      }
    } catch (err) {
      const msg = `fan_out 'with:' on '${node.id}' could not be resolved: ${(err as Error).message}`;
      await notify(`❌ **Composed fan-out failed** (node \`${node.id}\`): ${msg}`);
      return failResult(msg, 'config');
    }
    if ('error' in currentItems) {
      throw new Error('unreachable: fresh composed fan-out has no resolved item list');
    }
    computedSnapshots = buildInstanceSnapshots(currentItems.items, staticInputs, fanOut.as);
  } else {
    // Only compare item identity for drift diagnostics. The persisted input map is the
    // authority on resume, so current `with:` references are intentionally not resolved.
    computedSnapshots =
      'items' in currentItems
        ? buildInstanceSnapshots(currentItems.items, {}, fanOut.as)
        : [...persistedSnapshots];
  }
  const snapshots = persistedSnapshots ?? computedSnapshots;

  if (persistedSnapshots === undefined) {
    try {
      await deps.store.persistWorkflowEvent({
        workflow_run_id: parentRun.id,
        event_type: 'fan_out_instances',
        step_name: fanOutScopeName,
        data: { instances: computedSnapshots },
      });
    } catch (err) {
      const msg =
        `composed fan-out node '${node.id}' could not persist its item snapshot before ` +
        `execution: ${(err as Error).message}`;
      await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
      return failResult(msg, 'unknown');
    }
  } else if (
    persistedSnapshots.length !== computedSnapshots.length ||
    persistedSnapshots.some((snapshot, index) => {
      const current = computedSnapshots[index];
      return (
        snapshot.identity !== current?.identity ||
        JSON.stringify(snapshot.item) !== JSON.stringify(current?.item)
      );
    })
  ) {
    getLog().warn(
      { parentRunId: parentRun.id, nodeId: node.id },
      'workflow.compose_fan_out_using_persisted_instances'
    );
  }

  if (snapshots.length === 0) {
    getLog().info({ parentRunId: parentRun.id, nodeId: node.id }, 'workflow.compose_fan_out_empty');
    return writeCompleted('[]', undefined, undefined, []);
  }

  const ambiguousIdentity = snapshots.find(snapshot =>
    resumeSnapshot.unresolvedNodeStarts.has(`${fanOutScopeName}__${snapshot.identity}`)
  );
  if (ambiguousIdentity !== undefined) {
    const msg =
      `composed fan-out node '${node.id}' has instance '${ambiguousIdentity.identity}' with ` +
      'a durable start but no terminal event. It may still be running or may have completed ' +
      'before its result was stored. Archon will not replay it automatically; inspect the ' +
      'run and deliberately abandon it or start a new run.';
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown');
  }

  // Execute incomplete identities through a bounded sliding window. Each instance runs
  // the composed body via runLayers in its own context: fresh output map, events under
  // the parent run id with engine-owned, instance-qualified step names. The authored
  // node ids remain ordinary DAG ids inside that isolated execution context.
  const settled = await mapWithLimit(
    snapshots,
    fanOut.max_parallel,
    async (snapshot): Promise<ComposeInstanceOutcome> => {
      let expanded: { nodes: DagNode[]; primarySink: string } | { error: string };
      try {
        expanded = expandComposeInstance(
          node,
          snapshot.identity,
          snapshot.inputs,
          resolved.definition,
          resolved.commandContents
        );
      } catch (err) {
        expanded = { error: (err as Error).message };
      }
      if ('error' in expanded) {
        return {
          status: 'failed',
          output: '',
          error: `instance ${snapshot.identity} failed to compose: ${expanded.error}`,
        };
      }
      const instanceScopeName = `${fanOutScopeName}__${snapshot.identity}`;
      const instanceStepNamePrefix = `${instanceScopeName}__`;
      const prior = priorOutputs.get(instanceScopeName);
      if (prior !== undefined) {
        const spend = prior.execution?.spend;
        return {
          ...(spend?.tokens.source === 'unavailable' && spend.tokens.reason === 'incomplete'
            ? { tokensUnknown: true }
            : {}),
          status: 'completed',
          output: prior.output,
          ...(prior.structuredOutput !== undefined
            ? { structuredOutput: prior.structuredOutput }
            : {}),
        };
      }
      const instancePriorNodes = new Map<string, PersistedNodeOutput>();
      const instanceNodeOutputs = new Map<string, NodeOutput>();
      for (const innerNode of expanded.nodes) {
        const persisted = priorOutputs.get(instanceStepNamePrefix + innerNode.id);
        if (persisted === undefined) continue;
        instancePriorNodes.set(innerNode.id, persisted);
        instanceNodeOutputs.set(innerNode.id, {
          state: 'completed',
          output: persisted.output,
          ...(persisted.structuredOutput !== undefined
            ? { structuredOutput: persisted.structuredOutput }
            : {}),
          ...(persisted.execution !== undefined ? { execution: persisted.execution } : {}),
        });
      }
      const instanceExecution: NodeExecutionRecord = {
        ...startNodeExecution({
          runId: parentRun.id,
          path: instanceScopeName,
          node: { kind: 'compose_fan_out_instance', id: instanceScopeName },
          invocation:
            resumeSnapshot.unfinishedInvocations?.get(
              nodeInvocationKey(instanceScopeName, ctx.loopGroupPath)
            )?.invocation ?? newNodeInvocation(ctx.loopGroupPath),
        }),
        diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
      };
      const deriveInstanceSinks = async (record: NodeExecutionRecord): Promise<void> => {
        const transcript = serializeNodeTranscript(record);
        if (transcript) await logWorkflowEvent(ctx.logDir, parentRun.id, transcript);
        const emitted = serializeNodeEmitter(record);
        if (emitted) getWorkflowEventEmitter().emit(emitted);
      };
      try {
        const startEvent = serializeNodeStateRecord(instanceExecution);
        const claim = await deps.store.persistWorkflowEventIfRunning(startEvent, {
          allowPaused: ctx.claimedWorkPausePolicy === 'finish_through_parent_pause',
        });
        if (!claim.persisted) {
          return {
            status: 'cancelled',
            output: '',
            error: 'parent run is no longer running; instance was not started',
          };
        }
        await deriveInstanceSinks(instanceExecution);
      } catch (err) {
        return {
          status: 'failed',
          output: '',
          error: `instance ${snapshot.identity} could not persist its start: ${(err as Error).message}`,
        };
      }
      const instanceCtx: RunLayersContext = {
        toolAttention: ctx.toolAttention,
        unfinishedInvocations: resumeSnapshot.unfinishedInvocations,
        deps: ctx.deps,
        platform: ctx.platform,
        conversationId: ctx.conversationId,
        cwd: ctx.cwd,
        workflowSourceRoots: ctx.workflowSourceRoots,
        runChildWorkflow: ctx.runChildWorkflow,
        execContext: ctx.execContext,
        workflowRun: parentRun,
        workflowName: ctx.workflowName,
        config: ctx.config,
        workflowProvider: ctx.workflowProvider,
        workflowModel: ctx.workflowModel,
        workflowLevelOptions: ctx.workflowLevelOptions,
        aiProfile: ctx.aiProfile,
        workflowPreset: ctx.workflowPreset,
        artifactsDir: ctx.artifactsDir,
        stateDir: ctx.stateDir,
        logDir: ctx.logDir,
        baseBranch: ctx.baseBranch,
        docsDir: ctx.docsDir,
        configuredCommandFolder: ctx.configuredCommandFolder,
        issueContext: ctx.issueContext,
        persistScope: ctx.persistScope,
        workflowPersistSessions: ctx.workflowPersistSessions,
        scopeArtifactsDir: undefined,
        // Runtime cardinality changes only the deterministic instance prefix; the body
        // was fully resolved and validated before any parent node ran.
        layers: planGraph(expanded.nodes).layers,
        nodeOutputs: instanceNodeOutputs,
        priorCompletedNodes: instancePriorNodes,
        claimedWorkPausePolicy: 'finish_through_parent_pause',
        lastSequentialSession: undefined,
        warnedProviderConflicts: ctx.warnedProviderConflicts,
        totalCostUsd: undefined,
        totalTokens: undefined,
        totalTokensUnknown: false,
        stepNamePrefix: instanceStepNamePrefix,
        loopGroupPath: ctx.loopGroupPath,
        // A composed instance is its own workflow: its prompts never took the enclosing
        // loop's substitution pass, so its command bodies don't either.
        loopBodyScopes: [],
      };
      try {
        await runLayers(instanceCtx);
      } catch (error) {
        // Without a terminal record the resumed fan-out would find this instance started
        // and never finished, and refuse to replay it.
        if (error instanceof RunSourceUnreadableError) {
          let releasedRecord = finishNodeExecution(
            instanceExecution,
            { status: 'failed', error: error.message, failureKind: 'child_failed' },
            { output: { text: '' } }
          );
          try {
            const rows = await deps.store.listWorkflowEvents(parentRun.id);
            let start = rows.length - 1;
            while (
              start >= 0 &&
              !(
                rows[start].step_name === instanceScopeName &&
                rows[start].event_type === 'node_started'
              )
            ) {
              start--;
            }
            const usage = await foldDagResumeSnapshot(
              rows
                .slice(start + 1)
                .filter(row => row.step_name?.startsWith(instanceStepNamePrefix)),
              parentRun.id
            );
            releasedRecord = finishNodeExecution(
              instanceExecution,
              { status: 'failed', error: error.message, failureKind: 'child_failed' },
              {
                costUsd: usage.costUsd,
                tokens: usage.tokens,
                tokensUnknown: usage.tokensUnknown,
                output: { text: '' },
                diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
              }
            );
            await deps.store.persistWorkflowEvent(serializeNodeStateRecord(releasedRecord));
          } catch (closureError) {
            if (
              closureError instanceof NodeEventWriteError ||
              closureError instanceof TerminalStatusWriteError
            )
              throw closureError;
            // The terminal owns the scope's spend. If accounting cannot be read, recovery
            // must retain the open start rather than close it with incomplete usage.
            throw new NodeEventWriteError(serializeNodeStateRecord(releasedRecord), closureError);
          }
          try {
            await deriveInstanceSinks(releasedRecord);
          } catch (cleanupError) {
            if (
              cleanupError instanceof NodeEventWriteError ||
              cleanupError instanceof TerminalStatusWriteError
            )
              throw cleanupError;
            getLog().error(
              { err: cleanupError, parentRunId: parentRun.id, instance: instanceScopeName },
              'workflow.compose_fan_out_release_sinks_failed'
            );
          }
        }
        throw error;
      }
      // Every instance exit carries the work it already paid for.
      const instanceUsage: Pick<ComposeInstanceOutcome, 'costUsd' | 'tokens' | 'tokensUnknown'> = {
        ...(instanceCtx.totalCostUsd !== undefined ? { costUsd: instanceCtx.totalCostUsd } : {}),
        ...(instanceCtx.totalTokens !== undefined ? { tokens: instanceCtx.totalTokens } : {}),
        tokensUnknown: instanceCtx.totalTokensUnknown,
      };
      const failed = [...instanceCtx.nodeOutputs.values()].filter(o => o.state === 'failed');
      if (failed.length > 0) {
        const providerFailure = aggregateProviderFailure(
          failed.map(o => o.providerFailure),
          Date.now()
        );
        const outcome: ComposeInstanceOutcome = {
          status: 'failed',
          output: '',
          error: failed[0].error ?? 'composed instance node failed',
          ...(providerFailure !== undefined ? { providerFailure } : {}),
          ...instanceUsage,
        };
        try {
          const failedRecord = finishNodeExecution(
            instanceExecution,
            {
              status: 'failed',
              error: outcome.error ?? 'composed instance node failed',
              failureKind: 'child_failed',
              ...(providerFailure !== undefined ? { providerFailure } : {}),
            },
            {
              output: { text: '' },
              costUsd: outcome.costUsd,
              tokens: outcome.tokens,
              tokensUnknown: outcome.tokensUnknown,
              diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
            }
          );
          await deps.store.persistWorkflowEvent(serializeNodeStateRecord(failedRecord));
          await deriveInstanceSinks(failedRecord);
        } catch (err) {
          return {
            ...outcome,
            status: 'ambiguous',
            error: `instance ${snapshot.identity} failed and its terminal state could not be stored: ${(err as Error).message}`,
          };
        }
        return outcome;
      }
      // Cancellation or another terminal status can stop runLayers early. A claimed
      // deterministic instance finishes through a sibling's pause and reaches its sink.
      // Surface any remaining incompleteness rather than treating absent output as success.
      const terminal = instanceCtx.nodeOutputs.get(expanded.primarySink);
      if (terminal?.state !== 'completed') {
        return {
          status: 'ambiguous',
          output: '',
          ...instanceUsage,
          error:
            `composed instance ${snapshot.identity} stopped without a terminal state; ` +
            'automatic replay is unsafe',
        };
      }
      const outcome: ComposeInstanceOutcome = {
        status: 'completed',
        output: terminal.output,
        ...(terminal.structuredOutput !== undefined
          ? { structuredOutput: terminal.structuredOutput }
          : {}),
        ...instanceUsage,
      };
      try {
        const completedRecord = finishNodeExecution(
          instanceExecution,
          { status: 'completed' },
          {
            output: {
              text: outcome.output,
              ...(outcome.structuredOutput !== undefined
                ? { structured: outcome.structuredOutput }
                : {}),
            },
            costUsd: outcome.costUsd,
            tokens: outcome.tokens,
            tokensUnknown: outcome.tokensUnknown,
            diagnostics: { identity: snapshot.identity, ordinal: snapshot.ordinal },
          }
        );
        await deps.store.persistWorkflowEvent(serializeNodeStateRecord(completedRecord));
        await deriveInstanceSinks(completedRecord);
      } catch (err) {
        return {
          ...outcome,
          status: 'ambiguous',
          error: `instance ${snapshot.identity} completed but its result could not be stored: ${(err as Error).message}`,
        };
      }
      return outcome;
    }
  );

  const outcomes = settledValuesOrThrow(settled, parentRun.id);

  const totalCostUsd = sumFanOutCost(outcomes);
  const totalTokens = sumFanOutTokens(outcomes);
  tokensUnknown = outcomes.some(outcome => outcome.tokensUnknown === true);

  // If the run stopped underneath us (external pause/cancel mid-flight), do NOT write a
  // terminal aggregate — leave the node unwritten so resume re-drives the incomplete
  // instances. Mirrors the between-layer early-return posture of runLayers itself.
  let runStatus: WorkflowRunStatus | null;
  try {
    runStatus = await deps.store.getWorkflowRunStatus(parentRun.id);
  } catch (err) {
    const msg = `could not verify parent status after composed fan-out: ${(err as Error).message}`;
    return failResult(msg, 'unknown', totalCostUsd, totalTokens);
  }
  const claimedWorkMayFinishPaused =
    runStatus === 'paused' && ctx.claimedWorkPausePolicy === 'finish_through_parent_pause';
  if (runStatus !== 'running' && !claimedWorkMayFinishPaused) {
    getLog().info(
      { parentRunId: parentRun.id, nodeId: node.id, runStatus },
      'workflow.compose_fan_out_interrupted'
    );
    return {
      ...serializeNodeOutput(execution),
      ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
      ...(tokensUnknown ? { tokensUnknown: true } : {}),
    };
  }

  const ambiguous = outcomes.find(outcome => outcome.status === 'ambiguous');
  if (ambiguous !== undefined) {
    const msg = ambiguous.error ?? 'a composed instance has ambiguous non-terminal work';
    await notify(`❌ **Composed fan-out blocked** (node \`${node.id}\`): ${msg}`);
    return failResult(msg, 'unknown', totalCostUsd, totalTokens);
  }

  if (fanOut.join === 'all_success') {
    const firstBad = outcomes.findIndex(o => o.status !== 'completed');
    if (firstBad !== -1) {
      const bad = outcomes[firstBad];
      const ref = `instance ${snapshots[firstBad].identity}`;
      await notify(
        `❌ **Composed fan-out failed** (node \`${node.id}\`): ${ref} ${bad.status}` +
          (bad.error ? ` — ${bad.error}` : '')
      );
      return failResult(
        `composed fan_out node '${node.id}' (join: all_success): ${ref} ${bad.status}` +
          (bad.error ? `: ${bad.error}` : ''),
        'child_failed',
        totalCostUsd,
        totalTokens,
        aggregateProviderFailure(
          outcomes.filter(o => o.status !== 'completed').map(o => o.providerFailure),
          Date.now()
        )
      );
    }
  }

  // all_done represents a failure as a marker object; all_success reaching here is all-completed.
  const elements = outcomes.map(o =>
    o.status === 'completed'
      ? ((o.structuredOutput !== undefined ? o.structuredOutput : o.output) as JsonValue)
      : {
          archon_failed: true,
          error: o.error ?? `instance ${o.status}`,
          status: o.status === 'cancelled' ? 'cancelled' : 'failed',
        }
  );
  const aggregate = JSON.stringify(elements);
  return writeCompleted(aggregate, totalCostUsd, totalTokens, elements);
}

/**
 * A run's cross-run session scope. Concurrent runs of one workflow share a scope, so
 * `sessionsAtStart` is read once when the run starts and every persisted node continues
 * from that copy, never from a row a sibling run wrote afterwards. The read is issued
 * before any node runs; a persisted node awaits it, so a failed read surfaces at the
 * node that needed it.
 */
interface PersistScope {
  key: string;
  sessionsAtStart: Promise<readonly WorkflowNodeSession[]>;
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
    const { artifactsByType, errors } = await readNodeArtifacts(scopeArtifactsDir, {
      scope: 'resolved-scope',
    });
    if (errors.length > 0) {
      getLog().warn(
        { errors, scopeArtifactsDir, nodeId },
        'dag.cold_resume_artifacts_partial_read'
      );
    }
    const priorArtifacts = Object.values(artifactsByType)
      .flat()
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

type ClaimedWorkPausePolicy = 'finish_through_parent_pause';

/** Run-level values the caller supplies verbatim to the DAG boundary. */
interface RunInputs {
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
interface RunDerived {
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
 * events emitted inside executeNodeInternal / executeBashNode / executeScriptNode /
 * executeLoopNode / executeApprovalNode. Body lifecycle rows additionally carry `iteration`
 * in `data`. The in-process emitter payloads stay raw (unprefixed) — see #2090.
 */
interface RunLayersContext extends RunInputs, RunDerived {
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
  /** The run budget's live ledger; set only when the workflow declares `budget:`. */
  runBudget?: RunBudgetLedger;
  // --- per-subgraph mutable state (varies between top-level DAG and loop_group body) ---
  /** Pre-computed topological layers (caller builds once — body shape is static). runLayers walks ONLY these; there is deliberately no flat node list here. */
  layers: GraphPlan['layers'];
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

/** Preserve the rejection that determines run recovery after all claimed work settles. */
function settledValuesOrThrow<T>(
  results: readonly PromiseSettledResult<T>[],
  workflowRunId: string
): T[] {
  const values: T[] = [];
  const failures: PromiseRejectedResult[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
    else failures.push(result);
  }
  const selected =
    failures.find(result => result.reason instanceof TerminalStatusWriteError) ??
    failures.find(result => result.reason instanceof NodeEventWriteError) ??
    failures.find(result => result.reason instanceof RunBudgetRefusedError) ??
    failures.find(result => result.reason instanceof RunSourceUnreadableError) ??
    failures[0];
  if (selected === undefined) return values;
  for (const failure of failures) {
    if (failure === selected) continue;
    const reason: unknown = failure.reason;
    getLog().error({ err: reason, workflowRunId }, 'dag.join_secondary_failure');
  }
  throw selected.reason;
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
async function runLayers(parentCtx: RunLayersContext): Promise<void> {
  const ctx = parentCtx;
  const providers = ctx.deps.providers;
  // Lifecycle events expose only the immediate enclosing iteration; artifact
  // identity retains the complete outermost-to-innermost lineage.
  const iteration = ctx.loopGroupPath.at(-1)?.iteration;
  // nodeOutputs + accumulators + lastSequentialSession are mutated in place on `ctx`.

  for (let layerIdx = 0; layerIdx < ctx.layers.length; layerIdx++) {
    await ctx.toolAttention.refresh();
    const layer = ctx.layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
    }

    // Build a thunk per node so the layer can run either concurrently or strictly
    // sequentially. The `mutates_checkout: false` assertion snapshots before and
    // asserts after a node's own execution, so when a guarded node shares the layer
    // with any node that isn't checkout-guarded (including loop/loop_group/workflow
    // siblings whose internal execution would overlap the window), that sibling's
    // legitimate write would be blamed on the guarded node: such a mixed layer runs
    // sequentially. A layer of guarded nodes only runs concurrently, since no node in
    // it may write: the writer still sees its own write and fails, and a sibling
    // whose window overlapped fails with it, its error naming the siblings.
    const guardedCount = layer.filter(isCheckoutGuarded).length;
    const serializeLayer = guardedCount > 0 && guardedCount < layer.length;
    const guardedLayerSnapshots = serializeLayer ? undefined : new Set<string>();
    const nodeThunks = layer.map(
      (node): (() => Promise<LayerNodeResult>) =>
        async (): Promise<LayerNodeResult> => {
          const ctx: RunLayersContext = {
            ...parentCtx,
            currentExecution: undefined,
            guardedLayerSnapshots,
            nodeInvocation:
              parentCtx.unfinishedInvocations?.get(
                nodeInvocationKey(parentCtx.stepNamePrefix + node.id, parentCtx.loopGroupPath)
              )?.invocation ?? newNodeInvocation(parentCtx.loopGroupPath),
          };
          try {
            const checkpointSessionForProvider = (
              provider: string
            ): SessionCheckpoint | undefined => {
              const handles = ctx.nodeSessionHandles;
              if (handles === undefined || ctx.namedResumeSourceIds?.has(node.id) !== true) {
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
            };

            // Established before AI-configuration substitution below; each node kind
            // that reaches a provider assigns its own fresh observation before that
            // call. Coordination-only nodes leave it undefined, so an AI-config text
            // that references $TYPED_ARTIFACTS_FILE there fails loudly.
            let typedArtifactsFile: string | undefined;
            // `systemPrompt:` and `agents.*` go straight to the provider, so they resolve
            // exactly as a `prompt:` does (#2476). Inside a loop_group body this reads the
            // body's scoped `nodeOutputs` and loop scopes, matching every other surface.
            const resolveAiConfigText = (text: string): string =>
              substituteWorkflowVariables(
                text,
                ctx.workflowRun.id,
                ctx.workflowRun.user_message,
                ctx.artifactsDir,
                ctx.baseBranch,
                ctx.docsDir,
                ctx.issueContext,
                undefined,
                undefined,
                undefined,
                {
                  stateDir: ctx.stateDir,
                  inputs: resolveRunInputs(ctx.workflowRun),
                  typedArtifactsFile,
                  references: nodeTemplateReferences(text, ctx),
                }
              ).prompt;

            // A prior success is reusable only while every enclosing include is still active.
            // Unlike ordinary node-local rules, a composed boundary governs the whole block,
            // so resume must not let a stale completed descendant cross a newly-false gate.
            const priorCompletedNodes = ctx.priorCompletedNodes;
            const isCachedPriorSuccess =
              priorCompletedNodes?.has(node.id) === true && !node.always_run;
            const composedBoundaryDecision = checkComposedBlockBoundaries(
              node,
              ctx.nodeOutputs,
              resolveRunInputs(ctx.workflowRun),
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
                  ctx.artifactsDir,
                  stepName
                );
              if (node.always_run) {
                getLog().info({ nodeId: node.id }, 'dag.node_always_run_resume_forced');
                const alwaysRunStepName = ctx.stepNamePrefix + node.id;
                // The prior value being reset can be arbitrarily large — getDagResumeSnapshot
                // prefers the full spilled text over the bounded preview (#2726), so this
                // audit row must go through the same bounded-preview+spill helper as the
                // primary node_completed/node_skipped_prior_success writers, not the raw text.
                const alwaysRunPriorOutput = formatThisNodesPriorOutput(alwaysRunStepName);
                await recordNodeState(
                  { store: ctx.deps.store, logDir: ctx.logDir },
                  {
                    runId: ctx.workflowRun.id,
                    path: alwaysRunStepName,
                    node: describeExecutionNode(node),
                    cache: {
                      action: 'reset',
                      prior: persistedExecutionOutput(alwaysRunPriorOutput),
                    },
                  }
                );
                // falls through to re-execute the node
              } else if (
                composedBoundaryDecision.decision === 'run' &&
                // A join cached before failure-cascade skips blocked this rule must
                // satisfy its current eligibility before that success can be reused.
                (node.trigger_rule !== 'none_failed_min_one_success' ||
                  checkTriggerRule(node, ctx.nodeOutputs).decision === 'run')
              ) {
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
                  const invalidatedStepName = ctx.stepNamePrefix + node.id;
                  // Same rationale as the always_run reset above: prior.output can now be
                  // the full spilled text, so this audit row needs the same bounding (#2726).
                  const invalidatedPriorOutput = formatThisNodesPriorOutput(invalidatedStepName);
                  getLog().info(
                    { nodeId: node.id, invalidatingDeps: staleDeps },
                    'dag.node_prior_cache_invalidated'
                  );
                  await recordNodeState(
                    { store: ctx.deps.store, logDir: ctx.logDir },
                    {
                      runId: ctx.workflowRun.id,
                      path: invalidatedStepName,
                      node: describeExecutionNode(node),
                      cache: {
                        action: 'invalidated',
                        invalidatingDeps: staleDeps,
                        prior: {
                          ...persistedExecutionOutput(invalidatedPriorOutput),
                          structured: priorCompletedNodes.get(node.id)?.structuredOutput,
                        },
                      },
                    }
                  );
                  // falls through to re-execute the node with fresh dep output
                } else {
                  getLog().info({ nodeId: node.id }, 'dag.node_skipped_prior_success');
                  const skipStepName = ctx.stepNamePrefix + node.id;
                  // Preserve incomplete recovery as a preview with its original provenance.
                  // Re-spilling that preview would falsely certify it as the full result.
                  const prior = priorCompletedNodes.get(node.id);
                  const truncation = prior?.outputTruncation;
                  const priorSkipOutput = truncation
                    ? {
                        nodeOutput: prior?.output ?? '',
                        truncated: true,
                        ...(truncation.originalBytes !== null
                          ? { originalBytes: truncation.originalBytes }
                          : {}),
                        ...(truncation.spillPath !== null
                          ? { spillPath: truncation.spillPath }
                          : {}),
                      }
                    : formatThisNodesPriorOutput(skipStepName);
                  // Return the pre-populated output (already in nodeOutputs)
                  const cachedOutput = ctx.nodeOutputs.get(node.id);
                  if (cachedOutput === undefined) {
                    throw new Error(`Cached output for node '${node.id}' was not pre-populated`);
                  }
                  if (node.kind === 'workflow' && node.fan_out !== undefined) {
                    const aggregate: unknown =
                      'structuredOutput' in cachedOutput &&
                      cachedOutput.structuredOutput !== undefined
                        ? cachedOutput.structuredOutput
                        : JSON.parse(cachedOutput.output);
                    if (!Array.isArray(aggregate)) {
                      throw new Error(
                        `Cached fan_out node '${node.id}' aggregate is not a JSON array`
                      );
                    }
                    const children = await findFanOutChildRuns(
                      ctx.deps.store,
                      ctx.workflowRun.id,
                      skipStepName
                    );
                    const started = new Set(
                      children
                        .map(child => readSubrunMetadata(child.metadata).childIndex)
                        .filter(
                          (index): index is number =>
                            index !== undefined && index >= 0 && index < aggregate.length
                        )
                    );
                    const refused = aggregate.length - started.size;
                    if (refused > 0) {
                      await safeSendMessage(
                        ctx.platform,
                        ctx.conversationId,
                        `Skipping fan_out node '${node.id}': fan-out previously refused ${String(refused)} of ${String(aggregate.length)} children.`,
                        { workflowId: ctx.workflowRun.id, nodeName: node.id }
                      );
                    }
                  }
                  await recordNodeState(
                    { store: ctx.deps.store, logDir: ctx.logDir },
                    {
                      runId: ctx.workflowRun.id,
                      path: skipStepName,
                      node: describeExecutionNode(node),
                      cache: {
                        action: 'replayed',
                        output: {
                          ...persistedExecutionOutput(priorSkipOutput, prior?.output ?? ''),
                          structured:
                            'structuredOutput' in cachedOutput
                              ? cachedOutput.structuredOutput
                              : undefined,
                          declaredOutputPaths:
                            'declaredOutputPaths' in cachedOutput
                              ? cachedOutput.declaredOutputPaths
                              : undefined,
                        },
                      },
                    }
                  );
                  return {
                    nodeId: node.id,
                    output: cachedOutput,
                  };
                }
              }
            }

            // 1. Enforce every enclosing include boundary before this node's local rule.
            const triggerDecision =
              composedBoundaryDecision.decision === 'skip'
                ? composedBoundaryDecision
                : checkTriggerRule(node, ctx.nodeOutputs);
            if (triggerDecision.decision === 'skip') {
              const { cause } = triggerDecision;
              getLog().info({ nodeId: node.id, reason: 'trigger_rule' }, 'dag_node_skipped');
              const output = await recordNodeState(
                { store: ctx.deps.store, logDir: ctx.logDir },
                finishNodeExecution(
                  beginExecution(ctx, node),
                  { status: 'skipped', reason: 'trigger_rule', cause },
                  { output: { text: '' }, diagnostics: { iteration, expr: node.when } }
                )
              );
              return { nodeId: node.id, output };
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
                resolveRunInputs(ctx.workflowRun),
                { loopPrevOutputs: ctx.loopPrevOutputs }
              );
              if (!conditionParsed) {
                const cause: SkipCause = {
                  kind: 'condition_parse_error',
                  expr: node.when,
                };
                const parseErrMsg = `⚠️ Node '${node.id}': unparseable \`when:\` expression "${node.when}" — node skipped (fail-closed). Check syntax: \`$nodeId.output == 'VALUE'\`, \`$nodeId.output > '5'\`, or compound \`$a.output == 'X' && $b.output != 'Y'\`.`;
                await safeSendMessage(ctx.platform, ctx.conversationId, parseErrMsg, {
                  workflowId: ctx.workflowRun.id,
                  nodeName: node.id,
                });
                getLog().error(
                  { nodeId: node.id, when: node.when },
                  'dag_node_skipped_condition_parse_error'
                );
                const output = await recordNodeState(
                  { store: ctx.deps.store, logDir: ctx.logDir },
                  finishNodeExecution(
                    beginExecution(ctx, node),
                    { status: 'skipped', reason: 'when_condition_parse_error', cause },
                    { output: { text: '' }, diagnostics: { iteration, expr: node.when } }
                  )
                );
                return { nodeId: node.id, output };
              }
              if (!conditionPasses) {
                const cause: SkipCause = { kind: 'condition', expr: node.when };
                getLog().info({ nodeId: node.id, when: node.when }, 'dag_node_skipped_condition');
                const output = await recordNodeState(
                  { store: ctx.deps.store, logDir: ctx.logDir },
                  finishNodeExecution(
                    beginExecution(ctx, node),
                    { status: 'skipped', reason: 'when_condition', cause },
                    { output: { text: '' }, diagnostics: { iteration, expr: node.when } }
                  )
                );
                return { nodeId: node.id, output };
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
                  const excludes = checkoutSnapshotExcludes(
                    ctx.artifactsDir,
                    ctx.stateDir,
                    ctx.logDir
                  );
                  const treeBefore = await snapshotGuardedNode(ctx, node, excludes);
                  const output = await runDeterministicNodeWithRetry(
                    node,
                    ctx.platform,
                    ctx.conversationId,
                    ctx.workflowRun,
                    ctx.deps.store,
                    ctx.stepNamePrefix + node.id,
                    () =>
                      runBudgetedAttempt(ctx, node, async reserve => {
                        await reserve();
                        return executeBashNode(
                          ctx,
                          node,
                          ctx.config.envVars,
                          ctx.config.protectedEnvKeys,
                          ctx.config.protectedCredentialValues,
                          ctx.stepNamePrefix,
                          iteration,
                          ctx.bodyLoopUserInput ?? ''
                        );
                      }),
                    iteration
                  );
                  return {
                    nodeId: node.id,
                    output: await assertCheckoutUntouched(
                      node,
                      ctx.cwd,
                      excludes,
                      treeBefore,
                      output,
                      ctx.deps,
                      ctx.logDir,
                      ctx.guardedLayerSnapshots
                    ),
                  };
                }
                // Script dispatch — runs via bun or uv. Same opt-in retry rule as bash
                // (#2088): retries solely when an explicit `retry:` block is declared.
                const excludes = checkoutSnapshotExcludes(
                  ctx.artifactsDir,
                  ctx.stateDir,
                  ctx.logDir
                );
                const treeBefore = await snapshotGuardedNode(ctx, node, excludes);
                const output = await runDeterministicNodeWithRetry(
                  node,
                  ctx.platform,
                  ctx.conversationId,
                  ctx.workflowRun,
                  ctx.deps.store,
                  ctx.stepNamePrefix + node.id,
                  () =>
                    runBudgetedAttempt(ctx, node, reserve =>
                      executeScriptNode(
                        ctx,
                        node,
                        reserve,
                        ctx.config.envVars,
                        ctx.config.protectedEnvKeys,
                        ctx.config.protectedCredentialValues,
                        ctx.stepNamePrefix,
                        iteration,
                        ctx.bodyLoopUserInput ?? ''
                      )
                    ),
                  iteration
                );
                return {
                  nodeId: node.id,
                  output: await assertCheckoutUntouched(
                    node,
                    ctx.cwd,
                    excludes,
                    treeBefore,
                    output,
                    ctx.deps,
                    ctx.logDir,
                    ctx.guardedLayerSnapshots
                  ),
                };
              }

              case 'loop': {
                // Materialized before provider resolution so AI-configuration text can
                // reference the listing. executeLoopNode materializes its own fresh
                // observation for each iteration's prompt and until_bash.
                typedArtifactsFile = await writeNodeArtifactsListing(
                  ctx.artifactsDir,
                  ctx.workflowRun.id
                );
                // Loop node dispatch — manages its own AI sessions and iteration
                const {
                  provider: loopProvider,
                  options: loopOptions,
                  model: resolvedLoopModel,
                  tier: resolvedLoopTier,
                  effort: resolvedLoopEffort,
                } = await resolveNodeProviderAndModel(
                  providers,
                  node,
                  ctx.workflowProvider,
                  ctx.workflowModel,
                  ctx.config,
                  ctx.platform,
                  ctx.conversationId,
                  ctx.workflowRun.id,
                  ctx.cwd,
                  ctx.workflowLevelOptions,
                  ctx.aiProfile,
                  ctx.workflowPreset,
                  resolveAiConfigText,
                  ctx.warnedProviderConflicts,
                  ctx.execContext
                );

                const output = await executeLoopNode(
                  ctx,
                  node,
                  loopProvider,
                  loopOptions,
                  ctx.stepNamePrefix,
                  resolvedLoopModel,
                  resolvedLoopTier,
                  resolvedLoopEffort,
                  checkpointSessionForProvider(loopProvider)
                );
                // Loop nodes run every iteration on the same resolved provider, so the
                // result session (if any) is attributable to loopProvider — tag it so a
                // downstream sequential node on a different provider starts fresh (#1992).
                return { nodeId: node.id, output, sessionProvider: loopProvider };
              }

              case 'loop_group': {
                // Materialized before provider resolution for the group's AI-configuration
                // text. Body nodes re-enter runLayers and establish their own observation.
                typedArtifactsFile = await writeNodeArtifactsListing(
                  ctx.artifactsDir,
                  ctx.workflowRun.id
                );
                // Loop-group node dispatch — manages its own subgraph iteration
                // (body is a sealed sub-DAG re-executed per iteration; the loop is
                // encapsulated inside this one node, keeping the outer DAG acyclic).
                // Resolve provider and model for the group: both are forwarded to body
                // AI nodes as their defaults. The group itself never calls sendQuery, so
                // the resolved SendQueryOptions are not needed here.
                const groupScope = resolveNodeModelScope(
                  node,
                  {
                    provider: ctx.workflowProvider,
                    model: ctx.workflowModel,
                    preset: ctx.workflowPreset,
                    tier: ctx.workflowLevelOptions.workflowTier,
                    effort: ctx.workflowLevelOptions.effort,
                    providerOrigin: 'workflow',
                  },
                  assistantModelDefaults(ctx.config),
                  ctx.aiProfile
                );
                const {
                  provider: loopGroupProvider,
                  model: loopGroupModel,
                  tier: loopGroupTier,
                  preset: loopGroupPreset,
                } = groupScope.provider === undefined
                  ? groupScope
                  : await resolveNodeProviderAndModel(
                      providers,
                      node,
                      ctx.workflowProvider,
                      ctx.workflowModel,
                      ctx.config,
                      ctx.platform,
                      ctx.conversationId,
                      ctx.workflowRun.id,
                      ctx.cwd,
                      ctx.workflowLevelOptions,
                      ctx.aiProfile,
                      ctx.workflowPreset,
                      resolveAiConfigText,
                      ctx.warnedProviderConflicts,
                      ctx.execContext
                    );

                const output = await executeLoopGroupNode(
                  ctx,
                  node,
                  loopGroupProvider,
                  loopGroupModel,
                  loopGroupTier,
                  loopGroupPreset,
                  ctx.stepNamePrefix
                );
                return { nodeId: node.id, output };
              }

              case 'gate': {
                // Approval node dispatch — pauses workflow for human review
                const output = await executeApprovalNode(ctx, node, ctx.stepNamePrefix, iteration);
                return { nodeId: node.id, output };
              }

              case 'wait': {
                const loopFrame = ctx.loopGroupPath.at(-1);
                const output = await executeWaitNode(
                  ctx,
                  node,
                  loopFrame === undefined
                    ? undefined
                    : {
                        groupId: loopFrame.groupId,
                        iteration: loopFrame.iteration,
                        sessionId: ctx.lastSequentialSession?.sessionId ?? null,
                        sessionProvider: ctx.lastSequentialSession?.provider ?? null,
                        ...(ctx.bodySessionCursors !== undefined
                          ? { bodySessionCursors: Object.fromEntries(ctx.bodySessionCursors) }
                          : {}),
                        ...snapshotBodySessionCursorAncestry(ctx.bodySessionCursorAncestry),
                      }
                );
                return { nodeId: node.id, output };
              }

              case 'halt': {
                const execution = beginExecution(ctx, node);
                await recordNodeState({ store: ctx.deps.store, logDir: ctx.logDir }, execution);
                // Cancel node dispatch — terminates the workflow run
                const reason = substituteNodeOutputRefs(
                  node.reason,
                  ctx.nodeOutputs,
                  ctx.loopBodyScopes
                );
                const cancelMsg = `❌ **Workflow cancelled** (node \`${node.id}\`): ${reason}`;
                await safeSendMessage(ctx.platform, ctx.conversationId, cancelMsg, {
                  workflowId: ctx.workflowRun.id,
                  nodeName: node.id,
                });
                await requireTerminalStatusWrite(
                  ctx.deps.store.cancelWorkflowRun(ctx.workflowRun.id, {
                    step_name: ctx.stepNamePrefix + node.id,
                    reason,
                    cancel_reason: 'halt_node',
                  }),
                  { workflowRunId: ctx.workflowRun.id, site: 'dag.halt_cancel' }
                );
                getWorkflowEventEmitter().emit({
                  type: 'workflow_cancelled',
                  runId: ctx.workflowRun.id,
                  nodeId: node.id,
                  reason,
                });
                // The cancellation transaction owns terminality; no node completion was committed.
                return { nodeId: node.id, output: serializeNodeOutput(execution) };
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

              case 'compose_fan_out': {
                // Composed fan-out dispatch (#2512): per-item in-parent expansion. Like
                // the sub-run wrapper it makes no provider call of its own and writes its
                // own completion/failure events.
                const output = await executeComposeFanOutNode(node, ctx, node.fan_out);
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
            // Agent nodes reach a provider, so AI-configuration text gets this
            // observation; the body prompt is substituted per attempt below.
            typedArtifactsFile = await writeNodeArtifactsListing(
              ctx.artifactsDir,
              ctx.workflowRun.id
            );
            const {
              provider,
              model: resolvedNodeModel,
              options: nodeOptions,
              tier: resolvedTier,
              effort: resolvedEffort,
            } = await resolveNodeProviderAndModel(
              providers,
              node,
              ctx.workflowProvider,
              ctx.workflowModel,
              ctx.config,
              ctx.platform,
              ctx.conversationId,
              ctx.workflowRun.id,
              ctx.cwd,
              ctx.workflowLevelOptions,
              ctx.aiProfile,
              ctx.workflowPreset,
              resolveAiConfigText,
              ctx.warnedProviderConflicts,
              ctx.execContext
            );

            // 5. Determine session. An explicit named ancestor has first priority and
            // is independent of the ambient sequential cursor and parallel-layer reset.
            const namedResumeSourceNodeId = isNodeContextResume(node.context)
              ? node.context.resume
              : undefined;
            const hasNamedSessionResume = namedResumeSourceNodeId !== undefined;
            let resumeSessionId: string | undefined;
            let resumeIntent: SessionResumeIntent = hasNamedSessionResume
              ? 'source-fork'
              : 'ordinary';
            if (hasNamedSessionResume) {
              const sourceNodeId = namedResumeSourceNodeId;
              const ownerCursor = ctx.bodySessionCursors?.get(node.id);
              if (ownerCursor !== undefined) resumeIntent = 'owner-continuation';
              const sourceHandle = ownerCursor ?? ctx.nodeSessionHandles?.get(sourceNodeId);
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
              const caps = requireProvider(ctx.deps.providers, provider).capabilities;
              if (
                !caps.sessionResume ||
                (resumeIntent === 'source-fork' && caps.sessionFork !== true)
              ) {
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
            const usesPersistedScope = nodeUsesPersistedScope(node, ctx.workflowPersistSessions);

            if (usesPersistedScope) {
              const handling = persistedSessionHandling(
                requireProvider(ctx.deps.providers, provider).capabilities
              );
              if (handling === 'unsupported') {
                throw new Error(
                  `Node '${node.id}' has persist_session: true but resolved provider '${provider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`
                );
              }
              const persistScope = ctx.persistScope;
              if (persistScope && !hasNamedSessionResume) {
                try {
                  const persisted = (await persistScope.sessionsAtStart).find(
                    row => row.node_id === node.id && row.provider === provider
                  );
                  if (persisted) {
                    // This event is not a node record, so it carries only the preview.
                    const sessionIdPreview = sessionPreview(persisted.provider_session_id);
                    const continues = handling === 'fork';
                    if (continues) resumeSessionId = persisted.provider_session_id;
                    ctx.deps.store
                      .createWorkflowEvent({
                        workflow_run_id: ctx.workflowRun.id,
                        event_type: continues
                          ? 'node_session_resumed'
                          : 'node_session_not_continued',
                        step_name: ctx.stepNamePrefix + node.id,
                        data: {
                          provider,
                          scope_key: persistScope.key,
                          provider_session_id_preview: sessionIdPreview,
                        },
                      })
                      .catch((err: Error) => {
                        getLog().warn(
                          { err, nodeId: node.id },
                          'persist_session_event_persist_failed'
                        );
                      });
                    if (!continues) {
                      await safeSendMessage(
                        ctx.platform,
                        ctx.conversationId,
                        `⚠️ Node \`${node.id}\`: provider \`${provider}\` cannot fork a session, so this run started fresh instead of continuing the persisted session (concurrent runs never share one provider conversation). To carry context across runs, use a provider with sessionFork or pass state through artifacts.`,
                        { workflowId: ctx.workflowRun.id, nodeName: node.id }
                      );
                    }
                  }
                } catch (err) {
                  // Non-fatal: the node still runs (fresh, no resume), but the user opted
                  // into persistence — a DB error here silently breaks continuity, so warn
                  // them as well as the logs. (A "no row" result is not an error: it finds
                  // nothing above and this catch never fires for it.)
                  getLog().warn(
                    {
                      err: err as Error,
                      nodeId: node.id,
                      workflow: ctx.workflowName,
                      scopeKey: persistScope.key,
                      provider,
                    },
                    'persist_session_lookup_failed'
                  );
                  await safeSendMessage(
                    ctx.platform,
                    ctx.conversationId,
                    `⚠️ Could not load the persisted session for node \`${node.id}\` — it will run without prior context. Session continuity may be broken; if this recurs, check server logs or run \`${spellWorkflowCommand(ctx.platform, `reset-sessions ${ctx.workflowName}`)}\`.`,
                    { workflowId: ctx.workflowRun.id, nodeName: node.id }
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
            const checkoutExcludes = checkoutSnapshotExcludes(
              ctx.artifactsDir,
              ctx.stateDir,
              ctx.logDir
            );
            const treeBefore = await snapshotGuardedNode(ctx, node, checkoutExcludes);
            const retriedOutput = await runNodeRetryLoop(
              node,
              ctx.platform,
              ctx.conversationId,
              ctx.workflowRun,
              ctx.deps.store,
              ctx.stepNamePrefix + node.id,
              getEffectiveNodeRetryConfig(node),
              () =>
                runBudgetedAttempt(ctx, node, async reserve => {
                  // Fresh per attempt: an attempt after a transient failure observes
                  // artifacts published in the interval, and never reuses the
                  // listing handed to AI-configuration substitution above.
                  const attemptTypedArtifactsFile = await writeNodeArtifactsListing(
                    ctx.artifactsDir,
                    ctx.workflowRun.id
                  );
                  return executeNodeInternal(
                    ctx,
                    node,
                    reserve,
                    provider,
                    nodeOptions,
                    resumeSessionId,
                    resolvedNodeModel,
                    resolvedTier,
                    resolvedEffort,
                    ctx.stepNamePrefix,
                    iteration,
                    checkpointSessionForProvider(provider),
                    attemptTypedArtifactsFile,
                    resumeIntent
                  );
                }),
              { state: 'failed', output: '', error: 'Node did not execute' },
              iteration
            );
            const output = await assertCheckoutUntouched(
              node,
              ctx.cwd,
              checkoutExcludes,
              treeBefore,
              retriedOutput,
              ctx.deps,
              ctx.logDir,
              ctx.guardedLayerSnapshots
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
              const recoveryPointer = ctx.scopeArtifactsDir
                ? await buildColdResumeRecoveryPointer(
                    ctx.scopeArtifactsDir,
                    ctx.workflowRun.id,
                    node.id
                  )
                : '';
              getLog().warn(
                {
                  nodeId: node.id,
                  provider,
                  workflowRunId: ctx.workflowRun.id,
                  resumeSessionIdPreview: sessionPreview(resumeSessionId),
                  priorArtifactsFound: recoveryPointer !== '',
                },
                'dag.session_resume_failed'
              );
              await safeSendMessage(
                ctx.platform,
                ctx.conversationId,
                `⚠️ Node \`${node.id}\`: could not resume the prior session — continued with a fresh session, so the earlier context was not restored.${recoveryPointer}`,
                { workflowId: ctx.workflowRun.id, nodeName: node.id }
              );
            }

            // Advance the scope's cursor to this node's session for the next run. Concurrent
            // runs each write their own session, so the cursor ends at the newest finished
            // one. A completion without a session ID leaves the row alone: deleting it could
            // erase a newer session a sibling run just wrote. A provider that cannot fork
            // still writes its row: the next run never continues it, but reads it to record
            // which session it did not continue.
            // context:'fresh' nodes are excluded (the author opted out of any cross-run memory).
            const persistScope = ctx.persistScope;
            if (
              usesPersistedScope &&
              persistScope &&
              output.state === 'completed' &&
              output.sessionId !== undefined
            ) {
              try {
                await ctx.deps.store.upsertWorkflowNodeSession({
                  workflow_name: ctx.workflowName,
                  node_id: node.id,
                  scope_key: persistScope.key,
                  provider,
                  provider_session_id: output.sessionId,
                  last_run_id: ctx.workflowRun.id,
                });
              } catch (err) {
                // Non-fatal: persistence failure does not undo a successful node execution.
                // But the user opted into persistence — the next run will not continue this
                // session, so warn them as well as the logs.
                getLog().warn(
                  {
                    err: err as Error,
                    nodeId: node.id,
                    workflow: ctx.workflowName,
                    scopeKey: persistScope.key,
                    provider,
                  },
                  'persist_session_upsert_failed'
                );
                await safeSendMessage(
                  ctx.platform,
                  ctx.conversationId,
                  `⚠️ Could not persist the session for node \`${node.id}\` (${provider}). The next run will not continue from it.`,
                  { workflowId: ctx.workflowRun.id, nodeName: node.id }
                );
              }
            }

            return { nodeId: node.id, output, sessionProvider: provider };
          } catch (error) {
            // This dispatch boundary also owns provider/binding preparation failures.
            // Durable-write rejection and a budget refusal must reach run recovery
            // without becoming a node outcome: a refused node never started.
            if (
              error instanceof TerminalStatusWriteError ||
              error instanceof NodeEventWriteError ||
              error instanceof RunBudgetRefusedError
            )
              throw error;

            const err = error as Error;
            getLog().error({ err, nodeId: node.id }, 'dag_node_pre_execution_failed');
            // Before the node's execution began, this is a preparation fault (provider,
            // binding, session source). After it, the executor itself threw something
            // it did not classify, such as a store read failing between iterations.
            const failureKind = ctx.currentExecution === undefined ? 'config' : 'unknown';
            const failed = await recordNodeState(
              { store: ctx.deps.store, logDir: ctx.logDir },
              finishNodeExecution(
                ctx.currentExecution ?? beginExecution(ctx, node),
                { status: 'failed', error: err.message, failureKind },
                {
                  output: { text: '' },
                  diagnostics: isNodeContextResume(node.context)
                    ? { sessionSourceNodeId: node.context.resume }
                    : undefined,
                }
              )
            );
            // The attempt is recorded so it does not read as running; the run itself is
            // released once the layer settles.
            if (error instanceof RunSourceUnreadableError) throw error;
            await safeSendMessage(
              ctx.platform,
              ctx.conversationId,
              `Node '${node.id}' failed before execution: ${err.message}`,
              { workflowId: ctx.workflowRun.id, nodeName: node.id }
            );
            return {
              nodeId: node.id,
              output: failed,
            };
          }
        }
    );
    // A layer mixing guarded and unguarded nodes runs sequentially (see the thunk
    // comment above); every other layer keeps the concurrent `allSettled` path.
    const layerResults = serializeLayer
      ? await settleSequentially(nodeThunks)
      : await Promise.allSettled(nodeThunks.map(thunk => thunk()));

    // Process layer results — store all outputs, track failures
    const nodeById = new Map(layer.map(n => [n.id, n]));
    let layerHadFailure = false;
    for (const result of layerResults) {
      if (result.status === 'fulfilled') {
        const { nodeId, output, sessionProvider } = result.value;
        // SINGLE aggregation point for this segment's run-level usage: the run
        // row's persisted totals and the transcript. Per-node cost/tokens must be
        // summed here and ONLY here. Terminal telemetry does not read this: it
        // folds the persisted node events (getDagResumeSnapshot) across segments.
        if (output.costUsd !== undefined) {
          // Same guard as tokens below, and for the same reason: cost comes from
          // providers (incl. community ones), and one NaN poisons the run total for
          // every other node — NaN > 0 is false, so the cost is dropped from the run
          // row with no trace. Exactly the silent loss #2469 exists to
          // remove. Guarded here, at the single aggregation point, so one bad node
          // costs only its own contribution.
          if (Number.isFinite(output.costUsd)) {
            ctx.totalCostUsd = (ctx.totalCostUsd ?? 0) + output.costUsd;
          } else {
            getLog().warn({ nodeId, costUsd: output.costUsd }, 'dag.usage_cost_non_finite_ignored');
          }
        }
        ctx.totalTokensUnknown ||= output.tokensUnknown === true;
        if (ctx.totalTokensUnknown) {
          ctx.totalTokens = undefined;
        } else if (output.tokens !== undefined) {
          ctx.totalTokens = sumTokenUsage(
            [...(ctx.totalTokens !== undefined ? [ctx.totalTokens] : []), output.tokens],
            { nodeId }
          );
        }
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
        const ownerNode = nodeById.get(nodeId);
        if (
          ownerNode &&
          isNodeContextResume(ownerNode.context) &&
          output.state === 'completed' &&
          output.sessionId !== undefined &&
          sessionProvider !== undefined
        ) {
          ctx.bodySessionCursors?.set(nodeId, {
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
            runId: ctx.workflowRun.id,
            producedAt: new Date().toISOString(),
            ...(ctx.loopGroupPath.length > 0 ? { loopGroupPath: ctx.loopGroupPath } : {}),
          };
          try {
            await writeNodeArtifact(ctx.artifactsDir, meta, output.output);
          } catch (err) {
            getLog().warn(
              { err: err as Error, nodeId, workflowRunId: ctx.workflowRun.id },
              'artifacts.write_failed'
            );
          }
          // Scope mirror (#1846): persistence-participating nodes also write their
          // typed sidecar into the stable `scopes/<workflow>/<scope>/` dir, so the
          // NEXT invocation can recover this output by reference if its persisted
          // session comes back cold. Per-node files; concurrent same-scope runs are
          // last-writer-wins for a given node. Best-effort, like the run-dir write.
          if (
            ctx.scopeArtifactsDir &&
            nodeUsesPersistedScope(completedNode, ctx.workflowPersistSessions)
          ) {
            try {
              await writeNodeArtifact(ctx.scopeArtifactsDir, meta, output.output);
            } catch (err) {
              getLog().warn(
                {
                  err: err as Error,
                  nodeId,
                  workflowRunId: ctx.workflowRun.id,
                  scopeArtifactsDir: ctx.scopeArtifactsDir,
                },
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
      }
    }
    settledValuesOrThrow(layerResults, ctx.workflowRun.id);

    if (layerHadFailure) {
      getLog().warn({ layerIdx, nodeCount: layer.length }, 'dag_layer_had_failures');
    }

    await ctx.afterLayer?.();

    // Check for non-running status between DAG layers (cancellation, deletion, pause)
    try {
      const dagStatus = await ctx.deps.store.getWorkflowRunStatus(ctx.workflowRun.id);
      if (dagStatus === null || dagStatus !== 'running') {
        const effectiveStatus = dagStatus ?? 'deleted';
        if (
          effectiveStatus === 'paused' &&
          ctx.claimedWorkPausePolicy === 'finish_through_parent_pause'
        ) {
          getLog().debug(
            { workflowRunId: ctx.workflowRun.id, layerIdx, totalLayers: ctx.layers.length },
            'dag.claimed_work_continues_through_parent_pause'
          );
          continue;
        }
        getLog().info(
          {
            workflowRunId: ctx.workflowRun.id,
            layerIdx,
            totalLayers: ctx.layers.length,
            status: effectiveStatus,
          },
          'dag.stop_detected_between_layers'
        );
        // Paused is intentional (approval gate) — the approval message was already sent
        if (effectiveStatus !== 'paused') {
          await safeSendMessage(
            ctx.platform,
            ctx.conversationId,
            `⚠️ **Workflow stopped** (${effectiveStatus}): DAG execution stopped after layer ${String(layerIdx + 1)}/${String(ctx.layers.length)}`,
            { workflowId: ctx.workflowRun.id }
          );
        }
        break;
      }
    } catch (statusErr) {
      // Non-fatal — status check failure should not crash the workflow
      getLog().warn(
        { err: statusErr as Error, workflowRunId: ctx.workflowRun.id },
        'dag.status_check_failed'
      );
    }
  }
}

/**
 * Walk every node (including loop_group bodies) that can invoke a provider.
 * Execution and coordination nodes are skipped (no direct provider call). An approval
 * node counts only when it has an `on_reject` reprompt (the one AI turn it can
 * spawn). For each visited node the resolved provider is passed to `visit`.
 * Unknown providers are passed through — the caller decides how to handle them.
 */
export function visitProviderInvokingNodes(
  nodes: readonly (DagNode | IncludeDirective)[],
  workflowProvider: string | undefined,
  aiProfile: ResolvedAiProfile | undefined,
  visit: (node: DagNode, provider: string) => void
): void {
  const resolve = (node: DagNode): string =>
    resolveNodeModel(
      node,
      {
        provider: workflowProvider,
        providerOrigin: 'workflow',
        model: undefined,
        preset: undefined,
        tier: undefined,
        effort: undefined,
      },
      {},
      aiProfile
    ).provider;
  for (const node of nodes) {
    if (
      isIncludeDirective(node) ||
      isExecNode(node) ||
      isHaltNode(node) ||
      isWaitNode(node) ||
      node.kind === 'workflow' ||
      node.kind === 'compose_fan_out'
    )
      continue;
    if (isLoopGroupNode(node)) {
      const groupProvider = resolveNodeModelScope(
        node,
        {
          provider: workflowProvider,
          providerOrigin: 'workflow',
          model: undefined,
          preset: undefined,
          tier: undefined,
          effort: undefined,
        },
        {},
        aiProfile
      ).provider;
      if (groupProvider !== undefined) visit(node, groupProvider);
      visitProviderInvokingNodes(node.loop_group.nodes, groupProvider, aiProfile, visit);
      continue;
    }
    if (isGateNode(node)) {
      const rework = node.decisions.find(d => d.rework !== undefined)?.rework;
      if (rework) {
        visit(node, resolve(gateReworkNode(node, rework.prompt)));
      }
      continue;
    }
    // agent / loop → AI node
    visit(node, resolve(node));
  }
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
  providers: ProviderRegistry,
  nodes: readonly DagNode[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): Set<string> {
  const incompatible = new Set<string>();
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (_node, provider) => {
    const descriptor = providers.get(provider);
    if (descriptor && !descriptor.capabilities.containerExec) incompatible.add(provider);
  });
  return incompatible;
}

/**
 * Node fields that name a capability for the node to load. Each is also the key of
 * the provider capability that honours it. Running the node without what it named
 * would produce output from a setup its author did not intend, so a mismatch fails
 * the run instead of warning like the other capability axes. An `mcp:` declared
 * `optional: true` names no requirement; `resolveNodeMcp` records its absence.
 */
const SCOPED_CAPABILITIES = ['mcp', 'skills', 'plugins'] as const;
type ScopedCapability = (typeof SCOPED_CAPABILITIES)[number];

function namesScopedCapability(node: DagNode, capability: ScopedCapability): boolean {
  switch (capability) {
    case 'mcp':
      return 'mcp' in node && mcpDeclaration(node.mcp)?.optional === false;
    // `skills: []` and `plugins: []` name nothing, so they need no capability.
    case 'skills':
      return 'skills' in node && (node.skills?.length ?? 0) > 0;
    case 'plugins':
      return 'plugins' in node && (node.plugins?.length ?? 0) > 0;
  }
}

function unsupportedScopedCapabilities(
  node: DagNode,
  caps: ProviderCapabilities
): ScopedCapability[] {
  return SCOPED_CAPABILITIES.filter(cap => namesScopedCapability(node, cap) && !caps[cap]);
}

/** A node that names capabilities its resolved provider cannot honour. */
export interface ScopedCapabilityMismatch {
  nodeId: string;
  provider: string;
  capabilities: ScopedCapability[];
}

/**
 * Collect AI nodes that name `mcp:`, `skills:` or `plugins:` while their resolved
 * provider declares that capability `false`. Unknown providers are skipped here;
 * they fail later with a clearer "unknown provider" error.
 */
export function collectScopedCapabilityMismatches(
  providers: ProviderRegistry,
  nodes: readonly DagNode[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): ScopedCapabilityMismatch[] {
  const mismatches: ScopedCapabilityMismatch[] = [];
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (node, provider) => {
    const descriptor = providers.get(provider);
    if (!descriptor) return;
    const capabilities = unsupportedScopedCapabilities(node, descriptor.capabilities);
    if (capabilities.length > 0) mismatches.push({ nodeId: node.id, provider, capabilities });
  });
  return mismatches;
}

function scopedCapabilityMismatchMessage(mismatches: readonly ScopedCapabilityMismatch[]): string {
  const list = mismatches
    .map(m => `Node '${m.nodeId}' (provider '${m.provider}') names ${m.capabilities.join(', ')}`)
    .join('; ');
  return (
    `${list}, but ${mismatches.length === 1 ? 'that provider cannot' : 'those providers cannot'} ` +
    'load what the node names. Remove the field from the node or use a provider whose ' +
    'capability is true (see the provider capability matrix).'
  );
}

/**
 * A single `output_format` issue on a provider that enforces OpenAI strict mode
 * (Codex). Reported by {@link collectStrictSchemaViolations} before any node runs.
 */
export type StrictSchemaViolation = StrictSchemaIssue & {
  /** The resolved provider that enforces the rule */
  provider: string;
  /** The node whose output_format violates the rule */
  nodeId: string;
};

/**
 * Collect output_format schema violations for providers that enforce the OpenAI
 * strict-mode object-schema rules (`requiresAllPropertiesRequired`). Walks every
 * provider-invoking node (including loop_group bodies) and reports every object
 * schema node that omits properties or does not list every property in required.
 *
 * A node pinned to a non-enforcing provider (e.g. `provider: claude`) is skipped
 * even when the workflow-level provider would enforce — that's the intended
 * opt-out: the workflow owner chose a provider that accepts optional-by-omission.
 */
export function collectStrictSchemaViolations(
  providers: ProviderRegistry,
  nodes: readonly (DagNode | IncludeDirective)[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): StrictSchemaViolation[] {
  const violations: StrictSchemaViolation[] = [];
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (node, provider) => {
    if (!providers.get(provider)?.capabilities.requiresAllPropertiesRequired) return;
    // Only nodes whose output_format is enforced by the engine — gate/loop_group
    // schemas are inert even when present, so their issues cost nothing.
    if (!isOutputFormatEnforced(node)) return;
    if (node.output_format === undefined) return;
    for (const issue of findStrictSchemaIssues(node.output_format, 'output_format')) {
      violations.push({ provider, nodeId: node.id, ...issue });
    }
  });
  return violations;
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
      data: { ...(containerId ? { containerId } : {}), ...data },
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

/**
 * DB `workflow_events.event_type` values written best-effort beside the lifecycle signal.
 * `writeback_requested` is not one: it commits with the write-back pause.
 */
type ContainerLifecycleDbEvent =
  | 'container_created'
  | 'container_stopped'
  | 'container_resumed'
  | 'container_destroyed'
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
  // Matches control characters on purpose, to neutralize them.
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
  // node emits, so the existing pause UI shows approve/reject). The `writeback_requested`
  // row commits with the pause, so the pause reaches the event feed; only the live
  // container-lifecycle signal follows it.
  const paused = await pauseGateRespectingExternalTransition(
    deps,
    runId,
    { nodeId: WRITEBACK_GATE_NODE_ID, message, type: 'writeback' },
    {
      event: {
        workflow_run_id: runId,
        event_type: 'writeback_requested',
        step_name: 'container',
        data: { total_count: summary?.totalCount ?? 0 },
      },
      extraMetadata: {
        pending_writeback: { envId: containerCtx.envId, ...(summary ? { summary } : {}) },
      },
      failClosed: true,
    }
  );
  getWorkflowEventEmitter().emit({
    type: 'container_lifecycle',
    runId,
    phase: 'writeback_requested',
  });
  await suspendContainerForPause(deps, platform, conversationId, containerCtx, execContext, runId);
  // failClosed makes a lost pause throw above, so this guards the type, not a reachable state.
  if (paused === undefined) throw new Error(`Write-back gate for run ${runId} did not pause`);
  await sendPauseNotice(
    deps,
    platform,
    conversationId,
    runId,
    WRITEBACK_GATE_NODE_ID,
    gateOccurrence(paused),
    'container',
    message
  );
}

/** Inputs accepted by {@link executeDagWorkflow}. */
export interface ExecuteDagWorkflowOptions extends RunInputs {
  workflow: ResolvedWorkflow;
  priorCompletedNodes?: Map<string, PersistedNodeOutput>;
  /**
   * Stable cross-invocation artifact scope dir (`scopes/<workflow>/<scope>/`),
   * resolved by executor.ts when the workflow uses session persistence (#1846).
   * Undefined otherwise — no mirroring, no cold-resume pointer.
   */
  scopeArtifactsDir?: string;
  /**
   * Execution context for this run (host by default; the container backend
   * threads a container context in Phase B). Threaded onto every node's
   * `RunLayersContext` so provider turns and subprocesses exec in the right place.
   */
  execContext?: ExecutionContext;
  /**
   * Container run context (Phase C): the write-back backend port + env id + policy.
   * Present only for container runs. Drives suspend-on-pause and the engine-level
   * write-back gate that runs after the last node before the run completes.
   */
  containerCtx?: ContainerRunContext;
  /** Cumulative usage restored on resume, from prior completion AND failure events. */
  priorUsage?: PriorRunUsage;
  /** Private run-scoped handles restored before a cold resume transitions to running. */
  priorNodeSessions?: readonly WorkflowRunNodeSession[];
  /**
   * Roots this run's commands and scripts are read from. Undefined here means the caller
   * has no capture (an in-process caller with a hand-built definition); the boundary below
   * normalizes it to live roots ONCE so nothing downstream has to.
   */
  workflowSourceRoots?: WorkflowSourceRoots;
}

/**
 * Decide what happens to a completed run's worktree. The check is optional cleanup, so a
 * failure leaves the disposition unset and never blocks the completion write.
 */
async function assessCompletedWorktree(
  deps: WorkflowDeps,
  workflowRun: WorkflowRun
): Promise<{ completedRun: WorkflowRun; worktreeDisposition?: WorktreeDisposition | null }> {
  if (!deps.completedRunWorktree) return { completedRun: workflowRun };
  try {
    // Read fresh: a pre-created run's `owned_worktree` proof is stamped on the row after
    // this object was loaded.
    const completedRun = (await deps.store.getWorkflowRun(workflowRun.id)) ?? workflowRun;
    return {
      completedRun,
      worktreeDisposition: await deps.completedRunWorktree.assess(completedRun),
    };
  } catch (err) {
    getLog().warn(
      { err, workflowRunId: workflowRun.id },
      'workflow.completed_worktree_assess_failed'
    );
    return { completedRun: workflowRun };
  }
}

/**
 * Execute a complete DAG workflow.
 * Called from executeWorkflow() in executor.ts.
 */
export async function executeDagWorkflow(
  options: ExecuteDagWorkflowOptions
): Promise<string | undefined | { kind: 'source_release'; released: boolean }> {
  const {
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun,
    workflowProvider,
    workflowModel,
    artifactsDir,
    stateDir,
    logDir,
    baseBranch,
    docsDir,
    config,
    configuredCommandFolder,
    issueContext,
    priorCompletedNodes,
    aiProfile,
    workflowPreset,
    scopeArtifactsDir,
    execContext = { kind: 'host' },
    containerCtx,
    runChildWorkflow,
    priorUsage,
    priorNodeSessions,
    workflowSourceRoots,
  } = options;
  const providers = deps.providers;
  const dagStartTime = Date.now();

  // Scoped-capability fail-fast: before ANY node runs, so no node spends in a run
  // that would later reach a node whose MCP servers, skills or plugins cannot load.
  const capabilityMismatches = collectScopedCapabilityMismatches(
    providers,
    workflow.nodes,
    workflowProvider,
    aiProfile
  );
  if (capabilityMismatches.length > 0) {
    throw new Error(scopedCapabilityMismatchMessage(capabilityMismatches));
  }

  // Container capability fail-fast: before ANY node runs (and before any
  // container work), reject a container run whose AI nodes resolve to a provider
  // that can't spawn in-container. No silent downgrade to the host — the user
  // asked for isolation and must get it or a clear error.
  if (execContext.kind === 'container') {
    const incompatible = collectContainerIncompatibleProviders(
      providers,
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
    // H4 — native overlay mode grants CAP_SYS_ADMIN, so an adversarial in-container
    // agent can remount the read-only lower read-write and bypass the write-back
    // gate. Warn LOUDLY at run start (console/platform + the lifecycle event) so the
    // operator knows the isolation is accident-protection, not a hostile-agent
    // sandbox, in this mode. Warning-only in v1 (see SECURITY.md).
    const nativeOverlay = containerCtx?.overlayMode === 'native';
    emitContainerLifecycleEvent(
      deps,
      workflowRun.id,
      isResume ? 'resumed' : 'created',
      isResume ? 'container_resumed' : 'container_created',
      execContext.containerId,
      nativeOverlay ? { overlayMode: 'native', gateBypassable: true } : {}
    );

    if (nativeOverlay) {
      await safeSendMessage(
        platform,
        conversationId,
        '⚠️ Container is running in NATIVE overlay mode (CAP_SYS_ADMIN). An adversarial ' +
          'agent could bypass the write-back review by remounting the project root — treat ' +
          'this run as accident-protection, not a sandbox against hostile code. (See SECURITY.md.)',
        { workflowId: workflowRun.id }
      );
      getLog().warn({ workflowRunId: workflowRun.id }, 'dag.container_native_mode_gate_bypassable');
    }
  }

  // Strict-schema preflight: before ANY node runs, reject a workflow whose AI
  // nodes would send a schema that a strict provider will reject at the first
  // turn (OpenAI/Codex requires explicit object properties and complete required
  // coverage). Container scoping is irrelevant — this fires on host too, and it
  // protects the setup costs a first-turn 400 would otherwise burn.
  {
    const violations = collectStrictSchemaViolations(
      providers,
      workflow.nodes,
      workflowProvider,
      aiProfile
    );
    if (violations.length > 0) {
      const [first] = violations;
      const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : '';
      const location =
        `output_format schema strict-mode violation: workflow '${workflow.name}', ` +
        `node '${first.nodeId}', ${first.schemaPath}`;
      if (first.kind === 'missing-properties') {
        throw new Error(
          `${location} is an object schema without 'properties'${more}. ` +
            `Provider '${first.provider}' (OpenAI strict mode) rejects it. ` +
            'Declare the object properties and list every property in required; ' +
            'use a nullable object (e.g. type: ["object","null"]) when the value may be absent.'
        );
      }
      throw new Error(
        `${location} declares ${first.missing.join(', ')} not in 'required'${more}. ` +
          `Provider '${first.provider}' (OpenAI strict mode) rejects it. ` +
          'List every property in required; express optionality in-type ' +
          '(e.g. a ["string","null"] union or an enum sentinel).'
      );
    }
  }

  const workflowTier = workflow.model && isTierName(workflow.model) ? workflow.model : undefined;
  const workflowLevelOptions = {
    effort: workflow.effort,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
    webSearchMode: workflow.webSearchMode,
    workflowTier,
  };
  const layers = workflow.plan.layers;
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
      // A local producer's loaded definition owns its contract, so its strict
      // `$node.output.<path>` contract survives resume (#2091) and matches the load-time
      // check, even when the row was written by an older binary that recorded only
      // top-level fields. The persisted contract serves producers whose definition states
      // none: a `workflow:` node's is the CHILD's (#2453), and a wait node's is fixed by
      // the engine. A loop_group gets none: its output_format is ignored, but its
      // persisted terminal payload (below) still rehydrates, matching fresh completion
      // since #2637.
      const declaredOutputPaths =
        (node !== undefined ? definedOutputPaths(node) : undefined) ?? prior.declaredOutputPaths;
      nodeOutputs.set(nodeId, {
        state: 'completed',
        output: prior.output,
        // The persisted logical value (#2637): downstream whole-value and `.field`
        // consumers observe exactly what fresh execution exposed. Absent for rows
        // persisted before the key existed — those keep the text-parse fallback.
        ...(prior.structuredOutput !== undefined
          ? { structuredOutput: prior.structuredOutput }
          : {}),
        ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
        ...(prior.execution !== undefined ? { execution: prior.execution } : {}),
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

  // Per-node session persistence across workflow re-runs, keyed by the thread that
  // launched the run (see `persistScopeKey`). The `|| undefined` guard keeps an empty
  // key from scoping every invocation to the same blank scope — persistence is simply
  // skipped in that case.
  const runPersistScopeKey: string | undefined = persistScopeKey(workflowRun) || undefined;
  const workflowPersistSessions = workflow.persist_sessions === true;
  let persistScope: PersistScope | undefined;
  if (runPersistScopeKey !== undefined && runMayPersistSessions(workflow)) {
    const sessionsAtStart = deps.store.listWorkflowNodeSessions({
      workflow_name: workflow.name,
      scope_key: runPersistScopeKey,
    });
    // A persisted node that never dispatches (skipped by `when:`, or after a failure)
    // never awaits this; a failed read must not become an unhandled rejection there.
    // Nodes that await it still see the rejection.
    sessionsAtStart.catch(() => undefined);
    persistScope = { key: runPersistScopeKey, sessionsAtStart };
  }
  const namedResumeSourceIds = new Set<string>();
  const collectNamedSources = (nodes: readonly DagNode[]): void => {
    for (const node of nodes) {
      if (isNodeContextResume(node.context)) namedResumeSourceIds.add(node.context.resume);
      if (isLoopGroupNode(node)) collectNamedSources(resolvedBodyNodes(node.loop_group));
    }
  };
  collectNamedSources(workflow.nodes);
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

    const resolution = resolveNodeOutputField(
      selectedOutput,
      returns,
      field,
      outputRefText(returns, field)
    );
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
  // step_names are the raw node ids (identical to pre-refactor behavior). Fields stay
  // explicit because spreading options would also copy executor-only state into this
  // context without an excess-property check.
  // A budget always seeds from the run's own rows, never from `priorUsage`: a re-driven
  // run can arrive without prior usage, and a reset ledger would replay spent work.
  const resumeSnapshot =
    priorCompletedNodes !== undefined || workflow.budget !== undefined
      ? await deps.store.getDagResumeSnapshot(workflowRun.id)
      : undefined;
  const unfinishedInvocations =
    priorCompletedNodes === undefined ? undefined : resumeSnapshot?.unfinishedInvocations;
  const runBudget =
    workflow.budget !== undefined && resumeSnapshot !== undefined
      ? createRunBudgetLedger(workflow.budget, resumeSnapshot.budget)
      : undefined;
  const runCtx: RunLayersContext = {
    toolAttention: createRunToolCallAttention({ store: deps.store, runId: workflowRun.id }),
    unfinishedInvocations,
    runBudget,
    deps,
    platform,
    conversationId,
    cwd,
    execContext,
    runChildWorkflow,
    workflowRun,
    workflowName: workflow.name,
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
    persistScope,
    workflowPersistSessions,
    // Scope-keyed persistence surface: without a scope key there is no durable
    // scope to mirror into or recover from, so the dir is dropped alongside it.
    scopeArtifactsDir: persistScope !== undefined ? scopeArtifactsDir : undefined,
    layers,
    nodeOutputs,
    afterLayer: persistAuthoredOutcome,
    priorCompletedNodes,
    nodeSessionHandles,
    namedResumeSourceIds,
    lastSequentialSession: undefined,
    warnedProviderConflicts: new Set<string>(),
    totalCostUsd: priorUsage?.costUsd,
    totalTokens: priorUsage?.tokens,
    totalTokensUnknown: priorUsage?.tokensUnknown,
    stepNamePrefix: '',
    loopGroupPath: [],
    loopBodyScopes: [],
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
      ...(runCtx.totalCostUsd !== undefined ? { total_cost_usd: runCtx.totalCostUsd } : {}),
      ...(runCtx.totalTokensUnknown
        ? {
            total_tokens_unknown: true,
            total_tokens_in: null,
            total_tokens_out: null,
            total_cache_read_tokens: null,
            total_cache_write_tokens: null,
            total_cache_partial: null,
          }
        : {}),
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

  /**
   * The wait a failed pass takes instead of failing, when every failed node either hit a
   * provider usage limit whose reset the provider reported and that is still ahead, or hit a
   * rate limit that outlasted its retries (deadline: its reported reset when still ahead,
   * else a jittered backoff). The run cannot progress before the last of those deadlines, so
   * it waits for it. Any other failure, a usage limit without a reported reset,
   * `autoResumeOnQuotaReset: false`, or a container run (the continuation host does not
   * continue one) leaves the run to fail. Only the typed class says a limit is hit; the
   * error text never does.
   */
  const usageLimitWait = async (): Promise<
    { wait: WorkflowUsageLimitWaitContext; cause: ProviderLimitFailure['class'] } | undefined
  > => {
    const skip = async (
      nodeId: string,
      reason: 'reset_unavailable' | 'disabled' | 'reset_passed' | 'container_unsupported'
    ): Promise<undefined> => {
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'quota_resume_skipped',
        step_name: nodeId,
        data: { reason },
      });
      return undefined;
    };
    const now = Date.now();
    let latest:
      | { nodeId: string; resumeAt: number; cause: ProviderLimitFailure['class'] }
      | undefined;
    for (const [nodeId, output] of runCtx.nodeOutputs) {
      if (output.state !== 'failed') continue;
      const failure = output.providerFailure;
      if (!isProviderLimit(failure)) return undefined;
      const resumeAt = providerLimitResumeAt(failure, now);
      if (resumeAt === undefined) return skip(nodeId, 'reset_unavailable');
      if (latest === undefined || resumeAt > latest.resumeAt)
        latest = { nodeId, resumeAt, cause: failure.class };
    }
    if (latest === undefined) return undefined;
    if (config.workflows?.autoResumeOnQuotaReset === false) return skip(latest.nodeId, 'disabled');
    if (latest.resumeAt <= now) return skip(latest.nodeId, 'reset_passed');
    if (execContext.kind === 'container') return skip(latest.nodeId, 'container_unsupported');
    return {
      wait: {
        owner: 'node',
        nodeId: latest.nodeId,
        kind: 'quota',
        pauseId: randomUUID(),
        waitingSince: new Date(now).toISOString(),
        resumeAt: new Date(latest.resumeAt).toISOString(),
      },
      cause: latest.cause,
    };
  };

  /** Pause the run on a provider-limit wait. False when the pass must fail instead. */
  const pauseForUsageLimit = async (): Promise<boolean> => {
    const limit = await usageLimitWait();
    if (limit === undefined) return false;
    const { wait, cause } = limit;
    try {
      await deps.store.pauseWorkflowRunForWait(workflowRun.id, wait, {
        kind: 'started',
        stepName: wait.nodeId,
      });
    } catch (pauseError) {
      // A run cancelled or paused meanwhile keeps that status, exactly as the failure
      // branches below leave it.
      if ((await deps.store.getWorkflowRunStatus(workflowRun.id)) === 'running') throw pauseError;
      getLog().warn({ workflowRunId: workflowRun.id }, 'dag.usage_limit_wait_status_changed');
      return true;
    }
    getLog().info(
      { workflowRunId: workflowRun.id, nodeId: wait.nodeId, resumeAt: wait.resumeAt, cause },
      'dag.usage_limit_wait_started'
    );
    await safeSendMessage(
      platform,
      conversationId,
      cause === 'rate_limited'
        ? `⏸️ Workflow '${workflow.name}' hit a provider rate limit at node '${wait.nodeId}' ` +
            `and ran out of retries. It tries again at ${wait.resumeAt}; resume it to try ` +
            'sooner, or abandon it to stop it.'
        : `⏸️ Workflow '${workflow.name}' hit a provider usage limit at node '${wait.nodeId}'. ` +
            `It waits until the limit resets at ${wait.resumeAt}, then continues.`,
      { workflowId: workflowRun.id }
    );
    return true;
  };

  /**
   * The engine's terminal failure write. The live `workflow_failed` event is published only
   * when this call committed the failure: a run another writer already finished (a
   * cancellation during the failure notification, or a competing failure) keeps that
   * writer's outcome and announcement. A rejected write throws the typed marker, which the
   * outer executor catch rethrows without emitting.
   */
  const failRun = async (failMsg: string, exitReason: RunExitReason, site: string) => {
    const emitter = getWorkflowEventEmitter();
    try {
      const { failed } = await requireTerminalStatusWrite(
        deps.store.failWorkflowRun(workflowRun.id, failMsg, { exitReason }),
        { workflowRunId: workflowRun.id, site }
      );
      if (failed) {
        emitter.emit({
          type: 'workflow_failed',
          runId: workflowRun.id,
          workflowName: workflow.name,
          error: failMsg,
        });
      }
    } finally {
      emitter.unregisterRun(workflowRun.id);
    }
  };

  /**
   * Fail the run on a budget refusal. Returns normally, like the other engine refusals,
   * so the outer executor catch does not emit a second failure. A run paused or cancelled
   * meanwhile keeps its status; its next pass rebuilds the ledger and refuses again.
   */
  const failRunForBudget = async (
    ledger: RunBudgetLedger,
    refusal: RunBudgetRefusal
  ): Promise<void> => {
    if (await skipIfStatusChanged('dag.run_budget_refusal_status_changed')) return;
    const failMsg = describeRunBudgetRefusal(refusal, workflow.name);
    getLog().error({ workflowRunId: workflowRun.id, refusal }, 'dag.run_budget_refused');
    await deps.store.createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: RUN_BUDGET_REFUSED_EVENT_TYPE,
      step_name: refusal.path,
      data: runBudgetRefusalEventData(refusal, ledger.limits, ledger.usage),
    });
    await logWorkflowError(logDir, workflowRun.id, failMsg, {
      ...(runCtx.totalCostUsd !== undefined ? { cost_usd: runCtx.totalCostUsd } : {}),
      ...(runCtx.totalTokens !== undefined ? { tokens: runCtx.totalTokens } : {}),
    }).catch((logErr: Error) => {
      getLog().error(
        { err: logErr, workflowRunId: workflowRun.id },
        'dag.workflow_error_log_write_failed'
      );
    });
    await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(failMsg, 'budget_refused', 'dag.run_budget_refused_fail');
  };

  const startRefusal = runBudget && runBudgetStartRefusal(runBudget);
  if (runBudget !== undefined && startRefusal !== undefined) {
    await failRunForBudget(runBudget, startRefusal);
    return;
  }

  /**
   * Pause the run instead of failing it: this host could not read its source (#4209).
   * The release compares status and execution claim, so an operator's abandon or a
   * sibling gate that already moved the row wins. It runs after the layer settled, so
   * nothing of this run still executes here when another host may claim it.
   */
  const releaseRunForUnreadableSource = async (
    error: RunSourceUnreadableError
  ): Promise<boolean> => {
    getLog().warn(
      { workflowRunId: workflowRun.id, nodeId: error.nodeId, path: error.path, err: error.cause },
      'dag.run_released_source_unreadable'
    );
    const { released } = await deps.store.releaseRunForUnreadableSource(workflowRun.id, {
      claimId: executionClaim(workflowRun.metadata),
      nodeId: error.nodeId,
      ...(error.path !== undefined ? { path: error.path } : {}),
      error: error.message,
      retryAt: new Date(Date.now() + CONTINUATION_RETRY_MS).toISOString(),
    });
    if (!released) {
      getLog().info({ workflowRunId: workflowRun.id }, 'dag.source_release_skipped_status_changed');
      return false;
    }
    await safeSendMessage(
      platform,
      conversationId,
      sourceReleaseNotice(platform, workflowRun.id, {
        path: error.path,
        nodeId: error.nodeId,
        container: execContext.kind === 'container',
      }),
      { workflowId: workflowRun.id, nodeName: error.nodeId }
    );
    return true;
  };

  await persistAuthoredOutcome();
  let sourceUnreadable: RunSourceUnreadableError | undefined;
  try {
    await runLayers(runCtx);
  } catch (error) {
    // runLayers guards almost everything, but a failed durable write (terminal status or
    // node event) escapes through its layer join. Persist both durable facts before rethrowing that
    // exact value (including an exotic `throw undefined`). Usage is best-effort. An
    // outcome write failure is secondary here: record it, but never let it mask the
    // execution error already in flight. A run-budget refusal also escapes the join; it
    // fails the run here instead of propagating. An unreadable source escapes it too; the
    // run is released below after persisting the settled usage and outcome.
    if (error instanceof RunBudgetRefusedError || error instanceof RunSourceUnreadableError) {
      // The thunk that threw never reported its spend, nor did its settled siblings, so
      // the in-memory totals miss it. The durable rows hold all of it.
      try {
        const durable = await deps.store.getDagResumeSnapshot(workflowRun.id);
        // The fold sums to 0 when nothing reported cost; keep a run with no AI usage absent.
        if (runCtx.totalCostUsd !== undefined || durable.costUsd !== 0) {
          runCtx.totalCostUsd = durable.costUsd;
        }
        runCtx.totalTokens = durable.tokens;
        runCtx.totalTokensUnknown = durable.tokensUnknown;
      } catch (readError) {
        getLog().error(
          { err: readError as Error, workflowRunId: workflowRun.id },
          'dag.unwind_usage_refresh_failed'
        );
      }
    }
    if (error instanceof RunSourceUnreadableError) {
      sourceUnreadable = error;
    } else {
      await persistRunUsage();
      try {
        await persistAuthoredOutcome();
      } catch (outcomeError) {
        getLog().error(
          { err: outcomeError as Error, workflowRunId: workflowRun.id },
          'dag.authored_outcome_persist_failed_during_unwind'
        );
      }
      if (error instanceof RunBudgetRefusedError && runBudget !== undefined) {
        await failRunForBudget(runBudget, error.refusal);
        return;
      }
      throw error;
    }
  } finally {
    await runCtx.toolAttention.refresh();
  }

  // Normal return has no primary error to preserve, so a verdict persistence failure
  // remains visible to the caller. These two small calls intentionally mirror the
  // unwind path above; extracting a policy flag would hide which error owns the throw.
  await persistRunUsage();
  await persistAuthoredOutcome();
  const sourceReleased =
    sourceUnreadable !== undefined && (await releaseRunForUnreadableSource(sourceUnreadable));
  // Pull the mutated accumulators back into local scope for the terminal tally below.
  const totalCostUsd = runCtx.totalCostUsd;
  const totalTokens = runCtx.totalTokens;

  // Container pause economics (Phase C): if a node paused the run (approval /
  // interactive gate), suspend the container so a multi-day wait costs ~0 RAM/CPU.
  // The pause happens BETWEEN layers, after node completion — the #2134 background-
  // task wait gate has already drained and no `docker exec` is in flight (docker
  // stop would kill any live exec) — so it is safe to stop here. Resume rediscovers
  // and restarts. Terminal (failed / cancelled) runs are left for teardown, not
  // suspended. Only 'paused' triggers this.
  if (execContext.kind === 'container' && containerCtx) {
    try {
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
        return sourceUnreadable !== undefined
          ? { kind: 'source_release', released: sourceReleased }
          : undefined;
      }
    } catch (error) {
      if (sourceUnreadable === undefined) throw error;
      getLog().error(
        { err: error, workflowRunId: workflowRun.id },
        'dag.source_release_container_cleanup_failed'
      );
    }
  }

  if (sourceUnreadable !== undefined) return { kind: 'source_release', released: sourceReleased };

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
  const runTranscriptUsage: WorkflowUsage = {
    ...(totalCostUsd !== undefined ? { cost_usd: totalCostUsd } : {}),
    ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
  };

  getLog().info(
    { nodeCount: workflow.nodes.length, anyCompleted, anyFailed },
    'dag_workflow_finished'
  );

  if (!anyCompleted) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    if (anyFailed && (await pauseForUsageLimit())) return;
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
    // Note: nodeCounts not stored for failed runs — failWorkflowRun only stores { error }.
    // Frontend guards with isValidNodeCounts so missing node_counts is safe. (Usage IS
    // stored: persistRunUsage wrote it at the run tail, before this branch — #2469.)
    await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
      (logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      }
    );
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(
      failMsg,
      // A first-node failure completes nothing, but it is still a node failure.
      anyFailed ? 'node_error' : 'no_nodes_completed',
      'dag.no_nodes_completed_fail'
    );
    return;
  }

  if (anyFailed) {
    if (await skipIfStatusChanged('dag.skip_fail_status_changed')) return;
    if (await pauseForUsageLimit()) return;
    const failedNodes = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
      .join('; ');
    const failMsg = `DAG workflow '${workflow.name}' completed with failures: ${failedNodes}`;
    await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
      (logErr: Error) => {
        getLog().error(
          { err: logErr, workflowRunId: workflowRun.id },
          'dag.workflow_error_log_write_failed'
        );
      }
    );
    await safeSendMessage(platform, conversationId, `\u274c ${failMsg}`, {
      workflowId: workflowRun.id,
    });
    await failRun(failMsg, 'node_error', 'dag.node_failure_fail');
    return;
  }

  // Check if status was changed externally (e.g. cancelled) before marking complete.
  if (await skipIfStatusChanged('dag.skip_complete_status_changed')) return;

  // Evidence gate (#2230): thin terminal file-presence gate, a sibling of the
  // approval/write-back gates (run-status transitions are engine governance).
  // When the workflow declares `evidence_policy.required: true`, refuse to flip
  // the run to `completed` unless `$ARTIFACTS_DIR/evidence.json` exists — the
  // engine checks presence only (no schema validation, no content checks, no
  // git/gh I/O). Any contents satisfy this convention; deterministic checks
  // and authored outcomes remain separate. Placed BEFORE
  // the container write-back gate so a run that cannot complete never pauses
  // for (or applies) write-back — mirroring how node-failure runs skip that
  // gate entirely. Resume-safe: the run id (and therefore artifactsDir) is
  // stable across resume, so a failed run resumed after evidence.json is
  // produced re-enters here with all nodes prior-completed and completes.
  if (workflow.evidence_policy?.required === true) {
    const evidencePath = joinPath(artifactsDir, 'evidence.json');
    if (!existsSync(evidencePath)) {
      const failMsg =
        `DAG workflow '${workflow.name}' failed the evidence marker gate: ` +
        `evidence_policy.required is true but its conventional marker file is absent at ${evidencePath}. ` +
        'The policy checks only that path; create the marker in the host artifacts directory, ' +
        'then resume the run.';
      getLog().error({ workflowRunId: workflowRun.id, evidencePath }, 'dag.evidence_gate_failed');
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
      // Persist the reason into the workflow-events log (contract: never throws).
      await deps.store.createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'evidence_validation_failed',
        data: { policy: 'evidence_policy.required', expected_path: evidencePath },
      });
      await logWorkflowError(logDir, workflowRun.id, failMsg, runTranscriptUsage).catch(
        (logErr: Error) => {
          getLog().error(
            { err: logErr, workflowRunId: workflowRun.id },
            'dag.workflow_error_log_write_failed'
          );
        }
      );
      await safeSendMessage(platform, conversationId, `❌ ${failMsg}`, {
        workflowId: workflowRun.id,
      });
      // The metadata merge above precedes the terminal write, so
      // `metadata.evidence_validation` is present the moment the run reads as failed.
      await failRun(failMsg, 'evidence_missing', 'dag.evidence_gate_fail');
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
  // The selected node's declared field paths (#2453) — the callee-owned half of the
  // result contract. Stamped beside `summary_value` so the parent's `workflow:` node can
  // authorize `$<node>.output.a.b` from the CHILD's schema instead of requiring the
  // caller to repeat it. Only the projection travels; the schema stays in captured source.
  let terminalDeclaredOutputPaths: DeclaredOutputPaths | undefined;
  if (workflow.returns !== undefined && workflowRun.parent_run_id) {
    const returnsOutput = nodeOutputs.get(workflow.returns);
    const value = returnsOutput?.state === 'completed' ? returnsOutput.output : undefined;
    if (value !== undefined && value.trim().length > 0) {
      terminalOutput = value;
      terminalStructuredOutput =
        returnsOutput !== undefined && 'structuredOutput' in returnsOutput
          ? returnsOutput.structuredOutput
          : undefined;
      // Taken from the completed node rather than re-derived from the definition: the
      // node already resolved its own contract (a wait node's fixed schema, a resumed
      // node's persisted projection), and re-deriving here would silently disagree.
      terminalDeclaredOutputPaths =
        returnsOutput?.state === 'completed' ? returnsOutput.declaredOutputPaths : undefined;
    } else {
      getLog().warn(
        { workflowRunId: workflowRun.id, returns: workflow.returns },
        'workflow.returns_node_blank_output'
      );
      terminalOutput = '';
    }
  } else {
    const terminalSink = workflow.plan.sinks
      .map(nodeId => nodeOutputs.get(nodeId))
      .find(o => o?.state === 'completed' && o.output.trim().length > 0);
    terminalOutput = terminalSink?.output;
    // The sink scan's node owns its contract exactly as a `returns:` node does. Stamping
    // it here too keeps the two channels together: a child without `returns:` has threaded
    // its terminal LOGICAL value to the parent since #2637, and a value whose field
    // authorization stayed behind would read as schemaless downstream.
    terminalDeclaredOutputPaths =
      terminalSink?.state === 'completed' ? terminalSink.declaredOutputPaths : undefined;
    terminalStructuredOutput =
      terminalSink !== undefined && 'structuredOutput' in terminalSink
        ? terminalSink.structuredOutput
        : undefined;
  }

  const duration = Date.now() - dagStartTime;

  // Emit completion, then record it. The transcript and the live event do not depend
  // on the status write and used to run whether or not it succeeded, so the
  // (now-throwing) write goes last. Terminal telemetry is reported by the run store
  // after the write commits.
  await logWorkflowComplete(logDir, workflowRun.id, runTranscriptUsage);
  const emitter = getWorkflowEventEmitter();
  emitter.emit({
    type: 'workflow_completed',
    runId: workflowRun.id,
    workflowName: workflow.name,
    duration,
  });
  emitter.unregisterRun(workflowRun.id);

  const { completedRun, worktreeDisposition } = await assessCompletedWorktree(deps, workflowRun);

  await requireTerminalStatusWrite(
    deps.store.completeWorkflowRun(
      workflowRun.id,
      { duration_ms: duration },
      {
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
        // The callee-owned field contract (#2453). Gated on the same terminal output as
        // the two keys above, so a blank/incomplete `returns:` node stamps no contract
        // at all rather than one nothing satisfies. `summary_declared_fields` is derived
        // from the paths and still written for older binaries, which read only it.
        ...(workflowRun.parent_run_id && terminalOutput && terminalDeclaredOutputPaths !== undefined
          ? {
              [SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths]: terminalDeclaredOutputPaths,
              [SUBRUN_METADATA_KEYS.summaryDeclaredFields]: rootOutputFields(
                terminalDeclaredOutputPaths
              ),
            }
          : {}),
        ...(worktreeDisposition
          ? { [WORKTREE_DISPOSITION_METADATA_KEY]: worktreeDisposition }
          : {}),
      }
    ),
    { workflowRunId: workflowRun.id, site: 'dag_db_complete_failed' }
  );

  // The terminal record already carries the decision. Removing the checkout is cleanup
  // of terminal data, so a refusal or failure leaves it in place and the run completed.
  if (worktreeDisposition?.disposition === 'release') {
    try {
      await deps.completedRunWorktree?.release(completedRun);
      getLog().info({ workflowRunId: workflowRun.id }, 'workflow.completed_worktree_released');
    } catch (err) {
      getLog().warn(
        { err, workflowRunId: workflowRun.id },
        'workflow.completed_worktree_release_failed'
      );
    }
  }

  // terminalOutput (computed above, before the completion write) is the run's
  // summary for the parent conversation and the `workflow:` re-entry path.
  return terminalOutput;
}
