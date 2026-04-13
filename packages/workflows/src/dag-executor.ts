/**
 * DAG Workflow Executor
 *
 * Executes a `nodes:`-based workflow in topological order.
 * Independent nodes within the same layer run concurrently via Promise.allSettled.
 * Captures all assistant output regardless of streaming mode for $node_id.output substitution.
 */
import { resolve } from 'path';
import { execFileAsync } from '@archon/git';
import { discoverScripts } from './script-discovery';
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
import { getProviderCapabilities } from '@archon/providers';
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
import { createLogger } from '@archon/paths';
import { getWorkflowEventEmitter } from './event-emitter';
import { evaluateCondition } from './condition-evaluator';
import { inferProviderFromModel, isModelCompatible } from './model-validation';
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
} from './executor-shared';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.dag-executor');
  return cachedLog;
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

/** Throttle state for activity heartbeat writes (only used for stale/zombie detection) */
const lastNodeActivityUpdate = new Map<string, number>();
const ACTIVITY_HEARTBEAT_INTERVAL_MS = 60_000;

/** Context for platform message sending */
interface SendMessageContext {
  workflowId?: string;
  nodeName?: string;
}

/** Default DAG node retry for TRANSIENT errors */
const DEFAULT_NODE_MAX_RETRIES = 2;
const DEFAULT_NODE_RETRY_DELAY_MS = 3000;

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
 * Safely send a message to the platform without crashing on failure.
 * Returns true if message was sent successfully, false otherwise.
 */
async function safeSendMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  metadata?: WorkflowMessageMetadata
): Promise<boolean> {
  try {
    await platform.sendMessage(conversationId, message, metadata);
    return true;
  } catch (error) {
    const err = error as Error;
    const errorType = classifyError(err);

    getLog().error(
      {
        err,
        conversationId,
        messageLength: message.length,
        errorType,
        platformType: platform.getPlatformType(),
        ...context,
      },
      'dag_node_message_send_failed'
    );

    if (errorType === 'FATAL') {
      throw new Error(`Platform authentication/permission error: ${err.message}`);
    }

    return false;
  }
}

