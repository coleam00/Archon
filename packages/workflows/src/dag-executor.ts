/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'path';
import { execFileAsync } from '@archon/git';
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
} from '@archon/providers/types';
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
  ScriptNode,
  NodeOutput,
  TriggerRule,
  WorkflowRun,
  EffortLevel,
  ThinkingConfig,
  SandboxSettings,
  WorkflowSource,
} from './schemas';
import {
  isBashNode,
  isLoopNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isApprovalContext,
} from './schemas';
import { formatToolCall } from './utils/tool-formatter';
import { createLogger, captureWorkflowCompleted } from '@archon/paths';
import { getWorkflowEventEmitter } from './event-emitter';
import { evaluateCondition } from './condition-evaluator';
import { declaredFieldsFromSchema, resolveNodeOutputField } from './output-ref';
import { writeNodeArtifact } from './artifacts-index';
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
  resolveModelSpec,
  routePresetEffort,
  type ModelAliasPreset,
  type ResolvedAiProfile,
} from './model-validation';

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
}

/** Internal node execution result — extends NodeOutput with cost data for aggregation. */
type NodeExecutionResult = NodeOutput & { costUsd?: number };

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
  workflowPreset?: ModelAliasPreset
): Promise<{
  provider: string;
  model: string | undefined;
  options: SendQueryOptions | undefined;
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

  return { provider, model, options };
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
  issueContext?: string
): Promise<NodeExecutionResult> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  const configuredMcpNames = await loadConfiguredMcpServerNames(node.mcp, cwd);

  getLog().info({ nodeId: node.id, provider }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, node.command ?? '<inline>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { command: node.command ?? null, provider },
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
          step_name: node.id,
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
              step_name: node.id,
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
            step_name: node.id,
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
              step_name: node.id,
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
        break; // Result is the "I'm done" signal — don't wait for subprocess to exit
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
      }
      // rate_limit chunks: already log.warn'd in claude.ts; not surfaced to SSE per design
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
          step_name: node.id,
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
          step_name: node.id,
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
          step_name: node.id,
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
        step_name: node.id,
        data: {
          duration_ms: duration,
          node_output: nodeOutputText,
          ...(nodeCostUsd !== undefined ? { cost_usd: nodeCostUsd } : {}),
          ...(nodeStopReason ? { stop_reason: nodeStopReason } : {}),
          ...(nodeNumTurns !== undefined ? { num_turns: nodeNumTurns } : {}),
          ...(nodeModelUsage ? { model_usage: nodeModelUsage } : {}),
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
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(declaredFields !== undefined ? { declaredFields } : {}),
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
      };
    }

    getLog().error({ err, nodeId: node.id }, 'dag_node_failed');
    await logNodeError(logDir, workflowRun.id, node.id, err.message);

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'node_failed',
        step_name: node.id,
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

    return { state: 'failed', output: '', error: err.message, costUsd: nodeCostUsd };
  }
}