/**
 * Single-quote a string for safe inline shell use.
 * Replaces each ' with '\'' (end quote, literal single-quote, re-open quote).
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  escapedForBash = false
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
        return escapedForBash ? shellQuote(nodeOutput.output) : nodeOutput.output;
      }
      try {
        const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
        const value = parsed[field];
        if (typeof value === 'string') return escapedForBash ? shellQuote(value) : value;
        // numbers and booleans from JSON.parse are shell-safe without quoting:
        // JSON disallows NaN/Infinity, so String(number) contains only digits, sign, and '.'.
        // String(boolean) is 'true' or 'false' — no shell metacharacters.
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return escapedForBash ? "''" : ''; // objects, null, undefined, symbol, bigint → empty
      } catch (jsonErr) {
        getLog().warn(
          { nodeId, field, outputPreview: nodeOutput.output.slice(0, 100), err: jsonErr as Error },
          'dag_node_output_ref_json_parse_failed'
        );
        return escapedForBash ? "''" : '';
      }
    }
  );
}

// buildSDKHooksFromYAML moved to @archon/providers/src/claude/provider.ts
// loadMcpConfig moved to @archon/providers/src/claude/provider.ts

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
  workflowLevelOptions: WorkflowLevelOptions
): Promise<{
  provider: string;
  model: string | undefined;
  options: SendQueryOptions | undefined;
}> {
  const provider: string = node.provider ?? inferProviderFromModel(node.model, workflowProvider);

  const providerAssistantConfig = config.assistants[provider];
  const model: string | undefined =
    node.model ??
    (provider === workflowProvider
      ? workflowModel
      : (providerAssistantConfig?.model as string | undefined));

  if (!isModelCompatible(provider, model)) {
    throw new Error(
      `Node '${node.id}': model "${model ?? 'default'}" is not compatible with provider "${provider}"`
    );
  }

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
    mcp: node.mcp,
    hooks: node.hooks,
    skills: node.skills,
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
  const assistantConfig = config.assistants[provider] ?? {};

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

  try {
    for await (const msg of withIdleTimeout(
      aiClient.sendQuery(finalPrompt, cwd, resumeSessionId, nodeOptionsWithAbort),
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

      // Cancel/pause check — read-only, no write contention in WAL mode (every 10s)
      if (tickNow - (lastNodeCancelCheck.get(nodeKey) ?? 0) > CANCEL_CHECK_INTERVAL_MS) {
        lastNodeCancelCheck.set(nodeKey, tickNow);
        try {
          const streamStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
          if (streamStatus === null || streamStatus !== 'running') {
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
        if (streamingMode === 'stream') {
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
        break; // Result is the "I'm done" signal — don't wait for subprocess to exit
      } else if (msg.type === 'system' && msg.content) {
        // Forward provider warnings (⚠️) and MCP connection failures to the user.
        // Providers yield system chunks for user-actionable issues (missing env vars,
        // Haiku+MCP, structured output failures, etc.)
        if (
          msg.content.startsWith('MCP server connection failed:') ||
          msg.content.startsWith('⚠️')
        ) {
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

    // When output_format is set and the provider returned structured_output,
    // use it instead of the concatenated assistant text (which includes prose).
    // Each provider normalizes its own structured output onto the result chunk —
    // no provider-specific branching here.
    if (nodeOptions?.outputFormat) {
      if (structuredOutput !== undefined) {
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
      } else {
        // Provider did not populate structuredOutput — warn the user.
        // If the provider detected invalid output, it already yielded a system warning.
        getLog().warn(
          { nodeId: node.id, workflowRunId: workflowRun.id },
          'dag.structured_output_missing'
        );
        await safeSendMessage(
          platform,
          conversationId,
          `Warning: Node '${node.id}' requested output_format but the provider did not return structured output. Downstream conditions may not evaluate correctly.`,
          nodeContext
        );
      }
    }

    // If the node completed via idle timeout, log it
    if (nodeIdleTimedOut) {
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

    return {
      state: 'completed',
      output: nodeOutputText,
      sessionId: newSessionId,
      costUsd: nodeCostUsd,
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
    issueContext
  );
  const finalScript = substituteNodeOutputRefs(substitutedScript, nodeOutputs, true);

  const timeout = node.timeout ?? SUBPROCESS_DEFAULT_TIMEOUT;
  const subprocessEnv =
    envVars && Object.keys(envVars).length > 0 ? { ...process.env, ...envVars } : undefined;

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
    const err = error as Error & { killed?: boolean; code?: number | string };
    const isTimeout = err.killed === true || (err.message ?? '').includes('timed out');
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `Bash node '${node.id}' timed out after ${String(timeout)}ms`;
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `Bash node '${node.id}' failed: bash executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
      errorMsg = `Bash node '${node.id}' failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = `Bash node '${node.id}' failed: ${err.message}`;
    }

    getLog().error({ err, nodeId: node.id, isTimeout }, 'dag_node_failed');
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
  const subprocessEnv =
    envVars && Object.keys(envVars).length > 0 ? { ...process.env, ...envVars } : undefined;

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
      // Named script — look up in .archon/scripts/ directory
      const scriptsDir = resolve(cwd, '.archon', 'scripts');
      const scripts = await discoverScripts(scriptsDir);
      const scriptDef = scripts.get(finalScript);

      if (!scriptDef) {
        const errorMsg = `Script node '${node.id}': named script '${finalScript}' not found in .archon/scripts/`;
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
    const stderrHint = err.stderr?.trim() ? `\n\nScript output:\n${err.stderr.trim()}` : '';
    let errorMsg: string;
    if (isTimeout) {
      errorMsg = `Script node '${node.id}' timed out after ${String(timeout)}ms`;
    } else if (err.message?.includes('ENOENT')) {
      errorMsg = `Script node '${node.id}' failed: '${cmd}' executable not found in PATH`;
    } else if (err.message?.includes('EACCES')) {
      errorMsg = `Script node '${node.id}' failed: permission denied (check cwd permissions)`;
    } else {
      errorMsg = `Script node '${node.id}' failed: ${err.message}${stderrHint}`;
    }

    getLog().error({ err, nodeId: node.id, isTimeout }, 'dag_node_failed');
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
 * Build SendQueryOptions from resolved provider, model, and config.
 * Uses the same nodeConfig + assistantConfig pattern as resolveNodeProviderAndModel.
 */
function buildLoopNodeOptions(
  provider: string,
  model: string | undefined,
  config: WorkflowConfig,
  workflowLevelOptions?: WorkflowLevelOptions
): SendQueryOptions {
  const options: SendQueryOptions = {};
  if (model) options.model = model;
  if (config.envVars && Object.keys(config.envVars).length > 0) {
    options.env = config.envVars;
  }
  options.assistantConfig = config.assistants[provider] ?? {};
  // Pass workflow-level options as nodeConfig so providers can apply them
  if (workflowLevelOptions) {
    options.nodeConfig = {
      effort: workflowLevelOptions.effort,
      thinking: workflowLevelOptions.thinking,
      sandbox: workflowLevelOptions.sandbox,
      betas: workflowLevelOptions.betas,
      fallbackModel: workflowLevelOptions.fallbackModel,
    };
  }
  return options;
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
  workflowModel: string | undefined,
  artifactsDir: string,
  logDir: string,
  baseBranch: string,
  docsDir: string,
  nodeOutputs: Map<string, NodeOutput>,
  config: WorkflowConfig,
  issueContext?: string,
  workflowLevelOptions?: WorkflowLevelOptions
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
  let loopTotalCostUsd: number | undefined;
  let loopFinalStopReason: string | undefined;
  let loopTotalNumTurns: number | undefined;
  const resolvedOptions = buildLoopNodeOptions(
    workflowProvider,
    workflowModel,
    config,
    workflowLevelOptions
  );

  // Helper to log event store errors consistently
  const logEventStoreError = (err: Error, iteration: number): void => {
    getLog().error({ err, nodeId: node.id, iteration }, 'loop_node.iteration_event_failed');
  };

  for (let i = startIteration; i <= loop.max_iterations; i++) {
    const iterationStart = Date.now();

    // Check for non-running status between iterations (cancellation, deletion, or future: pause)
    const runStatus = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (runStatus === null || runStatus !== 'running') {
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

    // Session threading
    const needsFreshSession = loop.fresh_context || i === 1;
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
      const { prompt: substitutedPrompt } = substituteWorkflowVariables(
        loop.prompt,
        workflowRun.id,
        workflowRun.user_message,
        artifactsDir,
        baseBranch,
        docsDir,
        issueContext,
        i === startIteration ? loopUserInput : ''
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
          const cleaned = stripCompletionTags(msg.content);
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

    // Batch mode: send accumulated output
    if (platform.getStreamingMode() === 'batch' && cleanOutput) {
      await safeSendMessage(platform, conversationId, cleanOutput, msgContext);
    }

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
          issueContext
        );
        const substitutedBash = substituteNodeOutputRefs(
          bashPrompt,
          nodeOutputs,
          true // escapedForBash
        );
        await execFileAsync('bash', ['-c', substitutedBash], { cwd });
        bashComplete = true; // exit 0 = complete
      } catch (e) {
        const bashErr = e as NodeJS.ErrnoException;
        // ENOENT or other system errors are unexpected — log them
        if (bashErr.code === 'ENOENT') {
          getLog().warn(
            { err: bashErr, nodeId: node.id, iteration: i },
            'loop_node.until_bash_exec_error'
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
  issueContext?: string
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

    // Build a synthetic PromptNode to reuse executeNodeInternal
    const syntheticNode: PromptNode = {
      id: node.id,
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
      workflowLevelOptions
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

  // Standard approval gate — send message and pause
  const approvalMsg =
    `⏸ **Approval required**: ${node.approval.message}\n\n` +
    `Run ID: \`${workflowRun.id}\`\n` +
    `Approve: \`/workflow approve ${workflowRun.id}\` | Reject: \`/workflow reject ${workflowRun.id}\``;
  await safeSendMessage(platform, conversationId, approvalMsg, msgContext);

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'approval_requested',
      step_name: node.id,
      data: { message: node.approval.message },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'approval_requested' },
        'workflow.event_persist_failed'
      );
    });

  await deps.store.pauseWorkflowRun(workflowRun.id, {
    message: node.approval.message,
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
    message: node.approval.message,
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
  workflow: { name: string; nodes: readonly DagNode[] } & WorkflowLevelOptions,
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
  priorCompletedNodes?: Map<string, string>
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
  if (priorCompletedNodes && priorCompletedNodes.size > 0) {
    for (const [nodeId, output] of priorCompletedNodes) {
      nodeOutputs.set(nodeId, { state: 'completed', output });
    }
    getLog().info(
      { workflowRunId: workflowRun.id, priorCompletedCount: priorCompletedNodes.size },
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
          // 0. Skip if this node completed successfully in a prior run (resume path)
          if (priorCompletedNodes?.has(node.id)) {
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
                data: { reason: 'prior_success' },
              })
              .catch((err: Error) => {
                getLog().error(
                  { err, workflowRunId: workflowRun.id, eventType: 'node_skipped_prior_success' },
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
            // Resolve per-node provider/model overrides (same logic as other node types)
            const loopProvider: string =
              node.provider ?? inferProviderFromModel(node.model, workflowProvider);
            const loopAssistantConfig = config.assistants[loopProvider];
            const loopModel: string | undefined =
              node.model ??
              (loopProvider === workflowProvider
                ? workflowModel
                : (loopAssistantConfig?.model as string | undefined));

            if (!isModelCompatible(loopProvider, loopModel)) {
              return {
                nodeId: node.id,
                output: {
                  state: 'failed' as const,
                  output: '',
                  error: `Node '${node.id}': model "${loopModel ?? 'default'}" is not compatible with provider "${loopProvider}"`,
                },
              };
            }

            const output = await executeLoopNode(
              deps,
              platform,
              conversationId,
              cwd,
              workflowRun,
              node,
              loopProvider,
              loopModel,
              artifactsDir,
              logDir,
              baseBranch,
              docsDir,
              nodeOutputs,
              config,
              issueContext,
              workflowLevelOptions
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
              issueContext
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
            workflowLevelOptions
          );

          // 5. Determine session — parallel or context:fresh → always fresh
          // Parallel layers always get fresh sessions; explicit 'fresh' context also forces it.
          // 'shared' forces continuation. Default: fresh for parallel, inherited for sequential.
          const isFresh = isParallelLayer || node.context === 'fresh';
          const resumeSessionId = isFresh ? undefined : lastSequentialSessionId;

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
    let layerHadFailure = false;
    for (const result of layerResults) {
      if (result.status === 'fulfilled') {
        const { nodeId, output } = result.value;
        if (output.costUsd !== undefined) totalCostUsd += output.costUsd;
        nodeOutputs.set(nodeId, output);
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

  // Helper: bail out if the run was transitioned externally (cancelled, deleted, etc.)
  async function skipIfStatusChanged(logEvent: string): Promise<boolean> {
    const status = await deps.store.getWorkflowRunStatus(workflowRun.id);
    if (status === null || status !== 'running') {
      getLog().info({ workflowRunId: workflowRun.id, status: status ?? 'deleted' }, logEvent);
      getWorkflowEventEmitter().unregisterRun(workflowRun.id);
      return true;
    }
    return false;
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
    const failMsg =
      `DAG workflow '${workflow.name}' completed with no successful nodes. ` +
      'Check node conditions, trigger rules, and upstream failures.';
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
    const failedNodes = [...nodeOutputs.entries()]
      .filter(([, o]) => o.state === 'failed')
      .map(([id, o]) => `'${id}': ${o.state === 'failed' ? o.error : 'unknown'}`)
      .join('; ');
    await safeSendMessage(
      platform,
      conversationId,
      `\u26a0\ufe0f Some DAG nodes failed: ${failedNodes}\nSuccessful nodes completed normally.`,
      { workflowId: workflowRun.id }
    );
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