/** Default timeout for subprocess nodes (bash, script): 2 minutes */
const SUBPROCESS_DEFAULT_TIMEOUT = 120_000;

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
  envVars?: Record<string, string>
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  getLog().info({ nodeId: node.id, type: 'bash' }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<bash>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { type: 'bash' },
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
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...process.env,
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
    ...(envVars ?? {}),
  };

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', finalScript], {
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
        step_name: node.id,
        data: { duration_ms: duration, type: 'bash', node_output: output },
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
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `${label} failed: bash executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
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
        step_name: node.id,
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
  envVars?: Record<string, string>
): Promise<NodeOutput> {
  const nodeStartTime = Date.now();
  const nodeContext: SendMessageContext = { workflowId: workflowRun.id, nodeName: node.id };

  getLog().info({ nodeId: node.id, type: 'script', runtime: node.runtime }, 'dag_node_started');
  await logNodeStart(logDir, workflowRun.id, node.id, '<script>');

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'node_started',
      step_name: node.id,
      data: { type: 'script', runtime: node.runtime },
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

  // Variable substitution on script field
  const { prompt: substitutedScript } = substituteWorkflowVariables(
    node.script,
    workflowRun.id,
    workflowRun.user_message,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, false);

  const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;
  const subprocessEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACTS_DIR: artifactsDir,
    LOG_DIR: logDir,
    BASE_BRANCH: baseBranch,
    ...(envVars ?? {}),
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
            step_name: node.id,
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
            step_name: node.id,
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

    const { stdout, stderr } = await execFileAsync(cmd, args, {
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
        step_name: node.id,
        data: { duration_ms: duration, type: 'script', node_output: output },
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
        step_name: node.id,
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
  issueContext?: string
): Promise<NodeExecutionResult> {
  const loop = node.loop;
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };

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
    return { state: 'failed', output: '', error: errorMsg };
  }

  // Detect interactive loop resume — check if workflowRun.metadata has loop gate state for this node
  const rawApproval = workflowRun.metadata?.approval;
  const loopGateMeta = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const isLoopResume = loopGateMeta?.type === 'interactive_loop' && loopGateMeta.nodeId === node.id;
  const startIteration = isLoopResume ? (loopGateMeta.iteration ?? 0) + 1 : 1;
  let currentSessionId: string | undefined = isLoopResume ? loopGateMeta.sessionId : undefined;
  const loopUserInput = isLoopResume
    ? ((workflowRun.metadata?.loop_user_input as string | undefined) ?? '')
    : '';

  let lastIterationOutput = '';
  let lastIterationStructuredOutput: unknown;
  let loopTotalCostUsd: number | undefined;
  let loopFinalStopReason: string | undefined;
  let loopTotalNumTurns: number | undefined;
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
      return { state: 'failed', output: '', error: `Workflow ${effectiveStatus}` };
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
        step_name: node.id,
        data: { iteration: i, maxIterations: loop.max_iterations, nodeId: node.id },
      })
      .catch((err: Error) => {
        logEventStoreError(err, i);
      });

    // Session threading. Force a fresh session on the first iteration of an
    // interactive loop resume: the stored session id from the gate metadata
    // may be stale after a human review wait — passing it to the SDK can
    // trigger errors (e.g. error_during_execution on Claude SDK).
    // User feedback is carried via $LOOP_USER_INPUT, so session continuity is
    // not required for the first resumed iteration.
    const needsFreshSession =
      loop.fresh_context || i === 1 || (isLoopResume && i === startIteration);
    const resumeSessionId = needsFreshSession ? undefined : currentSessionId;

    // Stream AI response for this iteration
    let fullOutput = ''; // raw, for signal detection
    let cleanOutput = ''; // stripped, for platform display
    let iterationIdleTimedOut = false;
    const iterationAbortController = new AbortController();

    try {
      // Build prompt — substituteWorkflowVariables throws if $BASE_BRANCH referenced but empty
      // Pass loopUserInput on the first resumed iteration; '' on all others (non-interactive
      // or subsequent iterations) so $LOOP_USER_INPUT substitutes to empty string explicitly.
      // $LOOP_PREV_OUTPUT carries the previous iteration's cleaned output and is empty on
      // the first iteration (no prior output exists). Across an interactive resume, the
      // executor starts a fresh `lastIterationOutput` variable, so the first iteration of
      // the resume also receives an empty $LOOP_PREV_OUTPUT.
      const { prompt: substitutedPrompt } = substituteWorkflowVariables(
        loop.prompt,
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
                step_name: node.id,
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
          if (msg.cost !== undefined) {
            loopTotalCostUsd = (loopTotalCostUsd ?? 0) + msg.cost;
          }
          if (msg.stopReason !== undefined) loopFinalStopReason = msg.stopReason;
          if (msg.numTurns !== undefined) {
            loopTotalNumTurns = (loopTotalNumTurns ?? 0) + msg.numTurns;
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
          break; // Result is the "I'm done" signal — don't wait for subprocess to exit
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
                step_name: node.id,
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
              step_name: node.id,
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
    } catch (error) {
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
          step_name: node.id,
          data: { iteration: i, error: err.message, duration, nodeId: node.id },
        })
        .catch((evtErr: Error) => {
          logEventStoreError(evtErr, i);
        });
      return {
        state: 'failed',
        output: '',
        error: `Loop iteration ${i} failed: ${err.message}`,
        costUsd: loopTotalCostUsd,
      };
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
          step_name: node.id,
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
      return {
        state: 'failed',
        output: '',
        error: `Loop iteration ${i} failed: ${emptyError}`,
        costUsd: loopTotalCostUsd,
      };
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
        await execFileAsync('bash', ['-c', substitutedBash], {
          cwd,
          timeout: SUBPROCESS_DEFAULT_TIMEOUT,
          env: {
            ...process.env,
            USER_MESSAGE: workflowRun.user_message,
            ARGUMENTS: workflowRun.user_message,
            LOOP_USER_INPUT: i === startIteration ? (loopUserInput ?? '') : '',
            LOOP_PREV_OUTPUT: prevIterationOutput,
            REJECTION_REASON: '',
            CONTEXT: issueContext ?? '',
            EXTERNAL_CONTEXT: issueContext ?? '',
            ISSUE_CONTEXT: issueContext ?? '',
            // Managed per-project env vars + per-user GitHub token overrides
            // (incl. the unconnected-user scrub) must win last, exactly as
            // executeBashNode/executeScriptNode do — otherwise until_bash would
            // inherit the server's ambient GH token and bypass the scrub.
            ...(config.envVars ?? {}),
          },
        });
        bashComplete = true; // exit 0 = complete
      } catch (e) {
        const bashErr = e as NodeJS.ErrnoException;
        // ENOENT or other system errors are unexpected — log them
        if (bashErr.code === 'ENOENT') {
          getLog().warn(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_node.until_bash_exec_error'
          );
        } else if (bashErr.code !== undefined) {
          // Log non-ENOENT system errors (syntax errors, permission issues, etc.)
          getLog().warn(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_node.until_bash_unexpected_error'
          );
        }
        bashComplete = false; // non-zero exit = not complete
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
        step_name: node.id,
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
    // fresh interactive loop, the user hasn't seen anything yet — always gate first.
    // For non-interactive loops: the AI signals task completion at any point.
    const interactiveFirstRun = loop.interactive && !isLoopResume;
    if (completionDetected && !interactiveFirstRun) {
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
          step_name: node.id,
          data: {
            duration_ms: Date.now() - iterationStart,
            node_output: lastIterationOutput,
            ...(loopTotalCostUsd !== undefined ? { cost_usd: loopTotalCostUsd } : {}),
            ...(loopFinalStopReason ? { stop_reason: loopFinalStopReason } : {}),
            ...(loopTotalNumTurns !== undefined ? { num_turns: loopTotalNumTurns } : {}),
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
        ...(lastIterationStructuredOutput !== undefined
          ? { structuredOutput: lastIterationStructuredOutput }
          : {}),
      };
    }

    // Interactive loop gate — pause after every iteration where the AI did NOT emit the
    // completion signal. The user reviews the AI's output and provides feedback or approval.
    // On approval, the AI will emit the signal in the next iteration, exiting above.
    if (loop.interactive && loop.gate_message) {
      const gateMsg =
        `\u23f8 **Input required** (loop \`${node.id}\`, iteration ${String(i)}): ${loop.gate_message}\n\n` +
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
        return {
          state: 'failed',
          output: lastIterationOutput,
          error: `Loop gate message failed to deliver for node '${node.id}' — cannot pause safely`,
        };
      }
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'approval_requested',
          step_name: node.id,
          data: { message: loop.gate_message, iteration: i },
        })
        .catch((err: Error) => {
          logEventStoreError(err, i);
        });
      await deps.store.pauseWorkflowRun(workflowRun.id, {
        nodeId: node.id,
        message: loop.gate_message,
        type: 'interactive_loop',
        iteration: i,
        sessionId: currentSessionId,
      });
      getWorkflowEventEmitter().emit({
        type: 'approval_pending',
        runId: workflowRun.id,
        nodeId: node.id,
        message: loop.gate_message,
      });
      // Return completed — the between-layer status check sees 'paused' and halts cleanly.
      // This mirrors the approval-node pattern, preventing false "DAG nodes failed" warnings
      // in multi-node workflows. Resume correctness relies on the 'paused' DB status, not
      // on the node's output state.
      return { state: 'completed', output: lastIterationOutput, costUsd: loopTotalCostUsd };
    }
  }

  // Max iterations exceeded
  const errorMsg = `Loop node '${node.id}' exceeded max iterations (${String(loop.max_iterations)}) without completion signal '${loop.until}'`;
  getLog().warn(
    { nodeId: node.id, maxIterations: loop.max_iterations, signal: loop.until },
    'loop_node.max_iterations_reached'
  );
  await safeSendMessage(platform, conversationId, errorMsg, msgContext);
  return {
    state: 'failed',
    output: lastIterationOutput,
    error: errorMsg,
    costUsd: loopTotalCostUsd,
  };
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
  workflowPreset?: ModelAliasPreset
): Promise<NodeOutput> {
  const msgContext = { workflowId: workflowRun.id, nodeName: node.id };

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
          step_name: node.id,
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

    const { provider, options: nodeOptions } = await resolveNodeProviderAndModel(
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
      workflowPreset
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
      issueContext
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
      step_name: node.id,
      data: { message: renderedMessage },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'approval_requested' },
        'workflow.event_persist_failed'
      );
    });

  await deps.store.pauseWorkflowRun(workflowRun.id, {
    message: renderedMessage,
    nodeId: node.id,
    type: 'approval',
    captureResponse: node.approval.capture_response,
    onRejectPrompt: node.approval.on_reject?.prompt,
    onRejectMaxAttempts: node.approval.on_reject?.max_attempts,
  });

  getWorkflowEventEmitter().emit({
    type: 'approval_pending',
    runId: workflowRun.id,
    nodeId: node.id,
    message: renderedMessage,
  });

  // Return completed — the between-layer status check will see 'paused' and break.
  // On resume, the approve endpoint writes a real node_completed event with the user's response.
  return { state: 'completed' as const, output: '' };
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
  workflowPreset?: ModelAliasPreset
): Promise<string | undefined> {
  const dagStartTime = Date.now();
  const workflowLevelOptions = {
    effort: workflow.effort,
    thinking: workflow.thinking,
    fallbackModel: workflow.fallbackModel,
    betas: workflow.betas,
    sandbox: workflow.sandbox,
  };
  const layers = buildTopologicalLayers(workflow.nodes);
  const nodeOutputs = new Map<string, NodeOutput>();

  // Pre-populate nodeOutputs from prior run so already-completed nodes are
  // treated as done for trigger-rule and $nodeId.output substitution purposes.
  // Nodes flagged `always_run: true` are excluded — they re-execute on resume
  // and downstream consumers must see the fresh output, not the cached one.
  if (priorCompletedNodes && priorCompletedNodes.size > 0) {
    const alwaysRunIds = new Set(workflow.nodes.filter(n => n.always_run).map(n => n.id));
    let prepopulatedCount = 0;
    for (const [nodeId, output] of priorCompletedNodes) {
      if (alwaysRunIds.has(nodeId)) continue;
      nodeOutputs.set(nodeId, { state: 'completed', output });
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

  // Session threading: for sequential single-node layers, thread the session forward.
  // For parallel layers (>1 node), always fresh (can't share a session).
  let lastSequentialSessionId: string | undefined;
  // Note: accumulates cost for this invocation only. If this is a resume, nodes skipped
  // from the prior run are not included — total_cost_usd will reflect resumed-portion cost only.
  let totalCostUsd = 0;

  // Per-node session persistence across workflow re-runs. Scope = the DB conversation
  // UUID. The `?? undefined` guard keeps an empty/missing conversation_id from keying
  // every invocation to the same blank scope — persistence is simply skipped in that case.
  // Distinct from AgentRequestOptions.persistSession (Claude SDK on-disk transcript flag).
  const persistScopeKey: string | undefined = workflowRun.conversation_id ?? undefined;
  const workflowPersistSessions = workflow.persist_sessions === true;

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const isParallelLayer = layer.length > 1;

    if (isParallelLayer) {
      lastSequentialSessionId = undefined; // reset — parallel nodes can't share sessions
    }

    // Execute all nodes in the layer concurrently
    const layerResults = await Promise.allSettled(
      layer.map(async (node): Promise<{ nodeId: string; output: NodeExecutionResult }> => {
        try {
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
                  step_name: node.id,
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
                  step_name: node.id,
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
                output: nodeOutputs.get(node.id) ?? { state: 'skipped' as const, output: '' },
              };
            }
          }

          // 1. Evaluate trigger rule
          const triggerDecision = checkTriggerRule(node, nodeOutputs);
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
                step_name: node.id,
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
              nodeOutputs
            );
            if (!conditionParsed) {
              const parseErrMsg = `\u26a0\ufe0f Node '${node.id}': unparseable \`when:\` expression "${node.when}" \u2014 node skipped (fail-closed). Check syntax: \`$nodeId.output == 'VALUE'\`, \`$nodeId.output > '5'\`, or compound \`$a.output == 'X' && $b.output != 'Y'\`.`;
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
                  step_name: node.id,
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
                  step_name: node.id,
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

          // 3. Bash node dispatch — no AI, no session
          if (isBashNode(node)) {
            const output = await executeBashNode(
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
              nodeOutputs,
              issueContext,
              config.envVars
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
                workflowPreset
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
              nodeOutputs,
              config,
              issueContext
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
              nodeOutputs,
              config,
              workflowLevelOptions,
              configuredCommandFolder,
              issueContext,
              aiProfile,
              workflowPreset
            );
            return { nodeId: node.id, output };
          }

          // 3d. Cancel node dispatch — terminates the workflow run
          if (isCancelNode(node)) {
            const reason = substituteNodeOutputRefs(node.cancel, nodeOutputs);
            const cancelMsg = `\u274c **Workflow cancelled** (node \`${node.id}\`): ${reason}`;
            await safeSendMessage(platform, conversationId, cancelMsg, {
              workflowId: workflowRun.id,
              nodeName: node.id,
            });
            deps.store
              .createWorkflowEvent({
                workflow_run_id: workflowRun.id,
                event_type: 'workflow_cancelled',
                step_name: node.id,
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

          // 3e. Script node dispatch — runs via bun or uv
          if (isScriptNode(node)) {
            const output = await executeScriptNode(
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
              nodeOutputs,
              issueContext,
              config.envVars
            );
            return { nodeId: node.id, output };
          }

          // 4. Resolve per-node provider/model/options
          const { provider, options: nodeOptions } = await resolveNodeProviderAndModel(
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
            workflowPreset
          );

          // 5. Determine session — parallel or context:fresh → always fresh
          // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
          // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
          // isFreshSequential controls in-run threading (lastSequentialSessionId).
          // bypassesPersistence (context:'fresh' only) also disables cross-run persist_session;
          // a parallel-layer node CAN still use persist_session — it just doesn't share with siblings.
          const isFreshSequential = isParallelLayer || node.context === 'fresh';
          const bypassesPersistence = node.context === 'fresh';
          let resumeSessionId: string | undefined = isFreshSequential
            ? undefined
            : lastSequentialSessionId;

          const nodePersistFlag = 'persist_session' in node ? node.persist_session : undefined;
          // Strictly opt-in: off unless the node sets persist_session, or the workflow
          // sets persist_sessions and the node doesn't override it to false.
          const effectivePersist: boolean = nodePersistFlag ?? workflowPersistSessions;

          if (effectivePersist && !bypassesPersistence) {
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
                  workflow_name: workflow.name,
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
                      step_name: node.id,
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
                    workflow: workflow.name,
                    scopeKey: persistScopeKey,
                    provider,
                  },
                  'persist_session_lookup_failed'
                );
                await safeSendMessage(
                  platform,
                  conversationId,
                  `⚠️ Could not load the persisted session for node \`${node.id}\` — it will run without prior context. Session continuity may be broken; if this recurs, check server logs or run \`/workflow reset-sessions ${workflow.name}\`.`,
                  { workflowId: workflowRun.id, nodeName: node.id }
                );
              }
            }
          }

          // 6. Execute with retry for transient failures
          const retryConfig = getEffectiveNodeRetryConfig(node);
          let output: NodeExecutionResult = {
            state: 'failed',
            output: '',
            error: 'Node did not execute',
          };

          for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
            output = await executeNodeInternal(
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
              nodeOutputs,
              // Always pass the prior session ID — forkSession:true in executeNodeInternal
              // ensures the source is never mutated, so retries can safely resume from it.
              resumeSessionId,
              configuredCommandFolder,
              issueContext
            );

            if (output.state !== 'failed') break;

            // Check if retryable.
            // FATAL errors (auth, permissions, credit balance) are never retried even when on_error:all.
            const isFatal = output.error
              ? classifyError(new Error(output.error)) === 'FATAL'
              : false;
            const isTransient = output.error ? isTransientNodeError(output.error) : false;
            const shouldRetry =
              !isFatal &&
              (retryConfig.onError === 'all' ||
                (retryConfig.onError === 'transient' && isTransient));

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

          // Persist (or drop) the node's provider session ID for the next run in this scope.
          // context:'fresh' nodes are excluded (the author opted out of any cross-run memory).
          if (
            effectivePersist &&
            !bypassesPersistence &&
            persistScopeKey &&
            output.state === 'completed'
          ) {
            try {
              if (output.sessionId !== undefined) {
                await deps.store.upsertWorkflowNodeSession({
                  workflow_name: workflow.name,
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
                  workflow_name: workflow.name,
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
                  workflow: workflow.name,
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

          return { nodeId: node.id, output };
        } catch (error) {
          const err = error as Error;
          getLog().error({ err, nodeId: node.id }, 'dag_node_pre_execution_failed');
          deps.store
            .createWorkflowEvent({
              workflow_run_id: workflowRun.id,
              event_type: 'node_failed',
              step_name: node.id,
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
        const { nodeId, output } = result.value;
        if (output.costUsd !== undefined) totalCostUsd += output.costUsd;
        nodeOutputs.set(nodeId, output);
        // Typed artifact: when a node declares `output_type`, persist its output
        // as a typed sidecar (nodes/<id>.md + .meta.json) so other nodes and
        // later runs can locate it by type. Best-effort — a metadata write must
        // never fail an otherwise-successful node.
        const completedNode = nodeById.get(nodeId);
        if (output.state === 'completed' && completedNode?.output_type) {
          try {
            await writeNodeArtifact(
              artifactsDir,
              {
                nodeId,
                outputType: completedNode.output_type,
                runId: workflowRun.id,
                producedAt: new Date().toISOString(),
                // `sessionId` may be undefined (e.g. bash/script nodes have no
                // session); writeNodeArtifact omits it from the metadata when so.
                sessionId: output.sessionId,
              },
              output.output
            );
          } catch (err) {
            getLog().warn(
              { err: err as Error, nodeId, workflowRunId: workflowRun.id },
              'artifacts.write_failed'
            );
          }
        }
        if (output.state === 'completed' && !isParallelLayer && output.sessionId !== undefined) {
          lastSequentialSessionId = output.sessionId;
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

  // Update DB and emit completion
  try {
    await deps.store.completeWorkflowRun(workflowRun.id, {
      node_counts: nodeCounts,
      // totalCostUsd starts at 0; only write metadata when at least one node reported cost
      ...(totalCostUsd > 0 ? { total_cost_usd: totalCostUsd } : {}),
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

  // Return the first terminal node's output (nodes with no dependents) for the parent
  // conversation summary. For the common single-terminal case this is unambiguous; for
  // multi-terminal DAGs the first completed node in definition order is used.
  const allDependencies = new Set(workflow.nodes.flatMap(n => n.depends_on ?? []));
  const terminalOutput = workflow.nodes
    .filter(n => !allDependencies.has(n.id))
    .map(n => nodeOutputs.get(n.id))
    .find(o => o?.state === 'completed' && o.output.trim().length > 0)?.output;

  return terminalOutput;
}
